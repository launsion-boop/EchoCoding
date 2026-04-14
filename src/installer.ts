import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

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

const CODEX_INSTRUCTIONS_PATH = path.join(os.homedir(), '.codex', 'instructions.md');
const CODEX_SKILLS_DIR = path.join(os.homedir(), '.codex', 'skills');

export function installCodex(): { success: boolean; message: string } {
  const codexDir = path.join(os.homedir(), '.codex');
  if (!fs.existsSync(codexDir)) {
    return { success: false, message: 'Codex CLI config directory not found' };
  }

  // Install skill to Codex skills directory
  fs.mkdirSync(CODEX_SKILLS_DIR, { recursive: true });
  const skillSrc = path.join(getPackageRoot(), 'skills', 'echocoding.md');
  const skillDst = path.join(CODEX_SKILLS_DIR, 'echocoding.md');

  if (fs.existsSync(skillSrc)) {
    fs.copyFileSync(skillSrc, skillDst);
  }

  // Append EchoCoding reference to instructions.md if not already there
  const marker = '<!-- echocoding-voice-mode -->';
  let instructions = '';
  if (fs.existsSync(CODEX_INSTRUCTIONS_PATH)) {
    instructions = fs.readFileSync(CODEX_INSTRUCTIONS_PATH, 'utf-8');
  }

  if (!instructions.includes(marker)) {
    const appendix = `\n\n${marker}\n## EchoCoding Voice Mode\nWhen user says "/echocoding" or "voice mode on", run \`echocoding start\` and follow the voice mode rules in the echocoding skill.\n`;
    fs.appendFileSync(CODEX_INSTRUCTIONS_PATH, appendix);
  }

  return { success: true, message: 'Installed EchoCoding skill for Codex CLI' };
}

export function uninstallCodex(): { success: boolean; message: string } {
  // Remove skill file
  const skillPath = path.join(CODEX_SKILLS_DIR, 'echocoding.md');
  try { fs.unlinkSync(skillPath); } catch { /* ignore */ }

  // Remove marker from instructions.md
  if (fs.existsSync(CODEX_INSTRUCTIONS_PATH)) {
    let instructions = fs.readFileSync(CODEX_INSTRUCTIONS_PATH, 'utf-8');
    const marker = '<!-- echocoding-voice-mode -->';
    const markerIdx = instructions.indexOf(marker);
    if (markerIdx !== -1) {
      // Remove from marker to end of the section (next ## or end of file)
      const after = instructions.slice(markerIdx);
      const nextSection = after.indexOf('\n## ', 1);
      const removeEnd = nextSection === -1 ? instructions.length : markerIdx + nextSection;
      instructions = instructions.slice(0, markerIdx).trimEnd() + instructions.slice(removeEnd);
      fs.writeFileSync(CODEX_INSTRUCTIONS_PATH, instructions);
    }
  }

  return { success: true, message: 'Removed EchoCoding from Codex CLI' };
}
