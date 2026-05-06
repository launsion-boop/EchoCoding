import { playSfx } from './engines/sfx-engine.js';

// Ambient control — injected by daemon at init time
let _startAmbient: ((name: string, intervalMs?: number) => void) | null = null;
let _stopAmbient: (() => void) | null = null;
const AMBIENT_INTERVALS = {
  thinking: 3000,
  heartbeat: 1600,
  typing: 900,
  compact: 3000,
} as const;
const THINKING_CUE_MIN_INTERVAL_MS = 450;
let lastThinkingCueAt = 0;

// Track whether the model is actively working (between UserPromptSubmit and Stop).
// Prevents PostToolUse(Agent) — which can fire late after Stop in newer clients —
// from restarting the heartbeat while the user is waiting to type.
let modelActive = false;

export function setAmbientControls(
  start: (name: string, intervalMs?: number) => void,
  stop: () => void,
): void {
  _startAmbient = start;
  _stopAmbient = stop;
}

/**
 * Claude Code hook event data structure.
 * Hooks receive JSON on stdin with event details.
 */
export interface HookEvent {
  hook_event_name: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: string | Record<string, unknown>;
  session_id?: string;
  turn_id?: string;
  // PostToolUse provides exit_code or error info
  exit_code?: number;
  error?: string;
  // Stop event
  stop_reason?: string;
  // SessionStart
  session_type?: string;
  // Permission mode
  permission_mode?: string;
}

/**
 * Process a hook event and trigger appropriate SFX.
 */
export function handleHookEvent(event: HookEvent): void {
  const { hook_event_name } = event;

  // Ambient loop management:
  // - UserPromptSubmit → submit + thinking cue, then heartbeat ambient
  // - PreToolUse → semantic SFX + ambient (typing for edits, heartbeat otherwise)
  // - PostToolUse → keep typing ambient after successful writes, else heartbeat
  // - Stop → stop all ambient

  switch (hook_event_name) {
    case 'SessionStart':
      _stopAmbient?.();
      playSfx('startup');
      break;

    case 'UserPromptSubmit':
      modelActive = true;
      _stopAmbient?.();
      playSfx('submit');
      // Entering model-thinking state: play a cue, keep heartbeat running.
      maybePlayThinkingCue(true);
      _startAmbient?.('heartbeat', AMBIENT_INTERVALS.heartbeat);
      break;

    case 'PreToolUse':
      _stopAmbient?.();
      handlePreToolUse(event);
      break;

    case 'PostToolUse':
      _stopAmbient?.();
      {
        const toolKind = detectToolUseKind(event);
        handlePostToolUse(event, toolKind);
        startPostToolAmbient(event, toolKind);
      }
      break;

    case 'Notification':
      playSfx('notification');
      break;

    case 'Stop':
      modelActive = false;
      _stopAmbient?.(); // AI finished — kill all ambient
      handleStop(event);
      break;

    case 'SubagentStart':
      _stopAmbient?.();
      playSfx('agent-spawn');
      if (modelActive) {
        _startAmbient?.('heartbeat', AMBIENT_INTERVALS.heartbeat);
      }
      break;

    case 'SubagentStop':
      _stopAmbient?.();
      playSfx('agent-done');
      break;

    case 'PreCompact':
      _stopAmbient?.();
      playSfx('compact');
      _startAmbient?.('compact', AMBIENT_INTERVALS.compact);
      break;

    default:
      // Unknown event, ignore
      break;
  }
}

function handlePreToolUse(event: HookEvent): void {
  const toolKind = detectToolUseKind(event);
  if (toolKind === 'typing') {
    // Write + typing are intentionally paired:
    // write = start marker, typing = ongoing ambient while editing.
    playSfx('write');
    _startAmbient?.('typing', AMBIENT_INTERVALS.typing);
    return;
  }
  if (toolKind === 'read') {
    playSfx('read');
    _startAmbient?.('heartbeat', AMBIENT_INTERVALS.heartbeat);
    return;
  }
  if (toolKind === 'search') {
    playSfx('search');
    _startAmbient?.('heartbeat', AMBIENT_INTERVALS.heartbeat);
    return;
  }
  if (toolKind === 'notification') {
    playSfx('notification');
    _startAmbient?.('heartbeat', AMBIENT_INTERVALS.heartbeat);
    return;
  }

  playSfx('working');
  _startAmbient?.('heartbeat', AMBIENT_INTERVALS.heartbeat);
}

function handlePostToolUse(event: HookEvent, toolKind: ToolUseKind): void {
  const { tool_name, exit_code, error, tool_response } = event;

  // Detect bash command semantics
  if (isToolMatch((tool_name ?? '').toLowerCase(), ['bash', 'exec_command'])) {
    const command = getShellCommand(event);
    const bashSfx = detectBashSfx(command, exit_code, tool_response);
    if (bashSfx) {
      playSfx(bashSfx);
      return;
    }
  }

  const success = !error && (exit_code === undefined || exit_code === 0);

  // For read/search/edit flows, skip generic success chime to reduce noise.
  if (success && (toolKind === 'read' || toolKind === 'search' || toolKind === 'typing')) {
    return;
  }

  // Generic success/error
  if (!success) {
    playSfx('error');
  } else {
    playSfx('success');
  }
}

function startPostToolAmbient(event: HookEvent, toolKind: ToolUseKind): void {
  // Guard: if Stop has already fired (modelActive=false), don't restart heartbeat.
  // PostToolUse(Agent) can arrive after Stop in newer Claude Code clients.
  if (!modelActive) return;

  const success = !event.error && (event.exit_code === undefined || event.exit_code === 0);
  if (success && toolKind === 'typing') {
    // Keep typing ambience between consecutive write commands.
    _startAmbient?.('typing', AMBIENT_INTERVALS.typing);
    return;
  }
  // Model is back to planning state between tool calls.
  maybePlayThinkingCue();
  _startAmbient?.('heartbeat', AMBIENT_INTERVALS.heartbeat);
}

function maybePlayThinkingCue(force = false): void {
  const now = Date.now();
  if (!force && now - lastThinkingCueAt < THINKING_CUE_MIN_INTERVAL_MS) {
    return;
  }
  lastThinkingCueAt = now;
  // Use throttled playSfx — the local cooldown above plus SFX throttle
  // together prevent overlapping thinking cue afplay processes.
  playSfx('thinking');
}

function handleStop(event: HookEvent): void {
  const { stop_reason, error } = event;
  if (error || stop_reason === 'error') {
    playSfx('error');
  } else {
    playSfx('complete');
  }
}

/**
 * Detect bash command semantics for specialized SFX.
 */
function detectBashSfx(
  command: string,
  exitCode?: number,
  _response?: string | Record<string, unknown>,
): string | null {
  const cmd = command.trim().toLowerCase();
  const success = exitCode === undefined || exitCode === 0;

  // Git commands
  if (cmd.startsWith('git commit') || cmd.includes('git commit')) {
    return success ? 'git-commit' : 'error';
  }
  if (cmd.startsWith('git push') || cmd.includes('git push')) {
    return success ? 'git-push' : 'error';
  }
  if (cmd.startsWith('git') || cmd.includes(' git ')) {
    return success ? 'success' : 'error';
  }

  // Test commands
  if (
    cmd.includes('npm test') ||
    cmd.includes('yarn test') ||
    cmd.includes('pnpm test') ||
    cmd.includes('jest') ||
    cmd.includes('vitest') ||
    cmd.includes('pytest') ||
    cmd.includes('cargo test')
  ) {
    return success ? 'npm-test-pass' : 'npm-test-fail';
  }

  // Build commands
  if (
    cmd.includes('npm run build') ||
    cmd.includes('yarn build') ||
    cmd.includes('tsc') ||
    cmd.includes('cargo build')
  ) {
    return success ? 'success' : 'error';
  }

  // Install commands
  if (
    cmd.includes('npm install') ||
    cmd.includes('npm i ') ||
    cmd.includes('yarn add') ||
    cmd.includes('pnpm add') ||
    cmd.includes('pip install') ||
    cmd.includes('cargo add') ||
    cmd.includes('brew install')
  ) {
    return success ? 'install' : 'error';
  }

  // Delete/destructive commands
  if (cmd.includes('rm ') || cmd.includes('rmdir') || cmd.includes('git branch -D')) {
    return success ? 'delete' : 'error';
  }

  return null; // No special SFX, will fall through to generic
}

function isToolMatch(toolName: string, candidates: string[]): boolean {
  if (!toolName) return false;
  return candidates.some((candidate) =>
    toolName === candidate || toolName.endsWith(`.${candidate}`),
  );
}

function getShellCommand(event: HookEvent): string {
  const command = event.tool_input?.command;
  if (typeof command === 'string') return command;
  const cmd = event.tool_input?.cmd;
  if (typeof cmd === 'string') return cmd;
  return '';
}

type ToolUseKind = 'typing' | 'read' | 'search' | 'notification' | 'working';

function detectToolUseKind(event: HookEvent): ToolUseKind {
  const toolName = (event.tool_name ?? '').toLowerCase();
  if (isToolMatch(toolName, ['edit', 'apply_patch', 'write', 'multiedit', 'multi_edit'])) return 'typing';
  if (isToolMatch(toolName, ['read', 'open', 'find', 'view_image', 'screenshot', 'read_thread_terminal'])) return 'read';
  if (isToolMatch(toolName, ['glob', 'grep', 'search_query', 'image_query', 'fuzzy_file_search'])) return 'search';
  if (isToolMatch(toolName, ['parallel'])) return detectParallelToolKind(event);
  if (isToolMatch(toolName, ['bash', 'exec_command'])) return detectPreShellSfx(getShellCommand(event));
  if (isToolMatch(toolName, ['sports', 'finance', 'weather', 'time'])) return 'notification';
  return 'working';
}

type PreShellSfx = 'typing' | 'read' | 'search' | 'working';

function detectPreShellSfx(command: string): PreShellSfx {
  const cmd = command.trim().toLowerCase();
  if (!cmd) return 'working';

  // Edit-like shell commands.
  if (
    cmd.includes('apply_patch') ||
    cmd.startsWith('git apply ') ||
    cmd.startsWith('patch ') ||
    hasHereDocWrite(cmd) ||
    hasShellFileRedirectWrite(cmd) ||
    cmd.includes('tee ') ||
    /\b(?:echo|printf)\b.*>>?\s*(?!\/dev\/null\b)/.test(cmd) ||
    /\b(?:node|python|python3)\b.*\b(?:writefilesync|appendfilesync|writefile\(|write_text\(|write_bytes\(|open\(.+['"]w)/.test(cmd) ||
    cmd.includes('>>') ||
    /\bsed\b.*\s-i(\s|$)/.test(cmd) ||
    /\bperl\b.*\s-i(\s|$)/.test(cmd) ||
    cmd.startsWith('touch ') ||
    cmd.startsWith('cp ') ||
    cmd.startsWith('mv ')
  ) {
    return 'typing';
  }

  // Search-like commands.
  if (
    cmd.startsWith('git grep ') ||
    cmd.startsWith('rg ') ||
    cmd === 'rg' ||
    cmd.startsWith('grep ') ||
    cmd.startsWith('find ') ||
    cmd.startsWith('fd ') ||
    cmd.startsWith('ag ') ||
    cmd.startsWith('ack ')
  ) {
    return 'search';
  }

  // Read-like commands used while browsing files/logs.
  if (
    cmd === 'ls' ||
    cmd.startsWith('ls ') ||
    cmd.startsWith('tree ') ||
    cmd.startsWith('wc ') ||
    cmd.startsWith('stat ') ||
    cmd.startsWith('cat ') ||
    cmd.startsWith('less ') ||
    cmd.startsWith('more ') ||
    cmd.startsWith('head ') ||
    cmd.startsWith('tail ') ||
    cmd.startsWith('sed ') ||
    cmd.startsWith('awk ') ||
    cmd.startsWith('nl ') ||
    cmd.startsWith('git status') ||
    cmd.startsWith('git log') ||
    cmd.startsWith('git show') ||
    cmd.startsWith('git diff') ||
    cmd.startsWith('git branch') ||
    cmd.startsWith('git remote show') ||
    cmd.startsWith('git rev-list')
  ) {
    return 'read';
  }

  return 'working';
}

function hasHereDocWrite(cmd: string): boolean {
  if (!cmd.includes('<<')) return false;
  return /\b(?:cat|tee|python|python3|node|ruby|perl|awk|sed|bash|sh)\b[\s\S]*<<[-~]?\s*['"]?[a-z0-9_]+['"]?/.test(
    cmd,
  );
}

function hasShellFileRedirectWrite(cmd: string): boolean {
  if (!cmd.includes('>')) return false;
  if (!/\b(?:echo|printf|cat|tee)\b/.test(cmd)) return false;
  if (/(?:^|\s)\d?>>?\s*\/dev\/null\b/.test(cmd)) return false;
  // Treat explicit output redirection as a write action.
  // Examples: "cat > file", "printf ... >> file", "tee > file".
  return /(?:^|[;&|])[\s\S]*?(?:>>?|>\|)\s*(?:['"`$./~]|[a-z0-9_\/-])/.test(cmd);
}

function detectParallelToolKind(event: HookEvent): ToolUseKind {
  const uses = getParallelToolUses(event);
  if (uses.length === 0) return 'working';
  const kinds = new Set(uses.map((u) => detectParallelUseKind(u)));
  for (const kind of ['typing', 'search', 'read', 'notification', 'working'] as const) {
    if (kinds.has(kind)) return kind;
  }
  return 'working';
}

function getParallelToolUses(event: HookEvent): Array<Record<string, unknown>> {
  const list = event.tool_input?.tool_uses;
  if (!Array.isArray(list)) return [];
  return list.filter((item): item is Record<string, unknown> =>
    item !== null && typeof item === 'object' && !Array.isArray(item),
  );
}

function detectParallelUseKind(use: Record<string, unknown>): ToolUseKind {
  const recipient = String(use.recipient_name ?? '').toLowerCase();
  const tool = recipient.split('.').pop() ?? recipient;
  const parameters = asRecord(use.parameters) ?? {};

  if (isToolMatch(tool, ['apply_patch', 'write', 'edit', 'multiedit', 'multi_edit'])) return 'typing';
  if (isToolMatch(tool, ['read', 'open', 'find', 'view_image', 'screenshot', 'read_thread_terminal'])) return 'read';
  if (isToolMatch(tool, ['grep', 'glob', 'search_query', 'image_query', 'fuzzy_file_search'])) return 'search';
  if (isToolMatch(tool, ['exec_command', 'bash'])) {
    return detectPreShellSfx(String(parameters.cmd ?? parameters.command ?? ''));
  }
  if (isToolMatch(tool, ['sports', 'finance', 'weather', 'time'])) return 'notification';
  return 'working';
}

/**
 * Parse hook event from stdin JSON string.
 */
export function parseHookEvent(input: string): HookEvent | null {
  try {
    const raw = JSON.parse(input) as Record<string, unknown>;
    const hookEventName = asString(raw.hook_event_name ?? raw.hookEventName);
    if (!hookEventName) return null;

    const event: HookEvent = {
      hook_event_name: hookEventName,
    };

    const toolName = asString(raw.tool_name ?? raw.toolName ?? raw.tool);
    if (toolName) event.tool_name = toolName;

    const toolInput = asRecord(raw.tool_input ?? raw.toolInput ?? raw.input);
    if (toolInput) event.tool_input = toolInput;

    const toolResponse = raw.tool_response ?? raw.toolResponse ?? raw.output;
    if (toolResponse !== undefined && (typeof toolResponse === 'string' || asRecord(toolResponse))) {
      event.tool_response = typeof toolResponse === 'string' ? toolResponse : asRecord(toolResponse);
    }

    const sessionId = asString(raw.session_id ?? raw.sessionId);
    if (sessionId) event.session_id = sessionId;

    const turnId = asString(raw.turn_id ?? raw.turnId);
    if (turnId) event.turn_id = turnId;

    const exitCodeRaw = raw.exit_code ?? raw.exitCode;
    const exitCode = asNumber(exitCodeRaw);
    if (exitCode !== undefined) event.exit_code = exitCode;

    const error = asString(raw.error);
    if (error) event.error = error;

    const stopReason = asString(raw.stop_reason ?? raw.stopReason);
    if (stopReason) event.stop_reason = stopReason;

    const sessionType = asString(raw.session_type ?? raw.sessionType);
    if (sessionType) event.session_type = sessionType;

    const permissionMode = asString(raw.permission_mode ?? raw.permissionMode);
    if (permissionMode) event.permission_mode = permissionMode;

    return event;
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}
