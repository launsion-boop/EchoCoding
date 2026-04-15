#!/usr/bin/env node

import { Command } from 'commander';
import { isDaemonRunning, stopDaemon } from '../src/daemon/server.js';
import { sendSay, sendSfx, sendAsk, sendListen, sendWithResponse, pingDaemon } from '../src/daemon/client.js';
import { installClaudeCode, uninstallClaudeCode, installCodex, uninstallCodex, detectInstalledAgents } from '../src/installer.js';
import { detectInstalledClients, getAllAdapters } from '../src/adapters/registry.js';
import { getConfig, setConfigValue, getConfigValue, ensureConfigDir, saveConfig, getRuntimeClientId } from '../src/config.js';
import { playSfx } from '../src/engines/sfx-engine.js';
import { checkModels, downloadModels, hasEssentialModels } from '../src/downloader.js';
import { checkSystemDeps, installMissingDeps } from '../src/deps.js';
import { startStudio } from '../src/studio/server.js';
import fs from 'node:fs';
import { fork } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const program = new Command();

program
  .name('echocoding')
  .description('Immersive audio feedback for Vibe Coding')
  .version('0.1.0');

// --- install ---
program
  .command('install')
  .description('Install EchoCoding hooks into your coding agent')
  .option('--claude-code', 'Install for Claude Code only')
  .option('--auto', 'Non-interactive, skip prompts')
  .option('--start', 'Start daemon after install')
  .option('--local-models', 'Download local TTS/ASR models (~1GB)')
  .option('--skip-models', 'Skip model download (deprecated, cloud is default)')
  .action(async (opts) => {
    // Use adapter registry to detect and install all supported agents
    const allAdapters = getAllAdapters();
    const installed = allAdapters.filter((a) => a.detect().installed);

    if (installed.length === 0) {
      console.log('[echocoding] No supported coding agents detected.');
      console.log('  Supported: Claude Code, Codex CLI, Cursor, Windsurf, Gemini CLI');
      process.exit(1);
    }

    // If --claude-code, filter to Claude only
    const targets = opts.claudeCode
      ? installed.filter((a) => a.id === 'claude-code')
      : installed;

    if (targets.length === 0) {
      console.log('[echocoding] Claude Code not detected.');
      process.exit(1);
    }

    console.log(`[echocoding] Detected agents: ${targets.map((a) => a.id).join(', ')}`);

    // Check & install system dependencies (sox, etc.)
    console.log();
    const deps = checkSystemDeps();
    const missing = deps.filter((d) => !d.installed);
    if (missing.length > 0) {
      console.log('[echocoding] Missing system dependencies:');
      for (const d of missing) {
        console.log(`  ✗ ${d.name} — ${d.purpose}`);
      }
      console.log();
      const failed = await installMissingDeps(deps);
      if (failed.length > 0) {
        console.log('[echocoding] Could not auto-install:');
        for (const d of failed) {
          console.log(`  ✗ ${d.name}: ${d.installHint}`);
        }
        console.log();
      } else {
        console.log('[echocoding] All system dependencies installed.');
      }
    } else {
      console.log('[echocoding] System dependencies: OK');
    }

    // Install each detected adapter
    for (const adapter of targets) {
      const result = adapter.install();
      const icon = result.success ? '✓' : '✗';
      console.log(`[echocoding] ${icon} ${adapter.id}: ${result.message}`);
    }

    ensureConfigDir();

    // Cloud is default — local models are optional, downloaded via Studio or CLI
    if (opts.localModels) {
      if (!hasEssentialModels()) {
        console.log();
        console.log('[echocoding] Downloading local models (~1GB)...');
        await downloadModels();
      } else {
        const statuses = checkModels();
        const installed = statuses.filter((s) => s.installed).length;
        console.log(`[echocoding] Local models: ${installed}/${statuses.length} installed`);
      }
    } else {
      console.log('[echocoding] Using cloud TTS/ASR (default). Local models can be downloaded later via `echocoding studio`.');
    }

    // macOS: request microphone permission via mic-helper .app bundle
    if (process.platform === 'darwin') {
      const micHelper = path.join(path.dirname(__dirname), 'tools', 'mic-helper');
      if (fs.existsSync(micHelper)) {
        console.log();
        console.log('[echocoding] Requesting microphone permission...');
        try {
          const { execFileSync } = await import('node:child_process');
          execFileSync(micHelper, ['authorize'], { timeout: 30_000, encoding: 'utf-8' });
          console.log('[echocoding] Microphone: authorized');
        } catch {
          console.log('[echocoding] Microphone: not authorized (you can grant later in System Settings)');
        }
      }
    }

    // --start: auto-start daemon
    if (opts.start) {
      const status = isDaemonRunning();
      if (!status.running) {
        const daemonScript = path.resolve(__dirname, 'echocoding-daemon.js');
        const child = fork(daemonScript, [], { detached: true, stdio: 'ignore' });
        child.unref();
        // Wait for daemon to be ready
        for (let i = 0; i < 30; i++) {
          await new Promise((r) => setTimeout(r, 100));
          if (isDaemonRunning().running) break;
        }
        console.log('[echocoding] Daemon started.');
      }
    }

    console.log();
    console.log('[echocoding] Installation complete!');
    console.log('  In Claude Code / Codex: type /echocoding to start voice mode');
    console.log('  In Cursor/Windsurf: MCP tools available automatically');
    console.log('  Run `echocoding studio` to configure voices and preview sounds');

    // Auto-open Studio so user can see settings
    if (opts.start || opts.auto) {
      console.log();
      console.log('[echocoding] Opening Studio...');
      const { exec } = await import('node:child_process');
      startStudio(9876);
    }
  });

// --- uninstall ---
program
  .command('uninstall')
  .description('Remove EchoCoding hooks from your coding agent')
  .action(() => {
    // Uninstall all detected adapters
    for (const adapter of getAllAdapters()) {
      if (adapter.detect().installed) {
        const result = adapter.uninstall();
        const icon = result.success ? '✓' : '✗';
        console.log(`[echocoding] ${icon} ${adapter.id}: ${result.message}`);
      }
    }

    const status = isDaemonRunning();
    if (status.running) {
      stopDaemon();
      console.log('[echocoding] Daemon stopped.');
    }
  });

// --- start ---
program
  .command('start')
  .description('Start EchoCoding daemon')
  .action(async () => {
    const status = isDaemonRunning();
    if (status.running) {
      console.log(`[echocoding] Daemon already running (pid: ${status.pid})`);
      return;
    }

    // Fork daemon as a detached background process
    const daemonScript = path.resolve(__dirname, 'echocoding-daemon.js');
    const child = fork(daemonScript, [], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();

    // Poll until daemon is ready (pid exists + socket reachable)
    const maxWait = 3000;
    const interval = 100;
    let elapsed = 0;
    const poll = async () => {
      while (elapsed < maxWait) {
        await sleep(interval);
        elapsed += interval;
        const check = isDaemonRunning();
        if (check.running && await pingDaemon()) {
          console.log(`[echocoding] Daemon started (pid: ${check.pid})`);
          checkForUpdate(); // fire-and-forget, don't block
          return;
        }
      }
      console.error('[echocoding] Failed to start daemon (timeout)');
      process.exit(1);
    };
    await poll();
  });

// --- stop ---
program
  .command('stop')
  .description('Stop EchoCoding daemon')
  .action(() => {
    if (stopDaemon()) {
      console.log('[echocoding] Daemon stopped.');
    } else {
      console.log('[echocoding] Daemon is not running.');
    }
  });

// --- status ---
program
  .command('status')
  .description('Show daemon status')
  .action(async () => {
    console.log(`[echocoding] Client context: ${getRuntimeClientId()}`);
    const status = isDaemonRunning();
    if (status.running) {
      const reachable = await pingDaemon();
      console.log(`[echocoding] Daemon: running (pid: ${status.pid})`);
      console.log(`[echocoding] Socket: ${reachable ? 'reachable' : 'unreachable'}`);
    } else {
      console.log('[echocoding] Daemon: not running');
    }
    const config = getConfig();
    console.log(`[echocoding] Mode: ${config.mode}`);
    console.log(`[echocoding] Volume: ${config.volume}`);
    console.log(`[echocoding] TTS: ${config.tts.enabled ? 'enabled' : 'disabled'}`);
    console.log(`[echocoding] SFX: ${config.sfx.enabled ? 'enabled' : 'disabled'}`);
    await checkForUpdate();
  });

// --- say ---
program
  .command('say <text>')
  .description('Speak text via TTS (blocks until playback finishes)')
  .action(async (text: string) => {
    try {
      // Wait for TTS to finish so text and voice stay in sync
      await sendWithResponse({ type: 'say', text }, 15_000);
    } catch {
      console.error('[echocoding] Daemon not running. Run `echocoding start` first.');
      process.exit(1);
    }
    // Output current voiceLevel so the AI can detect live changes from Studio
    const level = getConfig().voiceLevel || 'balanced';
    process.stdout.write(`[voiceLevel=${level}]\n`);
  });

// --- ask ---
program
  .command('ask <question>')
  .description('Speak a question via TTS, then listen for voice answer (ASK mode timeout: 60s)')
  .action(async (question: string) => {
    // Prefer daemon path so multi-turn ASK can reuse one HUD session.
    try {
      const result = await sendAsk(question);
      process.stdout.write(result + '\n');
      return;
    } catch {
      // Fallback: foreground ASK if daemon is unavailable.
    }

    try {
      const { ask } = await import('../src/engines/asr-engine.js');
      const result = await ask(question, 60);
      process.stdout.write(result + '\n');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[echocoding] ASR error: ${msg}\n`);
      process.stdout.write('[error]\n');
    }
  });

// --- listen ---
program
  .command('listen')
  .description('Open microphone and listen for voice input (stdout: recognized text)')
  .action(async () => {
    // Record + ASR in foreground (daemon's detached process can't access mic on macOS)
    try {
      const { listen } = await import('../src/engines/asr-engine.js');
      const result = await listen();
      process.stdout.write(result + '\n');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[echocoding] ASR error: ${msg}\n`);
      process.stdout.write('[error]\n');
    }
  });

// --- sfx ---
program
  .command('sfx <name>')
  .description('Play a sound effect')
  .action(async (name: string) => {
    const sent = await sendSfx(name);
    if (!sent) {
      // Fallback: play directly without daemon
      playSfx(name);
    }
  });

// --- test ---
program
  .command('test')
  .description('Play test sound effects')
  .action(async () => {
    const effects = ['startup', 'submit', 'success', 'error', 'notification', 'complete', 'write', 'git-commit'];

    console.log('[echocoding] Playing test sounds...');
    for (const sfx of effects) {
      console.log(`  ${sfx}`);
      playSfx(sfx);
      await sleep(800);
    }
    console.log('[echocoding] Test complete.');
  });

// --- config ---
const configCmd = program
  .command('config')
  .description('Manage configuration');

configCmd
  .command('set <key> <value>')
  .description('Set a config value (e.g., tts.endpoint, volume)')
  .action((key: string, value: string) => {
    setConfigValue(key, value);
    console.log(`[echocoding] ${key} = ${getConfigValue(key)}`);
  });

configCmd
  .command('get <key>')
  .description('Get a config value')
  .action((key: string) => {
    const val = getConfigValue(key);
    if (val === undefined) {
      console.log(`[echocoding] ${key}: (not set)`);
    } else {
      console.log(`[echocoding] ${key} = ${JSON.stringify(val)}`);
    }
  });

// --- volume ---
program
  .command('volume <level>')
  .description('Set master volume (0-100)')
  .action((level: string) => {
    const vol = parseInt(level, 10);
    if (isNaN(vol) || vol < 0 || vol > 100) {
      console.error('[echocoding] Volume must be 0-100');
      process.exit(1);
    }
    const config = getConfig();
    config.volume = vol;
    saveConfig(config);
    console.log(`[echocoding] Volume set to ${vol}`);
  });

// --- mode ---
program
  .command('mode <mode>')
  .description('Switch mode (full | sfx-only | voice-only | focus | mute)')
  .action((mode: string) => {
    const valid = ['full', 'sfx-only', 'voice-only', 'focus', 'mute'];
    if (!valid.includes(mode)) {
      console.error(`[echocoding] Invalid mode. Valid: ${valid.join(', ')}`);
      process.exit(1);
    }
    const config = getConfig();
    config.mode = mode as typeof config.mode;
    saveConfig(config);
    console.log(`[echocoding] Mode: ${mode}`);
  });

// --- tts-provider ---
program
  .command('tts-provider <provider>')
  .description('Switch TTS provider (local | cloud)')
  .action((provider: string) => {
    const valid = ['local', 'cloud'];
    if (!valid.includes(provider)) {
      console.error(`[echocoding] Invalid provider. Valid: ${valid.join(', ')}`);
      process.exit(1);
    }
    const config = getConfig();
    config.tts.provider = provider as 'local' | 'cloud';
    saveConfig(config);
    console.log(`[echocoding] TTS provider: ${provider}`);
    if (provider === 'local') {
      console.log(`[echocoding] Engine: ${config.tts.engine} (emotion: ${config.tts.emotion ? 'on' : 'off'})`);
    } else {
      console.log(`[echocoding] Endpoint: ${config.tts.cloud.endpoint}`);
    }
  });

// --- tts-engine ---
program
  .command('tts-engine <engine>')
  .description('Switch local TTS engine (orpheus | kokoro | system)')
  .action((engine: string) => {
    const valid = ['orpheus', 'kokoro', 'system'];
    if (!valid.includes(engine)) {
      console.error(`[echocoding] Invalid engine. Valid: ${valid.join(', ')}`);
      process.exit(1);
    }
    const config = getConfig();
    config.tts.engine = engine as 'orpheus' | 'kokoro' | 'system';
    config.tts.emotion = engine === 'orpheus'; // only Orpheus supports emotion
    saveConfig(config);
    console.log(`[echocoding] TTS engine: ${engine}`);
    console.log(`[echocoding] Emotion tags: ${config.tts.emotion ? 'enabled' : 'disabled'}`);
  });

// --- download ---
program
  .command('download [models...]')
  .description('Download TTS/ASR models (kokoro-tts, paraformer-asr, silero-vad)')
  .action(async (models: string[]) => {
    const statuses = checkModels();
    console.log('[echocoding] Model status:');
    for (const s of statuses) {
      console.log(`  ${s.installed ? '✓' : '✗'} ${s.key} (${s.size}) — ${s.description}`);
    }
    console.log();
    await downloadModels(models.length > 0 ? models : undefined);
  });

// --- studio ---
program
  .command('studio')
  .description('Open voice preview & configuration panel in browser')
  .option('-p, --port <number>', 'Preferred port (auto-detect if not specified)')
  .action(async (opts) => {
    const port = opts.port ? parseInt(opts.port, 10) : undefined;
    await startStudio(port);
  });

// --- mcp ---
program
  .command('mcp')
  .description('Start MCP server (stdio transport) for Cursor/Windsurf/Gemini integration')
  .action(async () => {
    const { startMcpServer } = await import('../src/mcp/server.js');
    await startMcpServer();
  });

// --- doctor ---
program
  .command('doctor')
  .description('Check system health: daemon, audio, models, adapters')
  .action(async () => {
    const { runDoctor } = await import('../src/doctor.js');
    await runDoctor();
  });

program.parse();

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Check npm registry for newer version. Non-blocking, never throws.
 * Prints a one-line update hint if a newer version is available.
 */
async function checkForUpdate(): Promise<void> {
  try {
    const pkgPath = path.resolve(__dirname, '..', '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { version: string };
    const current = pkg.version;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const resp = await fetch('https://registry.npmjs.org/echocoding/latest', {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    clearTimeout(timer);

    if (!resp.ok) return;
    const data = await resp.json() as { version?: string };
    const latest = data.version;
    if (!latest || latest === current) return;

    // Simple semver compare: split and compare numerically
    const cur = current.split('.').map(Number);
    const lat = latest.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
      if ((lat[i] ?? 0) > (cur[i] ?? 0)) {
        console.log(`[echocoding] Update available: ${current} → ${latest}. Run: npm update -g echocoding`);
        return;
      }
      if ((lat[i] ?? 0) < (cur[i] ?? 0)) return;
    }
  } catch {
    // Network error, timeout, etc. — silently ignore
  }
}
