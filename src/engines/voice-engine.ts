import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { getConfig } from '../config.js';
import { shouldThrottle, recordUsage } from '../throttle.js';
import { playAudioFile } from './sfx-engine.js';

// Lazy-loaded sherpa-onnx-node (CJS module)
import { createRequire } from 'node:module';
const _require = createRequire(import.meta.url);

let sherpa: typeof import('sherpa-onnx-node') | null = null;

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

const TEMP_DIR = path.join(os.tmpdir(), 'echocoding-tts');

// Singleton TTS instance (reused across calls)
let ttsInstance: InstanceType<typeof import('sherpa-onnx-node').OfflineTts> | null = null;

// --- Kokoro v1.1-zh speaker ID ranges ---
// sid 0-2:    English female (3 speakers)
// sid 3-57:   Chinese female (55 speakers)
// sid 58-102: Chinese male (45 speakers)
const KOKORO_DEFAULTS = {
  'zh-female': 30,
  'zh-male': 80,
  'en-female': 0,
} as const;

function containsChinese(text: string): boolean {
  return /[\u4e00-\u9fff]/.test(text);
}

function selectKokoroSid(text: string): number {
  const config = getConfig();
  const voice = config.tts.voice;

  // Explicit numeric sid in config
  if (/^\d+$/.test(voice)) {
    return parseInt(voice, 10);
  }

  // Named preset
  if (voice in KOKORO_DEFAULTS) {
    return KOKORO_DEFAULTS[voice as keyof typeof KOKORO_DEFAULTS];
  }

  // Auto-detect: pick speaker based on language config + text content
  const isChinese = config.tts.language === 'zh' ||
    (config.tts.language === 'auto' && containsChinese(text));

  return isChinese ? KOKORO_DEFAULTS['zh-female'] : KOKORO_DEFAULTS['en-female'];
}

// --- Public API ---

export async function speak(text: string): Promise<void> {
  const config = getConfig();

  if (!config.tts.enabled || config.mode === 'mute' || config.mode === 'sfx-only') {
    return;
  }

  if (shouldThrottle('tts', text, {
    minInterval: config.tts.throttle.minInterval,
    dedupWindow: config.tts.throttle.dedupWindow,
  })) {
    return;
  }

  recordUsage('tts', text);

  try {
    if (config.tts.provider === 'local') {
      await speakLocal(text);
    } else {
      await speakCloud(text);
    }
  } catch (err) {
    // All providers failed, try system fallback
    try {
      await speakSystemFallback(stripEmotionTags(text));
    } catch { /* truly silent failure */ }
  }
}

// --- Local TTS via sherpa-onnx-node ---

async function speakLocal(text: string): Promise<void> {
  const config = getConfig();
  const engine = config.tts.engine;

  // Kokoro via sherpa-onnx-node (no emotion tags)
  if (engine === 'kokoro') {
    const cleanText = stripEmotionTags(text);
    await speakViaSherpa(cleanText);
    return;
  }

  // Orpheus: currently no sherpa-onnx integration, use system fallback
  // TODO: integrate Orpheus via llama.cpp or native addon when available
  if (engine === 'orpheus') {
    // Try Kokoro as fallback for now, strip emotion tags
    try {
      await speakViaSherpa(stripEmotionTags(text));
      return;
    } catch { /* fall through */ }
  }

  // System TTS fallback
  await speakSystemFallback(stripEmotionTags(text));
}

async function speakViaSherpa(text: string): Promise<void> {
  const s = getSherpa();
  if (!s) {
    throw new Error('sherpa-onnx-node not available');
  }

  const config = getConfig();
  const modelsDir = config.tts.local.modelsDir;
  const kokoroDir = path.join(modelsDir, config.tts.local.kokoroModel);

  // Check model exists
  const modelFile = path.join(kokoroDir, 'model.onnx');
  if (!fs.existsSync(modelFile)) {
    throw new Error(`Kokoro model not found at ${modelFile}. Run: npx tsx scripts/download-models.ts kokoro-tts`);
  }

  // Create or reuse TTS instance
  if (!ttsInstance) {
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
          lengthScale: 1.0 / config.tts.speed,
        },
      },
      maxNumSentences: 1,
      numThreads: 2,
    });
  }

  // Generate audio — select speaker based on text language
  const sid = selectKokoroSid(text);
  const audio = ttsInstance.generate({
    text,
    sid,
    speed: config.tts.speed,
  });

  if (!audio || !audio.samples || audio.samples.length === 0) {
    throw new Error('TTS generated empty audio');
  }

  // Write WAV and play
  fs.mkdirSync(TEMP_DIR, { recursive: true });
  const tempFile = path.join(TEMP_DIR, `tts-${Date.now()}.wav`);
  s.writeWave(tempFile, { samples: audio.samples, sampleRate: audio.sampleRate });

  const vol = Math.round((config.volume / 100) * 100);
  playAudioFile(tempFile, vol);

  // Cleanup after playback
  setTimeout(() => {
    try { fs.unlinkSync(tempFile); } catch { /* ignore */ }
  }, 30_000);
}

// --- Cloud TTS ---

async function speakCloud(text: string): Promise<void> {
  const config = getConfig();
  const { endpoint, apiKey, stream: useStream } = config.tts.cloud;

  if (!endpoint) {
    throw new Error('Cloud TTS endpoint not configured');
  }

  fs.mkdirSync(TEMP_DIR, { recursive: true });
  const tempFile = path.join(TEMP_DIR, `tts-${Date.now()}.mp3`);

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  const cleanText = stripEmotionTags(text);
  const body = JSON.stringify({
    text: cleanText,
    voice: config.tts.voice,
    speed: config.tts.speed,
    language: config.tts.language,
    stream: useStream,
    format: 'mp3',
  });

  const response = await fetch(endpoint, { method: 'POST', headers, body });

  if (!response.ok || !response.body) {
    throw new Error(`Cloud TTS error: ${response.status}`);
  }

  const fileStream = fs.createWriteStream(tempFile);
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      fileStream.write(Buffer.from(value));
    }
  } finally {
    fileStream.end();
  }
  await new Promise<void>((resolve) => fileStream.on('finish', resolve));

  const vol = Math.round((config.volume / 100) * 100);
  playAudioFile(tempFile, vol);

  setTimeout(() => {
    try { fs.unlinkSync(tempFile); } catch { /* ignore */ }
  }, 30_000);
}

// --- System Fallback ---

async function speakSystemFallback(text: string): Promise<void> {
  const platform = os.platform();
  const config = getConfig();

  if (platform === 'darwin') {
    const rate = Math.round(180 * config.tts.speed);
    const child = spawn('say', ['-r', String(rate), text], {
      stdio: 'ignore',
      detached: true,
    });
    child.unref();
  } else if (platform === 'linux') {
    const child = spawn('espeak', [text], {
      stdio: 'ignore',
      detached: true,
    });
    child.on('error', () => { /* not available */ });
    child.unref();
  }
}

// --- Helpers ---

function stripEmotionTags(text: string): string {
  return text.replace(/<(laugh|chuckle|sigh|gasp|cough|yawn|groan|sniffle)>/gi, '').replace(/\s+/g, ' ').trim();
}

export function cleanupTempFiles(): void {
  try {
    if (fs.existsSync(TEMP_DIR)) {
      for (const file of fs.readdirSync(TEMP_DIR)) {
        fs.unlinkSync(path.join(TEMP_DIR, file));
      }
    }
  } catch { /* ignore */ }
}

export function disposeTts(): void {
  ttsInstance = null;
}
