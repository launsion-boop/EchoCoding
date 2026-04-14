import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getSoundsDir, getConfig } from '../config.js';
import { shouldThrottle, recordUsage } from '../throttle.js';

/**
 * Sound effect fallback chains.
 * If a specific SFX isn't found, walk up the chain until we find one.
 */
const FALLBACK_CHAINS: Record<string, string[]> = {
  'git-commit': ['git-commit', 'git', 'success'],
  'git-push': ['git-push', 'git', 'success'],
  'npm-test-pass': ['npm-test-pass', 'test-pass', 'success'],
  'npm-test-fail': ['npm-test-fail', 'test-fail', 'error'],
  'test-pass': ['test-pass', 'success'],
  'test-fail': ['test-fail', 'error'],
  'write': ['write', 'success'],
  'typing': ['typing', 'write', 'success'],
  'complete': ['complete', 'success'],
  'startup': ['startup', 'notification'],
  'submit': ['submit', 'notification'],
  'search': ['search', 'notification'],
  'read': ['read', 'notification'],
  'compact': ['compact', 'notification'],
  'thinking': ['thinking', 'notification'],
  'working': ['working', 'notification'],
  'agent-spawn': ['agent-spawn', 'notification'],
  'agent-done': ['agent-done', 'success'],
  'delete': ['delete', 'error'],
  'install': ['install', 'success'],
  'heartbeat': ['heartbeat', 'notification'],
  'mic-ready': ['mic-ready', 'notification'],
};

const SUPPORTED_EXTENSIONS = ['.mp3', '.wav', '.ogg', '.m4a', '.aiff'];

export function playSfx(name: string): void {
  const config = getConfig();

  if (!config.sfx.enabled || config.mode === 'mute' || config.mode === 'voice-only') {
    return;
  }

  if (shouldThrottle('sfx:' + name)) {
    return;
  }

  const soundFile = resolveSoundFile(name);
  if (!soundFile) {
    return;
  }

  const volume = Math.round((config.volume / 100) * (config.sfx.volume / 100) * 100);
  playAudioFile(soundFile, volume);
  recordUsage('sfx:' + name);
}

function resolveSoundFile(name: string): string | null {
  const soundsDir = getSoundsDir();

  // Try the name directly, then walk fallback chain
  const chain = FALLBACK_CHAINS[name] ?? [name];

  for (const candidate of chain) {
    for (const ext of SUPPORTED_EXTENSIONS) {
      const filePath = path.join(soundsDir, candidate + ext);
      if (fs.existsSync(filePath)) {
        return filePath;
      }
    }
    // Also check sfx/ subdirectory
    for (const ext of SUPPORTED_EXTENSIONS) {
      const filePath = path.join(soundsDir, 'sfx', candidate + ext);
      if (fs.existsSync(filePath)) {
        return filePath;
      }
    }
  }

  return null;
}

export function playAudioFile(filePath: string, volume?: number): void {
  const platform = os.platform();

  if (platform === 'darwin') {
    // macOS: afplay supports volume (0-255 scale)
    const args = [filePath];
    if (volume !== undefined) {
      // afplay volume: 0 = silent, 1 = normal, >1 = amplified
      const afplayVol = (volume / 100).toFixed(2);
      args.push('-v', afplayVol);
    }
    const child = spawn('afplay', args, {
      stdio: 'ignore',
      detached: true,
    });
    child.unref();
  } else if (platform === 'linux') {
    // Linux: try paplay (PulseAudio), then aplay (ALSA)
    const child = spawn('paplay', [filePath], {
      stdio: 'ignore',
      detached: true,
    });
    child.on('error', () => {
      const fallback = spawn('aplay', [filePath], {
        stdio: 'ignore',
        detached: true,
      });
      fallback.unref();
    });
    child.unref();
  } else if (platform === 'win32') {
    // Windows: PowerShell
    const psCmd = `(New-Object Media.SoundPlayer '${filePath}').PlaySync()`;
    const child = spawn('powershell', ['-Command', psCmd], {
      stdio: 'ignore',
      detached: true,
    });
    child.unref();
  }
}

export function listAvailableSfx(): string[] {
  const soundsDir = getSoundsDir();
  const results: string[] = [];

  for (const dir of [soundsDir, path.join(soundsDir, 'sfx')]) {
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir)) {
      const ext = path.extname(file);
      if (SUPPORTED_EXTENSIONS.includes(ext)) {
        results.push(path.basename(file, ext));
      }
    }
  }

  return [...new Set(results)].sort();
}
