/**
 * EchoCoding Cloud Proxy Server
 *
 * Sits between EchoCoding clients and Volcengine APIs.
 * Holds the Volcengine API key server-side — clients don't need any key.
 * Adds rate limiting to prevent abuse.
 *
 * Endpoints:
 *   POST /v1/tts  — text → base64 mp3
 *   POST /v1/asr  — base64 wav → text
 *   GET  /health   — server health check
 *
 * Deploy: node proxy/server.js
 * Env vars: VOLC_APP_ID, VOLC_ACCESS_TOKEN, PORT, RATE_LIMIT_PER_MIN
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const WS = require('ws');

// --- Config from env ---
const VOLC_APP_ID = process.env.VOLC_APP_ID || '';
const VOLC_ACCESS_TOKEN = process.env.VOLC_ACCESS_TOKEN || '';
const SIGNING_KEY = process.env.EC_HMAC_SECRET || 'ec-managed-v1-7a3f2b1d5e8c490f6d2a1b3e7c9f4d8a';

function verifyHmac(method, urlPath, timestamp, signature, body) {
  if (!timestamp || !signature) return false;
  const ts = parseInt(timestamp, 10);
  const now = Math.floor(Date.now() / 1000);
  if (isNaN(ts) || Math.abs(now - ts) > 120) return false; // 2 minute window
  const bodyHash = crypto.createHash('sha256').update(body).digest('hex');
  const payload = `${method}:${urlPath}:${timestamp}:${bodyHash}`;
  const expected = crypto.createHmac('sha256', SIGNING_KEY).update(payload).digest('hex');
  try { return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected)); }
  catch { return false; }
}
const PORT = parseInt(process.env.PORT || '3456', 10);
const RATE_LIMIT_PER_MIN = parseInt(process.env.RATE_LIMIT_PER_MIN || '30', 10);

if (!VOLC_APP_ID || !VOLC_ACCESS_TOKEN) {
  console.error('ERROR: Set VOLC_APP_ID and VOLC_ACCESS_TOKEN env vars');
  process.exit(1);
}

// --- Rate limiter (per-IP, sliding window) ---
const rateLimits = new Map();

function checkRateLimit(ip) {
  const now = Date.now();
  const windowMs = 60_000;

  if (!rateLimits.has(ip)) {
    rateLimits.set(ip, []);
  }

  const timestamps = rateLimits.get(ip).filter((t) => now - t < windowMs);
  rateLimits.set(ip, timestamps);

  if (timestamps.length >= RATE_LIMIT_PER_MIN) {
    return false;
  }

  timestamps.push(now);
  return true;
}

// Cleanup stale entries every 5 min
setInterval(() => {
  const now = Date.now();
  for (const [ip, timestamps] of rateLimits.entries()) {
    const fresh = timestamps.filter((t) => now - t < 60_000);
    if (fresh.length === 0) rateLimits.delete(ip);
    else rateLimits.set(ip, fresh);
  }
}, 300_000);

// --- Volcengine TTS ---
async function volcTts(text, voiceType, speed) {
  const reqid = crypto.randomUUID();

  const body = JSON.stringify({
    app: {
      appid: VOLC_APP_ID,
      token: VOLC_ACCESS_TOKEN,
      cluster: 'volcano_tts',
    },
    user: { uid: 'echocoding-proxy' },
    audio: {
      voice_type: voiceType || 'zh_female_shuangkuaisisi_moon_bigtts',
      encoding: 'mp3',
      speed_ratio: speed || 1.0,
      volume_ratio: 1.0,
      pitch_ratio: 1.0,
    },
    request: {
      reqid,
      text,
      text_type: 'plain',
      operation: 'query',
    },
  });

  const response = await fetch('https://openspeech.bytedance.com/api/v1/tts', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer;${VOLC_ACCESS_TOKEN}`,
    },
    body,
  });

  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    throw new Error(`Volcengine TTS HTTP ${response.status} voice=${voiceType} ${errBody.slice(0, 100)}`);
  }

  const result = await response.json();

  if (result.code !== 3000 || !result.data) {
    throw new Error(`Volcengine TTS: ${result.message || `code ${result.code}`}`);
  }

  return result.data; // base64 audio
}

const VOLC_ASR_WS_URL = 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel';
const VOLC_ASR_RESOURCE_ID = 'volc.bigasr.sauc.duration';

function createVolcAsrHeaders() {
  return {
    'X-Api-App-Key': VOLC_APP_ID,
    'X-Api-Access-Key': VOLC_ACCESS_TOKEN,
    'X-Api-Resource-Id': VOLC_ASR_RESOURCE_ID,
    'X-Api-Connect-Id': crypto.randomUUID(),
  };
}

function createVolcAsrConfigPayload(format, language) {
  const normalizedFormat = format === 'webm' ? 'ogg' : format;
  const codec = (normalizedFormat === 'ogg' || normalizedFormat === 'webm') ? 'opus' : 'raw';
  return JSON.stringify({
    user: { uid: 'echocoding-proxy' },
    audio: {
      format: normalizedFormat,
      rate: 16000,
      bits: 16,
      channel: 1,
      codec,
    },
    request: {
      model_name: 'bigmodel',
      enable_itn: true,
      enable_punc: true,
      result_type: 'full',
      language: language === 'en-US' ? 'en' : 'zh',
    },
  });
}

// Build binary frame: [4B header] [4B payload_size_BE] [payload]
function buildV3Frame(msgType, flags, serialization, payload) {
  const header = Buffer.alloc(4);
  header[0] = 0x11; // version=1, header_size=1
  header[1] = (msgType << 4) | (flags & 0x0f);
  header[2] = (serialization << 4) | 0x00; // no compression
  header[3] = 0x00;
  const sizeBuf = Buffer.alloc(4);
  sizeBuf.writeUInt32BE(payload.length, 0);
  return Buffer.concat([header, sizeBuf, payload]);
}

function parseV3FrameJson(buf) {
  // V3 server response frame:
  // [4B header] [4B sequence] [4B payload_size BE] [JSON payload]
  if (buf.length > 12) {
    try {
      const payloadSize = buf.readUInt32BE(8);
      const json = buf.slice(12, 12 + payloadSize).toString('utf-8');
      return JSON.parse(json);
    } catch { /* continue fallback */ }
  }
  for (const offset of [12, 8]) {
    if (buf.length <= offset) continue;
    try {
      const raw = buf.slice(offset).toString('utf-8').trim();
      if (raw.startsWith('{')) return JSON.parse(raw);
    } catch { /* continue */ }
  }
  return null;
}

function parseV3ServerMessage(data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (buf.length < 4) return null;

  return {
    buf,
    msgType: (buf[1] >> 4) & 0x0f,
    isFinal: (buf[1] & 0x02) !== 0,
    payload: parseV3FrameJson(buf),
  };
}

function extractAsrText(payload) {
  return payload?.result?.text || payload?.text || '';
}

// --- Volcengine ASR via V3 WebSocket (bigmodel_nostream) ---
// Protocol: binary frames with 4-byte header + 4-byte payload_size + payload
// Flow: connect → send full_client_request (JSON config) → send audio chunks → send final marker → receive result

async function volcAsr(audioBase64, format, language) {
  const audioBuf = Buffer.from(audioBase64, 'base64');
  const configPayload = createVolcAsrConfigPayload(format, language);

  return new Promise((resolve, reject) => {
    const ws = new WS(VOLC_ASR_WS_URL, {
      skipUTF8Validation: true,
      headers: createVolcAsrHeaders(),
    });
    let done = false;
    let accumulatedText = '';

    const finish = (err, text) => {
      if (done) return;
      done = true;
      try { ws.close(); } catch {}
      if (err) reject(err);
      else resolve(text);
    };

    const timeout = setTimeout(() => {
      finish(new Error('ASR WebSocket timeout after 30 seconds'));
    }, 30_000);

    ws.on('open', () => {
      // 1. Send full_client_request (msg_type=0x1, serialization=JSON=0x1)
      const configBuf = Buffer.from(configPayload, 'utf-8');
      ws.send(buildV3Frame(0x1, 0x0, 0x1, configBuf));

      // 2. Send audio data in chunks (msg_type=0x2)
      const CHUNK_SIZE = 8000;  // 8KB chunks
      for (let i = 0; i < audioBuf.length; i += CHUNK_SIZE) {
        const chunk = audioBuf.slice(i, i + CHUNK_SIZE);
        const isLast = (i + CHUNK_SIZE) >= audioBuf.length;
        ws.send(buildV3Frame(0x2, isLast ? 0x2 : 0x0, 0x0, chunk));
      }

      // 3. If audio was empty, send final empty marker
      if (audioBuf.length === 0) {
        ws.send(buildV3Frame(0x2, 0x2, 0x0, Buffer.alloc(0)));
      }
    });

    ws.on('message', (data) => {
      try {
        const parsed = parseV3ServerMessage(data);
        if (!parsed || !parsed.payload) return;

        // V3 error response (msg_type=0xf)
        if (parsed.msgType === 0xf) {
          clearTimeout(timeout);
          finish(new Error(`ASR error: ${parsed.payload.error || parsed.payload.message || JSON.stringify(parsed.payload).slice(0, 200)}`));
          return;
        }

        const text = extractAsrText(parsed.payload);
        if (text) accumulatedText = text;

        if (parsed.isFinal) {
          clearTimeout(timeout);
          finish(null, accumulatedText.trim());
        }
      } catch (e) {
        console.error('[ASR] Parse error:', e.message);
      }
    });

    ws.on('error', (err) => {
      clearTimeout(timeout);
      finish(new Error(`ASR WebSocket error: ${err.message || 'connection failed'}`));
    });

    ws.on('close', () => {
      // Non-streaming bigmodel closes after sending result.
      // Resolve with whatever text we collected (empty string = silence/no speech).
      clearTimeout(timeout);
      if (!done) finish(null, accumulatedText.trim());
    });
  });
}

function normalizeStreamFormat(input) {
  if (input === 'pcm' || input === 'raw' || input === 's16le') return 'pcm';
  if (input === 'ogg' || input === 'webm') return 'ogg';
  return 'wav';
}

function sendWsJson(ws, payload) {
  if (ws.readyState !== WS.OPEN) return;
  try { ws.send(JSON.stringify(payload)); } catch { /* ignore */ }
}

function createHttpErrorResponse(status, message) {
  const body = JSON.stringify({ error: message });
  return [
    `HTTP/1.1 ${status} ${http.STATUS_CODES[status] || 'Error'}`,
    'Content-Type: application/json',
    'Connection: close',
    `Content-Length: ${Buffer.byteLength(body)}`,
    '',
    body,
  ].join('\r\n');
}

function handleStreamUpgrade(req, socket, head) {
  let parsed;
  try {
    parsed = new URL(req.url || '/', 'http://localhost');
  } catch {
    socket.write(createHttpErrorResponse(400, 'Bad request URL'));
    socket.destroy();
    return;
  }

  if (parsed.pathname !== '/v1/asr/stream') {
    socket.write(createHttpErrorResponse(404, 'Not found'));
    socket.destroy();
    return;
  }

  const ip = req.headers['x-forwarded-for']?.toString().split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
  if (!checkRateLimit(ip)) {
    socket.write(createHttpErrorResponse(429, `Rate limit exceeded. Max ${RATE_LIMIT_PER_MIN} requests per minute.`));
    socket.destroy();
    return;
  }

  const ts = parsed.searchParams.get('ts') || req.headers['x-ec-timestamp'];
  const sig = parsed.searchParams.get('sig') || req.headers['x-ec-signature'];
  if (!verifyHmac('GET', '/v1/asr/stream', ts, sig, '')) {
    socket.write(createHttpErrorResponse(401, 'Unauthorized: invalid or missing signature'));
    socket.destroy();
    return;
  }

  asrStreamWss.handleUpgrade(req, socket, head, (ws) => {
    asrStreamWss.emit('connection', ws, req);
  });
}

function handleAsrStreamSession(client, req) {
  const ip = req.headers['x-forwarded-for']?.toString().split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
  const upstream = new WS(VOLC_ASR_WS_URL, {
    skipUTF8Validation: true,
    headers: createVolcAsrHeaders(),
  });

  let done = false;
  let started = false;
  let endedByClient = false;
  let configSent = false;
  let finalSentToUpstream = false;
  let language = 'zh-CN';
  let format = 'wav';
  let accumulatedText = '';
  const queuedAudio = [];
  const MAX_QUEUED_AUDIO = 2 * 1024 * 1024;
  let queuedBytes = 0;

  let finalWaitTimer = null;
  const sessionTimeout = setTimeout(() => {
    finishError('ASR stream timeout');
  }, 120_000);

  const cleanup = () => {
    clearTimeout(sessionTimeout);
    if (finalWaitTimer) {
      clearTimeout(finalWaitTimer);
      finalWaitTimer = null;
    }
    try { upstream.close(); } catch { /* ignore */ }
    try { client.close(); } catch { /* ignore */ }
  };

  const finishError = (message) => {
    if (done) return;
    done = true;
    sendWsJson(client, { type: 'error', error: message });
    cleanup();
  };

  const finishSuccess = (text) => {
    if (done) return;
    done = true;
    sendWsJson(client, { type: 'final', text: (text || '').trim() });
    cleanup();
    console.log(`[ASR/STREAM] ${ip} result="${(text || '').slice(0, 30)}"`);
  };

  const sendConfigIfReady = () => {
    if (configSent || upstream.readyState !== WS.OPEN) return;
    const payload = Buffer.from(createVolcAsrConfigPayload(format, language), 'utf-8');
    upstream.send(buildV3Frame(0x1, 0x0, 0x1, payload));
    configSent = true;

    while (queuedAudio.length > 0) {
      const chunk = queuedAudio.shift();
      queuedBytes -= chunk.length;
      upstream.send(buildV3Frame(0x2, 0x0, 0x0, chunk));
    }

    if (endedByClient) sendFinalMarker();
  };

  const sendFinalMarker = () => {
    if (!configSent || upstream.readyState !== WS.OPEN || finalSentToUpstream) return;
    finalSentToUpstream = true;
    upstream.send(buildV3Frame(0x2, 0x2, 0x0, Buffer.alloc(0)));
    finalWaitTimer = setTimeout(() => {
      finishSuccess(accumulatedText);
    }, 12_000);
  };

  const forwardAudioChunk = (chunk) => {
    if (done || endedByClient) return;
    started = true;
    if (upstream.readyState === WS.OPEN && !configSent) {
      sendConfigIfReady();
    }
    if (upstream.readyState === WS.OPEN && configSent) {
      upstream.send(buildV3Frame(0x2, 0x0, 0x0, chunk));
      return;
    }
    queuedAudio.push(chunk);
    queuedBytes += chunk.length;
    if (queuedBytes > MAX_QUEUED_AUDIO) {
      finishError('ASR stream audio queue overflow');
    }
  };

  upstream.on('open', () => {
    sendConfigIfReady();
  });

  upstream.on('message', (data) => {
    const parsed = parseV3ServerMessage(data);
    if (!parsed || !parsed.payload) return;

    if (parsed.msgType === 0xf) {
      finishError(`ASR error: ${parsed.payload.error || parsed.payload.message || 'upstream failure'}`);
      return;
    }

    const text = extractAsrText(parsed.payload).trim();
    if (text && text !== accumulatedText) {
      accumulatedText = text;
      sendWsJson(client, { type: 'partial', text: accumulatedText });
    }

    if (parsed.isFinal) {
      finishSuccess(accumulatedText);
    }
  });

  upstream.on('error', (err) => {
    if (!done) finishError(`ASR upstream websocket error: ${err.message || 'connection failed'}`);
  });

  upstream.on('close', () => {
    if (!done) finishSuccess(accumulatedText);
  });

  client.on('message', (data, isBinary) => {
    if (done) return;

    if (isBinary) {
      const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (chunk.length > 0) forwardAudioChunk(chunk);
      return;
    }

    let msg;
    try {
      const raw = typeof data === 'string' ? data : data.toString('utf-8');
      msg = JSON.parse(raw);
    } catch {
      finishError('Invalid JSON frame');
      return;
    }

    if (msg?.type === 'start') {
      started = true;
      if (typeof msg.language === 'string') language = msg.language;
      if (msg.audio && typeof msg.audio.format === 'string') {
        format = normalizeStreamFormat(msg.audio.format);
      }
      sendConfigIfReady();
      return;
    }

    if (msg?.type === 'end') {
      endedByClient = true;
      if (!started) started = true;
      sendConfigIfReady();
      sendFinalMarker();
      return;
    }
  });

  client.on('close', () => {
    if (done) return;
    done = true;
    clearTimeout(sessionTimeout);
    if (finalWaitTimer) clearTimeout(finalWaitTimer);
    try { upstream.close(); } catch { /* ignore */ }
  });

  client.on('error', () => {
    if (!done) finishError('Client websocket error');
  });
}

const asrStreamWss = new WS.WebSocketServer({ noServer: true });
asrStreamWss.on('connection', handleAsrStreamSession);

// --- HTTP Server ---
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const MAX_SIZE = 10 * 1024 * 1024; // 10MB limit

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_SIZE) {
        reject(new Error('Request too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    sendJson(res, 200, { ok: true });
    return;
  }

  const ip = req.headers['x-forwarded-for']?.toString().split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
  let url = '/';
  try {
    url = new URL(req.url || '/', 'http://localhost').pathname;
  } catch {
    sendJson(res, 400, { error: 'Bad request URL' });
    return;
  }

  // Health check
  if (url === '/health' && req.method === 'GET') {
    sendJson(res, 200, { status: 'ok', uptime: process.uptime() });
    return;
  }

  // Rate limit check
  if (!checkRateLimit(ip)) {
    sendJson(res, 429, { error: 'Rate limit exceeded. Max ' + RATE_LIMIT_PER_MIN + ' requests per minute.' });
    return;
  }

  try {
    // Auth check for TTS/ASR endpoints
    if ((url === '/v1/tts' || url === '/v1/asr') && req.method === 'POST') {
      const rawBody = await readBody(req);
      const ts = req.headers['x-ec-timestamp'];
      const sig = req.headers['x-ec-signature'];
      if (!verifyHmac(req.method, url, ts, sig, rawBody)) {
        sendJson(res, 401, { error: 'Unauthorized: invalid or missing signature' });
        return;
      }
      // Parse after auth
      req._parsedBody = JSON.parse(rawBody);
    }

    // TTS endpoint
    if (url === '/v1/tts' && req.method === 'POST') {
      const body = req._parsedBody;

      // Strict parameter whitelist
      const text = typeof body.text === 'string' ? body.text : '';
      const voiceType = typeof body.voice_type === 'string' ? body.voice_type : '';
      const speed = typeof body.speed === 'number' ? body.speed : 1.0;

      if (!text) {
        sendJson(res, 400, { error: 'Missing "text" field' });
        return;
      }
      if (text.length > 2000) {
        sendJson(res, 400, { error: 'Text too long (max 2000 chars)' });
        return;
      }

      // voice_type whitelist: BVxxx_streaming format or legacy zh_xxx format
      const ALLOWED_VOICE_PATTERN = /^(BV|BR)\d+(_V\d+)?_streaming$|^[a-z]{2}_(?:fe)?male_[a-z0-9_]+$/;
      if (voiceType && !ALLOWED_VOICE_PATTERN.test(voiceType)) {
        sendJson(res, 400, { error: 'Invalid voice_type format' });
        return;
      }

      // speed range: 0.5 - 2.0
      if (speed < 0.5 || speed > 2.0) {
        sendJson(res, 400, { error: 'Speed must be 0.5-2.0' });
        return;
      }

      const audioData = await volcTts(text, voiceType || undefined, speed);
      sendJson(res, 200, { data: audioData });
      console.log(`[TTS] ${ip} len=${text.length} voice=${voiceType || 'default'}`);
      return;
    }

    // ASR endpoint
    if (url === '/v1/asr' && req.method === 'POST') {
      const body = req._parsedBody;

      const audio = typeof body.audio === 'string' ? body.audio : '';
      const format = typeof body.format === 'string' && ['wav', 'mp3', 'ogg'].includes(body.format) ? body.format : 'wav';
      const language = typeof body.language === 'string' && ['zh-CN', 'en-US', 'auto'].includes(body.language) ? body.language : 'zh-CN';

      if (!audio) {
        sendJson(res, 400, { error: 'Missing "audio" field (base64)' });
        return;
      }

      // base64 limit: 13MB ~ 10MB raw audio after decode
      if (audio.length > 13_000_000) {
        sendJson(res, 400, { error: 'Audio too large (max 10MB)' });
        return;
      }

      const text = await volcAsr(audio, format, language);
      sendJson(res, 200, { text });
      console.log(`[ASR] ${ip} len=${audio.length} result="${text.slice(0, 30)}"`);
      return;
    }

    sendJson(res, 404, { error: 'Not found. Endpoints: POST /v1/tts, POST /v1/asr, WS /v1/asr/stream, GET /health' });
  } catch (err) {
    const msg = err.message?.slice(0, 200) || 'Unknown error';
    console.error(`[ERROR] ${ip} ${url}:`, msg);
    sendJson(res, 500, { error: msg });
  }
});

server.on('upgrade', handleStreamUpgrade);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[EchoCoding Proxy] Listening on port ${PORT}`);
  console.log(`[EchoCoding Proxy] Rate limit: ${RATE_LIMIT_PER_MIN} req/min per IP`);
  console.log(`[EchoCoding Proxy] Volcengine App ID: ${VOLC_APP_ID}`);
});
