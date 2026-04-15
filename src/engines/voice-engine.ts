import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { getConfig } from '../config.js';
import { shouldThrottle, recordUsage } from '../throttle.js';
import { playAudioFileAsync } from './sfx-engine.js';
import { signRequest } from '../auth.js';
import { clearTtsPlaybackReference, registerTtsPlaybackReference } from './echo-guard.js';

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
const TTS_WARMUP_INTERVAL_MS = 3_000;
const TTS_WARMUP_SILENCE_MS = 90;
const ECHO_DECODE_TIMEOUT_MS = 1_200;

// Singleton TTS instance (reused across calls)
let ttsInstance: InstanceType<typeof import('sherpa-onnx-node').OfflineTts> | null = null;
let ttsPlaybackQueue: Promise<void> = Promise.resolve();
let ttsWarmupFilePath: string | null = null;
let lastTtsWarmupAt = 0;

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

async function enqueueTtsPlayback(task: () => Promise<void>): Promise<void> {
  const run = ttsPlaybackQueue.catch(() => { /* keep queue healthy */ }).then(task);
  ttsPlaybackQueue = run.catch(() => { /* keep queue healthy */ });
  return run;
}

function getOrCreateTtsWarmupFile(): string {
  if (ttsWarmupFilePath && fs.existsSync(ttsWarmupFilePath)) {
    return ttsWarmupFilePath;
  }

  fs.mkdirSync(TEMP_DIR, { recursive: true });
  const filePath = path.join(TEMP_DIR, 'tts-warmup-silence.wav');
  const sampleRate = 16_000;
  const channels = 1;
  const bitsPerSample = 16;
  const sampleCount = Math.max(1, Math.floor((sampleRate * TTS_WARMUP_SILENCE_MS) / 1000));
  const pcm = Buffer.alloc(sampleCount * 2, 0);

  const blockAlign = channels * (bitsPerSample / 8);
  const byteRate = sampleRate * blockAlign;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);

  fs.writeFileSync(filePath, Buffer.concat([header, pcm]));
  ttsWarmupFilePath = filePath;
  return filePath;
}

async function warmupAudioOutputIfNeeded(): Promise<void> {
  if (os.platform() !== 'darwin') return;
  const now = Date.now();
  if ((now - lastTtsWarmupAt) < TTS_WARMUP_INTERVAL_MS) return;
  lastTtsWarmupAt = now;

  try {
    const warmupFile = getOrCreateTtsWarmupFile();
    await playAudioFileAsync(warmupFile, 0);
  } catch {
    // Warmup failures should never block TTS.
  }
}

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clampPercent(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(100, Math.round(value as number)));
}

function getTtsPlaybackVolumePercent(config: ReturnType<typeof getConfig>): number {
  const masterVolume = clampPercent(config.volume, 70);
  const ttsVolume = clampPercent(config.tts.volume, 100);
  return Math.round((masterVolume / 100) * (ttsVolume / 100) * 100);
}

function applyVolumeBoost(basePercent: number, boost?: number): number {
  if (!Number.isFinite(boost)) return basePercent;
  const factor = Math.max(0.5, Math.min(2.2, boost as number));
  return Math.max(0, Math.min(220, Math.round(basePercent * factor)));
}

function float32ToInt16Pcm(samples: Float32Array): Int16Array {
  const pcm = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const x = Math.max(-1, Math.min(1, samples[i] || 0));
    pcm[i] = x < 0 ? Math.round(x * 32768) : Math.round(x * 32767);
  }
  return pcm;
}

async function decodeCompressedToPcm16kMono(
  audioBuffer: Buffer,
  inputFormat: 'mp3' | 'wav' | 'aiff' = 'mp3',
): Promise<Int16Array | null> {
  return new Promise((resolve) => {
    const args = [
      '-hide_banner',
      '-loglevel', 'error',
      '-f', inputFormat,
      '-i', 'pipe:0',
      '-f', 's16le',
      '-ac', '1',
      '-ar', '16000',
      'pipe:1',
    ];

    const ffmpeg = spawn('ffmpeg', args, {
      stdio: ['pipe', 'pipe', 'ignore'],
    });

    const chunks: Buffer[] = [];
    let settled = false;

    const finish = (pcm: Int16Array | null) => {
      if (settled) return;
      settled = true;
      resolve(pcm);
    };

    ffmpeg.stdout?.on('data', (chunk: Buffer) => {
      if (chunk.length > 0) chunks.push(Buffer.from(chunk));
    });

    ffmpeg.on('error', () => finish(null));
    ffmpeg.on('close', (code) => {
      if (code !== 0) {
        finish(null);
        return;
      }
      const raw = Buffer.concat(chunks);
      if (raw.length < 2) {
        finish(null);
        return;
      }
      const samples = Math.floor(raw.length / 2);
      const pcm = new Int16Array(samples);
      for (let i = 0; i < samples; i++) {
        pcm[i] = raw.readInt16LE(i * 2);
      }
      finish(pcm);
    });

    try {
      ffmpeg.stdin?.end(audioBuffer);
    } catch {
      finish(null);
    }
  });
}

async function decodeAudioFileToPcm16kMono(filePath: string): Promise<Int16Array | null> {
  return new Promise((resolve) => {
    const args = [
      '-hide_banner',
      '-loglevel', 'error',
      '-i', filePath,
      '-f', 's16le',
      '-ac', '1',
      '-ar', '16000',
      'pipe:1',
    ];

    const ffmpeg = spawn('ffmpeg', args, {
      stdio: ['ignore', 'pipe', 'ignore'],
    });

    const chunks: Buffer[] = [];
    let settled = false;

    const finish = (pcm: Int16Array | null) => {
      if (settled) return;
      settled = true;
      resolve(pcm);
    };

    ffmpeg.stdout?.on('data', (chunk: Buffer) => {
      if (chunk.length > 0) chunks.push(Buffer.from(chunk));
    });

    ffmpeg.on('error', () => finish(null));
    ffmpeg.on('close', (code) => {
      if (code !== 0) {
        finish(null);
        return;
      }
      const raw = Buffer.concat(chunks);
      if (raw.length < 2) {
        finish(null);
        return;
      }
      const sampleCount = Math.floor(raw.length / 2);
      const pcm = new Int16Array(sampleCount);
      for (let i = 0; i < sampleCount; i++) {
        pcm[i] = raw.readInt16LE(i * 2);
      }
      finish(pcm);
    });
  });
}

interface SpeakOptions {
  force?: boolean;
  onPlaybackStart?: () => void;
  volumeBoost?: number;
}

// --- Public API ---

export async function speak(text: string, options: SpeakOptions = {}): Promise<void> {
  const config = getConfig();

  if (!config.tts.enabled || config.mode === 'mute' || config.mode === 'sfx-only') {
    return;
  }

  if (!options.force) {
    if (shouldThrottle('tts', text, {
      minInterval: config.tts.throttle.minInterval,
      dedupWindow: config.tts.throttle.dedupWindow,
    })) {
      return;
    }
  }

  recordUsage('tts', text);

  await enqueueTtsPlayback(async () => {
    try {
      if (config.tts.provider === 'local') {
        await speakLocal(text, options);
      } else {
        await speakCloud(text, options);
      }
    } catch (err) {
      // All providers failed, try system fallback
      try {
        await speakSystemFallback(stripEmotionTags(text), options.onPlaybackStart, options.volumeBoost);
      } catch { /* truly silent failure */ }
    }
  });
}

// --- Local TTS via sherpa-onnx-node ---

async function speakLocal(text: string, options: SpeakOptions = {}): Promise<void> {
  const config = getConfig();
  const engine = config.tts.engine;

  // Kokoro via sherpa-onnx-node (no emotion tags)
  if (engine === 'kokoro') {
    const cleanText = stripEmotionTags(text);
    await speakViaSherpa(cleanText, options.onPlaybackStart, options.volumeBoost);
    return;
  }

  // Orpheus: currently no sherpa-onnx integration, use system fallback
  // TODO: integrate Orpheus via llama.cpp or native addon when available
  if (engine === 'orpheus') {
    // Try Kokoro as fallback for now, strip emotion tags
    try {
      await speakViaSherpa(stripEmotionTags(text), options.onPlaybackStart, options.volumeBoost);
      return;
    } catch { /* fall through */ }
  }

  // System TTS fallback
  await speakSystemFallback(stripEmotionTags(text), options.onPlaybackStart, options.volumeBoost);
}

async function speakViaSherpa(
  text: string,
  onPlaybackStart?: () => void,
  volumeBoost?: number,
): Promise<void> {
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
  const echoPcm = float32ToInt16Pcm(audio.samples);

  const vol = applyVolumeBoost(getTtsPlaybackVolumePercent(config), volumeBoost);
  await warmupAudioOutputIfNeeded();
  const playbackStartAt = Date.now();
  registerTtsPlaybackReference(echoPcm, audio.sampleRate, playbackStartAt);
  onPlaybackStart?.();
  await playAudioFileAsync(tempFile, vol);

  // Cleanup after playback
  setTimeout(() => {
    try { fs.unlinkSync(tempFile); } catch { /* ignore */ }
  }, 5_000);
}

// --- Cloud TTS (Volcengine via proxy) ---

/**
 * Cloud TTS flow:
 * 1. Client → api.echoclaw.com/v1/tts (our proxy, no key needed)
 * 2. Proxy  → openspeech.bytedance.com/api/v1/tts (Volcengine, key on server)
 *
 * If user has their own Volcengine key, they can configure it to call direct.
 */
async function speakCloud(text: string, options: SpeakOptions = {}): Promise<void> {
  const config = getConfig();
  const { endpoint, apiKey } = config.tts.cloud;

  if (!endpoint) {
    throw new Error('Cloud TTS endpoint not configured');
  }

  fs.mkdirSync(TEMP_DIR, { recursive: true });
  const tempFile = path.join(TEMP_DIR, `tts-${Date.now()}.mp3`);
  const { cleanText, emotion } = extractEmotion(text);

  // Detect if endpoint is Volcengine direct or our proxy
  const isVolcDirect = endpoint.includes('openspeech.bytedance.com');

  let audioBuffer: Buffer;

  if (isVolcDirect) {
    // Direct Volcengine API call (user has own key)
    audioBuffer = await callVolcengineTts(cleanText, config, apiKey, emotion);
  } else {
    // Our proxy (api.echoclaw.com) — simplified request, proxy adds key
    audioBuffer = await callProxyTts(cleanText, config, endpoint, emotion);
  }
  const echoDecodePromise = decodeCompressedToPcm16kMono(audioBuffer, 'mp3').catch(() => null);
  const eagerEchoPcm = await Promise.race<Int16Array | null>([
    echoDecodePromise,
    waitMs(ECHO_DECODE_TIMEOUT_MS).then(() => null),
  ]);

  fs.writeFileSync(tempFile, audioBuffer);
  const vol = applyVolumeBoost(getTtsPlaybackVolumePercent(config), options.volumeBoost);
  await warmupAudioOutputIfNeeded();
  const playbackStartAt = Date.now();
  if (eagerEchoPcm) {
    registerTtsPlaybackReference(eagerEchoPcm, 16_000, playbackStartAt);
  } else {
    void echoDecodePromise.then((pcm) => {
      if (!pcm) return;
      registerTtsPlaybackReference(pcm, 16_000, playbackStartAt);
    }).catch(() => { /* ignore echo reference decode failure */ });
  }
  options.onPlaybackStart?.();
  await playAudioFileAsync(tempFile, vol);

  setTimeout(() => {
    try { fs.unlinkSync(tempFile); } catch { /* ignore */ }
  }, 5_000);
}

/**
 * Call Volcengine TTS API directly (user has own API key).
 */
async function callVolcengineTts(
  text: string,
  config: ReturnType<typeof getConfig>,
  apiKey: string,
  emotion?: string | null,
): Promise<Buffer> {
  const reqid = crypto.randomUUID();
  const voiceType = resolveVolcVoice(config.tts.voice, text);

  const audioParams: Record<string, unknown> = {
    voice_type: voiceType,
    encoding: 'mp3',
    speed_ratio: config.tts.speed,
    volume_ratio: 1.0,
    pitch_ratio: 1.0,
  };

  // Pass emotion for multi-emotion voices (those with _emo_ in voice_type)
  if (emotion && voiceType.includes('_emo_')) {
    audioParams.emotion = emotion;
  }

  const body = JSON.stringify({
    app: {
      appid: config.tts.cloud.appId || '',
      token: apiKey,
      cluster: 'volcano_tts',
    },
    user: { uid: 'echocoding' },
    audio: audioParams,
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
      'Authorization': `Bearer;${apiKey}`,
    },
    body,
  });

  if (!response.ok) {
    throw new Error(`Volcengine TTS error: ${response.status}`);
  }

  const result = await response.json() as { code?: number; data?: string; message?: string };

  if (result.code !== 3000 || !result.data) {
    throw new Error(`Volcengine TTS failed: ${result.message || result.code}`);
  }

  // Response data is base64-encoded audio
  return Buffer.from(result.data, 'base64');
}

/**
 * Call our proxy (api.echoclaw.com/v1/tts).
 * Proxy holds the Volcengine key — client just sends text + voice preference.
 */
async function callProxyTts(
  text: string,
  config: ReturnType<typeof getConfig>,
  endpoint: string,
  emotion?: string | null,
): Promise<Buffer> {
  const voiceType = resolveVolcVoice(config.tts.voice, text);
  const payload: Record<string, unknown> = {
    text,
    voice_type: voiceType,
    speed: config.tts.speed,
    encoding: 'mp3',
  };
  if (emotion) {
    payload.emotion = emotion;
  }
  const bodyStr = JSON.stringify(payload);
  const authHeaders = signRequest(bodyStr, 'POST', '/v1/tts');

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders },
    body: bodyStr,
  });

  if (!response.ok) {
    throw new Error(`Proxy TTS error: ${response.status}`);
  }

  const result = await response.json() as { data?: string; audio?: string; error?: string };

  if (result.error) {
    throw new Error(`Proxy TTS: ${result.error}`);
  }

  // Proxy returns base64-encoded audio in data or audio field
  const audioData = result.data || result.audio;
  if (!audioData) {
    throw new Error('Proxy TTS: no audio data in response');
  }

  return Buffer.from(audioData, 'base64');
}

/**
 * Map EchoCoding voice config to Volcengine voice_type.
 * Volcengine has many voices — map our presets to their IDs.
 */
function resolveVolcVoice(voice: string, text: string): string {
  // If voice looks like a Volcengine voice_type ID (BVxxx_streaming or old format), use directly
  if (voice.startsWith('BV') || voice.startsWith('BR') || (voice.includes('_') && voice.length > 10)) {
    return voice;
  }

  // Map our presets to Volcengine voices
  const isChinese = containsChinese(text);

  const VOLC_VOICES: Record<string, string> = {
    'zh-female': 'BV700_streaming',     // 灿灿
    'zh-male': 'BV701_streaming',       // 擎苍
    'en-female': 'BV001_streaming',     // 通用女声 (supports English)
    'en-male': 'BV002_streaming',       // 通用男声
    'default': isChinese ? 'BV700_streaming' : 'BV001_streaming',
  };

  return VOLC_VOICES[voice] || VOLC_VOICES['default'];
}

// --- System Fallback ---

async function speakSystemFallback(
  text: string,
  onPlaybackStart?: () => void,
  volumeBoost?: number,
): Promise<void> {
  const platform = os.platform();
  const config = getConfig();
  clearTtsPlaybackReference();

  if (platform === 'darwin') {
    const rate = Math.round(180 * config.tts.speed);
    fs.mkdirSync(TEMP_DIR, { recursive: true });
    const tempFile = path.join(
      TEMP_DIR,
      `tts-system-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}.aiff`,
    );

    const rendered = await new Promise<boolean>((resolve) => {
      const child = spawn('say', ['-r', String(rate), '-o', tempFile, text], {
        stdio: 'ignore',
      });
      child.on('error', () => resolve(false));
      child.on('close', (code) => resolve(code === 0));
    });

    if (rendered && fs.existsSync(tempFile)) {
      const echoDecodePromise = decodeAudioFileToPcm16kMono(tempFile).catch(() => null);
      const eagerEchoPcm = await Promise.race<Int16Array | null>([
        echoDecodePromise,
        waitMs(ECHO_DECODE_TIMEOUT_MS).then(() => null),
      ]);

      const vol = applyVolumeBoost(getTtsPlaybackVolumePercent(config), volumeBoost);
      await warmupAudioOutputIfNeeded();
      const playbackStartAt = Date.now();
      if (eagerEchoPcm) {
        registerTtsPlaybackReference(eagerEchoPcm, 16_000, playbackStartAt);
      } else {
        void echoDecodePromise.then((pcm) => {
          if (!pcm) return;
          registerTtsPlaybackReference(pcm, 16_000, playbackStartAt);
        }).catch(() => { /* ignore echo reference decode failure */ });
      }
      onPlaybackStart?.();
      await playAudioFileAsync(tempFile, vol);
      setTimeout(() => {
        try { fs.unlinkSync(tempFile); } catch { /* ignore */ }
      }, 5_000);
      return;
    }

    await warmupAudioOutputIfNeeded();
    onPlaybackStart?.();
    await new Promise<void>((resolve) => {
      const child = spawn('say', ['-r', String(rate), text], {
        stdio: 'ignore',
      });
      child.on('error', () => resolve());
      child.on('close', () => resolve());
    });
  } else if (platform === 'linux') {
    onPlaybackStart?.();
    await new Promise<void>((resolve) => {
      const child = spawn('espeak', [text], {
        stdio: 'ignore',
      });
      child.on('error', () => resolve());
      child.on('close', () => resolve());
    });
  }
}

// --- Helpers ---

function stripEmotionTags(text: string): string {
  return text.replace(/<(laugh|chuckle|sigh|gasp|cough|yawn|groan|sniffle)>/gi, '').replace(/\s+/g, ' ').trim();
}

// --- Emotion extraction for cloud TTS ---

const EMOTION_MAP: Record<string, string> = {
  laugh: 'happy',
  chuckle: 'happy',
  sigh: 'sad',
  groan: 'sad',
  gasp: 'surprised',
};

/**
 * Extract the first emotion tag from text and map it to a Volcengine emotion value.
 * Returns the cleaned text and the mapped emotion (or null if no mapping).
 */
function extractEmotion(text: string): { cleanText: string; emotion: string | null } {
  const match = text.match(/<(laugh|chuckle|sigh|gasp|cough|yawn|groan|sniffle)>/i);
  const cleanText = stripEmotionTags(text);
  if (!match) return { cleanText, emotion: null };
  const tag = match[1].toLowerCase();
  return { cleanText, emotion: EMOTION_MAP[tag] ?? null };
}

export function cleanupTempFiles(): void {
  try {
    if (fs.existsSync(TEMP_DIR)) {
      for (const file of fs.readdirSync(TEMP_DIR)) {
        fs.unlinkSync(path.join(TEMP_DIR, file));
      }
    }
  } catch { /* ignore */ }
  ttsWarmupFilePath = null;
  clearTtsPlaybackReference();
}

export function disposeTts(): void {
  ttsInstance = null;
  ttsPlaybackQueue = Promise.resolve();
  ttsWarmupFilePath = null;
  lastTtsWarmupAt = 0;
  clearTtsPlaybackReference();
}
