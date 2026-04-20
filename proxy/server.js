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
 * Env vars: VOLC_APP_ID, VOLC_ACCESS_TOKEN, PORT, RATE_LIMIT_PER_MIN, DAILY_MEDIA_QUOTA_SECONDS
 */

import http from 'node:http';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const WS = require('ws');

// --- Config from env ---
const VOLC_APP_ID = process.env.VOLC_APP_ID || '';
const VOLC_ACCESS_TOKEN = process.env.VOLC_ACCESS_TOKEN || '';
const SIGNING_KEY_CURRENT = process.env.EC_HMAC_SECRET || '';
const SIGNING_KEY_LEGACY = process.env.EC_HMAC_SECRET_LEGACY || '';
const SIGNING_KEYS = [...new Set([SIGNING_KEY_CURRENT, SIGNING_KEY_LEGACY].filter(Boolean))];
const PCM_SAMPLE_RATE = 16_000;
const PCM_BITS_PER_SAMPLE = 16;
const PCM_CHANNELS = 1;
const PCM_BYTES_PER_SECOND = (PCM_SAMPLE_RATE * PCM_BITS_PER_SAMPLE * PCM_CHANNELS) / 8;
const FALLBACK_MP3_BITRATE_BPS = 64_000;
const FALLBACK_OGG_OPUS_BITRATE_BPS = 32_000;

function verifyHmac(method, urlPath, timestamp, signature, body) {
  if (!timestamp || !signature) return false;
  const ts = parseInt(timestamp, 10);
  const now = Math.floor(Date.now() / 1000);
  if (isNaN(ts) || Math.abs(now - ts) > 120) return false; // 2 minute window
  const bodyHash = crypto.createHash('sha256').update(body).digest('hex');
  const payload = `${method}:${urlPath}:${timestamp}:${bodyHash}`;

  for (const signingKey of SIGNING_KEYS) {
    const expected = crypto.createHmac('sha256', signingKey).update(payload).digest('hex');
    try {
      if (signature.length === expected.length && crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
        return true;
      }
    } catch {
      // continue checking other keys
    }
  }
  return false;
}
const PORT = parseInt(process.env.PORT || '3456', 10);
const RATE_LIMIT_PER_MIN = parseInt(process.env.RATE_LIMIT_PER_MIN || '30', 10);
const DAILY_MEDIA_QUOTA_SECONDS = parseInt(process.env.DAILY_MEDIA_QUOTA_SECONDS || '0', 10); // 0 = disabled

if (!VOLC_APP_ID || !VOLC_ACCESS_TOKEN) {
  console.error('ERROR: Set VOLC_APP_ID and VOLC_ACCESS_TOKEN env vars');
  process.exit(1);
}
if (SIGNING_KEYS.length === 0) {
  console.error('ERROR: Set EC_HMAC_SECRET (and optional EC_HMAC_SECRET_LEGACY) env vars');
  process.exit(1);
}

// --- Rate limiter (per-IP, sliding window) ---
const rateLimits = new Map();
const dailyMediaUsage = new Map();

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

function getClientIp(req) {
  return req.headers['x-forwarded-for']?.toString().split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
}

function getDailyBucketUtc() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function getOrInitDailyMediaUsage(userKey) {
  const day = getDailyBucketUtc();
  const now = Date.now();
  const existing = dailyMediaUsage.get(userKey);
  if (!existing || existing.day !== day) {
    const fresh = { day, usedMs: 0, lastSeen: now };
    dailyMediaUsage.set(userKey, fresh);
    return fresh;
  }
  existing.lastSeen = now;
  dailyMediaUsage.set(userKey, existing);
  return existing;
}

function getDailyMediaUsage(userKey) {
  if (!Number.isFinite(DAILY_MEDIA_QUOTA_SECONDS) || DAILY_MEDIA_QUOTA_SECONDS <= 0) {
    return {
      enabled: false,
      limitMs: 0,
      usedMs: 0,
      remainingMs: Number.POSITIVE_INFINITY,
    };
  }

  const limitMs = DAILY_MEDIA_QUOTA_SECONDS * 1000;
  const usage = getOrInitDailyMediaUsage(userKey);
  return {
    enabled: true,
    limitMs,
    usedMs: usage.usedMs,
    remainingMs: Math.max(0, limitMs - usage.usedMs),
  };
}

function consumeDailyMediaMs(userKey, addMs) {
  const quota = getDailyMediaUsage(userKey);
  const incrementMs = Math.max(0, Math.floor(Number.isFinite(addMs) ? addMs : 0));
  if (!quota.enabled) {
    return {
      allowed: true,
      limitMs: 0,
      usedMs: incrementMs,
      remainingMs: Number.POSITIVE_INFINITY,
      addedMs: incrementMs,
    };
  }

  const usage = getOrInitDailyMediaUsage(userKey);
  if (usage.usedMs + incrementMs > quota.limitMs) {
    return {
      allowed: false,
      limitMs: quota.limitMs,
      usedMs: usage.usedMs,
      remainingMs: Math.max(0, quota.limitMs - usage.usedMs),
      addedMs: incrementMs,
    };
  }

  usage.usedMs += incrementMs;
  usage.lastSeen = Date.now();
  dailyMediaUsage.set(userKey, usage);
  return {
    allowed: true,
    limitMs: quota.limitMs,
    usedMs: usage.usedMs,
    remainingMs: Math.max(0, quota.limitMs - usage.usedMs),
    addedMs: incrementMs,
  };
}

function formatSecondsForLog(ms) {
  return Math.round(Math.max(0, ms) / 1000);
}

function buildDailyQuotaExceededMessage(limitMs) {
  const limitSeconds = Math.floor(limitMs / 1000);
  const limitHours = (limitSeconds / 3600).toFixed(limitSeconds % 3600 === 0 ? 0 : 2);
  return `Daily media quota exceeded. Max ${limitSeconds}s (${limitHours}h) per user/day (UTC).`;
}

function estimateDurationByBitrateMs(bufferSizeBytes, bitrateBps) {
  if (!Number.isFinite(bufferSizeBytes) || bufferSizeBytes <= 0 || !Number.isFinite(bitrateBps) || bitrateBps <= 0) {
    return 0;
  }
  return Math.round((bufferSizeBytes * 8 * 1000) / bitrateBps);
}

function estimatePcmDurationMs(bufferSizeBytes) {
  if (!Number.isFinite(bufferSizeBytes) || bufferSizeBytes <= 0) return 0;
  return Math.round((bufferSizeBytes * 1000) / PCM_BYTES_PER_SECOND);
}

function estimateWavDurationMs(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 44) {
    return 0;
  }
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    return estimatePcmDurationMs(buffer.length);
  }

  let offset = 12;
  let sampleRate = PCM_SAMPLE_RATE;
  let bitsPerSample = PCM_BITS_PER_SAMPLE;
  let channels = PCM_CHANNELS;
  let dataChunkSize = 0;

  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    const chunkEnd = chunkStart + chunkSize;
    if (chunkEnd > buffer.length) break;

    if (chunkId === 'fmt ' && chunkSize >= 16) {
      channels = buffer.readUInt16LE(chunkStart + 2);
      sampleRate = buffer.readUInt32LE(chunkStart + 4);
      bitsPerSample = buffer.readUInt16LE(chunkStart + 14);
    } else if (chunkId === 'data') {
      dataChunkSize = chunkSize;
      break;
    }

    offset = chunkEnd + (chunkSize % 2);
  }

  if (dataChunkSize <= 0) {
    dataChunkSize = Math.max(0, buffer.length - 44);
  }
  const bytesPerSecond = Math.max(1, (sampleRate * channels * bitsPerSample) / 8);
  return Math.round((dataChunkSize * 1000) / bytesPerSecond);
}

function parseMp3FrameHeader(header) {
  if ((header & 0xffe00000) !== 0xffe00000) return null;

  const versionBits = (header >> 19) & 0x3;
  const layerBits = (header >> 17) & 0x3;
  const bitrateIndex = (header >> 12) & 0xf;
  const sampleRateIndex = (header >> 10) & 0x3;
  const padding = (header >> 9) & 0x1;

  if (versionBits === 1 || layerBits === 0 || bitrateIndex === 0 || bitrateIndex === 0xf || sampleRateIndex === 0x3) {
    return null;
  }

  const version = versionBits === 3 ? '1' : (versionBits === 2 ? '2' : '2.5');
  const layer = layerBits === 3 ? 'I' : (layerBits === 2 ? 'II' : 'III');
  const sampleRateTable = {
    '1': [44_100, 48_000, 32_000],
    '2': [22_050, 24_000, 16_000],
    '2.5': [11_025, 12_000, 8_000],
  };
  const bitrateTable = {
    '1': {
      I: [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448, 0],
      II: [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, 0],
      III: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0],
    },
    '2': {
      I: [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256, 0],
      II: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0],
      III: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0],
    },
    '2.5': {
      I: [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256, 0],
      II: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0],
      III: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0],
    },
  };

  const bitrateKbps = bitrateTable[version]?.[layer]?.[bitrateIndex] || 0;
  const sampleRate = sampleRateTable[version]?.[sampleRateIndex] || 0;
  if (!bitrateKbps || !sampleRate) return null;

  const bitrate = bitrateKbps * 1000;
  const samplesPerFrame = layer === 'I' ? 384 : (layer === 'II' ? 1152 : (version === '1' ? 1152 : 576));
  let frameLength = 0;
  if (layer === 'I') {
    frameLength = Math.floor(((12 * bitrate) / sampleRate + padding) * 4);
  } else {
    const coeff = (layer === 'III' && version !== '1') ? 72 : 144;
    frameLength = Math.floor((coeff * bitrate) / sampleRate + padding);
  }
  if (!Number.isFinite(frameLength) || frameLength <= 0) return null;

  return { frameLength, samplesPerFrame, sampleRate };
}

function estimateMp3DurationMs(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) {
    return 0;
  }

  let offset = 0;
  if (buffer.length >= 10 && buffer.toString('ascii', 0, 3) === 'ID3') {
    const tagSize = ((buffer[6] & 0x7f) << 21) | ((buffer[7] & 0x7f) << 14) | ((buffer[8] & 0x7f) << 7) | (buffer[9] & 0x7f);
    offset = Math.min(buffer.length, 10 + tagSize);
  }

  let parsedFrames = 0;
  let totalDurationMs = 0;
  while (offset + 4 <= buffer.length) {
    const header = buffer.readUInt32BE(offset);
    const info = parseMp3FrameHeader(header);
    if (!info) {
      offset += 1;
      continue;
    }
    if (offset + info.frameLength > buffer.length) break;
    totalDurationMs += (info.samplesPerFrame * 1000) / info.sampleRate;
    parsedFrames += 1;
    offset += info.frameLength;
  }

  if (parsedFrames >= 3 && totalDurationMs > 0) {
    return Math.round(totalDurationMs);
  }
  return estimateDurationByBitrateMs(buffer.length, FALLBACK_MP3_BITRATE_BPS);
}

function estimateOggOpusDurationMs(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 27) return null;

  let offset = 0;
  let lastGranule = 0n;
  let foundPage = false;

  while (offset + 27 <= buffer.length) {
    if (buffer.toString('ascii', offset, offset + 4) !== 'OggS') {
      offset += 1;
      continue;
    }
    foundPage = true;
    const pageSegments = buffer[offset + 26];
    const segmentTableStart = offset + 27;
    if (segmentTableStart + pageSegments > buffer.length) break;
    let payloadSize = 0;
    for (let i = 0; i < pageSegments; i += 1) {
      payloadSize += buffer[segmentTableStart + i];
    }
    const pageSize = 27 + pageSegments + payloadSize;
    if (offset + pageSize > buffer.length) break;

    const granule = buffer.readBigUInt64LE(offset + 6);
    if (granule > lastGranule) lastGranule = granule;
    offset += pageSize;
  }

  if (!foundPage || lastGranule <= 0n) return null;
  return Math.round((Number(lastGranule) * 1000) / 48_000);
}

function estimateAudioDurationMsFromBuffer(buffer, format) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return 0;
  const normalized = (format || '').toLowerCase();

  if (normalized === 'pcm' || normalized === 'raw' || normalized === 's16le') {
    return estimatePcmDurationMs(buffer.length);
  }
  if (normalized === 'wav') {
    return estimateWavDurationMs(buffer);
  }
  if (normalized === 'mp3') {
    return estimateMp3DurationMs(buffer);
  }
  if (normalized === 'ogg' || normalized === 'webm' || normalized === 'opus') {
    return estimateOggOpusDurationMs(buffer) || estimateDurationByBitrateMs(buffer.length, FALLBACK_OGG_OPUS_BITRATE_BPS);
  }
  return estimateDurationByBitrateMs(buffer.length, FALLBACK_MP3_BITRATE_BPS);
}

function estimateAudioDurationMsFromBase64(audioBase64, format) {
  if (typeof audioBase64 !== 'string' || audioBase64.length === 0) return 0;
  try {
    const buffer = Buffer.from(audioBase64, 'base64');
    return estimateAudioDurationMsFromBuffer(buffer, format);
  } catch {
    return 0;
  }
}

function estimateStreamChunkDurationMs(chunk, streamFormat) {
  if (!Buffer.isBuffer(chunk) || chunk.length === 0) return 0;
  const normalized = (streamFormat || '').toLowerCase();
  if (normalized === 'pcm' || normalized === 'raw' || normalized === 's16le' || normalized === 'wav') {
    return estimatePcmDurationMs(chunk.length);
  }
  if (normalized === 'ogg' || normalized === 'webm' || normalized === 'opus') {
    return estimateDurationByBitrateMs(chunk.length, FALLBACK_OGG_OPUS_BITRATE_BPS);
  }
  return estimateDurationByBitrateMs(chunk.length, FALLBACK_MP3_BITRATE_BPS);
}

// Cleanup stale entries every 5 min
setInterval(() => {
  const now = Date.now();
  for (const [ip, timestamps] of rateLimits.entries()) {
    const fresh = timestamps.filter((t) => now - t < 60_000);
    if (fresh.length === 0) rateLimits.delete(ip);
    else rateLimits.set(ip, fresh);
  }

  // Drop prior-day and stale user buckets.
  const currentDay = getDailyBucketUtc();
  for (const [userKey, usage] of dailyMediaUsage.entries()) {
    if (usage.day !== currentDay || now - usage.lastSeen > 3 * 24 * 60 * 60 * 1000) {
      dailyMediaUsage.delete(userKey);
    }
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

  const ip = getClientIp(req);
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

  const daily = getDailyMediaUsage(ip);
  if (daily.enabled && daily.remainingMs <= 0) {
    socket.write(createHttpErrorResponse(429, buildDailyQuotaExceededMessage(daily.limitMs)));
    socket.destroy();
    return;
  }

  asrStreamWss.handleUpgrade(req, socket, head, (ws) => {
    asrStreamWss.emit('connection', ws, req);
  });
}

function handleAsrStreamSession(client, req) {
  const ip = getClientIp(req);
  const upstream = new WS(VOLC_ASR_WS_URL, {
    skipUTF8Validation: true,
    headers: createVolcAsrHeaders(),
  });

  let done = false;
  let started = false;
  let startReceived = false;
  let endedByClient = false;
  let configSent = false;
  let finalSentToUpstream = false;
  let language = 'zh-CN';
  let format = 'pcm';
  let accumulatedText = '';
  let streamInputMs = 0;
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
    console.log(`[ASR/STREAM] ${ip} in=${formatSecondsForLog(streamInputMs)}s result="${(text || '').slice(0, 30)}"`);
  };

  const sendConfigIfReady = () => {
    if (configSent || upstream.readyState !== WS.OPEN || !startReceived) return;
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
    if (!startReceived) startReceived = true;

    const chunkDurationMs = estimateStreamChunkDurationMs(chunk, format);
    const quota = consumeDailyMediaMs(ip, chunkDurationMs);
    if (!quota.allowed) {
      finishError(buildDailyQuotaExceededMessage(quota.limitMs));
      return;
    }
    streamInputMs += quota.addedMs;

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
      startReceived = true;
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
      if (!startReceived) startReceived = true;
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

  const ip = getClientIp(req);
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

      const dailyBeforeTts = getDailyMediaUsage(ip);
      if (dailyBeforeTts.enabled && dailyBeforeTts.remainingMs <= 0) {
        sendJson(res, 429, { error: buildDailyQuotaExceededMessage(dailyBeforeTts.limitMs) });
        return;
      }

      const audioData = await volcTts(text, voiceType || undefined, speed);
      const outputMs = estimateAudioDurationMsFromBase64(audioData, 'mp3');
      const ttsQuota = consumeDailyMediaMs(ip, outputMs);
      if (!ttsQuota.allowed) {
        sendJson(res, 429, { error: buildDailyQuotaExceededMessage(ttsQuota.limitMs) });
        return;
      }

      sendJson(res, 200, { data: audioData });
      console.log(`[TTS] ${ip} text=${text.length} out=${formatSecondsForLog(outputMs)}s voice=${voiceType || 'default'}`);
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

      const inputMs = estimateAudioDurationMsFromBase64(audio, format);
      const asrQuota = consumeDailyMediaMs(ip, inputMs);
      if (!asrQuota.allowed) {
        sendJson(res, 429, { error: buildDailyQuotaExceededMessage(asrQuota.limitMs) });
        return;
      }

      const text = await volcAsr(audio, format, language);
      sendJson(res, 200, { text });
      console.log(`[ASR] ${ip} in=${formatSecondsForLog(inputMs)}s result="${text.slice(0, 30)}"`);
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
  console.log(`[EchoCoding Proxy] Daily media quota: ${DAILY_MEDIA_QUOTA_SECONDS > 0 ? DAILY_MEDIA_QUOTA_SECONDS + ' seconds/user/day (UTC)' : 'disabled'}`);
  console.log(`[EchoCoding Proxy] Volcengine App ID: ${VOLC_APP_ID}`);
  console.log(`[EchoCoding Proxy] HMAC keys loaded: ${SIGNING_KEYS.length} (legacy enabled: ${SIGNING_KEY_LEGACY ? 'yes' : 'no'})`);
});
