#!/usr/bin/env node

/**
 * EchoCoding Hook Handler — ultra-lightweight IPC client.
 * Called by Claude Code hooks. Reads stdin JSON, sends to daemon, exits.
 * Must be fast and never block the agent.
 */
import { sendHookEvent } from '../src/daemon/client.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let input = '';

function writeHookTrace(data: Record<string, unknown>): void {
  try {
    const clientRaw = process.env.ECHOCODING_CLIENT ?? process.env.ECHOCODING_HOOK_CLIENT ?? 'default';
    const client = /^(codex|claude)$/.test(clientRaw) ? clientRaw : 'default';
    const logDir = path.join(os.homedir(), '.echocoding', 'logs');
    const logPath = path.join(logDir, `hook-events.${client}.log`);
    fs.mkdirSync(logDir, { recursive: true });

    const command = extractCommand(data);
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      hook_event_name: data.hook_event_name ?? data.hookEventName,
      tool_name: data.tool_name ?? data.toolName ?? data.tool,
      cmd: command ? command.slice(0, 240) : undefined,
      exit_code: data.exit_code ?? data.exitCode,
      has_error: !!data.error,
    }) + '\n';
    fs.appendFileSync(logPath, line, 'utf-8');

    // Keep file bounded (~2MB) to avoid unbounded growth.
    const maxBytes = 2 * 1024 * 1024;
    const stat = fs.statSync(logPath);
    if (stat.size > maxBytes) {
      const content = fs.readFileSync(logPath, 'utf-8');
      const tail = content.split('\n').slice(-2500).join('\n').trimStart();
      fs.writeFileSync(logPath, (tail ? tail + '\n' : ''), 'utf-8');
    }
  } catch {
    // Tracing must never block hook execution.
  }
}

function extractCommand(data: Record<string, unknown>): string {
  const input = (data.tool_input ?? data.toolInput) as Record<string, unknown> | undefined;
  if (!input || typeof input !== 'object') return '';
  const cmd = input.cmd;
  if (typeof cmd === 'string') return cmd;
  const command = input.command;
  if (typeof command === 'string') return command;
  return '';
}

process.stdin.setEncoding('utf-8');
process.stdin.on('data', (chunk) => {
  input += chunk;
});

process.stdin.on('end', async () => {
  if (!input.trim()) {
    process.exit(0);
  }

  try {
    const data = JSON.parse(input);
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      writeHookTrace(data as Record<string, unknown>);
    }
    await sendHookEvent(data);
  } catch {
    // Malformed input, silently exit
  }

  process.exit(0);
});

// Timeout safety: don't hang if stdin never closes
setTimeout(() => process.exit(0), 5000);
