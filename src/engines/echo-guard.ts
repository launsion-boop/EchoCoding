const TARGET_SAMPLE_RATE = 16_000;
const ACTIVE_LEAD_MS = 120;
const ACTIVE_TAIL_MS = 3_200;
const REF_KEEP_AFTER_TAIL_MS = 5_200;
const REF_HISTORY_LIMIT = 3;

const MIN_CHUNK_SAMPLES = 160; // 10ms @ 16kHz
const MIN_MIC_POWER = 6.0e7;
const MIN_REF_POWER = 6.0e7;

const CORR_MIN_FOR_CANCELLATION = 0.11;
const CORR_THRESHOLD = 0.23;
const RESIDUAL_RATIO_THRESHOLD = 1.2;
const RMS_RATIO_MAX = 22.0;
const ALPHA_ABS_MIN = 0.0025;
const ALPHA_ABS_MAX = 28.0;

const SEARCH_LATE_MS = 5_200; // playback -> mic path latency allowance
const SEARCH_LEAD_MS = 80; // jitter / clock skew allowance
const SEARCH_STEP_SAMPLES = 80; // 5ms @ 16kHz
const LOCKED_SEARCH_STEP_SAMPLES = 32; // 2ms @ 16kHz
const LOCKED_SEARCH_RADIUS_SAMPLES = 480; // 30ms @ 16kHz
const MATCH_LOCK_MAX_AGE_MS = 4_200;

const NLMS_TAP_COUNT = 96;
const NLMS_STEP_SIZE = 0.22;
const NLMS_EPSILON = 1.0e9;
const NLMS_WEIGHT_LIMIT = 32.0;
const SOFT_SUPPRESS_MIN_GAIN = 0.28;

interface PlaybackReference {
  id: number;
  startMs: number;
  endMs: number;
  pcm16k: Int16Array;
}

interface EchoMatch {
  ref: PlaybackReference;
  refStart: number;
  corrAbs: number;
  residualRatio: number;
  rmsRatio: number;
  alphaAbs: number;
  alpha: number;
  micPow: number;
  refPow: number;
}

interface EchoSearchResult {
  micSamples: Int16Array;
  match: EchoMatch | null;
}

interface AdaptiveAecState {
  refId: number;
  refStart: number;
  weights: Float64Array;
  updatedAt: number;
}

interface AdaptiveCancelResult {
  cleaned: Buffer;
  residualRatio: number;
  gainDb: number;
}

let playbackReferences: PlaybackReference[] = [];
let nextPlaybackRefId = 1;
let adaptiveState: AdaptiveAecState | null = null;

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

function pruneReferences(nowMs: number): void {
  playbackReferences = playbackReferences.filter((ref) => nowMs <= (ref.endMs + ACTIVE_TAIL_MS + REF_KEEP_AFTER_TAIL_MS));
  if (playbackReferences.length > REF_HISTORY_LIMIT) {
    playbackReferences = playbackReferences.slice(-REF_HISTORY_LIMIT);
  }

  if (adaptiveState && !playbackReferences.some((ref) => ref.id === adaptiveState?.refId)) {
    adaptiveState = null;
  }
}

export function registerTtsPlaybackReference(
  pcm: Int16Array,
  sampleRate: number,
  startMs = Date.now(),
): void {
  if (!pcm || pcm.length < MIN_CHUNK_SAMPLES) {
    return;
  }

  const pcm16k = sampleRate === TARGET_SAMPLE_RATE
    ? pcm.slice()
    : resampleLinearInt16(pcm, sampleRate, TARGET_SAMPLE_RATE);

  if (pcm16k.length < MIN_CHUNK_SAMPLES) {
    return;
  }

  const durationMs = Math.floor((pcm16k.length / TARGET_SAMPLE_RATE) * 1000);
  const reference: PlaybackReference = {
    id: nextPlaybackRefId++,
    startMs,
    endMs: startMs + Math.max(1, durationMs),
    pcm16k,
  };

  playbackReferences.push(reference);
  playbackReferences.sort((a, b) => a.startMs - b.startMs);
  pruneReferences(startMs);
}

export function clearTtsPlaybackReference(): void {
  playbackReferences = [];
  adaptiveState = null;
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

function toInt16Samples(chunk: Buffer, sampleCount: number): Int16Array {
  const aligned = (chunk.byteOffset % 2) === 0;
  const viewBuffer = aligned ? chunk : Buffer.from(chunk);
  return new Int16Array(viewBuffer.buffer, viewBuffer.byteOffset, sampleCount);
}

function evaluateEchoMatch(
  micSamples: Int16Array,
  ref: PlaybackReference,
  refStart: number,
): EchoMatch | null {
  const samples = micSamples.length;
  let dot = 0;
  let micPow = 0;
  let refPow = 0;

  for (let i = 0; i < samples; i++) {
    const mic = micSamples[i];
    const refSample = ref.pcm16k[refStart + i];
    dot += mic * refSample;
    micPow += mic * mic;
    refPow += refSample * refSample;
  }

  if (micPow < MIN_MIC_POWER || refPow < MIN_REF_POWER) return null;

  const alpha = dot / (refPow + 1);
  const residualPow = Math.max(0, micPow - (2 * alpha * dot) + (alpha * alpha * refPow));
  const corrAbs = Math.abs(dot) / Math.sqrt((micPow * refPow) + 1);
  const residualRatio = residualPow / (micPow + 1);
  const rmsRatio = Math.sqrt(micPow / (refPow + 1));

  return {
    ref,
    refStart,
    corrAbs,
    residualRatio,
    rmsRatio,
    alphaAbs: Math.abs(alpha),
    alpha,
    micPow,
    refPow,
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

function scoreMatch(match: EchoMatch): number {
  return (match.corrAbs * 2.0) - match.residualRatio - (match.rmsRatio * 0.02);
}

function estimateLockedRefStart(baseRefStart: number, refId: number, nowMs: number): number | null {
  if (!adaptiveState || adaptiveState.refId !== refId) return null;
  const ageMs = nowMs - adaptiveState.updatedAt;
  if (ageMs < 0 || ageMs > MATCH_LOCK_MAX_AGE_MS) return null;

  const driftSamples = Math.floor((ageMs * TARGET_SAMPLE_RATE) / 1000);
  const predicted = adaptiveState.refStart + driftSamples;
  if (!Number.isFinite(predicted)) return null;

  // Lock only when prediction is still in the same neighborhood as timeline estimate.
  const lateSamples = Math.floor((SEARCH_LATE_MS * TARGET_SAMPLE_RATE) / 1000);
  if (Math.abs(predicted - baseRefStart) > (lateSamples + LOCKED_SEARCH_RADIUS_SAMPLES)) {
    return null;
  }

  return predicted;
}

function getBestEchoMatch(chunk: Buffer, nowMs: number): EchoSearchResult {
  pruneReferences(nowMs);

  if (playbackReferences.length <= 0) {
    return { micSamples: new Int16Array(0), match: null };
  }

  const sampleCount = Math.floor(chunk.length / 2);
  if (sampleCount < MIN_CHUNK_SAMPLES) {
    return { micSamples: new Int16Array(0), match: null };
  }

  const micSamples = toInt16Samples(chunk, sampleCount);
  let bestMatch: EchoMatch | null = null;

  for (const ref of playbackReferences) {
    if (!isReferenceActive(ref, nowMs)) continue;

    const maxRefStart = ref.pcm16k.length - sampleCount;
    if (maxRefStart < 0) continue;

    const refEndSample = Math.floor(((nowMs - ref.startMs) * TARGET_SAMPLE_RATE) / 1000);
    const baseRefStart = refEndSample - sampleCount;

    const lateSamples = Math.floor((SEARCH_LATE_MS * TARGET_SAMPLE_RATE) / 1000);
    const leadSamples = Math.floor((SEARCH_LEAD_MS * TARGET_SAMPLE_RATE) / 1000);

    const lockedCenter = estimateLockedRefStart(baseRefStart, ref.id, nowMs);

    let searchStart: number;
    let searchEnd: number;
    let searchStep: number;

    if (lockedCenter !== null) {
      searchStart = lockedCenter - LOCKED_SEARCH_RADIUS_SAMPLES;
      searchEnd = lockedCenter + LOCKED_SEARCH_RADIUS_SAMPLES;
      searchStep = LOCKED_SEARCH_STEP_SAMPLES;
    } else {
      searchStart = baseRefStart - lateSamples;
      searchEnd = baseRefStart + leadSamples;
      searchStep = SEARCH_STEP_SAMPLES;
    }

    searchStart = Math.max(0, searchStart);
    searchEnd = Math.min(maxRefStart, searchEnd);

    if (searchEnd < searchStart) continue;

    for (let candidateStart = searchStart; candidateStart <= searchEnd; candidateStart += searchStep) {
      const match = evaluateEchoMatch(micSamples, ref, candidateStart);
      if (!match) continue;

      if (!bestMatch || scoreMatch(match) > scoreMatch(bestMatch)) {
        bestMatch = match;
      }
    }
  }

  return { micSamples, match: bestMatch };
}

function pickAdaptiveWeights(match: EchoMatch): Float64Array {
  if (
    adaptiveState &&
    adaptiveState.refId === match.ref.id &&
    Math.abs(adaptiveState.refStart - match.refStart) <= (LOCKED_SEARCH_RADIUS_SAMPLES * 2)
  ) {
    return adaptiveState.weights;
  }

  return new Float64Array(NLMS_TAP_COUNT);
}

function applyAdaptiveCancellation(
  micSamples: Int16Array,
  ref: PlaybackReference,
  refStart: number,
  weights: Float64Array,
): AdaptiveCancelResult {
  const out = Buffer.allocUnsafe(micSamples.length * 2);
  const xCache = new Float64Array(weights.length);

  let micPow = 0;
  let errPow = 0;

  for (let i = 0; i < micSamples.length; i++) {
    let y = 0;
    let norm = NLMS_EPSILON;

    for (let tap = 0; tap < weights.length; tap++) {
      const refIndex = refStart + i - tap;
      const x = (refIndex >= 0 && refIndex < ref.pcm16k.length) ? ref.pcm16k[refIndex] : 0;
      xCache[tap] = x;
      y += weights[tap] * x;
      norm += x * x;
    }

    const d = micSamples[i];
    const e = d - y;

    micPow += d * d;
    errPow += e * e;

    const mu = NLMS_STEP_SIZE / norm;
    for (let tap = 0; tap < weights.length; tap++) {
      const next = weights[tap] + (mu * e * xCache[tap]);
      if (next > NLMS_WEIGHT_LIMIT) weights[tap] = NLMS_WEIGHT_LIMIT;
      else if (next < -NLMS_WEIGHT_LIMIT) weights[tap] = -NLMS_WEIGHT_LIMIT;
      else weights[tap] = next;
    }

    out.writeInt16LE(clampInt16(Math.round(e)), i * 2);
  }

  const residualRatio = errPow / (micPow + 1);
  const gainDb = 10 * Math.log10((micPow + 1) / (errPow + 1));

  return {
    cleaned: out,
    residualRatio,
    gainDb,
  };
}

function applySoftSuppression(chunk: Buffer, gain: number): Buffer {
  if (gain >= 0.999) return chunk;

  const out = Buffer.allocUnsafe(chunk.length);
  const sampleCount = Math.floor(chunk.length / 2);

  for (let i = 0; i < sampleCount; i++) {
    const sample = chunk.readInt16LE(i * 2);
    out.writeInt16LE(clampInt16(Math.round(sample * gain)), i * 2);
  }

  return out;
}

export function filterEchoChunk(chunk: Buffer, nowMs = Date.now()): Buffer {
  const result = getBestEchoMatch(chunk, nowMs);
  const match = result.match;

  if (!match || result.micSamples.length <= 0) {
    return chunk;
  }

  if (match.corrAbs < CORR_MIN_FOR_CANCELLATION) {
    return chunk;
  }

  const weights = pickAdaptiveWeights(match);
  const cancelled = applyAdaptiveCancellation(result.micSamples, match.ref, match.refStart, weights);

  // If cancellation does not improve anything, keep original to avoid speech distortion.
  if (cancelled.gainDb < -0.2 && cancelled.residualRatio > 1.02) {
    return chunk;
  }

  adaptiveState = {
    refId: match.ref.id,
    refStart: match.refStart,
    weights,
    updatedAt: nowMs,
  };

  if (!isStrongEchoMatch(match) || cancelled.residualRatio > 0.55 || cancelled.gainDb < 4.0) {
    return cancelled.cleaned;
  }

  const suppressGain = Math.max(
    SOFT_SUPPRESS_MIN_GAIN,
    Math.min(0.9, 0.35 + cancelled.residualRatio),
  );
  return applySoftSuppression(cancelled.cleaned, suppressGain);
}

export function shouldSuppressEchoChunk(chunk: Buffer, nowMs = Date.now()): boolean {
  const result = getBestEchoMatch(chunk, nowMs);
  if (!result.match) return false;
  return isStrongEchoMatch(result.match);
}
