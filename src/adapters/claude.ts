import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import type { ClientAdapter, AdapterDetection, AdapterResult } from './types.js';

// --- Shared utilities ---

export function getPackageRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'package.json'))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  return process.cwd();
}

export function writeSettingsSafe(settingsPath: string, settings: Record<string, unknown>): void {
  const content = JSON.stringify(settings, null, 2) + '\n';
  const tmpPath = settingsPath + '.tmp';
  const bakPath = settingsPath + '.echocoding.bak';

  // Backup existing file
  if (fs.existsSync(settingsPath)) {
    fs.copyFileSync(settingsPath, bakPath);
  }

  // Atomic write: write to tmp, then rename
  fs.writeFileSync(tmpPath, content);
  fs.renameSync(tmpPath, settingsPath);
}

// --- Claude Code hook types ---

interface ClaudeHookEntry {
  type: string;
  command: string;
  async?: boolean;
}

interface ClaudeHookMatcher {
  matcher?: string;
  hooks: ClaudeHookEntry[];
}

interface ClaudeSettings {
  hooks?: Record<string, ClaudeHookMatcher[]>;
  [key: string]: unknown;
}

// --- Hook configuration ---

const HOOK_CONFIG: Record<string, { async: boolean }> = {
  SessionStart: { async: true },
  UserPromptSubmit: { async: true },
  PreToolUse: { async: true },
  PostToolUse: { async: true },
  Notification: { async: false },
  Stop: { async: true },
  SubagentStart: { async: true },
  SubagentStop: { async: true },
  PreCompact: { async: true },
};

function getHookCommand(): string {
  const hookScript = path.join(getPackageRoot(), 'dist', 'bin', 'echocoding-hook.js');
  // Use absolute path to node — hook env may not have /opt/homebrew/bin in PATH
  const nodePath = process.execPath;
  return `${nodePath} ${hookScript}`;
}

// --- Claude Code adapter ---

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const CLAUDE_SETTINGS_PATH = path.join(CLAUDE_DIR, 'settings.json');
const SKILL_PATH = path.join(CLAUDE_DIR, 'commands', 'echocoding.md');

export const claudeAdapter: ClientAdapter = {
  id: 'claude-code',
  name: 'Claude Code',
  mechanism: 'hook',

  detect(): AdapterDetection {
    const installed = fs.existsSync(CLAUDE_DIR);
    const detection: AdapterDetection = { installed };
    if (installed) {
      detection.configPath = CLAUDE_SETTINGS_PATH;
      detection.integrated = false;
      try {
        if (fs.existsSync(CLAUDE_SETTINGS_PATH)) {
          const raw = fs.readFileSync(CLAUDE_SETTINGS_PATH, 'utf-8');
          detection.integrated = raw.includes('echocoding-hook');
        }
      } catch {
        // Can't read settings - treat as not integrated
      }
    }
    return detection;
  },

  install(): AdapterResult {
    if (!fs.existsSync(CLAUDE_DIR)) {
      return {
        success: false,
        message: `Claude Code settings directory not found: ${CLAUDE_DIR}`,
      };
    }

    // Read existing settings
    let settings: ClaudeSettings = {};
    if (fs.existsSync(CLAUDE_SETTINGS_PATH)) {
      try {
        settings = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS_PATH, 'utf-8'));
      } catch {
        return { success: false, message: 'Failed to parse existing settings.json' };
      }
    }

    if (!settings.hooks) {
      settings.hooks = {};
    }

    // Inject EchoCoding hooks (preserve existing hooks)
    let injected = 0;
    for (const [eventName, config] of Object.entries(HOOK_CONFIG)) {
      const existing = settings.hooks[eventName] ?? [];

      // Check if EchoCoding hook already exists
      const hasEchoCoding = existing.some((matcher) =>
        matcher.hooks.some((h) => h.command.includes('echocoding-hook')),
      );

      if (!hasEchoCoding) {
        const newEntry: ClaudeHookMatcher = {
          matcher: '',
          hooks: [
            {
              type: 'command',
              command: getHookCommand(),
              ...(config.async ? { async: true } : {}),
            },
          ],
        };
        existing.push(newEntry);
        settings.hooks[eventName] = existing;
        injected++;
      }
    }

    // Backup + atomic write
    writeSettingsSafe(CLAUDE_SETTINGS_PATH, settings);

    // Install skill
    const skillsDir = path.join(CLAUDE_DIR, 'commands');
    fs.mkdirSync(skillsDir, { recursive: true });

    const skillSrc = path.join(getPackageRoot(), 'skills', 'echocoding.md');
    if (fs.existsSync(skillSrc)) {
      fs.copyFileSync(skillSrc, SKILL_PATH);
    }

    return {
      success: true,
      message: injected > 0
        ? `Injected ${injected} hook(s) into Claude Code settings.json`
        : 'EchoCoding hooks already installed',
    };
  },

  uninstall(): AdapterResult {
    if (!fs.existsSync(CLAUDE_SETTINGS_PATH)) {
      return { success: false, message: 'Claude Code settings.json not found' };
    }

    let settings: ClaudeSettings;
    try {
      settings = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS_PATH, 'utf-8'));
    } catch {
      return { success: false, message: 'Failed to parse settings.json' };
    }

    if (!settings.hooks) {
      return { success: true, message: 'No hooks to remove' };
    }

    let removed = 0;
    for (const [eventName, matchers] of Object.entries(settings.hooks)) {
      const filtered = matchers
        .map((matcher) => ({
          ...matcher,
          hooks: matcher.hooks.filter((h) => !h.command.includes('echocoding-hook')),
        }))
        .filter((matcher) => matcher.hooks.length > 0);

      if (
        filtered.length !== matchers.length ||
        filtered.some((f, i) => f.hooks.length !== matchers[i].hooks.length)
      ) {
        removed++;
      }

      if (filtered.length > 0) {
        settings.hooks[eventName] = filtered;
      } else {
        delete settings.hooks[eventName];
      }
    }

    // Clean up empty hooks object
    if (Object.keys(settings.hooks).length === 0) {
      delete settings.hooks;
    }

    writeSettingsSafe(CLAUDE_SETTINGS_PATH, settings);

    // Remove skill
    try {
      fs.unlinkSync(SKILL_PATH);
    } catch {
      /* ignore */
    }

    return {
      success: true,
      message: removed > 0
        ? `Removed ${removed} EchoCoding hook(s) from settings.json`
        : 'No EchoCoding hooks found',
    };
  },

  getPromptPath(): string | null {
    return SKILL_PATH;
  },
};
