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

function upsertClaudeManagedGroup(
  hooks: Record<string, ClaudeHookMatcher[]>,
  eventName: string,
  managedCommandNeedles: string[],
  desiredGroup: ClaudeHookMatcher,
): boolean {
  const groups = hooks[eventName] ?? [];
  const normalized: ClaudeHookMatcher[] = groups
    .map((group) => {
      const retainedHooks = group.hooks.filter(
        (hook) => !managedCommandNeedles.some((needle) => hook.command.includes(needle)),
      );
      if (retainedHooks.length === 0) return null;
      return {
        ...group,
        hooks: retainedHooks,
      };
    })
    .filter((group): group is ClaudeHookMatcher => group !== null);

  normalized.push({
    matcher: desiredGroup.matcher ?? '',
    hooks: desiredGroup.hooks.map((hook) => ({ ...hook })),
  });

  hooks[eventName] = normalized;
  return JSON.stringify(groups) !== JSON.stringify(normalized);
}

function getHookCommand(): string {
  const hookScript = path.join(getPackageRoot(), 'dist', 'bin', 'echocoding-hook.js');
  const nodePath = resolveRuntimeNodePath();
  return `ECHOCODING_CLIENT=claude ${nodePath} ${hookScript}`;
}

function getVoiceReminderCommand(): string {
  const script = path.join(getPackageRoot(), 'scripts', 'voice-reminder.sh');
  return `ECHOCODING_HOOK_CLIENT=claude ECHOCODING_CLIENT=claude bash ${script}`;
}

function getVoiceAskNudgeCommand(): string {
  const script = path.join(getPackageRoot(), 'scripts', 'voice-ask-nudge.sh');
  return `ECHOCODING_HOOK_CLIENT=claude bash ${script}`;
}

function getVoiceAutoModeCommand(): string {
  const script = path.join(getPackageRoot(), 'scripts', 'voice-auto-mode.sh');
  return `ECHOCODING_HOOK_CLIENT=claude bash ${script}`;
}

function getAutoStartCommand(): string {
  const script = path.join(getPackageRoot(), 'scripts', 'auto-start.sh');
  const nodePath = resolveRuntimeNodePath();
  // Pass Node path as env so auto-start.sh doesn't need to hunt for it
  return `ECHOCODING_CLIENT=claude ECHOCODING_NODE=${nodePath} bash ${script}`;
}

function resolveRuntimeNodePath(): string {
  const stableCandidates = [
    '/opt/homebrew/bin/node', // Apple Silicon Homebrew
    '/usr/local/bin/node',    // Intel Homebrew / common global path
  ];
  for (const candidate of stableCandidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Try next candidate.
    }
  }
  return process.execPath;
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
      // Check if EchoCoding hooks are actually injected in settings.json
      try {
        if (fs.existsSync(CLAUDE_SETTINGS_PATH)) {
          const raw = fs.readFileSync(CLAUDE_SETTINGS_PATH, 'utf-8');
          detection.integrated = raw.includes('echocoding-hook');
        }
      } catch {
        // Can't read settings — treat as not integrated
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

    // Inject EchoCoding hooks (preserve unrelated hooks, upsert managed hooks)
    let injected = 0;
    for (const [eventName, config] of Object.entries(HOOK_CONFIG)) {
      if (eventName === 'SessionStart' || eventName === 'UserPromptSubmit' || eventName === 'Stop') continue;
      if (upsertClaudeManagedGroup(settings.hooks, eventName, ['echocoding-hook'], {
        matcher: '',
        hooks: [
          {
            type: 'command',
            command: getHookCommand(),
            ...(config.async ? { async: true } : {}),
          },
        ],
      })) {
        injected++;
      }
    }

    // SessionStart: voice-auto-mode (blocking) + auto-start + hook.
    if (upsertClaudeManagedGroup(settings.hooks, 'SessionStart', ['echocoding-hook', 'auto-start', 'voice-auto-mode'], {
      matcher: '',
      hooks: [
        {
          type: 'command',
          command: getVoiceAutoModeCommand(),
          // blocking (no async) — stdout injected as session-start context
        },
        {
          type: 'command',
          command: getAutoStartCommand(),
          async: true, // non-blocking — daemon starts in background
        },
        {
          type: 'command',
          command: getHookCommand(),
          async: true,
        },
      ],
    })) {
      injected++;
    }

    // UserPromptSubmit: keep reminder + hook in one group.
    if (upsertClaudeManagedGroup(settings.hooks, 'UserPromptSubmit', ['echocoding-hook', 'voice-reminder'], {
      matcher: '',
      hooks: [
        {
          type: 'command',
          command: getVoiceReminderCommand(),
          // blocking (no async) — stdout is injected as system message
        },
        {
          type: 'command',
          command: getHookCommand(),
          async: true,
        },
      ],
    })) {
      injected++;
    }

    // Stop: voice-ask-nudge (blocking) + hook.
    if (upsertClaudeManagedGroup(settings.hooks, 'Stop', ['echocoding-hook', 'voice-ask-nudge'], {
      matcher: '',
      hooks: [
        {
          type: 'command',
          command: getVoiceAskNudgeCommand(),
          // blocking (no async) — stdout injected as stop-hook context
        },
        {
          type: 'command',
          command: getHookCommand(),
          async: true,
        },
      ],
    })) {
      injected++;
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
          hooks: matcher.hooks.filter(
            (h) =>
              !h.command.includes('echocoding-hook') &&
              !h.command.includes('voice-reminder') &&
              !h.command.includes('voice-ask-nudge') &&
              !h.command.includes('voice-auto-mode') &&
              !h.command.includes('auto-start'),
          ),
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
