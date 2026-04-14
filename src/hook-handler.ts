import { playSfx } from './engines/sfx-engine.js';

// Ambient control — injected by daemon at init time
let _startAmbient: ((name: string, intervalMs?: number) => void) | null = null;
let _stopAmbient: (() => void) | null = null;

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
      _startAmbient?.('thinking', 4000);
      break;

    case 'PreToolUse':
      _stopAmbient?.();
      handlePreToolUse(event);
      break;

    case 'PostToolUse':
      _stopAmbient?.();
      handlePostToolUse(event);
      // After tool completes, start heartbeat — AI is still working (computing next step)
      _startAmbient?.('heartbeat', 2500);
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
      _startAmbient?.('heartbeat', 2500);
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

  if (tool_name === 'Edit') {
    // Edit: typing ambient (keyboard sounds throughout edit)
    _startAmbient?.('typing', 1200);
  } else if (tool_name === 'Write') {
    playSfx('write');
    _startAmbient?.('heartbeat', 2500);
  } else if (tool_name === 'Read') {
    playSfx('read');
    _startAmbient?.('heartbeat', 2500);
  } else if (tool_name === 'Glob' || tool_name === 'Grep') {
    playSfx('search');
    _startAmbient?.('heartbeat', 2500);
  } else if (tool_name === 'Bash') {
    // Bash: notification (attention — may need approval) + heartbeat
    playSfx('notification');
    _startAmbient?.('heartbeat', 2500);
  } else {
    playSfx('working');
    _startAmbient?.('heartbeat', 2500);
  }
}

function handlePostToolUse(event: HookEvent): void {
  const { tool_name, tool_input, exit_code, error, tool_response } = event;

  // Detect bash command semantics
  if (tool_name === 'Bash') {
    const command = (tool_input?.command as string) ?? '';
    const bashSfx = detectBashSfx(command, exit_code, tool_response);
    if (bashSfx) {
      playSfx(bashSfx);
      return;
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

/**
 * Parse hook event from stdin JSON string.
 */
export function parseHookEvent(input: string): HookEvent | null {
  try {
    return JSON.parse(input) as HookEvent;
  } catch {
    return null;
  }
}
