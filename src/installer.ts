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

interface CodexHookEntry {
  type: 'command';
  command: string;
  statusMessage?: string;
  timeout?: number;
}

interface CodexHookMatcher {
  matcher?: string;
  hooks: CodexHookEntry[];
}

interface CodexHooksFile {
  hooks?: Record<string, CodexHookMatcher[]>;
  [key: string]: unknown;
}

const CLAUDE_SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');

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

function getHookCommand(): string {
  const hookScript = path.join(getPackageRoot(), 'dist', 'bin', 'echocoding-hook.js');
  // Use absolute path to node — hook env may not have /opt/homebrew/bin in PATH
  const nodePath = resolveRuntimeNodePath();
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
const CODEX_CONFIG_PATH = path.join(CODEX_DIR, 'config.toml');
const CODEX_INSTRUCTIONS_PATH = path.join(CODEX_DIR, 'instructions.md');
const CODEX_HOOKS_PATH = path.join(CODEX_DIR, 'hooks.json');
const CODEX_SKILLS_DIR = path.join(CODEX_DIR, 'skills');
const CODEX_SKILL_DIR = path.join(CODEX_SKILLS_DIR, 'echocoding');
const CODEX_SKILL_PATH = path.join(CODEX_SKILL_DIR, 'SKILL.md');
const CODEX_LEGACY_SKILL_PATH = path.join(CODEX_SKILLS_DIR, 'echocoding.md');
const CODEX_MANAGED_BLOCK_START = '<!-- echocoding-voice-mode:start -->';
const CODEX_MANAGED_BLOCK_END = '<!-- echocoding-voice-mode:end -->';
const CODEX_LEGACY_MARKER = '<!-- echocoding-voice-mode -->';
const CODEX_HOOKS_FEATURE_START = '# echocoding-codex-hooks:start';
const CODEX_HOOKS_FEATURE_END = '# echocoding-codex-hooks:end';
const CODEX_TYPING_TOOL_MATCHER = 'apply_patch|Edit|Write|MultiEdit';
const CODEX_LOW_NOISE_HOOK_EVENTS = ['Notification', 'Stop', 'SubagentStart', 'SubagentStop', 'PreCompact'];
const CODEX_LEGACY_TOOL_HOOK_EVENTS = ['PreToolUse', 'PostToolUse'];
const CODEX_LEGACY_BLOCK = [
  '## EchoCoding Voice Mode',
  'When user says "/echocoding" or "voice mode on", run `echocoding start` and follow the voice mode rules in the echocoding skill.',
].join('\n');

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function getCodexVoiceReminderCommand(): string {
  const script = path.join(getPackageRoot(), 'scripts', 'voice-reminder.sh');
  return `ECHOCODING_HOOK_CLIENT=codex ECHOCODING_CLIENT=codex bash ${shellQuote(script)}`;
}

function getCodexHookCommand(): string {
  const hookScript = path.join(getPackageRoot(), 'dist', 'bin', 'echocoding-hook.js');
  return `ECHOCODING_CLIENT=codex ${shellQuote(resolveRuntimeNodePath())} ${shellQuote(hookScript)}`;
}

function getCodexAutoStartCommand(): string {
  const script = path.join(getPackageRoot(), 'scripts', 'auto-start.sh');
  return `ECHOCODING_CLIENT=codex ECHOCODING_NODE=${shellQuote(resolveRuntimeNodePath())} bash ${shellQuote(script)}`;
}

function getCodexVoiceAutoModeCommand(): string {
  const script = path.join(getPackageRoot(), 'scripts', 'voice-auto-mode.sh');
  return `ECHOCODING_HOOK_CLIENT=codex bash ${shellQuote(script)}`;
}

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

    let config = '';
    if (fs.existsSync(CODEX_CONFIG_PATH)) {
      config = fs.readFileSync(CODEX_CONFIG_PATH, 'utf-8');
    }
    const nextConfig = upsertCodexHooksFeature(config);
    writeTextFileAtomic(CODEX_CONFIG_PATH, nextConfig);

    const hooks = readCodexHooksFile();
    const nextHooks = upsertCodexHooks(hooks);
    writeJsonFileAtomic(CODEX_HOOKS_PATH, nextHooks);

    return { success: true, message: 'Installed EchoCoding skill and hooks for Codex CLI' };
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

    if (fs.existsSync(CODEX_CONFIG_PATH)) {
      const config = fs.readFileSync(CODEX_CONFIG_PATH, 'utf-8');
      writeTextFileAtomic(CODEX_CONFIG_PATH, removeCodexHooksFeature(config));
    }

    if (fs.existsSync(CODEX_HOOKS_PATH)) {
      const hooks = removeCodexHooks(readCodexHooksFile());
      if (isCodexHooksFileEmpty(hooks)) {
        try {
          fs.unlinkSync(CODEX_HOOKS_PATH);
        } catch {
          /* ignore */
        }
      } else {
        writeJsonFileAtomic(CODEX_HOOKS_PATH, hooks);
      }
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

export function hasCodexHooksFeatureEnabled(config: string): boolean {
  const text = config.replace(/\r\n/g, '\n');

  if (/^\s*features\.codex_hooks\s*=\s*true\s*(?:#.*)?$/m.test(text)) {
    return true;
  }

  const lines = text.split('\n');
  let inFeatures = false;
  for (const line of lines) {
    const tableMatch = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (tableMatch) {
      inFeatures = tableMatch[1].trim() === 'features';
      continue;
    }
    if (inFeatures && /^\s*codex_hooks\s*=\s*true\s*(?:#.*)?$/m.test(line)) {
      return true;
    }
  }

  return false;
}

function upsertCodexHooksFeature(config: string): string {
  let next = stripCodexHooksFeatureBlock(config);

  if (/^\s*features\.codex_hooks\s*=\s*(?:true|false)\s*(?:#.*)?$/m.test(next)) {
    next = next.replace(
      /^\s*features\.codex_hooks\s*=\s*(?:true|false)\s*(?:#.*)?$/m,
      'features.codex_hooks = true',
    );
    return tidyText(next) + '\n';
  }

  const lines = next.split('\n');
  let inFeatures = false;
  for (let i = 0; i < lines.length; i++) {
    const tableMatch = lines[i].match(/^\s*\[([^\]]+)\]\s*$/);
    if (tableMatch) {
      inFeatures = tableMatch[1].trim() === 'features';
      continue;
    }
    if (inFeatures && /^\s*codex_hooks\s*=\s*(?:true|false)\s*(?:#.*)?$/.test(lines[i])) {
      lines[i] = 'codex_hooks = true';
      return tidyText(lines.join('\n')) + '\n';
    }
  }

  const managedBlock = [
    CODEX_HOOKS_FEATURE_START,
    'codex_hooks = true',
    CODEX_HOOKS_FEATURE_END,
  ];

  for (let i = 0; i < lines.length; i++) {
    if (/^\s*\[features\]\s*$/.test(lines[i])) {
      lines.splice(i + 1, 0, ...managedBlock);
      return tidyText(lines.join('\n')) + '\n';
    }
  }

  const cleaned = tidyText(next);
  const suffix = cleaned ? '\n\n' : '';
  return cleaned + suffix + [
    CODEX_HOOKS_FEATURE_START,
    'features.codex_hooks = true',
    CODEX_HOOKS_FEATURE_END,
  ].join('\n') + '\n';
}

function removeCodexHooksFeature(config: string): string {
  const cleaned = tidyText(stripCodexHooksFeatureBlock(config));
  return cleaned ? cleaned + '\n' : '';
}

function stripCodexHooksFeatureBlock(config: string): string {
  return removeDelimitedBlock(
    config.replace(/\r\n/g, '\n'),
    CODEX_HOOKS_FEATURE_START,
    CODEX_HOOKS_FEATURE_END,
  );
}

function readCodexHooksFile(): CodexHooksFile {
  if (!fs.existsSync(CODEX_HOOKS_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(CODEX_HOOKS_PATH, 'utf-8')) as CodexHooksFile;
  } catch {
    throw new Error(`Failed to parse existing Codex hooks file: ${CODEX_HOOKS_PATH}`);
  }
}

function upsertCodexHooks(config: CodexHooksFile): CodexHooksFile {
  const next: CodexHooksFile = { ...config, hooks: { ...(config.hooks ?? {}) } };

  upsertCodexManagedGroup(next.hooks!, 'SessionStart', ['echocoding-hook', 'auto-start', 'voice-auto-mode'], {
    matcher: 'startup|resume',
    hooks: [
      {
        type: 'command',
        command: getCodexVoiceAutoModeCommand(),
        statusMessage: 'Syncing EchoCoding voice mode',
      },
      {
        type: 'command',
        command: getCodexAutoStartCommand(),
        statusMessage: 'Starting EchoCoding daemon',
      },
      {
        type: 'command',
        command: getCodexHookCommand(),
      },
    ],
  });

  upsertCodexManagedGroup(next.hooks!, 'UserPromptSubmit', ['echocoding-hook', 'voice-reminder'], {
    hooks: [
      {
        type: 'command',
        command: getCodexVoiceReminderCommand(),
      },
      {
        type: 'command',
        command: getCodexHookCommand(),
      },
    ],
  });

  for (const eventName of CODEX_LEGACY_TOOL_HOOK_EVENTS) {
    removeCodexManagedEventHooks(next.hooks!, eventName, ['echocoding-hook']);
  }

  for (const eventName of CODEX_LEGACY_TOOL_HOOK_EVENTS) {
    upsertCodexManagedGroup(next.hooks!, eventName, ['echocoding-hook'], {
      matcher: CODEX_TYPING_TOOL_MATCHER,
      hooks: [
        {
          type: 'command',
          command: getCodexHookCommand(),
        },
      ],
    });
  }

  for (const eventName of CODEX_LOW_NOISE_HOOK_EVENTS) {
    upsertCodexManagedGroup(next.hooks!, eventName, ['echocoding-hook'], {
      hooks: [
        {
          type: 'command',
          command: getCodexHookCommand(),
        },
      ],
    });
  }

  return next;
}

function removeCodexManagedEventHooks(
  hooks: Record<string, CodexHookMatcher[]>,
  eventName: string,
  managedCommandNeedles: string[],
): void {
  const groups = hooks[eventName];
  if (!groups) return;

  const retained = groups
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
    .filter((group): group is CodexHookMatcher => group !== null);

  if (retained.length > 0) {
    hooks[eventName] = retained;
  } else {
    delete hooks[eventName];
  }
}

function removeCodexHooks(config: CodexHooksFile): CodexHooksFile {
  if (!config.hooks) return config;

  const nextHooks: Record<string, CodexHookMatcher[]> = {};

  for (const [eventName, groups] of Object.entries(config.hooks)) {
    const filteredGroups = groups
      .map((group) => ({
        ...group,
        hooks: group.hooks.filter(
          (hook) =>
            !hook.command.includes('echocoding-hook') &&
            !hook.command.includes('voice-reminder') &&
            !hook.command.includes('voice-auto-mode') &&
            !hook.command.includes('auto-start'),
        ),
      }))
      .filter((group) => group.hooks.length > 0);

    if (filteredGroups.length > 0) {
      nextHooks[eventName] = filteredGroups;
    }
  }

  const next: CodexHooksFile = { ...config };
  if (Object.keys(nextHooks).length > 0) {
    next.hooks = nextHooks;
  } else {
    delete next.hooks;
  }
  return next;
}

function upsertCodexManagedGroup(
  hooks: Record<string, CodexHookMatcher[]>,
  eventName: string,
  managedCommandNeedles: string[],
  desiredGroup: CodexHookMatcher,
): void {
  const groups = hooks[eventName] ?? [];
  const normalized: CodexHookMatcher[] = groups
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
    .filter((group): group is CodexHookMatcher => group !== null);

  normalized.push({
    ...desiredGroup,
    hooks: desiredGroup.hooks.map((hook) => ({ ...hook })),
  });

  hooks[eventName] = normalized;
}

function isCodexHooksFileEmpty(config: CodexHooksFile): boolean {
  const otherKeys = Object.keys(config).filter((key) => key !== 'hooks');

  if (!config.hooks) {
    return otherKeys.length === 0;
  }

  return Object.keys(config.hooks).length === 0 && otherKeys.length === 0;
}

function stripCodexManagedText(instructions: string): string {
  let next = instructions.replace(/\r\n/g, '\n');

  next = removeDelimitedBlock(next, CODEX_MANAGED_BLOCK_START, CODEX_MANAGED_BLOCK_END);
  next = removeLegacyCodexBlock(next);

  return tidyMarkdownText(next);
}

function removeDelimitedBlock(text: string, start: string, end: string): string {
  let next = text;
  while (true) {
    const startIdx = next.indexOf(start);
    if (startIdx === -1) return next;
    const endIdx = next.indexOf(end, startIdx);
    const removeEnd = endIdx === -1 ? next.length : endIdx + end.length;
    next = next.slice(0, startIdx) + next.slice(removeEnd);
  }
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
  return tidyText(text);
}

function tidyText(text: string): string {
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

function writeJsonFileAtomic(filePath: string, content: unknown): void {
  writeTextFileAtomic(filePath, JSON.stringify(content, null, 2) + '\n');
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
