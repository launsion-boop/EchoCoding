/**
 * Echo Event Protocol v1.0
 * Versioned IPC event definitions for EchoCoding daemon communication.
 */

export const PROTOCOL_VERSION = '1.0';

/** Standard event types that any adapter can emit. */
export enum EchoEvent {
  // Session lifecycle
  SessionStart = 'session.start',
  SessionEnd = 'session.end',

  // AI status
  Thinking = 'status.thinking',
  Working = 'status.working',
  Idle = 'status.idle',

  // User interaction
  UserMessage = 'user.message',

  // Tool usage
  ToolStart = 'tool.start',
  ToolEnd = 'tool.end',

  // Task lifecycle
  TaskStart = 'task.start',
  TaskComplete = 'task.complete',
  TaskError = 'task.error',

  // Special
  Notification = 'notification',
  PermissionRequest = 'permission.request',
  SubagentStart = 'subagent.start',
  SubagentEnd = 'subagent.end',
  Compact = 'compact',
}

/** Versioned daemon message. */
export interface EchoMessage {
  version: string;
  type: 'hook' | 'say' | 'sfx' | 'ask' | 'listen' | 'ping' | 'event';
  event?: EchoEvent;
  data?: Record<string, unknown>;
  text?: string;
  name?: string;
}
