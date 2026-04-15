import net from 'node:net';
import fs from 'node:fs';
import { getConfig, ensureConfigDir, resolveDaemonPaths } from '../config.js';
import { playSfx, playSfxAmbient } from '../engines/sfx-engine.js';
import { speak, cleanupTempFiles, disposeTts } from '../engines/voice-engine.js';
import { listen, ask, closeAskSessionHud, disposeAsr } from '../engines/asr-engine.js';
import { handleHookEvent, parseHookEvent, setAmbientControls } from '../hook-handler.js';
import { resetThrottle } from '../throttle.js';

interface DaemonMessage {
  type: 'hook' | 'say' | 'sfx' | 'ask' | 'listen' | 'ask-end' | 'ping';
  data?: Record<string, unknown>;
  text?: string;
  name?: string;
}

let server: net.Server | null = null;

// --- Ambient loop state ---
let ambientInterval: ReturnType<typeof setInterval> | null = null;
let ambientName: string | null = null;

/**
 * Start looping an SFX at a fixed interval (e.g. thinking sound while idle).
 * Calling again with a different name switches the ambient; same name is a no-op.
 */
export function startAmbient(sfxName: string, intervalMs = 3500): void {
  if (ambientName === sfxName && ambientInterval) return; // already playing
  stopAmbient();
  ambientName = sfxName;
  playSfxAmbient(sfxName); // play immediately (no throttle)
  ambientInterval = setInterval(() => playSfxAmbient(sfxName), intervalMs);
}

/** Stop any running ambient loop. */
export function stopAmbient(): void {
  if (ambientInterval) {
    clearInterval(ambientInterval);
    ambientInterval = null;
  }
  ambientName = null;
}

export function startDaemon(): void {
  const config = getConfig();
  const { socketPath, pidFile } = resolveDaemonPaths(config.daemon);

  ensureConfigDir();

  // Clean up stale socket
  if (fs.existsSync(socketPath)) {
    try {
      fs.unlinkSync(socketPath);
    } catch {
      console.error(`[echocoding] Cannot remove stale socket: ${socketPath}`);
      process.exit(1);
    }
  }

  const MAX_PAYLOAD = 1024 * 1024; // 1MB limit

  server = net.createServer((conn) => {
    let buffer = '';

    conn.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      if (buffer.length > MAX_PAYLOAD) {
        conn.destroy();
        return;
      }

      // Process complete lines immediately (don't wait for 'end')
      // This is critical: sendWithResponse keeps the connection open for the reply.
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';  // Keep incomplete last line in buffer
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line) as DaemonMessage;
          handleMessage(msg, conn);
        } catch {
          // Ignore malformed messages
        }
      }
    });

    conn.on('error', () => {
      // Client disconnected, ignore
    });
  });

  // Wire up ambient controls so hook-handler can start/stop ambient loops
  setAmbientControls(startAmbient, stopAmbient);

  server.listen(socketPath, () => {
    // Write PID file
    fs.writeFileSync(pidFile, String(process.pid));
    // Set socket permissions (owner-only)
    fs.chmodSync(socketPath, 0o600);
    // Clean up stale TTS temp files from previous sessions
    cleanupTempFiles();
    console.log(`[echocoding] Daemon started (pid: ${process.pid})`);
    console.log(`[echocoding] Listening on ${socketPath}`);
  });

  server.on('error', (err) => {
    console.error(`[echocoding] Daemon error:`, err.message);
    process.exit(1);
  });

  // Graceful shutdown
  const cleanup = () => {
    console.log('\n[echocoding] Shutting down...');
    stopAmbient();
    server?.close();
    try { fs.unlinkSync(socketPath); } catch { /* ignore */ }
    try { fs.unlinkSync(pidFile); } catch { /* ignore */ }
    cleanupTempFiles();
    disposeTts();
    disposeAsr();
    resetThrottle();
    process.exit(0);
  };

  process.on('SIGTERM', cleanup);
  process.on('SIGINT', cleanup);
}

function handleMessage(msg: DaemonMessage, conn?: net.Socket): void {
  switch (msg.type) {
    case 'hook': {
      if (msg.data) {
        const event = parseHookEvent(JSON.stringify(msg.data));
        if (event) {
          handleHookEvent(event);
        }
      }
      break;
    }

    case 'say': {
      if (msg.text) {
        speak(msg.text)
          .then(() => {
            try { conn?.write(JSON.stringify({ result: 'done' }) + '\n'); } catch { /* */ }
          })
          .catch(() => {
            try { conn?.write(JSON.stringify({ result: 'done' }) + '\n'); } catch { /* */ }
          });
      }
      break;
    }

    case 'sfx': {
      if (msg.name) {
        playSfx(msg.name);
      }
      break;
    }

    case 'ask': {
      // TTS question + open mic + ASR → send result back
      if (msg.text) {
        ask(msg.text, 60)
          .then((result) => {
            // Write result back to stdout-connected client
            try { conn?.write(JSON.stringify({ result }) + '\n'); } catch { /* */ }
          })
          .catch(() => {
            try { conn?.write(JSON.stringify({ result: '[error]' }) + '\n'); } catch { /* */ }
          });
      }
      break;
    }

    case 'listen': {
      // Open mic + ASR → send result back
      listen()
        .then((result) => {
          try { conn?.write(JSON.stringify({ result }) + '\n'); } catch { /* */ }
        })
        .catch(() => {
          try { conn?.write(JSON.stringify({ result: '[error]' }) + '\n'); } catch { /* */ }
        });
      break;
    }

    case 'ask-end': {
      closeAskSessionHud();
      try { conn?.write(JSON.stringify({ result: 'done' }) + '\n'); } catch { /* */ }
      break;
    }

    case 'ping': {
      // Health check
      break;
    }
  }
}

export function isDaemonRunning(): { running: boolean; pid?: number } {
  const config = getConfig();
  const { pidFile, socketPath } = resolveDaemonPaths(config.daemon);

  if (!fs.existsSync(pidFile)) {
    return { running: false };
  }

  const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);

  if (!Number.isInteger(pid) || pid < 2) {
    // Invalid pid file, clean up
    try { fs.unlinkSync(pidFile); } catch { /* ignore */ }
    try { fs.unlinkSync(socketPath); } catch { /* ignore */ }
    return { running: false };
  }

  // Check if process is alive
  try {
    process.kill(pid, 0); // Signal 0 = check existence
  } catch {
    // Process doesn't exist, clean up stale files
    try { fs.unlinkSync(pidFile); } catch { /* ignore */ }
    try { fs.unlinkSync(socketPath); } catch { /* ignore */ }
    return { running: false };
  }

  return { running: true, pid };
}

export function stopDaemon(): boolean {
  const status = isDaemonRunning();
  if (!status.running || !status.pid) {
    return false;
  }

  try {
    process.kill(status.pid, 'SIGTERM');
    return true;
  } catch {
    return false;
  }
}
