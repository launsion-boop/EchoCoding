import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import WebSocket, { type RawData } from 'ws';
import { getConfig, getPackageRoot } from '../config.js';
import { playSfx } from './sfx-engine.js';
import { signRequest } from '../auth.js';
import { filterEchoChunk, shouldSuppressEchoChunk } from './echo-guard.js';

const TEMP_DIR = path.join(os.tmpdir(), 'echocoding-asr');
const MAC_MIC_SETTINGS_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone';
const PCM_SAMPLE_RATE = 16_000;
const PCM_BYTES_PER_SAMPLE = 2;
const PCM_CHANNELS = 1;
const PCM_BYTES_PER_SECOND = PCM_SAMPLE_RATE * PCM_BYTES_PER_SAMPLE * PCM_CHANNELS;
const PROXY_STREAM_FINAL_WAIT_MS = 20_000;
const MAX_UNIX_SOCKET_PATH_LENGTH = 100;
const DEFAULT_ASK_TIMEOUT_SEC = 60;
const ASK_HUD_IDLE_CLOSE_MS = 60_000;
const ASK_MIC_IDLE_CLOSE_MS = 60_000;
const ASK_SHARED_MIC_MAX_SEC = 30 * 60;
const ASK_GATE_QUIET_MS = 100;
const ASK_GATE_MAX_WAIT_MS = 280;
const ASK_GATE_QUIET_FACTOR = 0.75;
const ASK_TTS_POST_ECHO_GUARD_MS = 1_800;
const ASK_PROMPT_ECHO_RETRY_MAX = 2;
const ASK_RECOVERABLE_ERROR_RETRY_MAX = 3;
const ASK_RECOVERABLE_ERROR_BACKOFF_MS = 180;
const ASK_NON_ECHO_VOICE_MIN_MS = 220;
const ASK_STRICT_NON_ECHO_RATIO_MIN = 0.55;
const ECHO_ONLY_RMS_RATIO_MAX = 0.72;
const ECHO_DOUBLE_TALK_RMS_FACTOR = 1.22;
const ASK_LOCK_DIR = path.join(os.tmpdir(), 'echocoding-ask.lock');
const ASK_LOCK_OWNER_FILE = path.join(ASK_LOCK_DIR, 'owner.json');
const ASK_LOCK_STALE_MS = 180_000;
const ASK_LOCK_WAIT_MS = 180_000;
const ASK_LOCK_POLL_MS = 120;

type VadInputConfig = ReturnType<typeof getConfig>['asr']['vad'];
type NoiseControlInput = ReturnType<typeof getConfig>['asr']['noiseControl'];
type NoiseProfile = NoiseControlInput['profile'];

const NOISE_PROFILE_TUNING: Record<NoiseProfile, NoiseProfileTuning> = {
  normal: {
    minThresholdScale: 0.85,
    maxThresholdScale: 5.2,
    noiseFloorMultiplier: 1.75,
    noiseRiseAlpha: 0.22,
    noiseFallAlpha: 0.055,
    thresholdRiseAlpha: 0.28,
    thresholdFallAlpha: 0.1,
    denoiseMinGain: 0.24,
    denoiseOpenRatio: 1.2,
    denoiseFullRatio: 2.4,
    denoiseAttack: 0.33,
    denoiseRelease: 0.09,
  },
  'high-noise': {
    minThresholdScale: 1.05,
    maxThresholdScale: 6.8,
    noiseFloorMultiplier: 2.25,
    noiseRiseAlpha: 0.35,
    noiseFallAlpha: 0.04,
    thresholdRiseAlpha: 0.4,
    thresholdFallAlpha: 0.06,
    denoiseMinGain: 0.14,
    denoiseOpenRatio: 1.4,
    denoiseFullRatio: 3.0,
    denoiseAttack: 0.38,
    denoiseRelease: 0.06,
  },
};

interface VADRuntimeConfig {
  rmsThreshold: number;
  silenceMs: number;
  preRollMs: number;
  minSpeechMs: number;
  noSpeechTimeoutMs: number;
  maxDurationMs: number;
}

interface MicrophoneStream {
  stop: () => void;
  done: Promise<void>;
}

type CloudStreamFormat = 'pcm' | 'ogg';

interface CloudAudioSender {
  format: CloudStreamFormat;
  sendPcm: (chunk: Buffer) => boolean;
  finalize: () => Promise<void>;
  abort: () => void;
}

interface ListenStartGate {
  ready: Promise<void>;
  antiBleedMs?: number;
}

interface ListenOptions {
  hud?: boolean;
  hudPrompt?: string;
  vadOverrides?: Partial<VadInputConfig>;
  startGate?: ListenStartGate;
  skipReadyCue?: boolean;
  askSession?: boolean;
  finalizeResult?: boolean;
  duringTtsRequireDoubleTalk?: (() => boolean) | undefined;
  promptEchoFilter?: ((text: string) => boolean) | undefined;
}

interface AskOptions {
  forceCloseHud?: boolean;
}

interface AsrHudController {
  reset: () => void;
  updatePrompt: (text: string) => void;
  updateStatus: (text: string, animate?: boolean) => void;
  updatePartial: (text: string) => void;
  finish: (text: string) => void;
  timeout: () => void;
  error: (text: string) => void;
  close: () => Promise<void>;
}

interface SharedAskMicTap {
  onChunk: (chunk: Buffer) => void;
  resolveDone: () => void;
  donePromise: Promise<void>;
  doneResolved: boolean;
}

interface SharedAskMicSession {
  stream: MicrophoneStream;
  taps: Set<SharedAskMicTap>;
  closeTimer: NodeJS.Timeout | null;
}

interface EchoVadFrame {
  filteredChunk: Buffer;
  rawRms: number;
  filteredRms: number;
  activeThreshold: number;
  strongEcho: boolean;
  echoLikely: boolean;
  voicedByFiltered: boolean;
  voicedByDoubleTalk: boolean;
  voiced: boolean;
}

interface NoiseProfileTuning {
  minThresholdScale: number;
  maxThresholdScale: number;
  noiseFloorMultiplier: number;
  noiseRiseAlpha: number;
  noiseFallAlpha: number;
  thresholdRiseAlpha: number;
  thresholdFallAlpha: number;
  denoiseMinGain: number;
  denoiseOpenRatio: number;
  denoiseFullRatio: number;
  denoiseAttack: number;
  denoiseRelease: number;
}

interface AdaptiveNoiseState {
  adaptiveEnabled: boolean;
  denoiseEnabled: boolean;
  tuning: NoiseProfileTuning;
  baseThreshold: number;
  minThreshold: number;
  maxThreshold: number;
  noiseFloorRms: number;
  dynamicThreshold: number;
  denoiseGain: number;
  initialized: boolean;
}

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

function getMicHelperAppPath(): string | null {
  const helper = getMicHelperPath();
  if (!helper) return null;
  const appPath = path.join(path.dirname(helper), 'MicHelper.app');
  return fs.existsSync(appPath) ? appPath : null;
}

let micAuthorized: boolean | null = null;
let lastMicSettingsOpenAt = 0;

function ensureMicAuthorized(): boolean {
  if (micAuthorized === true) return true;
  const appPath = getMicHelperAppPath();
  if (!appPath) { micAuthorized = false; return false; }

  if (runMicHelperAppAuthCommand(appPath, 'check', 4_000)) {
    micAuthorized = true;
    return true;
  }

  if (runMicHelperAppAuthCommand(appPath, 'authorize', 40_000)) {
    micAuthorized = true;
    return true;
  }

  maybeOpenMicPrivacySettings();
  // Keep retryable in future listens in case user changes permission later.
  micAuthorized = null;
  return false;
}

function maybeOpenMicPrivacySettings(): void {
  if (os.platform() !== 'darwin') return;
  const now = Date.now();
  if (now - lastMicSettingsOpenAt < 15_000) return;
  lastMicSettingsOpenAt = now;
  try {
    const child = spawn('open', [MAC_MIC_SETTINGS_URL], { stdio: 'ignore' });
    child.unref();
  } catch {
    // ignore
  }
}

function runMicHelperAppAuthCommand(
  appPath: string,
  command: 'check' | 'authorize',
  timeoutMs: number,
): boolean {
  const exitFile = path.join(
    os.tmpdir(),
    `echocoding-mic-${command}-${process.pid}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.txt`,
  );

  try { fs.unlinkSync(exitFile); } catch { /* ignore */ }

  try {
    execFileSync('open', ['-W', '-n', appPath, '--args', command, '--exit-file', exitFile], {
      stdio: 'ignore',
      timeout: timeoutMs,
    });
  } catch {
    // open may still complete and leave exit file.
  }

  try {
    const code = fs.readFileSync(exitFile, 'utf-8').trim();
    return code === '0';
  } catch {
    return false;
  } finally {
    try { fs.unlinkSync(exitFile); } catch { /* ignore */ }
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
let lastRecordError: string | null = null;
let sharedAskHud: AsrHudController | null = null;
let sharedAskHudUsers = 0;
let sharedAskHudCloseTimer: NodeJS.Timeout | null = null;
let sharedAskMic: SharedAskMicSession | null = null;
let sharedAskMicInit: Promise<SharedAskMicSession> | null = null;

function supportsSharedAskHud(): boolean {
  return process.argv.some((arg) => arg.includes('echocoding-daemon.js'));
}

function createNoopHudController(): AsrHudController {
  return {
    reset: () => { /* noop */ },
    updatePrompt: () => { /* noop */ },
    updateStatus: () => { /* noop */ },
    updatePartial: () => { /* noop */ },
    finish: () => { /* noop */ },
    timeout: () => { /* noop */ },
    error: () => { /* noop */ },
    close: async () => { /* noop */ },
  };
}

function delayMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeEchoText(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

function computeCharOverlap(a: string, b: string): number {
  if (!a || !b) return 0;
  const counts = new Map<string, number>();
  for (const ch of b) {
    counts.set(ch, (counts.get(ch) ?? 0) + 1);
  }

  let overlap = 0;
  for (const ch of a) {
    const count = counts.get(ch) ?? 0;
    if (count <= 0) continue;
    overlap += 1;
    counts.set(ch, count - 1);
  }
  return overlap;
}

function isLikelyPromptEcho(recognizedText: string, promptText: string): boolean {
  if (!recognizedText || !promptText) return false;
  const recognized = normalizeEchoText(recognizedText);
  const prompt = normalizeEchoText(promptText);
  if (!recognized || !prompt) return false;
  const minLen = Math.min(recognized.length, prompt.length);
  if (minLen < 2) return false;

  if (recognized === prompt) return true;
  if (prompt.includes(recognized) && recognized.length >= Math.max(2, Math.floor(prompt.length * 0.4))) {
    return true;
  }
  if (recognized.includes(prompt) && prompt.length >= Math.max(2, Math.floor(recognized.length * 0.4))) {
    return true;
  }

  const overlap = computeCharOverlap(recognized, prompt);
  const recognizedRatio = overlap / recognized.length;
  const promptRatio = overlap / prompt.length;
  if (minLen <= 4) {
    return recognizedRatio >= 0.78 && promptRatio >= 0.78;
  }
  return recognizedRatio >= 0.9 && promptRatio >= 0.5;
}

function isLikelyPromptEchoPartial(partialText: string, promptText: string): boolean {
  if (!partialText || !promptText) return false;
  const partial = normalizeEchoText(partialText);
  const prompt = normalizeEchoText(promptText);
  if (!partial || !prompt) return false;
  if (partial.length < 1) return false;

  // Streaming ASR often emits progressive prompt prefixes first.
  if (prompt.startsWith(partial) && partial.length >= 1) return true;
  if (partial.startsWith(prompt) && prompt.length >= 1) return true;

  return isLikelyPromptEcho(partialText, promptText);
}

function requiredNonEchoVoicedMs(strictWindow: boolean): number {
  return strictWindow ? ASK_NON_ECHO_VOICE_MIN_MS : 0;
}

function hasEnoughNonEchoEvidence(
  nonEchoVoicedMs: number,
  voicedMs: number,
  strictWindow: boolean,
): boolean {
  if (nonEchoVoicedMs < requiredNonEchoVoicedMs(strictWindow)) {
    return false;
  }
  if (!strictWindow) return true;
  if (voicedMs <= 0) return false;
  return (nonEchoVoicedMs / voicedMs) >= ASK_STRICT_NON_ECHO_RATIO_MIN;
}

function isRecoverableAskError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (!msg) return false;

  // Fatal conditions should surface immediately.
  if (
    msg.includes('permission denied') ||
    msg.includes('not configured') ||
    msg.includes('is busy') ||
    msg.includes('another session') ||
    msg.includes('not yet supported')
  ) {
    return false;
  }

  return (
    msg.includes('timeout') ||
    msg.includes('temporar') ||
    msg.includes('websocket') ||
    msg.includes('socket') ||
    msg.includes('stream') ||
    msg.includes('connection') ||
    msg.includes('upstream') ||
    msg.includes('network') ||
    msg.includes('econn') ||
    msg.includes('broken pipe')
  );
}

function isProcessRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function clearStaleAskLock(): void {
  if (!fs.existsSync(ASK_LOCK_DIR)) return;
  let shouldRemove = false;

  try {
    const stat = fs.statSync(ASK_LOCK_DIR);
    if ((Date.now() - stat.mtimeMs) > ASK_LOCK_STALE_MS) {
      shouldRemove = true;
    }
  } catch {
    shouldRemove = true;
  }

  if (!shouldRemove) {
    try {
      const owner = JSON.parse(fs.readFileSync(ASK_LOCK_OWNER_FILE, 'utf-8')) as { pid?: number };
      if (owner?.pid && !isProcessRunning(owner.pid)) {
        shouldRemove = true;
      }
    } catch {
      // Owner metadata missing or unreadable; fallback to mtime only.
    }
  }

  if (!shouldRemove) return;
  try {
    fs.rmSync(ASK_LOCK_DIR, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

async function acquireAskLock(): Promise<() => void> {
  const deadline = Date.now() + ASK_LOCK_WAIT_MS;

  while (Date.now() < deadline) {
    try {
      fs.mkdirSync(ASK_LOCK_DIR);
      try {
        fs.writeFileSync(
          ASK_LOCK_OWNER_FILE,
          JSON.stringify({ pid: process.pid, startedAt: Date.now() }),
          'utf-8',
        );
      } catch {
        // ignore metadata write errors
      }

      let released = false;
      return () => {
        if (released) return;
        released = true;
        try { fs.rmSync(ASK_LOCK_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
      };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw err;
      clearStaleAskLock();
      await delayMs(ASK_LOCK_POLL_MS);
    }
  }

  throw new Error('ASK is busy: another session is using the microphone.');
}

function resolveSharedAskTapDone(tap: SharedAskMicTap): void {
  if (tap.doneResolved) return;
  tap.doneResolved = true;
  tap.resolveDone();
}

function scheduleSharedAskMicIdleClose(): void {
  if (!sharedAskMic || sharedAskMic.taps.size > 0) return;
  if (sharedAskMic.closeTimer) {
    clearTimeout(sharedAskMic.closeTimer);
    sharedAskMic.closeTimer = null;
  }
  sharedAskMic.closeTimer = setTimeout(() => {
    if (!sharedAskMic || sharedAskMic.taps.size > 0) return;
    closeSharedAskMicNow();
  }, ASK_MIC_IDLE_CLOSE_MS);
  sharedAskMic.closeTimer.unref();
}

function closeSharedAskMicNow(): void {
  const session = sharedAskMic;
  sharedAskMic = null;
  sharedAskMicInit = null;
  if (!session) return;
  if (session.closeTimer) {
    clearTimeout(session.closeTimer);
    session.closeTimer = null;
  }
  for (const tap of session.taps) {
    resolveSharedAskTapDone(tap);
  }
  session.taps.clear();
  try { session.stream.stop(); } catch { /* ignore */ }
}

async function ensureSharedAskMic(): Promise<SharedAskMicSession> {
  if (sharedAskMic) {
    if (sharedAskMic.closeTimer) {
      clearTimeout(sharedAskMic.closeTimer);
      sharedAskMic.closeTimer = null;
    }
    return sharedAskMic;
  }
  if (sharedAskMicInit) {
    return sharedAskMicInit;
  }

  sharedAskMicInit = (async () => {
    let sessionRef: SharedAskMicSession | null = null;
    const stream = await startMicrophonePcmStream(ASK_SHARED_MIC_MAX_SEC, (chunk) => {
      const session = sessionRef ?? sharedAskMic;
      if (!session || session.taps.size <= 0) return;
      const frame = Buffer.from(chunk);
      for (const tap of [...session.taps]) {
        try { tap.onChunk(frame); } catch { /* ignore tap callback errors */ }
      }
    });

    const session: SharedAskMicSession = {
      stream,
      taps: new Set<SharedAskMicTap>(),
      closeTimer: null,
    };
    sessionRef = session;

    stream.done.then(() => {
      if (sharedAskMic === session) {
        closeSharedAskMicNow();
        return;
      }
      for (const tap of session.taps) {
        resolveSharedAskTapDone(tap);
      }
      session.taps.clear();
    }).catch(() => {
      if (sharedAskMic === session) {
        closeSharedAskMicNow();
        return;
      }
      for (const tap of session.taps) {
        resolveSharedAskTapDone(tap);
      }
      session.taps.clear();
    });

    sharedAskMic = session;
    return session;
  })().finally(() => {
    sharedAskMicInit = null;
  });

  return sharedAskMicInit;
}

async function startAskSessionMicTap(onChunk: (chunk: Buffer) => void): Promise<MicrophoneStream> {
  const session = await ensureSharedAskMic();
  if (session.closeTimer) {
    clearTimeout(session.closeTimer);
    session.closeTimer = null;
  }

  let resolveDone!: () => void;
  const donePromise = new Promise<void>((resolve) => { resolveDone = resolve; });
  const tap: SharedAskMicTap = {
    onChunk,
    resolveDone,
    donePromise,
    doneResolved: false,
  };
  session.taps.add(tap);

  const stop = () => {
    session.taps.delete(tap);
    resolveSharedAskTapDone(tap);
    if (session.taps.size === 0) {
      scheduleSharedAskMicIdleClose();
    }
  };

  return { stop, done: donePromise };
}

async function startAskAwareMicrophonePcmStream(
  timeoutSec: number,
  onChunk: (chunk: Buffer) => void,
  askSession = false,
): Promise<MicrophoneStream> {
  if (!askSession) {
    return startMicrophonePcmStream(timeoutSec, onChunk);
  }
  return startAskSessionMicTap(onChunk);
}

async function createHudController(enabled: boolean): Promise<AsrHudController> {
  if (!enabled || os.platform() !== 'darwin') return createNoopHudController();

  const appPath = getMicHelperAppPath();
  if (!appPath) return createNoopHudController();

  const sockPath = createUnixSocketPath('asr-hud');
  try { fs.unlinkSync(sockPath); } catch { /* ignore */ }

  const server = net.createServer();
  let hudSocket: net.Socket | null = null;
  let openChild: ChildProcess | undefined;
  let cleaned = false;
  let connected = false;
  const pendingLines: string[] = [];

  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    try { hudSocket?.destroy(); } catch { /* ignore */ }
    try { server.close(); } catch { /* ignore */ }
    try { fs.unlinkSync(sockPath); } catch { /* ignore */ }
  };

  const enqueue = (payload: Record<string, unknown>) => {
    const line = JSON.stringify(payload) + '\n';
    if (hudSocket && !hudSocket.destroyed && connected) {
      try { hudSocket.write(line); } catch { /* ignore */ }
      return;
    }
    if (pendingLines.length < 32) pendingLines.push(line);
  };

  const flushPending = () => {
    if (!hudSocket || hudSocket.destroyed) return;
    while (pendingLines.length > 0) {
      const line = pendingLines.shift();
      if (!line) continue;
      try { hudSocket.write(line); } catch { break; }
    }
  };

  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const done = (err?: Error) => {
        if (settled) return;
        settled = true;
        if (err) reject(err);
        else resolve();
      };

      server.on('error', (err) => done(err instanceof Error ? err : new Error('hud server error')));
      server.on('connection', (conn) => {
        if (connected) {
          conn.destroy();
          return;
        }
        connected = true;
        hudSocket = conn;
        conn.on('error', () => { /* ignore */ });
        conn.on('close', () => { /* ignore */ });
        flushPending();
        done();
      });

      server.listen(sockPath, () => {
        openChild = spawn('open', ['-W', '-n', appPath, '--args', 'hud', sockPath], {
          stdio: 'ignore',
        });

        openChild.on('error', (err) => done(new Error(`hud launch failed: ${err.message}`)));
      });

      setTimeout(() => {
        if (!connected) done(new Error('hud connect timeout'));
      }, 1_800).unref();
    });
  } catch {
    cleanup();
    try { openChild?.kill('SIGTERM'); } catch { /* ignore */ }
    return createNoopHudController();
  }

  return {
    reset: () => enqueue({ type: 'reset' }),
    updatePrompt: (text: string) => enqueue({ type: 'prompt', text }),
    updateStatus: (text: string, animate = false) => enqueue({ type: 'status', text, animate }),
    updatePartial: (text: string) => enqueue({ type: 'partial', text }),
    finish: (text: string) => enqueue({ type: 'final', text }),
    timeout: () => enqueue({ type: 'timeout', text: '[timeout]' }),
    error: (text: string) => enqueue({ type: 'error', text }),
    close: async () => {
      enqueue({ type: 'close' });
      try { hudSocket?.end(); } catch { /* ignore */ }
      await new Promise((resolve) => setTimeout(resolve, 120));
      try { openChild?.kill('SIGTERM'); } catch { /* ignore */ }
      cleanup();
    },
  };
}

async function acquireAskHud(enabled: boolean): Promise<AsrHudController> {
  if (!enabled || os.platform() !== 'darwin') {
    return createNoopHudController();
  }
  if (!supportsSharedAskHud()) {
    return createHudController(true);
  }
  if (sharedAskHudCloseTimer) {
    clearTimeout(sharedAskHudCloseTimer);
    sharedAskHudCloseTimer = null;
  }
  if (!sharedAskHud) {
    sharedAskHud = await createHudController(true);
  }
  sharedAskHudUsers += 1;
  return sharedAskHud;
}

async function releaseAskHud(
  hud: AsrHudController,
  enabled: boolean,
  options: { forceClose?: boolean } = {},
): Promise<void> {
  if (!enabled || os.platform() !== 'darwin') {
    await hud.close();
    return;
  }
  if (!supportsSharedAskHud()) {
    await hud.close();
    return;
  }
  if (options.forceClose) {
    closeSharedAskHudNow();
    return;
  }
  if (hud !== sharedAskHud) {
    await hud.close();
    return;
  }

  sharedAskHudUsers = Math.max(0, sharedAskHudUsers - 1);
  if (sharedAskHudUsers > 0) return;

  if (sharedAskHudCloseTimer) {
    clearTimeout(sharedAskHudCloseTimer);
    sharedAskHudCloseTimer = null;
  }
  sharedAskHudCloseTimer = setTimeout(() => {
    const hudToClose = sharedAskHud;
    sharedAskHud = null;
    sharedAskHudUsers = 0;
    sharedAskHudCloseTimer = null;
    if (hudToClose) void hudToClose.close();
    scheduleSharedAskMicIdleClose();
  }, ASK_HUD_IDLE_CLOSE_MS);
  sharedAskHudCloseTimer.unref();
  scheduleSharedAskMicIdleClose();
}

function closeSharedAskHudNow(): void {
  if (sharedAskHudCloseTimer) {
    clearTimeout(sharedAskHudCloseTimer);
    sharedAskHudCloseTimer = null;
  }
  const hud = sharedAskHud;
  sharedAskHud = null;
  sharedAskHudUsers = 0;
  if (hud) void hud.close();
  closeSharedAskMicNow();
}

export function closeAskSessionHud(): void {
  closeSharedAskHudNow();
}

// --- Public API ---

/**
 * Record audio from microphone, detect speech via VAD, recognize via ASR.
 * Returns the recognized text, or "[timeout]" if no speech detected.
 */
export async function listen(timeoutSec?: number, options: ListenOptions = {}): Promise<string> {
  const config = getConfig();
  const timeout = timeoutSec ?? config.asr.timeout;
  const hudEnabled = os.platform() === 'darwin' && (options.hud ?? process.env.ECHOCODING_HUD === '1');
  const hud = await createHudController(hudEnabled);

  try {
    return await listenWithHud(timeout, options, hud);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    hud.error(message || 'ASR failed');
    throw err;
  } finally {
    await hud.close();
  }
}

/**
 * Speak a question via TTS, then listen for the answer.
 * Returns the recognized text.
 */
export async function ask(
  question: string,
  timeoutSec?: number,
  options: AskOptions = {},
): Promise<string> {
  // Import speak dynamically to avoid circular deps
  const { speak } = await import('./voice-engine.js');
  const effectiveTimeout = Math.max(1, Math.floor(timeoutSec ?? DEFAULT_ASK_TIMEOUT_SEC));
  const hudEnabled = os.platform() === 'darwin';
  const prompt = question.trim();
  const releaseAskLock = await acquireAskLock();
  const forceCloseHud = options.forceCloseHud === true;

  try {
    const hud = await acquireAskHud(hudEnabled);
    try {
      hud.reset();

      // HUD appears and recording starts immediately; users can answer right away.
      hud.updateStatus('Assistant speaking', true);
      let promptShown = false;
      let ttsPlaybackActive = true;
      let ttsEchoGuardUntil = Date.now() + ASK_TTS_POST_ECHO_GUARD_MS;
      const extendTtsEchoGuard = () => {
        ttsEchoGuardUntil = Math.max(ttsEchoGuardUntil, Date.now() + ASK_TTS_POST_ECHO_GUARD_MS);
      };
      const speakTask = speak(question, {
        force: true,
        onPlaybackStart: () => {
          extendTtsEchoGuard();
          if (promptShown) return;
          promptShown = true;
          if (prompt) hud.updatePrompt(prompt);
        },
      }).catch(() => {
        extendTtsEchoGuard();
        if (!promptShown && prompt) {
          promptShown = true;
          hud.updatePrompt(prompt);
        }
      }).finally(() => {
        ttsPlaybackActive = false;
        extendTtsEchoGuard();
      });

      const askDeadlineAt = Date.now() + (effectiveTimeout * 1000);
      let result = '[timeout]';
      let echoRetryCount = 0;
      let recoverableErrorCount = 0;
      let hudFinalized = false;
      while (true) {
        const remainingMs = askDeadlineAt - Date.now();
        if (remainingMs <= 900) {
          result = '[timeout]';
          break;
        }

        let attemptResult: string;
        try {
          const listenPromise = listenWithHud(
            Math.max(1, Math.ceil(remainingMs / 1000)),
            {
              hud: hudEnabled,
              skipReadyCue: true,
              askSession: hudEnabled && supportsSharedAskHud(),
              finalizeResult: false,
              duringTtsRequireDoubleTalk: () => ttsPlaybackActive || (Date.now() <= ttsEchoGuardUntil),
              promptEchoFilter: (text: string) => (
                !!prompt &&
                isLikelyPromptEchoPartial(text, prompt)
              ),
              // Ask mode: if there is no clear response, keep channel open up to timeout.
              vadOverrides: {
                // Favor responsiveness during interactive ask.
                silenceMs: 800,
                minSpeechMs: 350,
                noSpeechTimeoutMs: remainingMs,
                maxDurationMs: remainingMs,
              },
            },
            hud,
          );
          // Keep rejection handling attached while TTS is still playing.
          listenPromise.catch(() => { /* handled below */ });
          attemptResult = await listenPromise;
        } catch (attemptErr) {
          const remainingAfterErrorMs = askDeadlineAt - Date.now();
          const canRetry = (
            isRecoverableAskError(attemptErr) &&
            recoverableErrorCount < ASK_RECOVERABLE_ERROR_RETRY_MAX &&
            remainingAfterErrorMs > 1_200
          );
          if (!canRetry) {
            throw attemptErr;
          }
          recoverableErrorCount += 1;
          hud.updateStatus('Reconnecting', true);
          hud.updatePartial('');
          await delayMs(Math.min(ASK_RECOVERABLE_ERROR_BACKOFF_MS * recoverableErrorCount, 420));
          continue;
        }

        recoverableErrorCount = 0;
        if (attemptResult === '[empty]') {
          attemptResult = '[timeout]';
        }
        if (!prompt || !isLikelyPromptEcho(attemptResult, prompt)) {
          if (attemptResult === '[timeout]') hud.timeout();
          else if (attemptResult === '[error]') hud.error('ASR error');
          else {
            hud.updatePartial(attemptResult);
            hud.finish(attemptResult);
          }
          hudFinalized = true;
          result = attemptResult;
          break;
        }

        // Detected prompt echo. Keep listening inside the same ASK session.
        echoRetryCount += 1;
        if (echoRetryCount > ASK_PROMPT_ECHO_RETRY_MAX) {
          result = '[timeout]';
          break;
        }
        try { await speakTask; } catch { /* ignore */ }
        hud.updateStatus('Listening', true);
        hud.updatePartial('');
      }

      if (!hudFinalized) {
        if (result === '[timeout]') hud.timeout();
        else if (result === '[error]') hud.error('ASR error');
        else {
          hud.updatePartial(result);
          hud.finish(result);
        }
      }

      void speakTask;
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      hud.error(message || 'ASK failed');
      throw err;
    } finally {
      await releaseAskHud(hud, hudEnabled, { forceClose: forceCloseHud });
    }
  } catch (err) {
    throw err;
  } finally {
    releaseAskLock();
  }
}

async function listenWithHud(
  timeoutSec: number,
  options: ListenOptions,
  hud: AsrHudController,
): Promise<string> {
  const config = getConfig();
  if (!options.startGate) {
    hud.updateStatus('Preparing', true);
  }
  if (options.hudPrompt) {
    hud.updatePrompt(options.hudPrompt);
  }

  if (!config.asr.enabled) {
    hud.finish('[disabled]');
    return '[disabled]';
  }

  let result: string;
  if (config.asr.provider === 'cloud') {
    result = await listenCloud(timeoutSec, hud, options);
  } else {
    result = await listenLocal(timeoutSec, hud, options);
  }

  if (options.finalizeResult !== false) {
    if (result === '[timeout]') hud.timeout();
    else if (result === '[error]') hud.error('ASR error');
    else {
      hud.updatePartial(result);
      hud.finish(result);
    }
  }

  return result;
}

// --- Local ASR via sherpa-onnx-node ---

async function listenLocal(
  timeoutSec: number,
  hud: AsrHudController,
  options: ListenOptions = {},
): Promise<string> {
  if (!options.skipReadyCue) {
    // Play mic-ready beep (walkie-talkie style)
    playSfx('mic-ready');
    hud.updateStatus('Listening', true);
    await new Promise((r) => setTimeout(r, 300));
  }

  // Step 1: Record speech with local VAD (fallback to fixed recording if streaming capture fails).
  const config = getConfig();
  let audioFile: string | null = null;
  try {
    audioFile = await recordSpeechWithVad(
      timeoutSec,
      config.asr.vad,
      config.asr.noiseControl,
      hud,
      options.vadOverrides,
      options.startGate,
      options.askSession,
      options.duringTtsRequireDoubleTalk,
    );
  } catch {
    audioFile = await recordMicrophone(timeoutSec);
  }

  if (!audioFile) {
    if (lastRecordError) {
      throw new Error(lastRecordError);
    }
    return '[timeout]';
  }

  try {
    // Step 2: Recognize speech
    hud.updateStatus('Recognizing', true);
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
  const appPath = getMicHelperAppPath();
  if (!appPath) return null;
  if (!ensureMicAuthorized()) {
    lastRecordError = 'Microphone permission denied. Please enable EchoCoding Mic Helper in System Settings > Privacy & Security > Microphone.';
    return null;
  }

  return new Promise((resolve) => {
    // Launch via `open -W -n` (Launch Services, new instance) so macOS TCC grants
    // mic permission to MicHelper.app's own bundle ID, independent of the parent process.
    const child = spawn('open', ['-W', '-n', appPath, '--args', 'record', String(timeoutSec), outFile], {
      stdio: 'ignore',
    });

    child.on('close', () => {
      if (fs.existsSync(outFile) && fs.statSync(outFile).size > 44) {
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
  lastRecordError = null;
  fs.mkdirSync(TEMP_DIR, { recursive: true });
  const outFile = path.join(TEMP_DIR, `rec-${Date.now()}.wav`);
  const platform = os.platform();

  // macOS: try MicHelper.app via Launch Services for independent TCC mic permission.
  // Falls through to sox if mic-helper unavailable or fails.
  if (platform === 'darwin') {
    const result = await recordViaMicHelper(timeoutSec, outFile);
    if (result) return result;
    lastRecordError = null; // clear — sox may succeed where mic-helper failed
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

async function startMicrophonePcmStream(
  timeoutSec: number,
  onChunk: (chunk: Buffer) => void,
): Promise<MicrophoneStream> {
  const platform = os.platform();

  if (platform === 'darwin') {
    try {
      const helperStream = await startMicHelperPcmStream(timeoutSec, onChunk);
      if (helperStream) return helperStream;
    } catch {
      // Fall back to sox pipe below.
    }
  }

  if (platform === 'darwin' || platform === 'linux') {
    try {
      return await startSoxPcmStream(timeoutSec, onChunk);
    } catch (err) {
      if (platform === 'linux') {
        return startArecordPcmStream(timeoutSec, onChunk);
      }
      throw err;
    }
  }

  throw new Error('Streaming microphone not supported on this platform');
}

async function startMicHelperPcmStream(
  timeoutSec: number,
  onChunk: (chunk: Buffer) => void,
): Promise<MicrophoneStream | null> {
  const appPath = getMicHelperAppPath();
  if (!appPath) return null;
  if (!ensureMicAuthorized()) {
    lastRecordError = 'Microphone permission denied. Please enable EchoCoding Mic Helper in System Settings > Privacy & Security > Microphone.';
    return null;
  }

  const sockPath = createUnixSocketPath('mic-stream');
  try { fs.unlinkSync(sockPath); } catch { /* ignore */ }

  const server = net.createServer();
  let child: ChildProcess | null = null;
  let socket: net.Socket | null = null;
  let cleaned = false;
  let connected = false;
  let settled = false;

  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => { resolveDone = resolve; });

  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    if (socket && !socket.destroyed) socket.destroy();
    try { server.close(); } catch { /* ignore */ }
    try { fs.unlinkSync(sockPath); } catch { /* ignore */ }
    resolveDone();
  };

  const stop = () => {
    try { child?.kill('SIGTERM'); } catch { /* ignore */ }
    setTimeout(() => {
      try { child?.kill('SIGKILL'); } catch { /* ignore */ }
    }, 400).unref();
    cleanup();
  };

  return new Promise<MicrophoneStream>((resolve, reject) => {
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      stop();
      reject(err);
    };

    server.on('error', (err) => {
      fail(err instanceof Error ? err : new Error('mic-helper stream server error'));
    });

    server.on('connection', (conn) => {
      if (connected) {
        conn.destroy();
        return;
      }
      connected = true;
      socket = conn;
      conn.on('data', (chunk) => {
        if (chunk.length > 0) onChunk(Buffer.from(chunk));
      });
      conn.on('error', () => { /* ignore */ });
      if (!settled) {
        settled = true;
        resolve({ stop, done });
      }
    });

    server.listen(sockPath, () => {
      child = spawn('open', ['-W', '-n', appPath, '--args', 'stream-record', sockPath, String(timeoutSec)], {
        stdio: 'ignore',
      });

      child.on('error', (err) => {
        fail(new Error(`mic-helper stream launch failed: ${err.message}`));
      });

      child.on('close', () => {
        if (!connected && !settled) {
          settled = true;
          cleanup();
          reject(new Error('mic-helper stream exited before connecting'));
          return;
        }
        cleanup();
      });
    });

    setTimeout(() => {
      if (!connected) {
        fail(new Error('mic-helper stream connection timeout'));
      }
    }, 4_000).unref();
  });
}

function startRawPcmPipe(
  command: string,
  args: string[],
  onChunk: (chunk: Buffer) => void,
): Promise<MicrophoneStream> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'ignore'],
    });

    let settled = false;
    let cleaned = false;

    let resolveDone!: () => void;
    const done = new Promise<void>((resolveDonePromise) => { resolveDone = resolveDonePromise; });

    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      resolveDone();
    };

    const stop = () => {
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
      setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
      }, 300).unref();
    };

    child.on('spawn', () => {
      if (settled) return;
      settled = true;
      resolve({ stop, done });
    });

    child.stdout?.on('data', (chunk) => {
      if (chunk.length > 0) onChunk(Buffer.from(chunk));
    });

    child.on('error', (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
      cleanup();
    });

    child.on('close', () => {
      if (!settled) {
        settled = true;
        reject(new Error(`${command} exited before streaming`));
      }
      cleanup();
    });
  });
}

function startSoxPcmStream(timeoutSec: number, onChunk: (chunk: Buffer) => void): Promise<MicrophoneStream> {
  return startRawPcmPipe(
    'rec',
    [
      '-q',
      '-t', 'raw',
      '-e', 'signed-integer',
      '-b', '16',
      '-r', String(PCM_SAMPLE_RATE),
      '-c', String(PCM_CHANNELS),
      '-',
      'trim', '0', String(timeoutSec),
    ],
    onChunk,
  );
}

function startArecordPcmStream(timeoutSec: number, onChunk: (chunk: Buffer) => void): Promise<MicrophoneStream> {
  return startRawPcmPipe(
    'arecord',
    [
      '-q',
      '-f', 'S16_LE',
      '-r', String(PCM_SAMPLE_RATE),
      '-c', String(PCM_CHANNELS),
      '-d', String(timeoutSec),
      '-',
    ],
    onChunk,
  );
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
 * Cloud ASR:
 * - Preferred: stream PCM to proxy /v1/asr/stream with local VAD stop.
 * - Fallback: legacy batch /v1/asr upload (kept for compatibility).
 */
async function listenCloud(
  timeoutSec: number,
  hud: AsrHudController,
  options: ListenOptions = {},
): Promise<string> {
  const config = getConfig();
  const { endpoint, apiKey } = config.asr.cloud;

  if (!endpoint) {
    throw new Error('Cloud ASR endpoint not configured');
  }

  // Record audio with heartbeat indicator
  if (!options.skipReadyCue) {
    playSfx('mic-ready');
    hud.updateStatus('Listening', true);
    await new Promise((r) => setTimeout(r, 300));
  }

  // Play fast heartbeat while mic is open/listening.
  const heartbeatInterval = setInterval(() => playSfx('heartbeat'), 1200);
  try {
    const isVolcDirect = endpoint.includes('openspeech.bytedance.com');
    if (isVolcDirect) {
      return await listenCloudBatch(
        timeoutSec,
        endpoint,
        apiKey,
        config,
        hud,
        options.vadOverrides,
        options.startGate,
        options.askSession,
        options.duringTtsRequireDoubleTalk,
      );
    }

    try {
      return await listenCloudProxyStream(
        timeoutSec,
        endpoint,
        config.asr.vad,
        config.asr.noiseControl,
        hud,
        options.vadOverrides,
        options.startGate,
        options.askSession,
        options.duringTtsRequireDoubleTalk,
        options.promptEchoFilter,
      );
    } catch (err) {
      // Graceful downgrade for older proxy versions without /v1/asr/stream.
      if (!shouldFallbackToBatch(err)) throw err;
      return await listenCloudBatch(
        timeoutSec,
        endpoint,
        apiKey,
        config,
        hud,
        options.vadOverrides,
        options.startGate,
        options.askSession,
        options.duringTtsRequireDoubleTalk,
      );
    }
  } finally {
    clearInterval(heartbeatInterval);
  }
}

async function listenCloudBatch(
  timeoutSec: number,
  endpoint: string,
  apiKey: string,
  config: ReturnType<typeof getConfig>,
  hud: AsrHudController,
  vadOverrides?: Partial<VadInputConfig>,
  startGate?: ListenStartGate,
  askSession = false,
  duringTtsRequireDoubleTalk?: () => boolean,
): Promise<string> {
  let audioFile: string | null = null;
  try {
    audioFile = await recordSpeechWithVad(
      timeoutSec,
      config.asr.vad,
      config.asr.noiseControl,
      hud,
      vadOverrides,
      startGate,
      askSession,
      duringTtsRequireDoubleTalk,
    );
  } catch {
    // Keep compatibility when streaming mic capture is unavailable.
    audioFile = await recordMicrophone(timeoutSec);
  }

  if (!audioFile) {
    if (lastRecordError) throw new Error(lastRecordError);
    return '[timeout]';
  }

  let normalized: NormalizedAudio | null = null;
  try {
    hud.updateStatus('Recognizing', true);
    normalized = normalizeAudioForCloud(audioFile);
    const audioData = fs.readFileSync(normalized.file);
    const audioBase64 = audioData.toString('base64');

    const isVolcDirect = endpoint.includes('openspeech.bytedance.com');
    return isVolcDirect
      ? callVolcengineAsr(audioBase64, config, apiKey)
      : callProxyAsr(audioBase64, endpoint, normalized.format);
  } finally {
    if (normalized && normalized.file !== audioFile) {
      try { fs.unlinkSync(normalized.file); } catch { /* ignore */ }
    }
    try { fs.unlinkSync(audioFile); } catch { /* ignore */ }
  }
}

async function recordSpeechWithVad(
  timeoutSec: number,
  vadInput: VadInputConfig,
  noiseControl: NoiseControlInput,
  hud: AsrHudController,
  vadOverrides?: Partial<VadInputConfig>,
  startGate?: ListenStartGate,
  askSession = false,
  duringTtsRequireDoubleTalk?: () => boolean,
): Promise<string | null> {
  const vadConfig = getVadRuntimeConfig(timeoutSec, vadInput, vadOverrides);
  const noiseState = createAdaptiveNoiseState(vadConfig, noiseControl);
  const maxSourceSec = Math.ceil(vadConfig.maxDurationMs / 1000) + 1;
  const preRollLimitBytes = Math.max(0, Math.floor((vadConfig.preRollMs / 1000) * PCM_BYTES_PER_SECOND));
  const gateDelayMs = Math.max(0, Math.floor(startGate?.antiBleedMs ?? 0));
  let gateEligibleAt: number | null = startGate ? null : Date.now();
  let activatedAt: number | null = startGate ? null : Date.now();
  let gateActivated = !startGate;
  let quietMs = 0;

  let speechCommitted = false;
  let candidateActive = false;
  let candidateVoicedMs = 0;
  let candidateLastVoiceAt = 0;
  let candidateNonEchoVoicedMs = 0;
  let candidateStrictWindow = false;
  let lastVoiceAt = 0;
  let speechStrictWindow = false;
  let speechVoicedMs = 0;
  let speechNonEchoVoicedMs = 0;

  const preRollBuffers: Buffer[] = [];
  const candidateBuffers: Buffer[] = [];
  let preRollBytes = 0;

  const speechBuffers: Buffer[] = [];
  let speechBytes = 0;

  let finished = false;
  let mic: MicrophoneStream | null = null;
  let ticker: NodeJS.Timeout | null = null;
  let settleResolve!: (value: Buffer | null) => void;
  let settleReject!: (reason?: unknown) => void;
  const settle = new Promise<Buffer | null>((resolve, reject) => {
    settleResolve = resolve;
    settleReject = reject;
  });

  if (startGate) {
    startGate.ready.then(() => {
      if (finished) return;
      gateEligibleAt = Date.now() + gateDelayMs;
      hud.updateStatus('Listening', true);
    }).catch(() => {
      if (finished) return;
      gateEligibleAt = Date.now();
      hud.updateStatus('Listening', true);
    });
  }

  const appendSpeechChunk = (chunk: Buffer) => {
    speechBuffers.push(chunk);
    speechBytes += chunk.length;
  };

  const cleanup = () => {
    if (ticker) {
      clearInterval(ticker);
      ticker = null;
    }
    mic?.stop();
  };

  const finishTimeout = () => {
    if (finished) return;
    finished = true;
    cleanup();
    settleResolve(null);
  };

  const finishError = (err: unknown) => {
    if (finished) return;
    finished = true;
    cleanup();
    settleReject(err instanceof Error ? err : new Error(String(err)));
  };

  const finishSpeech = () => {
    if (finished) return;
    finished = true;
    cleanup();
    if (speechBytes <= 0) {
      settleResolve(null);
      return;
    }
    if (!hasEnoughNonEchoEvidence(speechNonEchoVoicedMs, speechVoicedMs, speechStrictWindow)) {
      settleResolve(null);
      return;
    }
    settleResolve(Buffer.concat(speechBuffers, speechBytes));
  };

  mic = await startAskAwareMicrophonePcmStream(maxSourceSec, (chunk) => {
    if (finished) return;

    const now = Date.now();
    const frame = applyEchoVadFrame(chunk, vadConfig.rmsThreshold, now, noiseState);
    const filteredChunk = frame.filteredChunk;
    if (!gateActivated) {
      if (gateEligibleAt === null || now < gateEligibleAt) return;
      const gateRms = frame.filteredRms;
      const gateChunkMs = pcmBytesToMs(filteredChunk.length);
      const quietThreshold = frame.activeThreshold * ASK_GATE_QUIET_FACTOR;
      quietMs = gateRms < quietThreshold ? (quietMs + gateChunkMs) : 0;
      if (quietMs < ASK_GATE_QUIET_MS && (now - gateEligibleAt) < ASK_GATE_MAX_WAIT_MS) return;
      gateActivated = true;
      activatedAt = now;
      quietMs = 0;
      candidateActive = false;
      candidateVoicedMs = 0;
      candidateLastVoiceAt = 0;
      candidateNonEchoVoicedMs = 0;
      candidateStrictWindow = false;
      preRollBuffers.length = 0;
      preRollBytes = 0;
      candidateBuffers.length = 0;
      return;
    }
    const requireDoubleTalk = duringTtsRequireDoubleTalk?.() ?? false;
    const voiced = frame.voiced && (!requireDoubleTalk || frame.voicedByDoubleTalk);
    const chunkMs = pcmBytesToMs(filteredChunk.length);

    if (!speechCommitted) {
      if (!candidateActive) {
        if (voiced) {
          candidateActive = true;
          candidateBuffers.push(...preRollBuffers, filteredChunk);
          candidateVoicedMs = chunkMs;
          candidateLastVoiceAt = now;
          candidateNonEchoVoicedMs = !frame.echoLikely ? chunkMs : 0;
          candidateStrictWindow = requireDoubleTalk;
        } else {
          preRollBuffers.push(filteredChunk);
          preRollBytes += filteredChunk.length;
          while (preRollBytes > preRollLimitBytes && preRollBuffers.length > 0) {
            const dropped = preRollBuffers.shift();
            preRollBytes -= dropped?.length ?? 0;
          }
        }
        return;
      }

      candidateBuffers.push(filteredChunk);
      if (requireDoubleTalk) {
        candidateStrictWindow = true;
      }
      if (voiced) {
        candidateVoicedMs += chunkMs;
        candidateLastVoiceAt = now;
        if (!frame.echoLikely) candidateNonEchoVoicedMs += chunkMs;
      }

      if (candidateVoicedMs >= vadConfig.minSpeechMs && hasEnoughNonEchoEvidence(candidateNonEchoVoicedMs, candidateVoicedMs, candidateStrictWindow)) {
        speechCommitted = true;
        speechStrictWindow = candidateStrictWindow;
        speechVoicedMs = candidateVoicedMs;
        speechNonEchoVoicedMs = candidateNonEchoVoicedMs;
        hud.updateStatus('Recognizing', true);
        lastVoiceAt = candidateLastVoiceAt || now;
        for (const pending of candidateBuffers) appendSpeechChunk(pending);
        candidateBuffers.length = 0;
        preRollBuffers.length = 0;
        preRollBytes = 0;
        candidateNonEchoVoicedMs = 0;
        return;
      }

      if (now - candidateLastVoiceAt >= vadConfig.silenceMs) {
        // Noise burst shorter than minimum speech duration.
        candidateActive = false;
        candidateBuffers.length = 0;
        candidateVoicedMs = 0;
        candidateLastVoiceAt = 0;
        candidateNonEchoVoicedMs = 0;
        candidateStrictWindow = false;
        preRollBuffers.length = 0;
        preRollBytes = 0;
      }
      return;
    }

    appendSpeechChunk(filteredChunk);
    if (requireDoubleTalk) {
      speechStrictWindow = true;
    }
    if (voiced) {
      lastVoiceAt = now;
      speechVoicedMs += chunkMs;
      if (!frame.echoLikely) speechNonEchoVoicedMs += chunkMs;
    }
    else if (now - lastVoiceAt >= vadConfig.silenceMs) {
      hud.updateStatus('Speech ended', true);
      finishSpeech();
    }
  }, askSession);

  ticker = setInterval(() => {
    if (finished) return;
    const now = Date.now();
    if (!gateActivated || activatedAt === null || now < activatedAt) return;
    const elapsed = now - activatedAt;

    if (!speechCommitted && elapsed >= vadConfig.noSpeechTimeoutMs) {
      hud.updateStatus('No speech detected', false);
      finishTimeout();
      return;
    }

    if (elapsed >= vadConfig.maxDurationMs) {
      hud.updateStatus('Max duration reached', false);
      if (speechCommitted) finishSpeech();
      else finishTimeout();
    }
  }, 120);

  mic.done.then(() => {
    if (finished) return;
    if (speechCommitted) finishSpeech();
    else finishTimeout();
  }).catch((err) => {
    finishError(err);
  });

  const pcm = await settle;
  if (!pcm || pcm.length <= 0) return null;

  fs.mkdirSync(TEMP_DIR, { recursive: true });
  const outFile = path.join(TEMP_DIR, `vad-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.wav`);
  writePcm16WavFile(outFile, pcm, PCM_SAMPLE_RATE, PCM_CHANNELS);
  return outFile;
}

function writePcm16WavFile(filePath: string, pcmData: Buffer, sampleRate: number, channels: number): void {
  const bitsPerSample = 16;
  const blockAlign = channels * (bitsPerSample / 8);
  const byteRate = sampleRate * blockAlign;
  const dataSize = pcmData.length;

  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // PCM fmt chunk size
  header.writeUInt16LE(1, 20); // PCM format
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataSize, 40);

  fs.writeFileSync(filePath, Buffer.concat([header, pcmData]));
}

let ffmpegAvailable: boolean | null = null;

function hasFfmpeg(): boolean {
  if (ffmpegAvailable != null) return ffmpegAvailable;
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore', timeout: 2_000 });
    ffmpegAvailable = true;
  } catch {
    ffmpegAvailable = false;
  }
  return ffmpegAvailable;
}

function resolveCloudStreamFormat(): CloudStreamFormat {
  // ECHOCODING_ASR_OPUS=0 can force-disable opus stream.
  if (process.env.ECHOCODING_ASR_OPUS === '0') return 'pcm';
  return hasFfmpeg() ? 'ogg' : 'pcm';
}

function createCloudAudioSender(
  format: CloudStreamFormat,
  onChunk: (chunk: Buffer) => boolean,
  onError: (err: unknown) => void,
): CloudAudioSender {
  if (format === 'ogg') {
    return createFfmpegOpusSender(onChunk, onError);
  }
  return {
    format: 'pcm',
    sendPcm: (chunk: Buffer) => onChunk(chunk),
    finalize: async () => { /* noop */ },
    abort: () => { /* noop */ },
  };
}

function createFfmpegOpusSender(
  onChunk: (chunk: Buffer) => boolean,
  onError: (err: unknown) => void,
): CloudAudioSender {
  const ffmpeg = spawn('ffmpeg', [
    '-hide_banner',
    '-loglevel', 'error',
    '-f', 's16le',
    '-ar', String(PCM_SAMPLE_RATE),
    '-ac', String(PCM_CHANNELS),
    '-i', 'pipe:0',
    '-c:a', 'libopus',
    '-application', 'voip',
    '-frame_duration', '20',
    '-b:a', '24k',
    '-vbr', 'on',
    '-compression_level', '10',
    '-f', 'ogg',
    'pipe:1',
  ], {
    stdio: ['pipe', 'pipe', 'ignore'],
  });

  let ended = false;
  let settled = false;
  let failed = false;
  let resolveDone!: () => void;
  let rejectDone!: (reason?: unknown) => void;
  const done = new Promise<void>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });

  ffmpeg.stdout?.on('data', (chunk) => {
    const buf = Buffer.from(chunk);
    if (buf.length === 0 || settled) return;
    const ok = onChunk(buf);
    if (!ok) failed = true;
  });

  ffmpeg.on('error', (err) => {
    if (settled) return;
    settled = true;
    failed = true;
    onError(err);
    rejectDone(err);
  });

  ffmpeg.on('close', (code, signal) => {
    if (settled) return;
    settled = true;
    if (failed || (typeof code === 'number' && code !== 0)) {
      const err = new Error(`ffmpeg opus encoder exited code=${code ?? 'null'} signal=${signal ?? 'null'}`);
      if (!failed) onError(err);
      rejectDone(err);
      return;
    }
    resolveDone();
  });

  return {
    format: 'ogg',
    sendPcm: (chunk: Buffer) => {
      if (ended || settled) return false;
      try {
        return ffmpeg.stdin?.write(chunk) ?? false;
      } catch (err) {
        failed = true;
        onError(err);
        return false;
      }
    },
    finalize: async () => {
      if (ended || settled) {
        await done.catch(() => { /* ignore */ });
        return;
      }
      ended = true;
      try { ffmpeg.stdin?.end(); } catch { /* ignore */ }
      await done;
    },
    abort: () => {
      if (settled) return;
      failed = true;
      try { ffmpeg.kill('SIGTERM'); } catch { /* ignore */ }
      setTimeout(() => {
        try { ffmpeg.kill('SIGKILL'); } catch { /* ignore */ }
      }, 200).unref();
    },
  };
}

async function listenCloudProxyStream(
  timeoutSec: number,
  endpoint: string,
  vadInput: VadInputConfig,
  noiseControl: NoiseControlInput,
  hud: AsrHudController,
  vadOverrides?: Partial<VadInputConfig>,
  startGate?: ListenStartGate,
  askSession = false,
  duringTtsRequireDoubleTalk?: () => boolean,
  promptEchoFilter?: (text: string) => boolean,
): Promise<string> {
  const vadConfig = getVadRuntimeConfig(timeoutSec, vadInput, vadOverrides);
  const noiseState = createAdaptiveNoiseState(vadConfig, noiseControl);
  let speechCommitted = false;
  let candidateActive = false;
  let candidateVoicedMs = 0;
  let candidateLastVoiceAt = 0;
  let candidateNonEchoVoicedMs = 0;
  let candidateStrictWindow = false;
  let lastVoiceAt = 0;
  let speechStrictWindow = false;
  let speechVoicedMs = 0;
  let speechNonEchoVoicedMs = 0;
  const ws = await openProxyAsrStream(endpoint);
  const resultPromise = createProxyStreamResultPromise(ws, (event) => {
    if (event.type === 'partial' && event.text) {
      const partial = event.text.trim();
      if (!speechCommitted) {
        return;
      }
      if (partial && promptEchoFilter?.(partial)) {
        return;
      }
      hud.updateStatus('Recognizing', true);
      hud.updatePartial(partial);
    }
    if (event.type === 'final') {
      hud.updateStatus('Finalizing', true);
    }
    if (event.type === 'error') {
      hud.error(event.error || 'ASR stream failed');
    }
  });

  const gateDelayMs = Math.max(0, Math.floor(startGate?.antiBleedMs ?? 0));
  let gateEligibleAt: number | null = startGate ? null : Date.now();
  let activatedAt: number | null = startGate ? null : Date.now();
  let gateActivated = !startGate;
  let quietMs = 0;
  const preRollLimitBytes = Math.max(0, Math.floor((vadConfig.preRollMs / 1000) * PCM_BYTES_PER_SECOND));
  const maxSourceSec = Math.ceil(vadConfig.maxDurationMs / 1000) + 1;

  const preRollBuffers: Buffer[] = [];
  const candidateBuffers: Buffer[] = [];
  let preRollBytes = 0;

  let finished = false;
  let mic: MicrophoneStream | null = null;
  let audioSender: CloudAudioSender | null = null;
  let ticker: NodeJS.Timeout | null = null;
  let settleResolve!: (value: string) => void;
  let settleReject!: (reason?: unknown) => void;
  const settle = new Promise<string>((resolve, reject) => {
    settleResolve = resolve;
    settleReject = reject;
  });

  if (startGate) {
    startGate.ready.then(() => {
      if (finished) return;
      gateEligibleAt = Date.now() + gateDelayMs;
      hud.updateStatus('Listening', true);
    }).catch(() => {
      if (finished) return;
      gateEligibleAt = Date.now();
      hud.updateStatus('Listening', true);
    });
  }

  const cleanup = () => {
    if (ticker) {
      clearInterval(ticker);
      ticker = null;
    }
    mic?.stop();
  };

  const finishTimeout = () => {
    if (finished) return;
    finished = true;
    cleanup();
    audioSender?.abort();
    try { ws.close(); } catch { /* ignore */ }
    settleResolve('[timeout]');
  };

  const finishError = (err: unknown) => {
    if (finished) return;
    finished = true;
    cleanup();
    audioSender?.abort();
    try { ws.close(); } catch { /* ignore */ }
    settleReject(err instanceof Error ? err : new Error(String(err)));
  };

  const finishSpeech = (reason: string) => {
    if (finished) return;
    if (!hasEnoughNonEchoEvidence(speechNonEchoVoicedMs, speechVoicedMs, speechStrictWindow)) {
      finishTimeout();
      return;
    }
    finished = true;
    cleanup();
    (async () => {
      await audioSender?.finalize();
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'end', reason }));
      }
      const text = await withTimeout(resultPromise, PROXY_STREAM_FINAL_WAIT_MS, 'ASR stream final result timeout');
      settleResolve(text.trim() || '[empty]');
    })().catch((err) => {
      settleReject(err instanceof Error ? err : new Error(String(err)));
    }).finally(() => {
      audioSender?.abort();
      try { ws.close(); } catch { /* ignore */ }
    });
  };

  const sendAudioChunk = (chunk: Buffer): boolean => {
    if (ws.readyState !== WebSocket.OPEN) {
      finishError(new Error('Proxy ASR stream socket is not open'));
      return false;
    }
    try {
      ws.send(chunk, { binary: true });
      return true;
    } catch (err) {
      finishError(err);
      return false;
    }
  };

  const streamFormat = resolveCloudStreamFormat();
  audioSender = createCloudAudioSender(streamFormat, sendAudioChunk, finishError);

  ws.send(JSON.stringify({
    type: 'start',
    language: 'zh-CN',
    audio: {
      format: streamFormat === 'ogg' ? 'ogg' : 'pcm',
      sampleRate: PCM_SAMPLE_RATE,
      bits: 16,
      channels: 1,
    },
  }));

  const sendSpeechChunk = (chunk: Buffer): boolean => {
    if (!audioSender) return sendAudioChunk(chunk);
    return audioSender.sendPcm(chunk);
  };

  mic = await startAskAwareMicrophonePcmStream(maxSourceSec, (chunk) => {
    if (finished) return;

    const now = Date.now();
    const frame = applyEchoVadFrame(chunk, vadConfig.rmsThreshold, now, noiseState);
    const filteredChunk = frame.filteredChunk;
    if (!gateActivated) {
      if (gateEligibleAt === null || now < gateEligibleAt) return;
      const gateRms = frame.filteredRms;
      const gateChunkMs = pcmBytesToMs(filteredChunk.length);
      const quietThreshold = frame.activeThreshold * ASK_GATE_QUIET_FACTOR;
      quietMs = gateRms < quietThreshold ? (quietMs + gateChunkMs) : 0;
      if (quietMs < ASK_GATE_QUIET_MS && (now - gateEligibleAt) < ASK_GATE_MAX_WAIT_MS) return;
      gateActivated = true;
      activatedAt = now;
      quietMs = 0;
      candidateActive = false;
      candidateVoicedMs = 0;
      candidateLastVoiceAt = 0;
      candidateNonEchoVoicedMs = 0;
      candidateStrictWindow = false;
      preRollBuffers.length = 0;
      preRollBytes = 0;
      candidateBuffers.length = 0;
      return;
    }
    const requireDoubleTalk = duringTtsRequireDoubleTalk?.() ?? false;
    const voiced = frame.voiced && (!requireDoubleTalk || frame.voicedByDoubleTalk);
    const chunkMs = pcmBytesToMs(filteredChunk.length);

    if (!speechCommitted) {
      if (!candidateActive) {
        if (voiced) {
          candidateActive = true;
          candidateBuffers.push(...preRollBuffers, filteredChunk);
          candidateVoicedMs = chunkMs;
          candidateLastVoiceAt = now;
          candidateNonEchoVoicedMs = !frame.echoLikely ? chunkMs : 0;
          candidateStrictWindow = requireDoubleTalk;
        } else {
          preRollBuffers.push(filteredChunk);
          preRollBytes += filteredChunk.length;
          while (preRollBytes > preRollLimitBytes && preRollBuffers.length > 0) {
            const dropped = preRollBuffers.shift();
            preRollBytes -= dropped?.length ?? 0;
          }
        }
        return;
      }

      candidateBuffers.push(filteredChunk);
      if (requireDoubleTalk) {
        candidateStrictWindow = true;
      }
      if (voiced) {
        candidateVoicedMs += chunkMs;
        candidateLastVoiceAt = now;
        if (!frame.echoLikely) candidateNonEchoVoicedMs += chunkMs;
      }

      if (candidateVoicedMs >= vadConfig.minSpeechMs && hasEnoughNonEchoEvidence(candidateNonEchoVoicedMs, candidateVoicedMs, candidateStrictWindow)) {
        speechCommitted = true;
        speechStrictWindow = candidateStrictWindow;
        speechVoicedMs = candidateVoicedMs;
        speechNonEchoVoicedMs = candidateNonEchoVoicedMs;
        hud.updateStatus('Recognizing', true);
        lastVoiceAt = candidateLastVoiceAt || now;
        for (const pending of candidateBuffers) {
          if (!sendSpeechChunk(pending)) return;
        }
        candidateBuffers.length = 0;
        preRollBuffers.length = 0;
        preRollBytes = 0;
        candidateNonEchoVoicedMs = 0;
        return;
      }

      if (now - candidateLastVoiceAt >= vadConfig.silenceMs) {
        // False trigger/noise burst.
        candidateActive = false;
        candidateBuffers.length = 0;
        candidateVoicedMs = 0;
        candidateLastVoiceAt = 0;
        candidateNonEchoVoicedMs = 0;
        candidateStrictWindow = false;
        preRollBuffers.length = 0;
        preRollBytes = 0;
      }
      return;
    }

    if (!sendSpeechChunk(filteredChunk)) return;
    if (requireDoubleTalk) {
      speechStrictWindow = true;
    }
    if (voiced) {
      lastVoiceAt = now;
      speechVoicedMs += chunkMs;
      if (!frame.echoLikely) speechNonEchoVoicedMs += chunkMs;
    }
    else if (now - lastVoiceAt >= vadConfig.silenceMs) {
      hud.updateStatus('Speech ended', true);
      finishSpeech('silence');
    }
  }, askSession);

  ticker = setInterval(() => {
    if (finished) return;
    const now = Date.now();
    if (!gateActivated || activatedAt === null || now < activatedAt) return;
    const elapsed = now - activatedAt;

    if (!speechCommitted && elapsed >= vadConfig.noSpeechTimeoutMs) {
      hud.updateStatus('No speech detected', false);
      finishTimeout();
      return;
    }

    if (elapsed >= vadConfig.maxDurationMs) {
      hud.updateStatus('Max duration reached', false);
      if (speechCommitted) finishSpeech('max-duration');
      else finishTimeout();
    }
  }, 120);

  mic.done.then(() => {
    if (finished) return;
    if (speechCommitted) finishSpeech('mic-ended');
    else finishTimeout();
  }).catch((err) => {
    finishError(err);
  });

  resultPromise.catch((err) => {
    if (!finished) finishError(err);
  });

  return settle;
}

function getVadRuntimeConfig(
  timeoutSec: number,
  source: VadInputConfig,
  overrides?: Partial<VadInputConfig>,
): VADRuntimeConfig {
  const merged = { ...source, ...(overrides ?? {}) };
  const maxDurationMs = Math.min(
    Math.max(1_000, Math.floor(timeoutSec * 1000)),
    normalizePositiveMs(merged.maxDurationMs, 90_000),
    90_000,
  );
  const noSpeechTimeoutMs = Math.min(
    normalizePositiveMs(merged.noSpeechTimeoutMs, 15_000),
    maxDurationMs,
  );

  return {
    rmsThreshold: normalizeThreshold(merged.rmsThreshold, 0.01),
    silenceMs: normalizePositiveMs(merged.silenceMs, 1_500),
    preRollMs: normalizePositiveMs(merged.preRollMs, 300),
    minSpeechMs: normalizePositiveMs(merged.minSpeechMs, 500),
    noSpeechTimeoutMs,
    maxDurationMs,
  };
}

function normalizeThreshold(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(1, Math.max(0.0001, value));
}

function normalizePositiveMs(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
}

function normalizeUnit(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(1, Math.max(0, value));
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function clampInt16(value: number): number {
  if (value > 32767) return 32767;
  if (value < -32768) return -32768;
  return value | 0;
}

function resolveNoiseProfile(noiseControl: NoiseControlInput): NoiseProfile {
  return noiseControl.profile === 'high-noise' ? 'high-noise' : 'normal';
}

function createAdaptiveNoiseState(vadConfig: VADRuntimeConfig, noiseControl: NoiseControlInput): AdaptiveNoiseState {
  const profile = resolveNoiseProfile(noiseControl);
  const tuning = NOISE_PROFILE_TUNING[profile];
  const minThreshold = normalizeThreshold(vadConfig.rmsThreshold * tuning.minThresholdScale, vadConfig.rmsThreshold);
  const maxThreshold = normalizeThreshold(vadConfig.rmsThreshold * tuning.maxThresholdScale, vadConfig.rmsThreshold);
  const baselineThreshold = clamp(vadConfig.rmsThreshold, minThreshold, maxThreshold);
  const baselineNoise = clamp(baselineThreshold / Math.max(1.1, tuning.noiseFloorMultiplier), 0.0001, 0.2);

  return {
    adaptiveEnabled: noiseControl.adaptiveRms !== false,
    denoiseEnabled: noiseControl.denoise !== false,
    tuning,
    baseThreshold: baselineThreshold,
    minThreshold,
    maxThreshold,
    noiseFloorRms: baselineNoise,
    dynamicThreshold: baselineThreshold,
    denoiseGain: 1,
    initialized: false,
  };
}

function updateAdaptiveNoiseThreshold(state: AdaptiveNoiseState, observedRms: number, strongEcho: boolean): number {
  if (!state.adaptiveEnabled) return state.baseThreshold;

  const rms = clamp(observedRms, 0.0001, 1);
  if (!state.initialized) {
    state.noiseFloorRms = rms;
    state.dynamicThreshold = clamp(
      Math.max(state.baseThreshold, state.noiseFloorRms * state.tuning.noiseFloorMultiplier),
      state.minThreshold,
      state.maxThreshold,
    );
    state.initialized = true;
    return state.dynamicThreshold;
  }

  const nearSilence = rms < (state.dynamicThreshold * 0.92);
  const floorAlpha = strongEcho || nearSilence
    ? (rms > state.noiseFloorRms ? state.tuning.noiseRiseAlpha : state.tuning.noiseFallAlpha)
    : 0.01;

  state.noiseFloorRms += (rms - state.noiseFloorRms) * floorAlpha;

  const targetThreshold = clamp(
    Math.max(state.baseThreshold, state.noiseFloorRms * state.tuning.noiseFloorMultiplier),
    state.minThreshold,
    state.maxThreshold,
  );
  const thresholdAlpha = targetThreshold > state.dynamicThreshold
    ? state.tuning.thresholdRiseAlpha
    : state.tuning.thresholdFallAlpha;

  state.dynamicThreshold += (targetThreshold - state.dynamicThreshold) * thresholdAlpha;
  state.dynamicThreshold = clamp(state.dynamicThreshold, state.minThreshold, state.maxThreshold);
  return state.dynamicThreshold;
}

function applyAdaptiveNoiseGate(chunk: Buffer, state: AdaptiveNoiseState): Buffer {
  if (!state.denoiseEnabled || chunk.length < 2) return chunk;
  const sampleCount = Math.floor(chunk.length / 2);
  if (sampleCount <= 0) return chunk;

  const out = Buffer.allocUnsafe(sampleCount * 2);
  const openLevel = Math.max(0.00025, state.noiseFloorRms * state.tuning.denoiseOpenRatio);
  const fullLevel = Math.max(openLevel * 1.2, state.noiseFloorRms * state.tuning.denoiseFullRatio);
  const minGain = normalizeUnit(state.tuning.denoiseMinGain, 0.2);
  let gain = clamp(state.denoiseGain, minGain, 1);

  for (let i = 0; i < sampleCount; i++) {
    const sample = chunk.readInt16LE(i * 2);
    const magnitude = Math.abs(sample) / 32768;
    let targetGain = 1;
    if (magnitude <= openLevel) {
      targetGain = minGain;
    } else if (magnitude < fullLevel) {
      const ratio = (magnitude - openLevel) / Math.max(1e-9, fullLevel - openLevel);
      const eased = ratio * ratio * (3 - (2 * ratio));
      targetGain = minGain + ((1 - minGain) * eased);
    }

    const alpha = targetGain > gain ? state.tuning.denoiseAttack : state.tuning.denoiseRelease;
    gain += (targetGain - gain) * alpha;
    out.writeInt16LE(clampInt16(Math.round(sample * gain)), i * 2);
  }

  state.denoiseGain = clamp(gain, minGain, 1);
  return out;
}

function openProxyAsrStream(endpoint: string): Promise<WebSocket> {
  const streamUrl = resolveStreamEndpoint(endpoint);
  const authHeaders = signRequest('', 'GET', streamUrl.pathname || '/v1/asr/stream');
  streamUrl.searchParams.set('ts', authHeaders['X-Ec-Timestamp']);
  streamUrl.searchParams.set('sig', authHeaders['X-Ec-Signature']);

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(streamUrl.toString());
    const timeout = setTimeout(() => {
      try { ws.terminate(); } catch { /* ignore */ }
      reject(new Error('Proxy ASR stream connect timeout'));
    }, 8_000);

    const onOpen = () => {
      clearTimeout(timeout);
      ws.off('error', onError);
      resolve(ws);
    };
    const onError = (err: Error) => {
      clearTimeout(timeout);
      ws.off('open', onOpen);
      reject(err);
    };

    ws.once('open', onOpen);
    ws.once('error', onError);
  });
}

interface ProxyStreamEvent {
  type: 'partial' | 'final' | 'error';
  text?: string;
  error?: string;
}

function createProxyStreamResultPromise(
  ws: WebSocket,
  onEvent?: (event: ProxyStreamEvent) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let latestText = '';

    const finishResolve = (value: string) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const finishReject = (err: Error) => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    ws.on('message', (data: RawData, isBinary: boolean) => {
      if (isBinary) return;
      try {
        const raw = typeof data === 'string' ? data : data.toString('utf-8');
        const msg = JSON.parse(raw) as {
          type?: string;
          text?: string;
          error?: string;
        };
        if (msg.type === 'partial') {
          latestText = (msg.text || '').trim();
          onEvent?.({ type: 'partial', text: latestText });
          return;
        }
        if (msg.type === 'final') {
          onEvent?.({ type: 'final', text: (msg.text || latestText || '').trim() });
          finishResolve((msg.text || latestText || '').trim());
          return;
        }
        if (msg.type === 'error') {
          onEvent?.({ type: 'error', error: msg.error || 'ASR stream failed' });
          finishReject(new Error(msg.error || 'ASR stream failed'));
        }
      } catch {
        // Ignore malformed text frames.
      }
    });

    ws.on('close', () => {
      if (!settled) finishResolve(latestText);
    });

    ws.on('error', (err: Error) => {
      if (!settled) finishReject(err instanceof Error ? err : new Error('ASR stream websocket error'));
    });
  });
}

function resolveStreamEndpoint(endpoint: string): URL {
  const parsed = new URL(endpoint);
  parsed.search = '';
  parsed.hash = '';

  const cleanPath = parsed.pathname.replace(/\/+$/, '');
  if (cleanPath.endsWith('/stream')) {
    parsed.pathname = cleanPath;
  } else if (cleanPath.endsWith('/v1/asr') || cleanPath.endsWith('/asr')) {
    parsed.pathname = `${cleanPath}/stream`;
  } else if (!cleanPath || cleanPath === '/') {
    parsed.pathname = '/v1/asr/stream';
  } else {
    parsed.pathname = `${cleanPath}/stream`;
  }

  if (parsed.protocol === 'https:') parsed.protocol = 'wss:';
  else if (parsed.protocol === 'http:') parsed.protocol = 'ws:';
  return parsed;
}

function shouldFallbackToBatch(err: unknown): boolean {
  const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  return (
    msg.includes('unexpected server response: 404') ||
    msg.includes('unexpected server response: 426') ||
    msg.includes('unexpected server response: 405') ||
    msg.includes('stream connect timeout')
  );
}

function pcmBytesToMs(bytes: number): number {
  if (bytes <= 0) return 0;
  return (bytes / PCM_BYTES_PER_SECOND) * 1000;
}

function applyEchoVadFrame(
  chunk: Buffer,
  rmsThreshold: number,
  nowMs: number,
  noiseState?: AdaptiveNoiseState,
): EchoVadFrame {
  const echoFilteredChunk = filterEchoChunk(chunk, nowMs);
  const rawRms = computeRms(chunk);
  const echoFilteredRms = computeRms(echoFilteredChunk);
  const strongEcho = shouldSuppressEchoChunk(chunk, nowMs);
  const activeThreshold = noiseState
    ? updateAdaptiveNoiseThreshold(noiseState, echoFilteredRms, strongEcho)
    : rmsThreshold;
  const filteredChunk = noiseState
    ? applyAdaptiveNoiseGate(echoFilteredChunk, noiseState)
    : echoFilteredChunk;
  const filteredRms = computeRms(filteredChunk);
  const ratio = filteredRms / Math.max(1e-9, rawRms);
  const echoLikely = strongEcho || (rawRms >= activeThreshold && ratio <= ECHO_ONLY_RMS_RATIO_MAX);
  const voicedByFiltered = filteredRms >= activeThreshold;
  const voicedByDoubleTalk = filteredRms >= (activeThreshold * ECHO_DOUBLE_TALK_RMS_FACTOR);
  const voiced = voicedByFiltered && (!strongEcho || voicedByDoubleTalk) && (!echoLikely || voicedByDoubleTalk);

  return {
    filteredChunk,
    rawRms,
    filteredRms,
    activeThreshold,
    strongEcho,
    echoLikely,
    voicedByFiltered,
    voicedByDoubleTalk,
    voiced,
  };
}

function computeRms(pcmChunk: Buffer): number {
  const sampleCount = Math.floor(pcmChunk.length / 2);
  if (sampleCount <= 0) return 0;

  let sumSquares = 0;
  for (let i = 0; i < sampleCount; i++) {
    const s = pcmChunk.readInt16LE(i * 2) / 32768;
    sumSquares += s * s;
  }
  return Math.sqrt(sumSquares / sampleCount);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function createUnixSocketPath(prefix: string): string {
  const baseDir = os.platform() === 'darwin' ? '/tmp' : os.tmpdir();
  const compactTs = Date.now().toString(36);
  const random = crypto.randomBytes(3).toString('hex');
  let candidate = path.join(baseDir, `${prefix}-${process.pid}-${compactTs}-${random}.sock`);

  // macOS AF_UNIX path length is limited. Keep a short deterministic fallback.
  if (candidate.length > MAX_UNIX_SOCKET_PATH_LENGTH) {
    const shortId = crypto.randomBytes(6).toString('hex');
    candidate = path.join('/tmp', `${prefix}-${shortId}.sock`);
  }

  return candidate;
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
    const bodyText = await response.text().catch(() => '');
    throw new Error(`Volcengine ASR error: ${response.status}${bodyText ? ` ${bodyText.slice(0, 200)}` : ''}`);
  }

  const result = await response.json() as {
    code?: number;
    message?: string;
    result?: Array<{ text?: string }>;
  };

  if (result.code !== 1000 || !result.result?.[0]?.text) {
    throw new Error(`Volcengine ASR failed: ${result.message || result.code}`);
  }

  const text = result.result[0].text.trim();
  return text || '[empty]';
}

/**
 * Call our proxy (api.echoclaw.com/v1/asr).
 * Proxy holds the Volcengine key — client sends base64 audio.
 */
async function callProxyAsr(audioBase64: string, endpoint: string, format: 'ogg' | 'wav' = 'wav'): Promise<string> {
  const bodyStr = JSON.stringify({
    audio: audioBase64,
    format,
    language: 'zh-CN',
  });
  const authHeaders = signRequest(bodyStr, 'POST', resolveEndpointPath(endpoint, '/v1/asr'));

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders },
    body: bodyStr,
  });

  if (!response.ok) {
    const bodyText = await response.text().catch(() => '');
    const lower = bodyText.toLowerCase();
    if (
      response.status === 500 &&
      (lower.includes('websocket closed without result') || lower.includes('closed without result'))
    ) {
      return '[empty]';
    }
    throw new Error(`Proxy ASR error: ${response.status}${bodyText ? ` ${bodyText.slice(0, 200)}` : ''}`);
  }

  const result = await response.json() as { text?: string; error?: string };

  if (result.error) {
    throw new Error(`Proxy ASR: ${result.error}`);
  }

  const text = result.text?.trim();
  return text || '[empty]';
}

// --- Cleanup ---

export function disposeAsr(): void {
  closeSharedAskHudNow();
  closeSharedAskMicNow();
  recognizer = null;
  vad = null;
}

interface NormalizedAudio {
  file: string;
  format: 'ogg' | 'wav';
}

function normalizeAudioForCloud(inputFile: string): NormalizedAudio {
  // V3 BigASR only supports wav/pcm — normalize to standard 16kHz mono PCM WAV
  const wavFile = path.join(TEMP_DIR, `rec-normalized-${Date.now()}.wav`);
  try {
    execFileSync(
      'sox',
      [inputFile, '-t', 'wav', '-e', 'signed-integer', '-b', '16', '-r', '16000', '-c', '1', wavFile],
      { stdio: 'ignore', timeout: 8_000 },
    );
    if (fs.existsSync(wavFile) && fs.statSync(wavFile).size > 44) {
      return { file: wavFile, format: 'wav' };
    }
  } catch { /* keep original */ }
  try { fs.unlinkSync(wavFile); } catch { /* ignore */ }

  return { file: inputFile, format: 'wav' };
}

function resolveEndpointPath(endpoint: string, fallback: string): string {
  try {
    const parsed = new URL(endpoint);
    return parsed.pathname || fallback;
  } catch {
    return fallback;
  }
}
