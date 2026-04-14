import { playSfx } from './engines/sfx-engine.js';

/**
 * Claude Code hook event data structure.
 * Hooks receive JSON on stdin with event details.
 */
export interface HookEvent {
  hook_event_name: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: string;
  session_id?: string;
  turn_id?: string;
  // PostToolUse provides exit_code or error info
  exit_code?: number;
  error?: string;
  // Stop event
  stop_reason?: string;
  // SessionStart
  session_type?: string;
}

/**
 * Process a hook event and trigger appropriate SFX.
 */
export function handleHookEvent(event: HookEvent): void {
  const { hook_event_name, tool_name } = event;

  switch (hook_event_name) {
    case 'SessionStart':
      playSfx('startup');
      break;

    case 'UserPromptSubmit':
      playSfx('submit');
      break;

    case 'PreToolUse':
      handlePreToolUse(event);
      break;

    case 'PostToolUse':
      handlePostToolUse(event);
      break;

    case 'Notification':
      playSfx('notification');
      break;

    case 'Stop':
      handleStop(event);
      break;

    case 'SubagentStart':
      playSfx('agent-spawn');
      break;

    case 'SubagentStop':
      playSfx('agent-done');
      break;

    case 'PreCompact':
      playSfx('compact');
      break;

    default:
      // Unknown event, ignore
      break;
  }
}

function handlePreToolUse(event: HookEvent): void {
  const { tool_name } = event;

  if (tool_name === 'Write') {
    playSfx('write');
  } else if (tool_name === 'Edit') {
    playSfx('typing');
  } else if (tool_name === 'Read') {
    playSfx('read');
  } else if (tool_name === 'Glob' || tool_name === 'Grep') {
    playSfx('search');
  } else if (tool_name === 'Bash') {
    playSfx('working');
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
  _response?: string,
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
