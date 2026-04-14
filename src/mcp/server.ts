/**
 * EchoCoding MCP Server
 *
 * Exposes EchoCoding audio capabilities as MCP tools.
 * Thin wrapper — all work is dispatched to the daemon via IPC.
 * Runs as stdio transport for client integration.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { sendSay, sendSfx, sendAsk, sendListen, pingDaemon } from '../daemon/client.js';
import { getConfig } from '../config.js';
import { listAvailableSfx } from '../engines/sfx-engine.js';
import { isDaemonRunning } from '../daemon/server.js';

export async function startMcpServer(): Promise<void> {
  // CRITICAL: Redirect console.log to stderr to avoid polluting stdio MCP protocol.
  // Any stdout output that isn't JSON-RPC will crash the client connection.
  const _origLog = console.log;
  console.log = (...args: unknown[]) => console.error('[echocoding-mcp]', ...args);
  console.info = (...args: unknown[]) => console.error('[echocoding-mcp]', ...args);
  console.warn = (...args: unknown[]) => console.error('[echocoding-mcp warn]', ...args);

  const server = new McpServer({
    name: 'echocoding',
    version: '0.1.0',
  });

  // --- Tool: echocoding_say ---
  server.tool(
    'echocoding_say',
    'Speak text aloud via TTS. Use this to give voice feedback to the user at key moments: task start, findings, completions, errors, questions.',
    {
      text: z.string().describe('The text to speak. Keep it short (1-2 sentences). Use general terms, no code or file paths.'),
    },
    async ({ text }) => {
      const sent = await sendSay(text);
      return {
        content: [{ type: 'text', text: sent ? 'Speaking.' : 'Daemon not running. Start with: echocoding start' }],
      };
    },
  );

  // --- Tool: echocoding_sfx ---
  server.tool(
    'echocoding_sfx',
    'Play a sound effect. Available: startup, submit, success, error, notification, complete, write, typing, read, search, working, thinking, git-commit, git-push, test-pass, test-fail, compact, agent-spawn, agent-done, install, delete, heartbeat.',
    {
      name: z.string().describe('Sound effect name (e.g. "success", "error", "thinking", "git-commit")'),
    },
    async ({ name }) => {
      const sent = await sendSfx(name);
      return {
        content: [{ type: 'text', text: sent ? `Playing: ${name}` : 'Daemon not running.' }],
      };
    },
  );

  // --- Tool: echocoding_ask ---
  server.tool(
    'echocoding_ask',
    'Speak a question via TTS, then open the microphone and listen for the user\'s voice response. Returns recognized text. Use for decisions, confirmations, or when you need verbal input.',
    {
      question: z.string().describe('The question to ask the user via voice'),
    },
    async ({ question }) => {
      try {
        const result = await sendAsk(question);
        return {
          content: [{ type: 'text', text: `User said: ${result}` }],
        };
      } catch {
        return {
          content: [{ type: 'text', text: 'Daemon not running or ASR unavailable.' }],
        };
      }
    },
  );

  // --- Tool: echocoding_listen ---
  server.tool(
    'echocoding_listen',
    'Open the microphone and listen for user voice input without speaking first. Returns recognized text. Use after a spoken message when you want to give the user a chance to respond verbally.',
    {},
    async () => {
      try {
        const result = await sendListen();
        return {
          content: [{ type: 'text', text: `User said: ${result}` }],
        };
      } catch {
        return {
          content: [{ type: 'text', text: 'Daemon not running or ASR unavailable.' }],
        };
      }
    },
  );

  // --- Tool: echocoding_status ---
  server.tool(
    'echocoding_status',
    'Get EchoCoding daemon status and configuration. Returns whether daemon is running, current mode, volume, TTS/SFX enabled state, and available sound effects.',
    {},
    async () => {
      const status = isDaemonRunning();
      const reachable = status.running ? await pingDaemon() : false;
      const config = getConfig();
      const sfxList = listAvailableSfx();

      const info = [
        `Daemon: ${status.running ? `running (pid: ${status.pid})` : 'not running'}`,
        `Socket: ${reachable ? 'reachable' : 'unreachable'}`,
        `Mode: ${config.mode}`,
        `Volume: ${config.volume}`,
        `TTS: ${config.tts.enabled ? 'enabled' : 'disabled'} (${config.tts.provider})`,
        `SFX: ${config.sfx.enabled ? 'enabled' : 'disabled'}`,
        `Available SFX: ${sfxList.join(', ')}`,
      ];

      return {
        content: [{ type: 'text', text: info.join('\n') }],
      };
    },
  );

  // Start server with stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
