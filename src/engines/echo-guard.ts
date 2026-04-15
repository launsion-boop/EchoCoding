const TARGET_SAMPLE_RATE = 16_000;
const ACTIVE_LEAD_MS = 120;
const ACTIVE_TAIL_MS = 700;
const MIN_CHUNK_SAMPLES = 160; // 10ms @ 16kHz
const MIN_MIC_POWER = 8.0e7;
const MIN_REF_POWER = 8.0e7;
const CORR_THRESHOLD = 0.28;
const RESIDUAL_RATIO_THRESHOLD = 1.25;
const RMS_RATIO_MAX = 20.0;
const ALPHA_ABS_MIN = 0.005;
const ALPHA_ABS_MAX = 24.0;
const SEARCH_LATE_MS = 1_800; // playback -> mic path latency (afplay spawn + device pipeline)
const SEARCH_LEAD_MS = 80;  // jitter/clock skew allowance
const SEARCH_STEP_SAMPLES = 80; // 5ms @ 16kHz

interface PlaybackReference {
  startMs: number;
  endMs: number;
  pcm16k: Int16Array;
}

interface EchoMatch {
  refStart: number;
  corrAbs: number;
  residualRatio: number;
  rmsRatio: number;
  alphaAbs: number;
  alpha: number;
}

let activeReference: PlaybackReference | null = null;

function resampleLinearInt16(input: Int16Array, inputRate: number, outputRate: number): Int16Array {
  if (input.length <= 1 || inputRate === outputRate) {
    return inputRate === outputRate ? input.slice() : new Int16Array(input);
  }

  const outputLength = Math.max(1, Math.floor((input.length * outputRate) / inputRate));
  const output = new Int16Array(outputLength);
  const ratio = inputRate / outputRate;
  const last = input.length - 1;

  for (let i = 0; i < outputLength; i++) {
    const srcPos = i * ratio;
    const idx = Math.min(last, Math.floor(srcPos));
    const frac = srcPos - idx;
    const s0 = input[idx];
    const s1 = input[Math.min(last, idx + 1)];
    output[i] = Math.round(s0 + ((s1 - s0) * frac));
  }
  return output;
}

export function registerTtsPlaybackReference(
  pcm: Int16Array,
  sampleRate: number,
  startMs = Date.now(),
): void {
  if (!pcm || pcm.length < MIN_CHUNK_SAMPLES) {
    activeReference = null;
    return;
  }

  const pcm16k = sampleRate === TARGET_SAMPLE_RATE
    ? pcm.slice()
    : resampleLinearInt16(pcm, sampleRate, TARGET_SAMPLE_RATE);

  if (pcm16k.length < MIN_CHUNK_SAMPLES) {
    activeReference = null;
    return;
  }

  const durationMs = Math.floor((pcm16k.length / TARGET_SAMPLE_RATE) * 1000);
  activeReference = {
    startMs,
    endMs: startMs + Math.max(1, durationMs),
    pcm16k,
  };
}

export function clearTtsPlaybackReference(): void {
  activeReference = null;
}

function isReferenceActive(ref: PlaybackReference, nowMs: number): boolean {
  if (nowMs < (ref.startMs - ACTIVE_LEAD_MS)) return false;
  if (nowMs > (ref.endMs + ACTIVE_TAIL_MS)) return false;
  return true;
}

function clampInt16(value: number): number {
  if (value > 32767) return 32767;
  if (value < -32768) return -32768;
  return value | 0;
}

function evaluateEchoMatch(
  micSamples: Int16Array,
  refSamples: Int16Array,
  refStart: number,
): EchoMatch | null {
  const samples = micSamples.length;
  let dot = 0;
  let micPow = 0;
  let refPow = 0;

  for (let i = 0; i < samples; i++) {
    const mic = micSamples[i];
    const ref = refSamples[refStart + i];
    dot += mic * ref;
    micPow += mic * mic;
    refPow += ref * ref;
  }

  if (micPow < MIN_MIC_POWER || refPow < MIN_REF_POWER) return null;

  const alpha = dot / (refPow + 1);
  const residualPow = Math.max(0, micPow - (2 * alpha * dot) + (alpha * alpha * refPow));
  const corrAbs = Math.abs(dot) / Math.sqrt((micPow * refPow) + 1);
  const residualRatio = residualPow / (micPow + 1);
  const rmsRatio = Math.sqrt(micPow / (refPow + 1));

  return {
    refStart,
    corrAbs,
    residualRatio,
    rmsRatio,
    alphaAbs: Math.abs(alpha),
    alpha,
  };
}

function isStrongEchoMatch(match: EchoMatch): boolean {
  return (
    match.corrAbs >= CORR_THRESHOLD &&
    match.residualRatio <= RESIDUAL_RATIO_THRESHOLD &&
    match.rmsRatio <= RMS_RATIO_MAX &&
    match.alphaAbs >= ALPHA_ABS_MIN &&
    match.alphaAbs <= ALPHA_ABS_MAX
  );
}

function getBestEchoMatch(chunk: Buffer, nowMs: number): { ref: PlaybackReference; micSamples: Int16Array; match: EchoMatch | null } {
  const ref = activeReference;
  if (!ref) {
    return { ref: null as unknown as PlaybackReference, micSamples: new Int16Array(0), match: null };
  }

  if (!isReferenceActive(ref, nowMs)) {
    if (nowMs > (ref.endMs + ACTIVE_TAIL_MS)) activeReference = null;
    return { ref, micSamples: new Int16Array(0), match: null };
  }

  const samples = Math.floor(chunk.length / 2);
  if (samples < MIN_CHUNK_SAMPLES) {
    return { ref, micSamples: new Int16Array(0), match: null };
  }

  const aligned = (chunk.byteOffset % 2) === 0;
  const micViewBuffer = aligned ? chunk : Buffer.from(chunk);
  const micSamples = new Int16Array(micViewBuffer.buffer, micViewBuffer.byteOffset, samples);

  const refEndSample = Math.floor(((nowMs - ref.startMs) * TARGET_SAMPLE_RATE) / 1000);
  const baseRefStart = refEndSample - samples;
  const lateSamples = Math.floor((SEARCH_LATE_MS * TARGET_SAMPLE_RATE) / 1000);
  const leadSamples = Math.floor((SEARCH_LEAD_MS * TARGET_SAMPLE_RATE) / 1000);

  let best: EchoMatch | null = null;
  for (let shift = -lateSamples; shift <= leadSamples; shift += SEARCH_STEP_SAMPLES) {
    const candidateStart = baseRefStart + shift;
    if (candidateStart < 0) continue;
    if ((candidateStart + samples) > ref.pcm16k.length) continue;
    const match = evaluateEchoMatch(micSamples, ref.pcm16k, candidateStart);
    if (!match) continue;
    if (!best) {
      best = match;
      continue;
    }
    if (match.corrAbs > best.corrAbs || (match.corrAbs === best.corrAbs && match.residualRatio < best.residualRatio)) {
      best = match;
    }
  }

  return { ref, micSamples, match: best };
}

export function filterEchoChunk(chunk: Buffer, nowMs = Date.now()): Buffer {
  const result = getBestEchoMatch(chunk, nowMs);
  if (!result.match || !isStrongEchoMatch(result.match)) return chunk;

  const { ref, micSamples, match } = result;
  if (micSamples.length <= 0) return chunk;

  const out = Buffer.allocUnsafe(micSamples.length * 2);
  for (let i = 0; i < micSamples.length; i++) {
    const cleaned = micSamples[i] - (match.alpha * ref.pcm16k[match.refStart + i]);
    out.writeInt16LE(clampInt16(Math.round(cleaned)), i * 2);
  }
  return out;
}

export function shouldSuppressEchoChunk(chunk: Buffer, nowMs = Date.now()): boolean {
  const result = getBestEchoMatch(chunk, nowMs);
  if (!result.match) return false;
  return isStrongEchoMatch(result.match);
}
