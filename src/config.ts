import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

export type TtsProvider = 'local' | 'cloud';
export type TtsEngine = 'orpheus' | 'kokoro' | 'system';
export type AsrProvider = 'local' | 'cloud';
export type AsrEngine = 'paraformer' | 'whisper';
export type AsrNoiseProfile = 'normal' | 'high-noise';

export type VoiceLevel = 'minimal' | 'balanced' | 'verbose';
export type EchoClientId = 'default' | 'claude' | 'codex';
type ScopedClientId = Exclude<EchoClientId, 'default'>;

interface ClientModeOverrides {
  enabled?: boolean;
  mode?: EchoConfig['mode'];
  voiceLevel?: VoiceLevel;
}

interface EchoConfigFile extends EchoConfig {
  clients?: Partial<Record<ScopedClientId, ClientModeOverrides>>;
}

export interface EchoConfig {
  enabled: boolean;
  theme: string;
  volume: number;
  mode: 'full' | 'sfx-only' | 'voice-only' | 'focus' | 'mute';
  voiceLevel: VoiceLevel;
  autoVoiceMode: boolean; // if true, balanced voice mode activates automatically each session
  tts: {
    enabled: boolean;
    provider: TtsProvider;
    engine: TtsEngine;
    // Local engine settings
    local: {
      modelsDir: string;       // where downloaded models live
      orpheusModel: string;    // model variant: '150m' | '400m' | '1b'
      kokoroModel: string;     // kokoro model name
    };
    // Cloud API settings (Volcengine or proxy)
    cloud: {
      endpoint: string;     // api.echoclaw.com/v1/tts (proxy) or openspeech.bytedance.com (direct)
      apiKey: string;        // only needed for direct Volcengine calls
      appId: string;         // Volcengine App ID (only for direct calls)
      stream: boolean;
    };
    voice: string;
    volume: number;
    speed: number;
    language: 'zh' | 'en' | 'auto';
    emotion: boolean;          // enable emotion tags (Orpheus only)
    throttle: {
      minInterval: number;
      dedupWindow: number;
    };
  };
  asr: {
    enabled: boolean;
    provider: AsrProvider;
    engine: AsrEngine;
    local: {
      modelsDir: string;
    };
    cloud: {
      endpoint: string;     // api.echoclaw.com/v1/asr (proxy) or Volcengine direct
      apiKey: string;
      appId: string;         // Volcengine App ID
    };
    vad: {
      rmsThreshold: number;
      silenceMs: number;
      preRollMs: number;
      minSpeechMs: number;
      noSpeechTimeoutMs: number;
      maxDurationMs: number;
    };
    noiseControl: {
      profile: AsrNoiseProfile;
      adaptiveRms: boolean;
      denoise: boolean;
    };
    timeout: number;
  };
  sfx: {
    enabled: boolean;
    volume: number;
  };
  daemon: {
    socketPath: string;
    logFile: string;
    pidFile: string;
  };
}

const CONFIG_DIR = path.join(os.homedir(), '.echocoding');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.yaml');

const DEFAULT_ZH_CLOUD_VOICE = 'zh_female_wanwanxiaohe_moon_bigtts';
const DEFAULT_EN_CLOUD_VOICE = 'BV001_streaming';

function normalizeLocale(raw: string): string {
  return raw
    .trim()
    .split(':')[0]
    .split('.')[0]
    .split('@')[0]
    .replace(/_/g, '-')
    .toLowerCase();
}

function detectSystemLocale(env: NodeJS.ProcessEnv = process.env): string {
  const envLocale = [env.LC_ALL, env.LC_MESSAGES, env.LANG, env.LANGUAGE].find(
    (value) => typeof value === 'string' && value.trim().length > 0,
  );
  if (envLocale) return normalizeLocale(envLocale);

  try {
    const intlLocale = Intl.DateTimeFormat().resolvedOptions().locale;
    if (intlLocale) return normalizeLocale(intlLocale);
  } catch {
    // ignore — keep fallback
  }

  return 'en';
}

function detectDefaultCloudVoice(env: NodeJS.ProcessEnv = process.env): string {
  return detectSystemLocale(env).startsWith('zh')
    ? DEFAULT_ZH_CLOUD_VOICE
    : DEFAULT_EN_CLOUD_VOICE;
}

function createDefaultConfig(env: NodeJS.ProcessEnv = process.env): EchoConfig {
  return {
    enabled: true,
    theme: 'default',
    volume: 70,
    mode: 'full',
    voiceLevel: 'balanced',
    autoVoiceMode: true,
    tts: {
      enabled: true,
      provider: 'cloud',
      engine: 'kokoro',
      local: {
        modelsDir: path.join(CONFIG_DIR, 'models'),
        orpheusModel: '150m',
        kokoroModel: 'kokoro-multi-lang-v1_1',
      },
      cloud: {
        endpoint: 'https://coding.echoclaw.me/v1/tts',
        apiKey: '',
        appId: '',
        stream: true,
      },
      // First-run default: Chinese systems use 湾湾小何, others use English female.
      voice: detectDefaultCloudVoice(env),
      volume: 100,
      speed: 1.0,
      language: 'auto',
      emotion: true,
      throttle: {
        minInterval: 3,
        dedupWindow: 30,
      },
    },
    asr: {
      enabled: true,
      provider: 'cloud',
      engine: 'paraformer',
      local: {
        modelsDir: path.join(CONFIG_DIR, 'models'),
      },
      cloud: {
        endpoint: 'https://coding.echoclaw.me/v1/asr',
        apiKey: '',
        appId: '',
      },
      vad: {
        rmsThreshold: 0.01,
        silenceMs: 1500,
        preRollMs: 300,
        minSpeechMs: 500,
        noSpeechTimeoutMs: 15000,
        maxDurationMs: 90000,
      },
      noiseControl: {
        profile: 'normal',
        adaptiveRms: true,
        denoise: true,
      },
      timeout: 90,
    },
    sfx: {
      enabled: true,
      volume: 80,
    },
    daemon: {
      socketPath: '/tmp/echocoding.sock',
      logFile: path.join(CONFIG_DIR, 'logs', 'daemon.log'),
      pidFile: path.join(CONFIG_DIR, 'daemon.pid'),
    },
  };
}

const DEFAULT_CONFIG: EchoConfig = createDefaultConfig();

export function getConfigDir(): string {
  return CONFIG_DIR;
}

export function ensureConfigDir(): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.mkdirSync(path.join(CONFIG_DIR, 'logs'), { recursive: true });
}

export function getConfig(): EchoConfig {
  const merged = loadMergedConfig();
  const clientId = getRuntimeClientId();
  const withOverrides = applyClientRuntimeOverrides(merged, clientId);
  const { clients: _clients, ...effectiveConfig } = withOverrides;
  return effectiveConfig;
}

export function saveConfig(config: EchoConfig): void {
  ensureConfigDir();
  const clientId = getRuntimeClientId();
  const baseline = loadMergedConfig();
  const next = deepMerge(
    baseline as unknown as Record<string, unknown>,
    config as unknown as Record<string, unknown>,
  ) as unknown as EchoConfigFile;

  if (clientId !== 'default') {
    resetGlobalRuntimeFields(next, baseline);
    const scopedOverride = normalizeClientRuntimeOverride({
      ...(baseline.clients?.[clientId] ?? {}),
      ...(next.clients?.[clientId] ?? {}),
      ...captureClientRuntimeOverrides(config),
    });
    next.clients = {
      ...(baseline.clients ?? {}),
      ...(next.clients ?? {}),
      [clientId]: scopedOverride,
    };
  }

  fs.writeFileSync(CONFIG_FILE, stringifyYaml(next), 'utf-8');
}

export function setConfigValue(keyPath: string, value: string): void {
  const config = getConfig();
  setNestedValue(config as unknown as Record<string, unknown>, keyPath, parseValue(value));
  saveConfig(config);
}

export function getConfigValue(keyPath: string): unknown {
  const config = getConfig();
  return getNestedValue(config as unknown as Record<string, unknown>, keyPath);
}

export function getSoundsDir(theme?: string): string {
  const t = theme ?? getConfig().theme;
  return path.join(getPackageRoot(), 'sounds', t);
}

export function getRuntimeClientId(env: NodeJS.ProcessEnv = process.env): EchoClientId {
  const explicitRaw = env.ECHOCODING_CLIENT ?? env.ECHOCODING_HOOK_CLIENT;
  if (explicitRaw !== undefined) {
    return normalizeClientId(explicitRaw);
  }

  // Codex Desktop/CLI environment markers.
  if (env.CODEX_THREAD_ID || env.CODEX_CI || env.CODEX_SHELL || env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE) {
    return 'codex';
  }

  // Claude Code environment markers.
  if (env.CLAUDECODE || env.CLAUDE_CODE || env.CLAUDE_CODE_SESSION || env.CLAUDE_SESSION_ID) {
    return 'claude';
  }

  return 'default';
}

export function resolveDaemonPaths(
  daemon: EchoConfig['daemon'],
  clientId: EchoClientId = getRuntimeClientId(),
): EchoConfig['daemon'] {
  if (clientId === 'default') {
    return { ...daemon };
  }

  return {
    socketPath: appendClientSuffix(daemon.socketPath, clientId),
    logFile: appendClientSuffix(daemon.logFile, clientId),
    pidFile: appendClientSuffix(daemon.pidFile, clientId),
  };
}

export function getPackageRoot(): string {
  // Walk up from this file to find package.json
  // Use fileURLToPath for correct Windows path handling
  let dir = path.dirname(fileURLToPath(import.meta.url));
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'package.json'))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  return process.cwd();
}

// --- Helpers ---

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (
      source[key] &&
      typeof source[key] === 'object' &&
      !Array.isArray(source[key]) &&
      target[key] &&
      typeof target[key] === 'object'
    ) {
      result[key] = deepMerge(
        target[key] as Record<string, unknown>,
        source[key] as Record<string, unknown>,
      );
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

function setNestedValue(obj: Record<string, unknown>, keyPath: string, value: unknown): void {
  const keys = keyPath.split('.');
  let current = obj as Record<string, unknown>;
  for (let i = 0; i < keys.length - 1; i++) {
    if (!current[keys[i]] || typeof current[keys[i]] !== 'object') {
      current[keys[i]] = {};
    }
    current = current[keys[i]] as Record<string, unknown>;
  }
  current[keys[keys.length - 1]] = value;
}

function getNestedValue(obj: Record<string, unknown>, keyPath: string): unknown {
  const keys = keyPath.split('.');
  let current: unknown = obj;
  for (const key of keys) {
    if (current == null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function parseValue(value: string): unknown {
  if (value === 'true') return true;
  if (value === 'false') return false;
  const num = Number(value);
  if (!isNaN(num) && value.trim() !== '') return num;
  return value;
}

function normalizeClientId(raw: string | undefined): EchoClientId {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === 'claude' || value === 'codex') return value;
  return 'default';
}

function loadMergedConfig(): EchoConfigFile {
  const parsed = loadConfigFile();
  return deepMerge(
    DEFAULT_CONFIG as unknown as Record<string, unknown>,
    parsed as unknown as Record<string, unknown>,
  ) as unknown as EchoConfigFile;
}

function loadConfigFile(): Partial<EchoConfigFile> {
  try {
    if (!fs.existsSync(CONFIG_FILE)) return {};
    const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
    const parsed = parseYaml(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as Partial<EchoConfigFile>;
  } catch {
    return {};
  }
}

function applyClientRuntimeOverrides(config: EchoConfigFile, clientId: EchoClientId): EchoConfigFile {
  if (clientId === 'default') return config;
  const override = normalizeClientRuntimeOverride(config.clients?.[clientId]);
  if (!override) return config;

  const next: EchoConfigFile = { ...config };

  if (override.enabled !== undefined) next.enabled = override.enabled;
  if (override.mode !== undefined) next.mode = override.mode;
  if (override.voiceLevel !== undefined) next.voiceLevel = override.voiceLevel;

  return next;
}

function resetGlobalRuntimeFields(next: EchoConfigFile, baseline: EchoConfigFile): void {
  next.enabled = baseline.enabled;
  next.mode = baseline.mode;
  next.voiceLevel = baseline.voiceLevel;
}

function captureClientRuntimeOverrides(config: EchoConfig): ClientModeOverrides {
  return {
    enabled: config.enabled,
    mode: config.mode,
    voiceLevel: config.voiceLevel,
  };
}

function normalizeClientRuntimeOverride(override: ClientModeOverrides | undefined): ClientModeOverrides | undefined {
  if (!override) return undefined;
  const next: ClientModeOverrides = {};
  if (override.enabled !== undefined) next.enabled = override.enabled;
  if (override.mode !== undefined) next.mode = override.mode;
  if (override.voiceLevel !== undefined) next.voiceLevel = override.voiceLevel;
  return next;
}

function appendClientSuffix(filePath: string, clientId: EchoClientId): string {
  const parsed = path.parse(filePath);
  const marker = `.${clientId}`;

  if (parsed.ext) {
    if (parsed.name.endsWith(marker)) return filePath;
    return path.join(parsed.dir, `${parsed.name}${marker}${parsed.ext}`);
  }

  if (parsed.base.endsWith(marker)) return filePath;
  return path.join(parsed.dir, `${parsed.base}${marker}`);
}
