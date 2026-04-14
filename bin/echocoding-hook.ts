#!/usr/bin/env node

/**
 * EchoCoding Hook Handler — ultra-lightweight IPC client.
 * Called by Claude Code hooks. Reads stdin JSON, sends to daemon, exits.
 * Must be fast and never block the agent.
 */
import { sendHookEvent } from '../src/daemon/client.js';

let input = '';

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
    await sendHookEvent(data);
  } catch {
    // Malformed input, silently exit
  }

  process.exit(0);
});

// Timeout safety: don't hang if stdin never closes
setTimeout(() => process.exit(0), 5000);
