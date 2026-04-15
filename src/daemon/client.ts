import net from 'node:net';
import { getConfig, resolveDaemonPaths } from '../config.js';

interface DaemonMessage {
  type: 'hook' | 'say' | 'sfx' | 'ask' | 'listen' | 'ask-end' | 'ping';
  data?: Record<string, unknown>;
  text?: string;
  name?: string;
  forceCloseHud?: boolean;
}

/**
 * Send a message to the daemon via Unix socket.
 * Ultra-lightweight: connect → send → disconnect.
 * Silently fails if daemon is not running (never blocks the agent).
 */
export function sendToDaemon(msg: DaemonMessage): Promise<boolean> {
  return new Promise((resolve) => {
    const config = getConfig();
    const { socketPath } = resolveDaemonPaths(config.daemon);
    let settled = false;

    const done = (value: boolean) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };

    const client = net.createConnection(socketPath, () => {
      client.end(JSON.stringify(msg) + '\n');
      done(true);
    });

    client.on('error', () => {
      client.destroy();
      done(false);
    });

    // Timeout: don't hang if daemon is slow
    client.setTimeout(2000, () => {
      client.destroy();
      done(false);
    });
  });
}

export async function sendHookEvent(data: Record<string, unknown>): Promise<boolean> {
  return sendToDaemon({ type: 'hook', data });
}

export async function sendSay(text: string): Promise<boolean> {
  return sendToDaemon({ type: 'say', text });
}

export async function sendSfx(name: string): Promise<boolean> {
  return sendToDaemon({ type: 'sfx', name });
}

export async function pingDaemon(): Promise<boolean> {
  return sendToDaemon({ type: 'ping' });
}

/**
 * Send ask/listen to daemon and wait for ASR result.
 * These are blocking — the daemon opens mic, records, recognizes, and responds.
 */
export function sendWithResponse(msg: DaemonMessage, timeoutMs = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const config = getConfig();
    const { socketPath } = resolveDaemonPaths(config.daemon);
    let settled = false;
    let responseBuffer = '';
    const timeout = setTimeout(() => {
      client.destroy();
      done('[timeout]');
    }, timeoutMs);

    const done = (result: string) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        resolve(result);
      }
    };

    const fail = (err: string) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(new Error(err));
      }
    };

    const client = net.createConnection(socketPath, () => {
      // Send the message but don't close — wait for response
      client.write(JSON.stringify(msg) + '\n');
    });

    client.on('data', (chunk) => {
      responseBuffer += chunk.toString();
      const lines = responseBuffer.split('\n');
      responseBuffer = lines.pop() ?? '';
      // Parse complete lines only
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as { result?: string };
          if (parsed.result !== undefined) {
            client.destroy();
            done(parsed.result);
            return;
          }
        } catch { /* partial data, keep buffering */ }
      }
    });

    client.on('error', () => {
      client.destroy();
      fail('Daemon not reachable');
    });

    client.on('end', () => {
      // Daemon closed connection before sending result
      if (!settled) {
        fail('Daemon closed connection');
      }
    });
  });
}

export async function sendAsk(
  text: string,
  options: { forceCloseHud?: boolean } = {},
): Promise<string> {
  return sendWithResponse(
    { type: 'ask', text, forceCloseHud: options.forceCloseHud === true },
    80_000,
  );
}

export async function sendListen(): Promise<string> {
  return sendWithResponse({ type: 'listen' });
}

export async function sendAskEnd(): Promise<string> {
  return sendWithResponse({ type: 'ask-end' }, 5_000);
}
