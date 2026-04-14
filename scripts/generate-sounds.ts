#!/usr/bin/env node

/**
 * Generate sound effects as WAV files.
 * Pure Node.js — no external dependencies.
 * 20 sounds covering all EchoCoding hook events.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SOUNDS_DIR = path.resolve(__dirname, '..', 'sounds', 'default');

const SAMPLE_RATE = 44100;

// --- Envelope functions ---

function envPing(progress: number): number {
  return Math.exp(-progress * 8);
}

function envFade(progress: number): number {
  return progress < 0.1 ? progress / 0.1 : Math.exp(-(progress - 0.1) * 4);
}

function envPluck(progress: number): number {
  return Math.exp(-progress * 15);
}

function envBuzz(progress: number): number {
  return progress < 0.05 ? progress / 0.05 : (progress > 0.8 ? (1 - progress) / 0.2 : 1);
}

function envClick(progress: number): number {
  return Math.exp(-progress * 40);
}

function envSwell(progress: number): number {
  // Builds up then fades
  if (progress < 0.3) return progress / 0.3;
  if (progress < 0.7) return 1;
  return (1 - progress) / 0.3;
}

function envSweepDown(progress: number): number {
  return progress < 0.05 ? progress / 0.05 : Math.exp(-(progress - 0.05) * 6);
}

// --- Noise generator (deterministic) ---

let noiseSeed = 42;
function noise(): number {
  noiseSeed = (noiseSeed * 1103515245 + 12345) & 0x7fffffff;
  return (noiseSeed / 0x7fffffff) * 2 - 1;
}

function resetNoise(): void {
  noiseSeed = 42;
}

// --- Sound generators ---

interface SoundGenerator {
  name: string;
  generate: () => Float64Array;
}

function toneSound(
  frequencies: number[],
  duration: number,
  envFn: (p: number) => number,
  volume: number,
): Float64Array {
  const totalSamples = Math.floor(SAMPLE_RATE * duration);
  const samples = new Float64Array(totalSamples);
  for (let i = 0; i < totalSamples; i++) {
    const t = i / SAMPLE_RATE;
    const progress = i / totalSamples;
    let value = 0;
    for (let f = 0; f < frequencies.length; f++) {
      const freq = frequencies[f];
      const detune = 1 + (f * 0.002);
      value += Math.sin(2 * Math.PI * freq * detune * t) / frequencies.length;
    }
    samples[i] = value * envFn(progress) * volume;
  }
  return samples;
}

// Mechanical keyboard single keystroke
function keystroke(volume: number, pitchShift = 0): Float64Array {
  resetNoise();
  const duration = 0.045;
  const totalSamples = Math.floor(SAMPLE_RATE * duration);
  const samples = new Float64Array(totalSamples);
  const baseFreq = 3500 + pitchShift;

  for (let i = 0; i < totalSamples; i++) {
    const t = i / SAMPLE_RATE;
    const progress = i / totalSamples;

    // Click transient: short noise burst + resonant tone
    const clickEnv = Math.exp(-progress * 60);
    const click = noise() * clickEnv * 0.7;

    // Mechanical resonance: damped high frequency
    const resonance = Math.sin(2 * Math.PI * baseFreq * t) * Math.exp(-progress * 35) * 0.3;

    // Bottom-out thud: low frequency
    const thud = Math.sin(2 * Math.PI * 200 * t) * Math.exp(-progress * 50) * 0.2;

    samples[i] = (click + resonance + thud) * volume;
  }
  return samples;
}

// Multiple keystrokes in sequence (typing)
function typingSequence(count: number, avgInterval: number, volume: number): Float64Array {
  const totalDuration = avgInterval * count + 0.1;
  const totalSamples = Math.floor(SAMPLE_RATE * totalDuration);
  const samples = new Float64Array(totalSamples);

  for (let k = 0; k < count; k++) {
    // Slightly randomized timing and pitch
    const jitter = (((k * 7 + 3) % 11) / 11 - 0.5) * avgInterval * 0.3;
    const offset = Math.floor((k * avgInterval + jitter) * SAMPLE_RATE);
    const pitchShift = ((k * 13 + 5) % 7 - 3) * 200;
    const volVar = 0.8 + ((k * 11 + 2) % 5) / 25;
    const key = keystroke(volume * volVar, pitchShift);

    for (let i = 0; i < key.length && offset + i < totalSamples; i++) {
      samples[offset + i] += key[i];
    }
  }
  return samples;
}

// Sweep tone (rising or falling)
function sweepTone(
  startFreq: number,
  endFreq: number,
  duration: number,
  envFn: (p: number) => number,
  volume: number,
): Float64Array {
  const totalSamples = Math.floor(SAMPLE_RATE * duration);
  const samples = new Float64Array(totalSamples);
  for (let i = 0; i < totalSamples; i++) {
    const t = i / SAMPLE_RATE;
    const progress = i / totalSamples;
    const freq = startFreq + (endFreq - startFreq) * progress;
    const value = Math.sin(2 * Math.PI * freq * t);
    samples[i] = value * envFn(progress) * volume;
  }
  return samples;
}

// Concatenate samples arrays
function concat(...arrays: Float64Array[]): Float64Array {
  const totalLen = arrays.reduce((sum, a) => sum + a.length, 0);
  const result = new Float64Array(totalLen);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

// Mix samples (overlay)
function mix(...arrays: Float64Array[]): Float64Array {
  const maxLen = Math.max(...arrays.map((a) => a.length));
  const result = new Float64Array(maxLen);
  for (const arr of arrays) {
    for (let i = 0; i < arr.length; i++) {
      result[i] += arr[i];
    }
  }
  return result;
}

// Silence
function silence(duration: number): Float64Array {
  return new Float64Array(Math.floor(SAMPLE_RATE * duration));
}

// --- All 20 sounds ---

const SOUNDS: SoundGenerator[] = [
  // === Session lifecycle ===
  {
    name: 'startup',
    generate: () => {
      // Ascending chord: C5 → E5 → G5, warm fade-in
      return toneSound([523, 659, 784], 0.5, envFade, 0.4);
    },
  },
  {
    name: 'complete',
    generate: () => {
      // Triumphant ascending: C5 → E5 → G5 → C6
      return toneSound([523, 659, 784, 1047], 0.6, envFade, 0.4);
    },
  },

  // === User interaction ===
  {
    name: 'submit',
    generate: () => {
      // Short upward sweep — "message sent" feel
      return sweepTone(400, 900, 0.12, envPluck, 0.3);
    },
  },

  // === Code editing — the signature sounds ===
  {
    name: 'write',
    generate: () => {
      // Single mechanical keystroke — for Write tool (new file)
      return keystroke(0.25);
    },
  },
  {
    name: 'typing',
    generate: () => {
      // Burst of rapid keystrokes — loops every ~1s for Edit tool ambient
      // More keystrokes, tighter intervals, varied volume = realistic keyboard
      return typingSequence(12, 0.055, 0.15);
    },
  },

  // === Search & Read ===
  {
    name: 'search',
    generate: () => {
      // Quick scanning sweep — ascending blip
      return sweepTone(600, 2000, 0.15, envPluck, 0.15);
    },
  },
  {
    name: 'read',
    generate: () => {
      // Soft page turn — gentle noise whoosh
      resetNoise();
      const duration = 0.12;
      const total = Math.floor(SAMPLE_RATE * duration);
      const samples = new Float64Array(total);
      for (let i = 0; i < total; i++) {
        const progress = i / total;
        const env = Math.sin(progress * Math.PI) * 0.12;
        samples[i] = noise() * env;
      }
      return samples;
    },
  },

  // === Status indicators ===
  {
    name: 'success',
    generate: () => {
      // Bright double ping
      return toneSound([880, 1100], 0.2, envPing, 0.3);
    },
  },
  {
    name: 'error',
    generate: () => {
      // Low dissonant buzz
      return toneSound([220, 185], 0.35, envBuzz, 0.35);
    },
  },
  {
    name: 'notification',
    generate: () => {
      // Bell-like chime
      return toneSound([1047, 1319], 0.3, envPing, 0.3);
    },
  },

  // === Git operations ===
  {
    name: 'git-commit',
    generate: () => {
      // Solid stamp/thud — "sealed"
      return toneSound([150, 100], 0.25, envPluck, 0.4);
    },
  },
  {
    name: 'git-push',
    generate: () => {
      // Upward launch sweep — "sending out"
      return sweepTone(300, 1200, 0.3, envFade, 0.3);
    },
  },

  // === Test results ===
  {
    name: 'test-pass',
    generate: () => {
      // Happy ascending two-note: ding-ding!
      const n1 = toneSound([880], 0.1, envPing, 0.3);
      const gap = silence(0.05);
      const n2 = toneSound([1175], 0.15, envPing, 0.35);
      return concat(n1, gap, n2);
    },
  },
  {
    name: 'test-fail',
    generate: () => {
      // Descending two-note: doh-doh
      const n1 = toneSound([440], 0.15, envPing, 0.3);
      const gap = silence(0.05);
      const n2 = toneSound([330], 0.2, envPing, 0.35);
      return concat(n1, gap, n2);
    },
  },

  // === Context & memory ===
  {
    name: 'compact',
    generate: () => {
      // Compression feel: descending sweep that tightens
      return sweepTone(1000, 300, 0.35, envSweepDown, 0.2);
    },
  },
  {
    name: 'thinking',
    generate: () => {
      // Soft ambient pulse — gentle thinking indicator
      const duration = 0.8;
      const total = Math.floor(SAMPLE_RATE * duration);
      const samples = new Float64Array(total);
      for (let i = 0; i < total; i++) {
        const t = i / SAMPLE_RATE;
        const progress = i / total;
        // Soft pulsing tone
        const pulse = Math.sin(2 * Math.PI * 3 * t) * 0.5 + 0.5;
        const tone = Math.sin(2 * Math.PI * 440 * t) * 0.3 + Math.sin(2 * Math.PI * 554 * t) * 0.2;
        const env = Math.sin(progress * Math.PI);
        samples[i] = tone * pulse * env * 0.1;
      }
      return samples;
    },
  },

  // === Multi-agent ===
  {
    name: 'agent-spawn',
    generate: () => {
      // Split/fork sound: tone that divides into two
      const base = toneSound([660], 0.1, envPluck, 0.25);
      const gap = silence(0.02);
      const fork = mix(
        toneSound([784], 0.15, envPing, 0.2),
        toneSound([554], 0.15, envPing, 0.2),
      );
      return concat(base, gap, fork);
    },
  },
  {
    name: 'agent-done',
    generate: () => {
      // Merge/converge: two tones joining into one
      const dual = mix(
        toneSound([554], 0.1, envPluck, 0.2),
        toneSound([784], 0.1, envPluck, 0.2),
      );
      const gap = silence(0.02);
      const merged = toneSound([660], 0.15, envPing, 0.25);
      return concat(dual, gap, merged);
    },
  },

  // === Working indicator — subtle heartbeat beeps ===
  {
    name: 'working',
    generate: () => {
      // 3 seconds of soft, periodic blips every ~0.6s
      const duration = 3.0;
      const total = Math.floor(SAMPLE_RATE * duration);
      const samples = new Float64Array(total);
      const blipInterval = 0.6;
      const blipCount = Math.floor(duration / blipInterval);

      for (let k = 0; k < blipCount; k++) {
        const offset = Math.floor(k * blipInterval * SAMPLE_RATE);
        const blipDur = 0.03;
        const blipSamples = Math.floor(SAMPLE_RATE * blipDur);
        const freq = 1200;
        for (let i = 0; i < blipSamples && offset + i < total; i++) {
          const t = i / SAMPLE_RATE;
          const progress = i / blipSamples;
          const env = Math.exp(-progress * 25);
          samples[offset + i] = Math.sin(2 * Math.PI * freq * t) * env * 0.08;
        }
      }
      return samples;
    },
  },

  // === Destructive / system ===
  {
    name: 'delete',
    generate: () => {
      // Crumple/trash: descending noise burst
      resetNoise();
      const duration = 0.2;
      const total = Math.floor(SAMPLE_RATE * duration);
      const samples = new Float64Array(total);
      for (let i = 0; i < total; i++) {
        const t = i / SAMPLE_RATE;
        const progress = i / total;
        const freq = 800 * (1 - progress * 0.7);
        const tone = Math.sin(2 * Math.PI * freq * t) * 0.3;
        const n = noise() * 0.4;
        const env = Math.exp(-progress * 8);
        samples[i] = (tone + n) * env * 0.25;
      }
      return samples;
    },
  },
  {
    name: 'install',
    generate: () => {
      // Download/install: ratcheting ascending clicks
      const samples = new Float64Array(Math.floor(SAMPLE_RATE * 0.4));
      for (let k = 0; k < 4; k++) {
        const offset = Math.floor(k * 0.09 * SAMPLE_RATE);
        const freq = 600 + k * 200;
        const clickDur = 0.04;
        const clickSamples = Math.floor(SAMPLE_RATE * clickDur);
        for (let i = 0; i < clickSamples && offset + i < samples.length; i++) {
          const t = i / SAMPLE_RATE;
          const progress = i / clickSamples;
          samples[offset + i] += Math.sin(2 * Math.PI * freq * t) * Math.exp(-progress * 20) * 0.25;
        }
      }
      return samples;
    },
  },
];

// --- WAV writer ---

function writeWav(filePath: string, samples: Float64Array): void {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = SAMPLE_RATE * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = samples.length * (bitsPerSample / 8);
  const fileSize = 36 + dataSize;

  const buffer = Buffer.alloc(44 + dataSize);
  let offset = 0;

  buffer.write('RIFF', offset); offset += 4;
  buffer.writeUInt32LE(fileSize, offset); offset += 4;
  buffer.write('WAVE', offset); offset += 4;

  buffer.write('fmt ', offset); offset += 4;
  buffer.writeUInt32LE(16, offset); offset += 4;
  buffer.writeUInt16LE(1, offset); offset += 2;
  buffer.writeUInt16LE(numChannels, offset); offset += 2;
  buffer.writeUInt32LE(SAMPLE_RATE, offset); offset += 4;
  buffer.writeUInt32LE(byteRate, offset); offset += 4;
  buffer.writeUInt16LE(blockAlign, offset); offset += 2;
  buffer.writeUInt16LE(bitsPerSample, offset); offset += 2;

  buffer.write('data', offset); offset += 4;
  buffer.writeUInt32LE(dataSize, offset); offset += 4;

  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    const int16 = Math.round(clamped * 32767);
    buffer.writeInt16LE(int16, offset);
    offset += 2;
  }

  fs.writeFileSync(filePath, buffer);
}

// --- Main ---
fs.mkdirSync(SOUNDS_DIR, { recursive: true });

console.log('[echocoding] Generating sound effects...\n');

for (const sound of SOUNDS) {
  const samples = sound.generate();
  const filePath = path.join(SOUNDS_DIR, `${sound.name}.wav`);
  writeWav(filePath, samples);
  const sizeKB = (fs.statSync(filePath).size / 1024).toFixed(1);
  const durationMs = Math.round((samples.length / SAMPLE_RATE) * 1000);
  console.log(`  ${sound.name}.wav (${sizeKB} KB, ${durationMs}ms)`);
}

console.log(`\nGenerated ${SOUNDS.length} sound effects in ${SOUNDS_DIR}`);
