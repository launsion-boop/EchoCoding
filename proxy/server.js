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
import crypto from 'node:crypto';

// --- Config from env ---
const VOLC_APP_ID = process.env.VOLC_APP_ID || '';
const VOLC_ACCESS_TOKEN = process.env.VOLC_ACCESS_TOKEN || '';
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

// --- Volcengine ASR ---
async function volcAsr(audioBase64, format, language) {
  const reqid = crypto.randomUUID();

  const body = JSON.stringify({
    app: {
      appid: VOLC_APP_ID,
      token: VOLC_ACCESS_TOKEN,
      cluster: 'volcengine_streaming_common',
    },
    user: { uid: 'echocoding-proxy' },
    audio: {
      format: format || 'wav',
      rate: 16000,
      bits: 16,
      channel: 1,
      language: language || 'zh-CN',
    },
    request: {
      reqid,
      sequence: -1,
      nbest: 1,
      text: audioBase64,
    },
  });

  const response = await fetch('https://openspeech.bytedance.com/api/v2/asr', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer;${VOLC_ACCESS_TOKEN}`,
    },
    body,
  });

  if (!response.ok) {
    throw new Error(`Volcengine ASR HTTP ${response.status}`);
  }

  const result = await response.json();

  if (result.code !== 1000 || !result.result?.[0]?.text) {
    throw new Error(`Volcengine ASR: ${result.message || `code ${result.code}`}`);
  }

  return result.result[0].text.trim();
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
    // TTS endpoint
    if (url === '/v1/tts' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));

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
      const body = JSON.parse(await readBody(req));

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
