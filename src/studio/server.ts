/**
 * EchoCoding Studio — lightweight localhost web server for voice preview & config.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { exec } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getConfig, saveConfig, setConfigValue, getConfigValue } from '../config.js';
import { isDaemonRunning } from '../daemon/server.js';
import { checkModels, downloadModels, hasEssentialModels } from '../downloader.js';
import { getSoundsDir, getPackageRoot } from '../config.js';
import { signRequest } from '../auth.js';
import { createRequire } from 'node:module';

const _require = createRequire(import.meta.url);

const TEMP_DIR = path.join(os.tmpdir(), 'echocoding-studio');
const STUDIO_PREVIEW_TEXT = {
  zh: '你好，我是你的编程助手，很高兴认识你',
  en: "Hello, I'm your coding assistant. Nice to meet you.",
} as const;

// Lazy-loaded sherpa-onnx
let sherpa: typeof import('sherpa-onnx-node') | null = null;
let ttsInstance: InstanceType<typeof import('sherpa-onnx-node').OfflineTts> | null = null;

function getSherpa(): typeof import('sherpa-onnx-node') | null {
  if (!sherpa) {
    try {
      sherpa = _require('sherpa-onnx-node') as typeof import('sherpa-onnx-node');
    } catch {
      sherpa = null;
    }
  }
  return sherpa;
}

function getTtsInstance(): InstanceType<typeof import('sherpa-onnx-node').OfflineTts> | null {
  if (ttsInstance) return ttsInstance;

  const s = getSherpa();
  if (!s) return null;

  const config = getConfig();
  const modelsDir = config.tts.local.modelsDir;
  const kokoroDir = path.join(modelsDir, config.tts.local.kokoroModel);
  const modelFile = path.join(kokoroDir, 'model.onnx');

  if (!fs.existsSync(modelFile)) return null;

  ttsInstance = new s.OfflineTts({
    model: {
      kokoro: {
        model: modelFile,
        voices: path.join(kokoroDir, 'voices.bin'),
        tokens: path.join(kokoroDir, 'tokens.txt'),
        dataDir: path.join(kokoroDir, 'espeak-ng-data'),
        dictDir: path.join(kokoroDir, 'dict'),
        lexicon: [
          path.join(kokoroDir, 'lexicon-us-en.txt'),
          path.join(kokoroDir, 'lexicon-zh.txt'),
        ].join(','),
        lengthScale: 1.0,
      },
    },
    maxNumSentences: 1,
    numThreads: 2,
  });

  return ttsInstance;
}

// --- Speaker metadata ---

interface SpeakerInfo {
  sid: number;
  lang: 'zh' | 'en';
  gender: 'female' | 'male';
  label: string;
  recommended?: boolean;
}

interface CloudVoiceInfo {
  id: string;
  label: string;
  lang: 'zh' | 'en';
  gender: 'female' | 'male';
  recommended?: boolean;
}

const STUDIO_CLOUD_VOICES: CloudVoiceInfo[] = [
  // Legacy BigTTS voices commonly used in EchoCoding configs.
  { id: 'zh_female_wanwanxiaohe_moon_bigtts', label: '湾湾小何', lang: 'zh', gender: 'female', recommended: true },
  { id: 'zh_female_shuangkuaisisi_moon_bigtts', label: '双快思思', lang: 'zh', gender: 'female' },

  // Chinese Female — Streaming
  { id: 'BV700_streaming', label: '灿灿', lang: 'zh', gender: 'female', recommended: true },
  { id: 'BV406_streaming', label: '梓梓', lang: 'zh', gender: 'female' },
  { id: 'BV405_streaming', label: '甜美小源', lang: 'zh', gender: 'female', recommended: true },
  { id: 'BV007_streaming', label: '亲切女声', lang: 'zh', gender: 'female' },
  { id: 'BV009_streaming', label: '知性女声', lang: 'zh', gender: 'female' },
  { id: 'BV104_streaming', label: '温柔淑女', lang: 'zh', gender: 'female' },
  { id: 'BV428_streaming', label: '清新文艺女声', lang: 'zh', gender: 'female' },
  { id: 'BV005_streaming', label: '活泼女声', lang: 'zh', gender: 'female' },

  // Chinese Male — Streaming
  { id: 'BV701_streaming', label: '擎苍', lang: 'zh', gender: 'male', recommended: true },
  { id: 'BV407_streaming', label: '燃燃', lang: 'zh', gender: 'male' },
  { id: 'BV705_streaming', label: '炀炀', lang: 'zh', gender: 'male' },
  { id: 'BV008_streaming', label: '亲切男声', lang: 'zh', gender: 'male', recommended: true },
  { id: 'BV123_streaming', label: '阳光青年', lang: 'zh', gender: 'male' },
  { id: 'BV004_streaming', label: '开朗青年', lang: 'zh', gender: 'male' },
  { id: 'BV102_streaming', label: '儒雅青年', lang: 'zh', gender: 'male' },
  { id: 'BV006_streaming', label: '磁性男声', lang: 'zh', gender: 'male' },

  // English — Streaming
  { id: 'BV001_streaming', label: 'English Female (General)', lang: 'en', gender: 'female', recommended: true },
  { id: 'BV002_streaming', label: 'English Male (General)', lang: 'en', gender: 'male', recommended: true },

  // Special
  { id: 'BV034_streaming', label: '知性姐姐', lang: 'zh', gender: 'female' },
  { id: 'BV033_streaming', label: '温柔小哥', lang: 'zh', gender: 'male' },
];

function inferCloudVoiceLang(voiceId: string): 'zh' | 'en' {
  const lower = voiceId.toLowerCase();
  if (lower.startsWith('en_') || lower.includes('english')) return 'en';
  if (voiceId === 'BV001_streaming' || voiceId === 'BV002_streaming') return 'en';
  return 'zh';
}

function inferCloudVoiceGender(voiceId: string): 'female' | 'male' {
  const lower = voiceId.toLowerCase();
  if (lower.includes('_male_') && !lower.includes('_female_')) return 'male';
  if (voiceId === 'BV002_streaming') return 'male';
  return 'female';
}

function buildCloudVoiceList(currentVoice: string): CloudVoiceInfo[] {
  const voices: CloudVoiceInfo[] = [...STUDIO_CLOUD_VOICES];

  if (currentVoice && !voices.some((v) => v.id === currentVoice)) {
    voices.unshift({
      id: currentVoice,
      label: `当前音色 (${currentVoice})`,
      lang: inferCloudVoiceLang(currentVoice),
      gender: inferCloudVoiceGender(currentVoice),
      recommended: true,
    });
  }

  return voices;
}

function buildSpeakerList(): SpeakerInfo[] {
  const speakers: SpeakerInfo[] = [];

  // English female: sid 0-2
  for (let i = 0; i <= 2; i++) {
    speakers.push({
      sid: i,
      lang: 'en',
      gender: 'female',
      label: `EN Female ${i + 1}`,
      recommended: i === 0,
    });
  }

  // Chinese female: sid 3-57
  const zhFemaleRecommended = [10, 20, 30, 40, 50];
  for (let i = 3; i <= 57; i++) {
    speakers.push({
      sid: i,
      lang: 'zh',
      gender: 'female',
      label: `ZH Female ${i - 2}`,
      recommended: zhFemaleRecommended.includes(i),
    });
  }

  // Chinese male: sid 58-102
  const zhMaleRecommended = [60, 70, 80, 90, 100];
  for (let i = 58; i <= 102; i++) {
    speakers.push({
      sid: i,
      lang: 'zh',
      gender: 'male',
      label: `ZH Male ${i - 57}`,
      recommended: zhMaleRecommended.includes(i),
    });
  }

  return speakers;
}

function normalizeLocale(raw: string): string {
  return raw
    .trim()
    .split(':')[0]
    .split('.')[0]
    .split('@')[0]
    .replace(/_/g, '-')
    .toLowerCase();
}

function detectServerLocale(): string {
  const envLocale = [process.env.LC_ALL, process.env.LC_MESSAGES, process.env.LANG, process.env.LANGUAGE]
    .find((value) => typeof value === 'string' && value.trim().length > 0);
  if (envLocale) return normalizeLocale(envLocale);

  try {
    const locale = Intl.DateTimeFormat().resolvedOptions().locale;
    if (locale) return normalizeLocale(locale);
  } catch {
    // ignore and use fallback below
  }

  return 'en';
}

function getStudioPreviewFallbackText(language: 'zh' | 'en' | 'auto'): string {
  if (language === 'zh') return STUDIO_PREVIEW_TEXT.zh;
  if (language === 'en') return STUDIO_PREVIEW_TEXT.en;
  return detectServerLocale().startsWith('zh')
    ? STUDIO_PREVIEW_TEXT.zh
    : STUDIO_PREVIEW_TEXT.en;
}

// --- HTTP Server ---

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => resolve(body));
  });
}

function jsonResponse(res: http.ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(data));
}

function cors(res: http.ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://localhost`);
  const pathname = url.pathname;

  cors(res);

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Serve HTML page
  if (pathname === '/' && req.method === 'GET') {
    const htmlPath = path.join(getStudioDir(), 'index.html');
    if (fs.existsSync(htmlPath)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(htmlPath, 'utf-8'));
    } else {
      res.writeHead(404);
      res.end('Studio HTML not found');
    }
    return;
  }

  // API: Get config
  if (pathname === '/api/config' && req.method === 'GET') {
    jsonResponse(res, getConfig());
    return;
  }

  // API: Update config
  if (pathname === '/api/config' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req));
    if (body.key && body.value !== undefined) {
      setConfigValue(body.key, String(body.value));
      jsonResponse(res, { ok: true, key: body.key, value: getConfigValue(body.key) });
    } else {
      jsonResponse(res, { error: 'Missing key or value' }, 400);
    }
    return;
  }

  // API: Speaker list
  if (pathname === '/api/speakers' && req.method === 'GET') {
    const config = getConfig();
    const currentVoice = config.tts.voice;
    jsonResponse(res, {
      speakers: buildSpeakerList(),
      currentVoice,
    });
    return;
  }

  // API: TTS preview — generate audio, return WAV
  if (pathname === '/api/preview/tts' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req));
    const config = getConfig();
    const text = body.text || getStudioPreviewFallbackText(config.tts.language);
    const sid = typeof body.sid === 'number' ? body.sid : 30;
    const speed = typeof body.speed === 'number' ? body.speed : 1.0;

    const tts = getTtsInstance();
    if (!tts) {
      jsonResponse(res, { error: 'TTS model not available' }, 503);
      return;
    }

    const s = getSherpa()!;
    const audio = tts.generate({ text, sid, speed });

    if (!audio?.samples?.length) {
      jsonResponse(res, { error: 'TTS generated empty audio' }, 500);
      return;
    }

    // Write WAV to temp file and serve
    fs.mkdirSync(TEMP_DIR, { recursive: true });
    const tempFile = path.join(TEMP_DIR, `preview-${sid}-${Date.now()}.wav`);
    s.writeWave(tempFile, { samples: audio.samples, sampleRate: audio.sampleRate });

    const wavData = fs.readFileSync(tempFile);
    res.writeHead(200, {
      'Content-Type': 'audio/wav',
      'Content-Length': wavData.length,
      'Access-Control-Allow-Origin': '*',
    });
    res.end(wavData);

    // Cleanup
    setTimeout(() => {
      try { fs.unlinkSync(tempFile); } catch { /* ignore */ }
    }, 30_000);
    return;
  }

  // API: SFX preview — serve WAV file
  const sfxMatch = pathname.match(/^\/api\/preview\/sfx\/(.+)$/);
  if (sfxMatch && req.method === 'GET') {
    const name = sfxMatch[1];
    const soundsDir = getSoundsDir();
    const extensions = ['.wav', '.mp3', '.ogg', '.m4a'];
    let filePath = '';

    for (const ext of extensions) {
      const candidate = path.join(soundsDir, `${name}${ext}`);
      if (fs.existsSync(candidate)) {
        filePath = candidate;
        break;
      }
    }

    if (!filePath) {
      jsonResponse(res, { error: `Sound not found: ${name}` }, 404);
      return;
    }

    const data = fs.readFileSync(filePath);
    const ext = path.extname(filePath);
    const mimeMap: Record<string, string> = {
      '.wav': 'audio/wav',
      '.mp3': 'audio/mpeg',
      '.ogg': 'audio/ogg',
      '.m4a': 'audio/mp4',
    };
    res.writeHead(200, {
      'Content-Type': mimeMap[ext] || 'application/octet-stream',
      'Content-Length': data.length,
      'Access-Control-Allow-Origin': '*',
    });
    res.end(data);
    return;
  }

  // API: Status
  if (pathname === '/api/status' && req.method === 'GET') {
    const daemon = isDaemonRunning();
    const models = checkModels();
    jsonResponse(res, { daemon, models });
    return;
  }

  // API: Cloud voices list
  if (pathname === '/api/cloud/voices' && req.method === 'GET') {
    const config = getConfig();
    jsonResponse(res, {
      voices: buildCloudVoiceList(config.tts.voice),
      currentProvider: config.tts.provider,
      currentVoice: config.tts.voice,
    });
    return;
  }

  // API: Cloud TTS preview — proxy to Volcengine
  if (pathname === '/api/preview/cloud-tts' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req));
    const config = getConfig();
    const text = body.text || getStudioPreviewFallbackText(config.tts.language);
    const voiceType = body.voice_type || config.tts.voice || 'zh_female_wanwanxiaohe_moon_bigtts';
    const speed = typeof body.speed === 'number' ? body.speed : 1.0;
    const endpoint = config.tts.cloud.endpoint;

    try {
      const ttsBody = JSON.stringify({ text, voice_type: voiceType, speed, encoding: 'mp3' });
      const ttsAuth = signRequest(ttsBody, 'POST', '/v1/tts');
      const proxyRes = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...ttsAuth },
        body: ttsBody,
      });

      if (!proxyRes.ok) {
        jsonResponse(res, { error: `Cloud TTS error: ${proxyRes.status}` }, 502);
        return;
      }

      const result = await proxyRes.json() as { data?: string; error?: string };
      if (result.error || !result.data) {
        jsonResponse(res, { error: result.error || 'No audio data' }, 502);
        return;
      }

      // Return raw MP3 bytes
      const audioBuffer = Buffer.from(result.data, 'base64');
      res.writeHead(200, {
        'Content-Type': 'audio/mpeg',
        'Content-Length': audioBuffer.length,
        'Access-Control-Allow-Origin': '*',
      });
      res.end(audioBuffer);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      jsonResponse(res, { error: `Cloud TTS unavailable: ${msg}` }, 502);
    }
    return;
  }

  // API: Switch TTS provider
  if (pathname === '/api/provider' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req));
    if (body.provider === 'local' || body.provider === 'cloud') {
      const config = getConfig();
      config.tts.provider = body.provider;
      saveConfig(config);
      jsonResponse(res, { ok: true, provider: body.provider });
    } else {
      jsonResponse(res, { error: 'Invalid provider. Use "local" or "cloud"' }, 400);
    }
    return;
  }

  // API: Set voice (convenience endpoint)
  if (pathname === '/api/voice' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req));
    if (body.sid !== undefined) {
      setConfigValue('tts.voice', String(body.sid));
      // No need to reset TTS instance — sid is passed per-generate call
      jsonResponse(res, { ok: true, voice: body.sid });
    } else {
      jsonResponse(res, { error: 'Missing sid' }, 400);
    }
    return;
  }

  // API: Local model status + download
  if (pathname === '/api/models' && req.method === 'GET') {
    const models = checkModels();
    const hasAll = hasEssentialModels();
    jsonResponse(res, { models, hasAll });
    return;
  }

  if (pathname === '/api/models/download' && req.method === 'POST') {
    // Start download in background, return immediately
    const models = checkModels();
    const missing = models.filter((m) => !m.installed);
    if (missing.length === 0) {
      jsonResponse(res, { ok: true, message: 'All models already installed' });
      return;
    }

    // Run download async — client can poll /api/models for progress
    downloadModels().then(() => {
      console.log('[echocoding] Local models download complete');
    }).catch((err) => {
      console.error('[echocoding] Model download failed:', err);
    });

    jsonResponse(res, { ok: true, message: `Downloading ${missing.length} model(s) in background...` });
    return;
  }

  // API: Browser ASR — receive recorded audio from browser, send to cloud ASR
  if (pathname === '/api/asr' && req.method === 'POST') {
    const config = getConfig();
    const endpoint = config.asr.cloud.endpoint;

    if (!endpoint) {
      jsonResponse(res, { error: 'Cloud ASR endpoint not configured' }, 503);
      return;
    }

    try {
      const rawBody = await readBody(req);
      // Browser sends base64 WAV audio
      const body = JSON.parse(rawBody) as { audio?: string; format?: string };

      if (!body.audio) {
        jsonResponse(res, { error: 'Missing audio data' }, 400);
        return;
      }

      // Forward to cloud ASR proxy
      const asrBody = JSON.stringify({
        audio: body.audio,
        format: body.format || 'wav',
        language: 'zh-CN',
      });
      const asrAuth = signRequest(asrBody, 'POST', '/v1/asr');
      const asrRes = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...asrAuth },
        body: asrBody,
      });

      if (!asrRes.ok) {
        jsonResponse(res, { error: `ASR error: ${asrRes.status}` }, 502);
        return;
      }

      const result = await asrRes.json() as { text?: string; error?: string };
      jsonResponse(res, result);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      jsonResponse(res, { error: `ASR failed: ${msg}` }, 500);
    }
    return;
  }

  // 404
  res.writeHead(404);
  res.end('Not found');
}

function getStudioDir(): string {
  // In compiled form, this file is at dist/src/studio/server.js
  // HTML is at src/studio/index.html (source) — we need to resolve it
  const pkgRoot = getPackageRoot();
  // Try source location first, then dist
  const srcHtml = path.join(pkgRoot, 'src', 'studio', 'index.html');
  if (fs.existsSync(srcHtml)) return path.dirname(srcHtml);
  return path.dirname(fileURLToPath(import.meta.url));
}

async function findAvailablePort(preferred?: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(preferred || 0, () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        const port = addr.port;
        server.close(() => resolve(port));
      } else {
        reject(new Error('Could not determine port'));
      }
    });
    server.on('error', () => {
      // If preferred port is taken, find any available
      if (preferred) {
        const fallback = net.createServer();
        fallback.listen(0, () => {
          const addr = fallback.address();
          if (addr && typeof addr === 'object') {
            const port = addr.port;
            fallback.close(() => resolve(port));
          }
        });
      } else {
        reject(new Error('No port available'));
      }
    });
  });
}

export async function startStudio(preferredPort?: number): Promise<void> {
  // Pre-load TTS model so first preview is instant
  console.log('[echocoding] Loading TTS model...');
  const tts = getTtsInstance();
  if (tts) {
    console.log('[echocoding] TTS model ready.');
  } else {
    console.log('[echocoding] Warning: TTS model not available. Voice preview will be disabled.');
  }

  const port = await findAvailablePort(preferredPort);
  const server = http.createServer(handleRequest);

  server.listen(port, () => {
    const url = `http://localhost:${port}`;
    console.log(`[echocoding] Studio running at ${url}`);
    console.log('[echocoding] Press Ctrl+C to stop');

    // Auto-open browser
    const platform = os.platform();
    if (platform === 'darwin') {
      exec(`open "${url}"`);
    } else if (platform === 'linux') {
      exec(`xdg-open "${url}" 2>/dev/null`);
    } else if (platform === 'win32') {
      exec(`start "${url}"`);
    }
  });

  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log('\n[echocoding] Studio stopped.');
    ttsInstance = null;
    server.close();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    ttsInstance = null;
    server.close();
    process.exit(0);
  });
}
