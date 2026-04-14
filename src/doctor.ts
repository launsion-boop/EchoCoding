/**
 * System health check command.
 * Prints a diagnostic report of EchoCoding's environment.
 */
import os from 'node:os';
import { execSync } from 'node:child_process';
import { isDaemonRunning } from './daemon/server.js';
import { pingDaemon } from './daemon/client.js';
import { checkModels } from './downloader.js';
import { checkSystemDeps } from './deps.js';

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

function ok(label: string, detail?: string): void {
  const suffix = detail ? ` ${DIM}${detail}${RESET}` : '';
  console.log(`  ${GREEN}\u2713${RESET} ${label}${suffix}`);
}

function fail(label: string, detail?: string): void {
  const suffix = detail ? ` ${DIM}${detail}${RESET}` : '';
  console.log(`  ${RED}\u2717${RESET} ${label}${suffix}`);
}

function heading(title: string): void {
  console.log();
  console.log(`${BOLD}${title}${RESET}`);
}

function getNodeVersion(): string | null {
  try {
    return process.versions.node;
  } catch {
    return null;
  }
}

export async function runDoctor(): Promise<void> {
  console.log();
  console.log(`${BOLD}EchoCoding Doctor${RESET}`);
  console.log(`${'='.repeat(40)}`);

  // ── System checks ──────────────────────────────────────
  heading('System');

  const nodeVersion = getNodeVersion();
  if (nodeVersion) {
    const major = parseInt(nodeVersion.split('.')[0], 10);
    if (major >= 18) {
      ok('Node.js', `v${nodeVersion}`);
    } else {
      fail('Node.js', `v${nodeVersion} (requires >= 18)`);
    }
  } else {
    fail('Node.js', 'not detected');
  }

  const platform = os.platform();
  const arch = os.arch();
  ok('Platform', `${platform} ${arch}`);

  const deps = checkSystemDeps();
  for (const dep of deps) {
    if (dep.installed) {
      ok(dep.name, dep.purpose);
    } else {
      fail(dep.name, `${dep.purpose} -- ${dep.installHint}`);
    }
  }

  // ── Daemon checks ──────────────────────────────────────
  heading('Daemon');

  const daemonStatus = isDaemonRunning();
  if (daemonStatus.running) {
    ok('Daemon running', `pid ${daemonStatus.pid}`);

    const reachable = await pingDaemon();
    if (reachable) {
      ok('Socket reachable');
    } else {
      fail('Socket reachable', 'ping failed');
    }
  } else {
    fail('Daemon running', 'not started');
    fail('Socket reachable', 'daemon not running');
  }

  // ── Model checks ───────────────────────────────────────
  heading('Models');

  const models = checkModels();
  for (const model of models) {
    if (model.installed) {
      ok(model.key, model.description);
    } else {
      fail(model.key, `${model.description} (${model.size})`);
    }
  }

  // ── Adapter checks ─────────────────────────────────────
  heading('Adapters');

  try {
    const registry = await import('./adapters/registry.js');
    const adapters = registry.getAdapters?.() ?? [];
    const list = Array.isArray(adapters) ? adapters : [];

    if (list.length === 0) {
      console.log(`  ${DIM}(no adapters registered)${RESET}`);
    } else {
      for (const adapter of list) {
        const detection = adapter.detect();
        if (detection.installed) {
          const ver = detection.version ? ` v${detection.version}` : '';
          ok(adapter.name, `${adapter.mechanism}${ver}`);
        } else {
          fail(adapter.name, `not installed (${adapter.mechanism})`);
        }
      }
    }
  } catch {
    console.log(`  ${DIM}(adapter registry not available)${RESET}`);
  }

  console.log();
}
