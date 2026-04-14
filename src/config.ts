import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

export type TtsProvider = 'local' | 'cloud';
export type TtsEngine = 'orpheus' | 'kokoro' | 'system';
export type AsrProvider = 'local' | 'cloud';
export type AsrEngine = 'paraformer' | 'whisper';

export type VoiceLevel = 'minimal' | 'balanced' | 'verbose';

export interface EchoConfig {
  enabled: boolean;
  theme: string;
  volume: number;
  mode: 'full' | 'sfx-only' | 'voice-only' | 'focus' | 'mute';
  voiceLevel: VoiceLevel;
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

const DEFAULT_CONFIG: EchoConfig = {
  enabled: true,
  theme: 'default',
  volume: 70,
  mode: 'full',
  voiceLevel: 'balanced',
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
    voice: 'zh_female_wanwanxiaohe_moon_bigtts',
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
    timeout: 60,
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

export function getConfigDir(): string {
  return CONFIG_DIR;
}

export function ensureConfigDir(): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.mkdirSync(path.join(CONFIG_DIR, 'logs'), { recursive: true });
}

export function getConfig(): EchoConfig {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
      const parsed = parseYaml(raw) as Partial<EchoConfig>;
      return deepMerge(DEFAULT_CONFIG as unknown as Record<string, unknown>, parsed as unknown as Record<string, unknown>) as unknown as EchoConfig;
    }
  } catch {
    // Fall through to default
  }
  return { ...DEFAULT_CONFIG };
}

export function saveConfig(config: EchoConfig): void {
  ensureConfigDir();
  fs.writeFileSync(CONFIG_FILE, stringifyYaml(config), 'utf-8');
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
