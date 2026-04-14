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
    throw new Error(`Volcengine TTS HTTP ${response.status}`);
  }

  const result = await response.json();

  if (result.code !== 3000 || !result.data) {
    throw new Error(`Volcengine TTS: ${result.message || `code ${result.code}`}`);
  }

  return result.data; // base64 audio
}

// --- Volcengine ASR via File Recognition API ---
// Flow: save audio to temp file → serve via our proxy → submit URL to Volcengine → poll result

const TEMP_DIR = '/tmp/echocoding-asr';
try { fs.mkdirSync(TEMP_DIR, { recursive: true }); } catch {}

// Temp file serving: /tmp/<id>.wav → accessible at https://coding.echoclaw.me/tmp/<id>.wav
// Cleanup temp files after 60 seconds

async function volcAsr(audioBase64, format, language) {
  // Save audio to temp file with unique ID
  const fileId = crypto.randomUUID();
  const ext = format === 'webm' ? 'webm' : 'wav';
  const tempPath = path.join(TEMP_DIR, `${fileId}.${ext}`);
  const audioBuffer = Buffer.from(audioBase64, 'base64');
  fs.writeFileSync(tempPath, audioBuffer);

  // Public URL for Volcengine to fetch
  const audioUrl = `https://coding.echoclaw.me/tmp/${fileId}.${ext}`;

  try {
    // V3 大模型录音文件识别 API
    const taskId = crypto.randomUUID();
    const submitHeaders = {
      'Content-Type': 'application/json',
      'X-Api-App-Key': VOLC_APP_ID,
      'X-Api-Access-Key': VOLC_ACCESS_TOKEN,
      'X-Api-Resource-Id': 'volc.bigasr.auc',
      'X-Api-Request-Id': taskId,
      'X-Api-Sequence': '-1',
    };

    // Submit recognition task
    const submitRes = await fetch('https://openspeech.bytedance.com/api/v3/auc/bigmodel/submit', {
      method: 'POST',
      headers: submitHeaders,
      body: JSON.stringify({
        user: { uid: 'echocoding-proxy' },
        audio: { url: audioUrl, format: ext },
        request: {
          model_name: 'bigmodel',
          enable_itn: true,
          enable_punc: true,
          show_utterances: true,
        },
      }),
    });

    if (!submitRes.ok) {
      const errBody = await submitRes.text().catch(() => '');
      throw new Error(`Submit failed: HTTP ${submitRes.status} ${errBody.slice(0, 300)}`);
    }

    const submitResult = await submitRes.json();
    // Get logid from response header for query
    const logId = submitRes.headers.get('x-tt-logid') || '';

    if (submitResult.code && submitResult.code !== 20000000 && submitResult.code !== 20000001 && submitResult.code !== 20000002) {
      throw new Error(`Submit failed: ${submitResult.message || JSON.stringify(submitResult).slice(0, 200)}`);
    }

    // Poll for result (max 30 seconds, 2s intervals)
    const maxPolls = 15;
    for (let i = 0; i < maxPolls; i++) {
      await new Promise(r => setTimeout(r, 2000));

      const queryHeaders = {
        'Content-Type': 'application/json',
        'X-Api-App-Key': VOLC_APP_ID,
        'X-Api-Access-Key': VOLC_ACCESS_TOKEN,
        'X-Api-Resource-Id': 'volc.bigasr.auc',
        'X-Api-Request-Id': taskId,
        'X-Api-Sequence': '-1',
      };
      if (logId) queryHeaders['X-Tt-Logid'] = logId;

      const queryRes = await fetch('https://openspeech.bytedance.com/api/v3/auc/bigmodel/query', {
        method: 'POST',
        headers: queryHeaders,
        body: '{}',
      });

      if (!queryRes.ok) continue;

      const queryResult = await queryRes.json();
      const code = queryResult.code;

      // V3 API: result is directly in response when complete (no code field)
      if (queryResult.result?.text) {
        return queryResult.result.text.trim();
      }

      // Fallback: check utterances
      if (queryResult.result?.utterances?.length > 0) {
        const text = queryResult.result.utterances.map(u => u.text).join('');
        if (text.trim()) return text.trim();
      }

      // Status codes for polling
      if (code === 20000000) {
        return queryResult.result?.text?.trim() || '[empty]';
      } else if (code === 20000001 || code === 20000002) {
        continue;
      } else if (code !== undefined) {
        throw new Error(`ASR query: ${queryResult.message || `code ${code}`}`);
      }

      // No code, no result yet — keep polling
      continue;
    }

    throw new Error('ASR timeout: result not ready after 30 seconds');
  } finally {
    // Cleanup temp file after a delay (Volcengine needs time to fetch it)
    setTimeout(() => {
      try { fs.unlinkSync(tempPath); } catch {}
    }, 60_000);
  }
}

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
  const url = req.url;

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

      // voice_type whitelist: only allow known Volcengine voice IDs or empty (default)
      const ALLOWED_VOICE_PATTERN = /^[a-z]{2}_(?:fe)?male_[a-z0-9_]+$/;
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

    // Serve temp audio files for Volcengine to fetch
    if (url.startsWith('/tmp/') && req.method === 'GET') {
      const fileName = url.replace('/tmp/', '').replace(/[^a-zA-Z0-9._-]/g, '');
      const filePath = path.join(TEMP_DIR, fileName);
      if (fs.existsSync(filePath)) {
        const data = fs.readFileSync(filePath);
        const ext = path.extname(fileName);
        const mime = ext === '.webm' ? 'audio/webm' : ext === '.mp3' ? 'audio/mpeg' : 'audio/wav';
        res.writeHead(200, { 'Content-Type': mime, 'Content-Length': data.length });
        res.end(data);
        return;
      }
    }

    sendJson(res, 404, { error: 'Not found. Endpoints: POST /v1/tts, POST /v1/asr, GET /health' });
  } catch (err) {
    console.error(`[ERROR] ${ip} ${url}:`, err.message?.slice(0, 100));
    sendJson(res, 500, { error: 'Internal server error' });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[EchoCoding Proxy] Listening on port ${PORT}`);
  console.log(`[EchoCoding Proxy] Rate limit: ${RATE_LIMIT_PER_MIN} req/min per IP`);
  console.log(`[EchoCoding Proxy] Volcengine App ID: ${VOLC_APP_ID}`);
});
