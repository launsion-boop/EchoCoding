import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { getConfig, getPackageRoot } from '../config.js';
import { playSfx } from './sfx-engine.js';
import { signRequest } from '../auth.js';

const TEMP_DIR = path.join(os.tmpdir(), 'echocoding-asr');

// --- macOS mic-helper ---

function getMicHelperPath(): string | null {
  const candidates = [
    path.join(getPackageRoot(), 'tools', 'mic-helper'),
    path.join(getPackageRoot(), '..', 'tools', 'mic-helper'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

let micAuthorized: boolean | null = null;

function ensureMicAuthorized(): boolean {
  if (micAuthorized === true) return true;
  if (micAuthorized === false) return false;  // Already checked and failed — don't retry
  const helper = getMicHelperPath();
  if (!helper) { micAuthorized = false; return false; }

  try {
    // Quick check — never blocks
    execFileSync(helper, ['check'], { stdio: 'ignore', timeout: 3_000 });
    micAuthorized = true;
    return true;
  } catch {
    // Not authorized — skip mic-helper, fall back to sox.
    // Authorization should be triggered during `echocoding install`, not at recording time.
    micAuthorized = false;
    return false;
  }
}

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

// Singleton ASR + VAD instances
let recognizer: InstanceType<typeof import('sherpa-onnx-node').OfflineRecognizer> | null = null;
let vad: InstanceType<typeof import('sherpa-onnx-node').Vad> | null = null;

// --- Public API ---

/**
 * Record audio from microphone, detect speech via VAD, recognize via ASR.
 * Returns the recognized text, or "[timeout]" if no speech detected.
 */
export async function listen(timeoutSec?: number): Promise<string> {
  const config = getConfig();
  const timeout = timeoutSec ?? config.asr.timeout;

  if (!config.asr.enabled) {
    return '[disabled]';
  }

  if (config.asr.provider === 'cloud') {
    return listenCloud(timeout);
  }

  return listenLocal(timeout);
}

/**
 * Speak a question via TTS, then listen for the answer.
 * Returns the recognized text.
 */
export async function ask(question: string, timeoutSec?: number): Promise<string> {
  // Import speak dynamically to avoid circular deps
  const { speak } = await import('./voice-engine.js');
  await speak(question);

  // Small delay to let TTS finish before opening mic
  await new Promise((r) => setTimeout(r, 500));

  return listen(timeoutSec);
}

// --- Local ASR via sherpa-onnx-node ---

async function listenLocal(timeoutSec: number): Promise<string> {
  // Play mic-ready beep (walkie-talkie style)
  playSfx('mic-ready');
  await new Promise((r) => setTimeout(r, 300));

  // Step 1: Record audio from microphone
  const audioFile = await recordMicrophone(timeoutSec);
  if (!audioFile) {
    return '[timeout]';
  }

  try {
    // Step 2: Recognize speech
    const text = recognizeFile(audioFile);
    return text || '[empty]';
  } finally {
    // Cleanup temp file
    try { fs.unlinkSync(audioFile); } catch { /* ignore */ }
  }
}

/**
 * Record audio using macOS mic-helper (AVFoundation).
 * Returns path to WAV file, or null if failed.
 */
async function recordViaMicHelper(timeoutSec: number, outFile: string): Promise<string | null> {
  const helper = getMicHelperPath();
  if (!helper || !ensureMicAuthorized()) return null;

  return new Promise((resolve) => {
    const child = spawn(helper, ['record', String(timeoutSec), outFile], {
      stdio: 'ignore',
    });

    child.on('close', (code) => {
      if (code === 0 && fs.existsSync(outFile) && fs.statSync(outFile).size > 44) {
        resolve(outFile);
      } else {
        resolve(null);
      }
    });

    child.on('error', () => resolve(null));

    // Safety net
    setTimeout(() => {
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
      setTimeout(() => {
        if (fs.existsSync(outFile) && fs.statSync(outFile).size > 44) {
          resolve(outFile);
        } else {
          resolve(null);
        }
      }, 200);
    }, (timeoutSec + 2) * 1000);
  });
}

/**
 * Record audio from system microphone.
 * macOS: tries mic-helper (AVFoundation) first, falls back to sox.
 * Linux: uses sox (rec) or arecord.
 * Returns path to WAV file, or null if timeout with no audio.
 */
async function recordMicrophone(timeoutSec: number): Promise<string | null> {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
  const outFile = path.join(TEMP_DIR, `rec-${Date.now()}.wav`);
  const platform = os.platform();

  // macOS: prefer mic-helper for proper permission handling
  if (platform === 'darwin') {
    const result = await recordViaMicHelper(timeoutSec, outFile);
    if (result) return result;
    // Fall through to sox if mic-helper unavailable
  }

  return new Promise((resolve) => {
    let child: ChildProcess;
    let resolved = false;

    const done = (file: string | null) => {
      if (resolved) return;
      resolved = true;
      resolve(file);
    };

    if (platform === 'darwin' || platform === 'linux') {
      // Record fixed duration, output standard PCM 16-bit WAV
      // (sherpa-onnx requires subchunk1_size=16, i.e. plain PCM format)
      child = spawn('rec', [
        '-t', 'wav',         // output WAV
        '-e', 'signed-integer', // PCM signed int
        '-b', '16',          // 16-bit
        outFile,
        'rate', '16000',
        'channels', '1',
        'trim', '0', String(timeoutSec),
      ], {
        stdio: 'ignore',
      });

      child.on('close', (code) => {
        if (fs.existsSync(outFile) && fs.statSync(outFile).size > 44) {
          done(outFile);
        } else {
          done(null);
        }
      });

      child.on('error', () => {
        // sox not available, try arecord (Linux)
        if (platform === 'linux') {
          const fallback = spawn('arecord', [
            '-f', 'S16_LE', '-r', '16000', '-c', '1',
            '-d', String(timeoutSec),
            outFile,
          ], { stdio: 'ignore' });

          fallback.on('close', () => {
            if (fs.existsSync(outFile) && fs.statSync(outFile).size > 44) {
              done(outFile);
            } else {
              done(null);
            }
          });

          fallback.on('error', () => done(null));
        } else {
          done(null);
        }
      });
    } else {
      // Windows or unsupported — no recording
      done(null);
    }

    // Hard timeout safety net
    setTimeout(() => {
      if (!resolved) {
        try { child?.kill('SIGTERM'); } catch { /* ignore */ }
        setTimeout(() => {
          if (fs.existsSync(outFile) && fs.statSync(outFile).size > 44) {
            done(outFile);
          } else {
            done(null);
          }
        }, 200);
      }
    }, (timeoutSec + 1) * 1000);
  });
}

/**
 * Recognize speech from a WAV file using sherpa-onnx Paraformer.
 */
function recognizeFile(wavFile: string): string {
  const s = getSherpa();
  if (!s) {
    throw new Error('sherpa-onnx-node not available');
  }

  const config = getConfig();
  const modelsDir = config.asr.local.modelsDir;

  // Initialize recognizer if needed
  if (!recognizer) {
    if (config.asr.engine === 'paraformer') {
      const modelDir = path.join(modelsDir, 'sherpa-onnx-paraformer-zh-2023-09-14');
      const modelFile = path.join(modelDir, 'model.int8.onnx');
      const tokensFile = path.join(modelDir, 'tokens.txt');

      if (!fs.existsSync(modelFile)) {
        throw new Error(`Paraformer model not found at ${modelFile}. Run: npx tsx scripts/download-models.ts paraformer-asr`);
      }

      recognizer = new s.OfflineRecognizer({
        modelConfig: {
          paraformer: { model: modelFile },
          tokens: tokensFile,
          numThreads: 2,
        },
      });
    } else {
      throw new Error(`ASR engine '${config.asr.engine}' not yet supported`);
    }
  }

  // Read WAV file
  const wave = s.readWave(wavFile);

  // Create stream and recognize
  const stream = recognizer.createStream();
  stream.acceptWaveform({ samples: wave.samples, sampleRate: wave.sampleRate });
  recognizer.decode(stream);
  const result = recognizer.getResult(stream);

  return result.text?.trim() ?? '';
}

// --- Cloud ASR (Volcengine via proxy) ---

/**
 * Cloud ASR flow:
 * 1. Record audio locally via sox
 * 2. Send WAV to api.echoclaw.com/v1/asr (our proxy) or Volcengine direct
 * 3. Proxy forwards to Volcengine, returns recognized text
 */
async function listenCloud(timeoutSec: number): Promise<string> {
  const config = getConfig();
  const { endpoint, apiKey } = config.asr.cloud;

  if (!endpoint) {
    throw new Error('Cloud ASR endpoint not configured');
  }

  // Record audio first
  playSfx('mic-ready');
  await new Promise((r) => setTimeout(r, 300));

  const audioFile = await recordMicrophone(timeoutSec);
  if (!audioFile) {
    return '[timeout]';
  }

  try {
    const audioData = fs.readFileSync(audioFile);
    const audioBase64 = audioData.toString('base64');

    // Detect if endpoint is Volcengine direct or our proxy
    const isVolcDirect = endpoint.includes('openspeech.bytedance.com');

    if (isVolcDirect) {
      // Direct Volcengine: send base64 audio via their format
      return await callVolcengineAsr(audioBase64, config, apiKey);
    } else {
      // Our proxy: simplified request
      return await callProxyAsr(audioBase64, endpoint);
    }
  } finally {
    try { fs.unlinkSync(audioFile); } catch { /* ignore */ }
  }
}

/**
 * Call Volcengine ASR API directly (user has own key).
 * Uses the recording file upload endpoint.
 */
async function callVolcengineAsr(
  audioBase64: string,
  config: ReturnType<typeof getConfig>,
  apiKey: string,
): Promise<string> {
  const reqid = crypto.randomUUID();

  const body = JSON.stringify({
    app: {
      appid: config.asr.cloud.appId || '',
      token: apiKey,
      cluster: 'volcengine_streaming_common',
    },
    user: { uid: 'echocoding' },
    audio: {
      format: 'wav',
      rate: 16000,
      bits: 16,
      channel: 1,
      language: 'zh-CN',
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
      'Authorization': `Bearer;${apiKey}`,
    },
    body,
  });

  if (!response.ok) {
    throw new Error(`Volcengine ASR error: ${response.status}`);
  }

  const result = await response.json() as {
    code?: number;
    message?: string;
    result?: Array<{ text?: string }>;
  };

  if (result.code !== 1000 || !result.result?.[0]?.text) {
    throw new Error(`Volcengine ASR failed: ${result.message || result.code}`);
  }

  return result.result[0].text.trim();
}

/**
 * Call our proxy (api.echoclaw.com/v1/asr).
 * Proxy holds the Volcengine key — client sends base64 audio.
 */
async function callProxyAsr(audioBase64: string, endpoint: string): Promise<string> {
  const bodyStr = JSON.stringify({
    audio: audioBase64,
    format: 'wav',
    language: 'zh-CN',
  });
  const authHeaders = signRequest(bodyStr, 'POST', '/v1/asr');

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders },
    body: bodyStr,
  });

  if (!response.ok) {
    throw new Error(`Proxy ASR error: ${response.status}`);
  }

  const result = await response.json() as { text?: string; error?: string };

  if (result.error) {
    throw new Error(`Proxy ASR: ${result.error}`);
  }

  return result.text?.trim() ?? '[empty]';
}

// --- Cleanup ---

export function disposeAsr(): void {
  recognizer = null;
  vad = null;
}
