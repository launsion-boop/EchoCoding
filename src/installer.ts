import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { compilePrompt } from './prompt-compiler.js';

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

const CLAUDE_SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');

function getHookCommand(): string {
  const hookScript = path.join(getPackageRoot(), 'dist', 'bin', 'echocoding-hook.js');
  // Use absolute path to node — hook env may not have /opt/homebrew/bin in PATH
  const nodePath = process.execPath;
  return `${nodePath} ${hookScript}`;
}

/**
 * The hooks we inject into Claude Code settings.json.
 */
const HOOK_CONFIG: Record<string, { async: boolean }> = {
  SessionStart: { async: true },
  UserPromptSubmit: { async: true },
  PreToolUse: { async: true },
  PostToolUse: { async: true },
  Notification: { async: false }, // Sync — may need to intercept permission prompts
  Stop: { async: true },
  SubagentStart: { async: true },
  SubagentStop: { async: true },
  PreCompact: { async: true },
};

export function installClaudeCode(): { success: boolean; message: string } {
  const settingsDir = path.dirname(CLAUDE_SETTINGS_PATH);

  // Check Claude Code is installed
  if (!fs.existsSync(settingsDir)) {
    return {
      success: false,
      message: `Claude Code settings directory not found: ${settingsDir}`,
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
  writeSettingsSafe(settings);

  // Install skill
  installSkill();

  return {
    success: true,
    message: injected > 0
      ? `Injected ${injected} hook(s) into Claude Code settings.json`
      : 'EchoCoding hooks already installed',
  };
}

export function uninstallClaudeCode(): { success: boolean; message: string } {
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

    if (filtered.length !== matchers.length || filtered.some((f, i) => f.hooks.length !== matchers[i].hooks.length)) {
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

  writeSettingsSafe(settings);

  // Remove skill
  uninstallSkill();

  return {
    success: true,
    message: removed > 0
      ? `Removed ${removed} EchoCoding hook(s) from settings.json`
      : 'No EchoCoding hooks found',
  };
}

/**
 * Write settings.json with backup + atomic rename.
 */
function writeSettingsSafe(settings: ClaudeSettings): void {
  const content = JSON.stringify(settings, null, 2) + '\n';
  const tmpPath = CLAUDE_SETTINGS_PATH + '.tmp';
  const bakPath = CLAUDE_SETTINGS_PATH + '.echocoding.bak';

  // Backup existing file
  if (fs.existsSync(CLAUDE_SETTINGS_PATH)) {
    fs.copyFileSync(CLAUDE_SETTINGS_PATH, bakPath);
  }

  // Atomic write: write to tmp, then rename
  fs.writeFileSync(tmpPath, content);
  fs.renameSync(tmpPath, CLAUDE_SETTINGS_PATH);
}

function installSkill(): void {
  const skillsDir = path.join(os.homedir(), '.claude', 'commands');
  fs.mkdirSync(skillsDir, { recursive: true });

  const skillSrc = path.join(getPackageRoot(), 'skills', 'echocoding.md');
  const skillDst = path.join(skillsDir, 'echocoding.md');

  if (fs.existsSync(skillSrc)) {
    fs.copyFileSync(skillSrc, skillDst);
  }
}

function uninstallSkill(): void {
  const skillPath = path.join(os.homedir(), '.claude', 'commands', 'echocoding.md');
  try {
    fs.unlinkSync(skillPath);
  } catch { /* ignore */ }
}

function getPackageRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'package.json'))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  return process.cwd();
}

export function detectInstalledAgents(): string[] {
  const agents: string[] = [];

  if (fs.existsSync(path.join(os.homedir(), '.claude'))) {
    agents.push('claude-code');
  }

  if (fs.existsSync(path.join(os.homedir(), '.codex'))) {
    agents.push('codex');
  }

  return agents;
}

// --- Codex CLI integration ---

const CODEX_DIR = path.join(os.homedir(), '.codex');
const CODEX_INSTRUCTIONS_PATH = path.join(CODEX_DIR, 'instructions.md');
const CODEX_SKILLS_DIR = path.join(CODEX_DIR, 'skills');
const CODEX_SKILL_DIR = path.join(CODEX_SKILLS_DIR, 'echocoding');
const CODEX_SKILL_PATH = path.join(CODEX_SKILL_DIR, 'SKILL.md');
const CODEX_LEGACY_SKILL_PATH = path.join(CODEX_SKILLS_DIR, 'echocoding.md');
const CODEX_MANAGED_BLOCK_START = '<!-- echocoding-voice-mode:start -->';
const CODEX_MANAGED_BLOCK_END = '<!-- echocoding-voice-mode:end -->';
const CODEX_LEGACY_MARKER = '<!-- echocoding-voice-mode -->';
const CODEX_LEGACY_BLOCK = [
  '## EchoCoding Voice Mode',
  'When user says "/echocoding" or "voice mode on", run `echocoding start` and follow the voice mode rules in the echocoding skill.',
].join('\n');

export function installCodex(): { success: boolean; message: string } {
  if (!fs.existsSync(CODEX_DIR)) {
    return { success: false, message: 'Codex CLI config directory not found' };
  }

  try {
    const compiledSkill = compilePrompt('codex').trimEnd() + '\n';
    fs.mkdirSync(CODEX_SKILL_DIR, { recursive: true });
    writeTextFileAtomic(CODEX_SKILL_PATH, compiledSkill);

    // Remove legacy flat skill if present.
    try {
      if (fs.existsSync(CODEX_LEGACY_SKILL_PATH)) fs.unlinkSync(CODEX_LEGACY_SKILL_PATH);
    } catch {
      /* ignore */
    }

    let instructions = '';
    if (fs.existsSync(CODEX_INSTRUCTIONS_PATH)) {
      instructions = fs.readFileSync(CODEX_INSTRUCTIONS_PATH, 'utf-8');
    }
    const nextInstructions = upsertCodexInstructions(instructions);
    writeTextFileAtomic(CODEX_INSTRUCTIONS_PATH, nextInstructions);

    return { success: true, message: 'Installed EchoCoding skill for Codex CLI' };
  } catch (err) {
    return {
      success: false,
      message: `Failed to install Codex integration: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export function uninstallCodex(): { success: boolean; message: string } {
  try {
    try {
      fs.unlinkSync(CODEX_SKILL_PATH);
    } catch {
      /* ignore */
    }
    try {
      fs.rmdirSync(CODEX_SKILL_DIR);
    } catch {
      /* ignore */
    }
    try {
      fs.unlinkSync(CODEX_LEGACY_SKILL_PATH);
    } catch {
      /* ignore */
    }

    if (fs.existsSync(CODEX_INSTRUCTIONS_PATH)) {
      const instructions = fs.readFileSync(CODEX_INSTRUCTIONS_PATH, 'utf-8');
      writeTextFileAtomic(CODEX_INSTRUCTIONS_PATH, removeCodexInstructions(instructions));
    }

    return { success: true, message: 'Removed EchoCoding from Codex CLI' };
  } catch (err) {
    return {
      success: false,
      message: `Failed to uninstall Codex integration: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function buildCodexInstructionsBlock(): string {
  return [
    CODEX_MANAGED_BLOCK_START,
    '## EchoCoding Voice Mode',
    'If the user explicitly asks for EchoCoding voice mode by saying `/echocoding`, `echocoding on`, `voice mode on`, `voice mode off`, or a level change such as `echocoding minimal`, load and follow the `echocoding` skill from `~/.codex/skills/echocoding/SKILL.md`.',
    'Treat `/echocoding` as a user trigger phrase, not as a built-in Codex slash command.',
    CODEX_MANAGED_BLOCK_END,
  ].join('\n');
}

function upsertCodexInstructions(instructions: string): string {
  const cleaned = stripCodexManagedText(instructions);
  const block = buildCodexInstructionsBlock();
  if (!cleaned.trim()) return block + '\n';
  return cleaned + '\n\n' + block + '\n';
}

function removeCodexInstructions(instructions: string): string {
  const cleaned = stripCodexManagedText(instructions);
  return cleaned ? cleaned + '\n' : '';
}

function stripCodexManagedText(instructions: string): string {
  let next = instructions.replace(/\r\n/g, '\n');

  next = removeDelimitedBlock(next, CODEX_MANAGED_BLOCK_START, CODEX_MANAGED_BLOCK_END);
  next = removeLegacyCodexBlock(next);

  return tidyMarkdownText(next);
}

function removeDelimitedBlock(text: string, start: string, end: string): string {
  const startIdx = text.indexOf(start);
  if (startIdx === -1) return text;
  const endIdx = text.indexOf(end, startIdx);
  const removeEnd = endIdx === -1 ? text.length : endIdx + end.length;
  return text.slice(0, startIdx) + text.slice(removeEnd);
}

function removeLegacyCodexBlock(text: string): string {
  const withMarker = new RegExp(
    `\\n{0,2}${escapeRegex(CODEX_LEGACY_MARKER)}\\n${escapeRegex(CODEX_LEGACY_BLOCK)}\\n?`,
    'g',
  );
  const withoutMarker = new RegExp(
    `\\n{0,2}${escapeRegex(CODEX_LEGACY_BLOCK)}\\n?`,
    'g',
  );
  return text.replace(withMarker, '\n').replace(withoutMarker, '\n');
}

function tidyMarkdownText(text: string): string {
  return text
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function writeTextFileAtomic(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = filePath + '.tmp';
  fs.writeFileSync(tmpPath, content, 'utf-8');
  fs.renameSync(tmpPath, filePath);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
