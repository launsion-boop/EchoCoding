import { playSfx } from './engines/sfx-engine.js';

// Ambient control — injected by daemon at init time
let _startAmbient: ((name: string, intervalMs?: number) => void) | null = null;
let _stopAmbient: (() => void) | null = null;
const AMBIENT_INTERVALS = {
  thinking: 3000,
  heartbeat: 1600,
  typing: 900,
} as const;

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
  // - UserPromptSubmit → thinking ambient (continuous while AI thinks)
  // - PreToolUse → heartbeat ambient (alive indicator during tool execution)
  //   Exception: Edit → typing ambient
  // - PostToolUse / Stop → stop ambient
  // - Next PreToolUse switches ambient automatically

  switch (hook_event_name) {
    case 'SessionStart':
      _stopAmbient?.();
      playSfx('startup');
      break;

    case 'UserPromptSubmit':
      _stopAmbient?.();
      playSfx('submit');
      // Start thinking ambient — keeps playing until first tool use or stop
      _startAmbient?.('thinking', AMBIENT_INTERVALS.thinking);
      break;

    case 'PreToolUse':
      _stopAmbient?.();
      handlePreToolUse(event);
      break;

    case 'PostToolUse':
      _stopAmbient?.();
      handlePostToolUse(event);
      // After tool completes, start heartbeat — AI is still working (computing next step)
      _startAmbient?.('heartbeat', AMBIENT_INTERVALS.heartbeat);
      break;

    case 'Notification':
      playSfx('notification');
      break;

    case 'Stop':
      _stopAmbient?.(); // AI finished — kill all ambient
      handleStop(event);
      break;

    case 'SubagentStart':
      _stopAmbient?.();
      playSfx('agent-spawn');
      _startAmbient?.('heartbeat', AMBIENT_INTERVALS.heartbeat);
      break;

    case 'SubagentStop':
      _stopAmbient?.();
      playSfx('agent-done');
      break;

    case 'PreCompact':
      _stopAmbient?.();
      playSfx('compact');
      break;

    default:
      // Unknown event, ignore
      break;
  }
}

function handlePreToolUse(event: HookEvent): void {
  const { tool_name } = event;
  const toolName = (tool_name ?? '').toLowerCase();
  const shellCommand = getShellCommand(event);

  if (isToolMatch(toolName, ['edit', 'apply_patch', 'write'])) {
    // Edit/write: keyboard ambience should be clearly audible.
    playSfx('write');
    _startAmbient?.('typing', AMBIENT_INTERVALS.typing);
  } else if (isToolMatch(toolName, ['parallel'])) {
    handleParallelPreToolUse(event);
  } else if (isToolMatch(toolName, ['read', 'open', 'find', 'view_image', 'screenshot'])) {
    playSfx('read');
    _startAmbient?.('heartbeat', AMBIENT_INTERVALS.heartbeat);
  } else if (isToolMatch(toolName, ['glob', 'grep', 'search_query', 'image_query', 'fuzzy_file_search'])) {
    playSfx('search');
    _startAmbient?.('heartbeat', AMBIENT_INTERVALS.heartbeat);
  } else if (isToolMatch(toolName, ['bash', 'exec_command'])) {
    // Shell: infer intent so "browsing" commands can use read/search SFX.
    const shellPreSfx = detectPreShellSfx(shellCommand);
    if (shellPreSfx === 'typing') {
      playSfx('write');
      _startAmbient?.('typing', AMBIENT_INTERVALS.typing);
    } else {
      playSfx(shellPreSfx);
      _startAmbient?.('heartbeat', AMBIENT_INTERVALS.heartbeat);
    }
  } else {
    playSfx('working');
    _startAmbient?.('heartbeat', AMBIENT_INTERVALS.heartbeat);
  }
}

function handlePostToolUse(event: HookEvent): void {
  const { tool_name, exit_code, error, tool_response } = event;

  // Detect bash command semantics
  if (isToolMatch((tool_name ?? '').toLowerCase(), ['bash', 'exec_command'])) {
    const command = getShellCommand(event);
    const bashSfx = detectBashSfx(command, exit_code, tool_response);
    if (bashSfx) {
      playSfx(bashSfx);
      return;
    }

    // For read/search/edit shell commands, skip generic success chime.
    // Ambient heartbeat/typing already communicates progress and avoids audio clutter.
    const success = exit_code === undefined || exit_code === 0;
    if (success) {
      const preKind = detectPreShellSfx(command);
      if (preKind === 'read' || preKind === 'search' || preKind === 'typing') {
        return;
      }
    }
  }

  // Generic success/error
  if (error || (exit_code !== undefined && exit_code !== 0)) {
    playSfx('error');
  } else {
    playSfx('success');
  }
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

type PreShellSfx = 'typing' | 'read' | 'search' | 'notification';

function detectPreShellSfx(command: string): PreShellSfx {
  const cmd = command.trim().toLowerCase();
  if (!cmd) return 'notification';

  // Edit-like shell commands.
  if (
    cmd.includes('apply_patch') ||
    cmd.startsWith('git apply ') ||
    cmd.startsWith('patch ') ||
    cmd.includes('cat <<') ||
    cmd.includes('tee ') ||
    cmd.includes(' > ') ||
    cmd.includes('>>') ||
    /\bsed\b.*\s-i(\s|$)/.test(cmd) ||
    /\bperl\b.*\s-i(\s|$)/.test(cmd)
  ) {
    return 'typing';
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

  // Search-like commands.
  if (
    cmd.startsWith('git grep ') ||
    cmd.startsWith('rg ') ||
    cmd === 'rg' ||
    cmd.startsWith('grep ') ||
    cmd.startsWith('find ') ||
    cmd.startsWith('fd ')
  ) {
    return 'search';
  }

  return 'notification';
}

function handleParallelPreToolUse(event: HookEvent): void {
  const uses = getParallelToolUses(event);
  if (uses.length === 0) {
    playSfx('working');
    _startAmbient?.('heartbeat', AMBIENT_INTERVALS.heartbeat);
    return;
  }

  const hasTyping = uses.some((u) => detectParallelUseKind(u) === 'typing');
  if (hasTyping) {
    playSfx('write');
    _startAmbient?.('typing', AMBIENT_INTERVALS.typing);
    return;
  }

  const hasSearch = uses.some((u) => detectParallelUseKind(u) === 'search');
  if (hasSearch) {
    playSfx('search');
    _startAmbient?.('heartbeat', AMBIENT_INTERVALS.heartbeat);
    return;
  }

  const hasRead = uses.some((u) => detectParallelUseKind(u) === 'read');
  if (hasRead) {
    playSfx('read');
    _startAmbient?.('heartbeat', AMBIENT_INTERVALS.heartbeat);
    return;
  }

  const hasNotify = uses.some((u) => detectParallelUseKind(u) === 'notification');
  if (hasNotify) {
    playSfx('notification');
    _startAmbient?.('heartbeat', AMBIENT_INTERVALS.heartbeat);
    return;
  }

  playSfx('working');
  _startAmbient?.('heartbeat', AMBIENT_INTERVALS.heartbeat);
}

function getParallelToolUses(event: HookEvent): Array<Record<string, unknown>> {
  const list = event.tool_input?.tool_uses;
  if (!Array.isArray(list)) return [];
  return list.filter((item): item is Record<string, unknown> =>
    item !== null && typeof item === 'object' && !Array.isArray(item),
  );
}

function detectParallelUseKind(use: Record<string, unknown>): 'typing' | 'read' | 'search' | 'notification' | 'working' {
  const recipient = String(use.recipient_name ?? '').toLowerCase();
  const tool = recipient.split('.').pop() ?? recipient;
  const parameters = asRecord(use.parameters) ?? {};

  if (isToolMatch(tool, ['apply_patch', 'write', 'edit'])) return 'typing';
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
