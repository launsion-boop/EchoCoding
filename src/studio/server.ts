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
import { checkModels } from '../downloader.js';
import { getSoundsDir, getPackageRoot } from '../config.js';
import { createRequire } from 'node:module';

const _require = createRequire(import.meta.url);

const TEMP_DIR = path.join(os.tmpdir(), 'echocoding-studio');

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
    const text = body.text || '你好，我是你的编程助手';
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
