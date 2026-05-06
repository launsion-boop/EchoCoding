import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { ClientAdapter, AdapterDetection, AdapterResult } from './types.js';
import { installCodex, uninstallCodex, hasCodexHooksFeatureEnabled } from '../installer.js';

const CODEX_DIR = path.join(os.homedir(), '.codex');
const CODEX_CONFIG_PATH = path.join(CODEX_DIR, 'config.toml');
const CODEX_HOOKS_PATH = path.join(CODEX_DIR, 'hooks.json');
const CODEX_SKILLS_DIR = path.join(CODEX_DIR, 'skills');
const CODEX_INSTRUCTIONS_PATH = path.join(CODEX_DIR, 'instructions.md');
const SKILL_PATH = path.join(CODEX_SKILLS_DIR, 'echocoding', 'SKILL.md');
const MANAGED_BLOCK_START = '<!-- echocoding-voice-mode:start -->';

function hasCodexSkill(): boolean {
  return fs.existsSync(SKILL_PATH);
}

function hasManagedInstructions(): boolean {
  if (!fs.existsSync(CODEX_INSTRUCTIONS_PATH)) return false;
  try {
    return fs.readFileSync(CODEX_INSTRUCTIONS_PATH, 'utf-8').includes(MANAGED_BLOCK_START);
  } catch {
    return false;
  }
}

function hasHooksFeatureEnabled(): boolean {
  if (!fs.existsSync(CODEX_CONFIG_PATH)) return false;
  try {
    return hasCodexHooksFeatureEnabled(fs.readFileSync(CODEX_CONFIG_PATH, 'utf-8'));
  } catch {
    return false;
  }
}

function hasManagedHooks(): boolean {
  if (!fs.existsSync(CODEX_HOOKS_PATH)) return false;
  try {
    const parsed = JSON.parse(fs.readFileSync(CODEX_HOOKS_PATH, 'utf-8')) as {
      hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>>;
    };
    const sessionStart = parsed.hooks?.SessionStart ?? [];
    const userPromptSubmit = parsed.hooks?.UserPromptSubmit ?? [];

    const hasAutoStart = sessionStart.some((group) =>
      (group.hooks ?? []).some((hook) => hook.command?.includes('auto-start')),
    );
    const hasVoiceAutoMode = sessionStart.some((group) =>
      (group.hooks ?? []).some((hook) => hook.command?.includes('voice-auto-mode')),
    );
    const hasReminder = userPromptSubmit.some((group) =>
      (group.hooks ?? []).some((hook) => hook.command?.includes('voice-reminder')),
    );
    const hasHookPipeline = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop'].every((eventName) =>
      (parsed.hooks?.[eventName] ?? []).some((group) =>
        (group.hooks ?? []).some((hook) => hook.command?.includes('echocoding-hook')),
      ),
    );

    return hasAutoStart && hasVoiceAutoMode && hasReminder && hasHookPipeline;
  } catch {
    return false;
  }
}

export const codexAdapter: ClientAdapter = {
  id: 'codex',
  name: 'Codex CLI',
  mechanism: 'hook',

  detect(): AdapterDetection {
    const installed = fs.existsSync(CODEX_DIR);
    const detection: AdapterDetection = { installed };
    if (installed) {
      detection.configPath = CODEX_INSTRUCTIONS_PATH;
      detection.integrated =
        hasCodexSkill() &&
        hasManagedInstructions() &&
        hasHooksFeatureEnabled() &&
        hasManagedHooks();
    }
    return detection;
  },

  install(): AdapterResult {
    return installCodex();
  },

  uninstall(): AdapterResult {
    return uninstallCodex();
  },

  getPromptPath(): string | null {
    return SKILL_PATH;
  },
};
