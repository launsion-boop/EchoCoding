import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';
import { getConfig } from '../config.js';

const TEMP_DIR = path.join(os.tmpdir(), 'echocoding-asr');

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
 * Record audio from system microphone using sox (rec) or arecord.
 * Returns path to WAV file, or null if timeout with no audio.
 */
async function recordMicrophone(timeoutSec: number): Promise<string | null> {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
  const outFile = path.join(TEMP_DIR, `rec-${Date.now()}.wav`);
  const platform = os.platform();

  return new Promise((resolve) => {
    let child: ChildProcess;
    let resolved = false;

    const done = (file: string | null) => {
      if (resolved) return;
      resolved = true;
      resolve(file);
    };

    if (platform === 'darwin' || platform === 'linux') {
      // Use sox 'rec' if available, otherwise arecord
      // rec outputs 16kHz mono WAV, stops after silence or timeout
      child = spawn('rec', [
        outFile,
        'rate', '16000',
        'channels', '1',
        'silence', '1', '0.1', '3%',    // start recording on sound
        '1', '1.5', '3%',               // stop after 1.5s of silence
        'trim', '0', String(timeoutSec), // max duration
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
        // sox not available, try arecord (Linux) or silence-based approach
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
        // Give child a moment to write the file
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

// --- Cloud ASR ---

async function listenCloud(timeoutSec: number): Promise<string> {
  const config = getConfig();
  const { endpoint, apiKey } = config.asr.cloud;

  if (!endpoint) {
    throw new Error('Cloud ASR endpoint not configured');
  }

  // Record audio first
  const audioFile = await recordMicrophone(timeoutSec);
  if (!audioFile) {
    return '[timeout]';
  }

  try {
    // Send to cloud ASR
    const formData = new FormData();
    const audioBlob = new Blob([fs.readFileSync(audioFile)], { type: 'audio/wav' });
    formData.append('audio', audioBlob, 'recording.wav');
    formData.append('language', 'auto');

    const headers: Record<string, string> = {};
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: formData,
    });

    if (!response.ok) {
      throw new Error(`Cloud ASR error: ${response.status}`);
    }

    const result = await response.json() as { text?: string };
    return result.text?.trim() ?? '[empty]';
  } finally {
    try { fs.unlinkSync(audioFile); } catch { /* ignore */ }
  }
}

// --- Cleanup ---

export function disposeAsr(): void {
  recognizer = null;
  vad = null;
}
