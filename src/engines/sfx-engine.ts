import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getSoundsDir, getConfig } from '../config.js';
import { shouldThrottle, recordUsage, type ThrottleOptions } from '../throttle.js';

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

// Per-SFX throttle tuning:
// default throttle (3s) is too coarse for dense tool streams and can hide events.
const SFX_THROTTLE_OVERRIDES: Record<string, Partial<ThrottleOptions>> = {
  write: { minInterval: 0.15, dedupWindow: 0.5 },
  typing: { minInterval: 0.15, dedupWindow: 0.4 },
  thinking: { minInterval: 0.2, dedupWindow: 0.6 },
  read: { minInterval: 0.35, dedupWindow: 0.8 },
  search: { minInterval: 0.35, dedupWindow: 0.8 },
  notification: { minInterval: 0.5, dedupWindow: 0.9 },
  working: { minInterval: 0.5, dedupWindow: 0.9 },
};

// Typing/write assets are intentionally quiet to avoid fatigue.
// Boost them at runtime so editing feedback stays audible at normal global volume.
const SFX_VOLUME_MULTIPLIERS: Record<string, number> = {
  write: 2.0,
  typing: 2.8,
  thinking: 2.2,
};

export function playSfx(name: string): void {
  const config = getConfig();

  if (!config.sfx.enabled || config.mode === 'mute' || config.mode === 'voice-only') {
    return;
  }

  const throttleOptions = SFX_THROTTLE_OVERRIDES[name];
  if (shouldThrottle('sfx:' + name, undefined, throttleOptions)) {
    return;
  }

  const soundFile = resolveSoundFile(name);
  if (!soundFile) {
    return;
  }

  const volume = resolveSfxVolume(name, config.volume, config.sfx.volume);
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

/**
 * Play audio file and wait for playback to finish.
 * Used by TTS to block until speech completes (text/voice sync).
 */
export function playAudioFileAsync(filePath: string, volume?: number): Promise<void> {
  return new Promise((resolve) => {
    const platform = os.platform();

    if (platform === 'darwin') {
      const args = [filePath];
      if (volume !== undefined) {
        args.push('-v', (volume / 100).toFixed(2));
      }
      const child = spawn('afplay', args, { stdio: 'ignore' });
      child.on('close', () => resolve());
      child.on('error', () => resolve());
    } else if (platform === 'linux') {
      const child = spawn('paplay', [filePath], { stdio: 'ignore' });
      child.on('close', () => resolve());
      child.on('error', () => {
        const fallback = spawn('aplay', [filePath], { stdio: 'ignore' });
        fallback.on('close', () => resolve());
        fallback.on('error', () => resolve());
      });
    } else if (platform === 'win32') {
      const psCmd = `(New-Object Media.SoundPlayer '${filePath}').PlaySync()`;
      const child = spawn('powershell', ['-Command', psCmd], { stdio: 'ignore' });
      child.on('close', () => resolve());
      child.on('error', () => resolve());
    } else {
      resolve();
    }
  });
}

/**
 * Play an SFX for ambient loops — bypasses throttle since ambient is intentionally looping.
 * Do NOT use for one-shot SFX (use playSfx instead).
 */
export function playSfxAmbient(name: string): void {
  const config = getConfig();
  if (!config.sfx.enabled || config.mode === 'mute' || config.mode === 'voice-only') {
    return;
  }
  const soundFile = resolveSoundFile(name);
  if (!soundFile) return;
  const volume = resolveSfxVolume(name, config.volume, config.sfx.volume);
  playAudioFile(soundFile, volume);
}

function resolveSfxVolume(name: string, masterVolume: number, sfxVolume: number): number {
  const base = (masterVolume / 100) * (sfxVolume / 100) * 100;
  const multiplier = SFX_VOLUME_MULTIPLIERS[name] ?? 1;
  // afplay accepts >1.0 volume, so allow moderate boost but cap to avoid clipping.
  return Math.max(0, Math.min(250, Math.round(base * multiplier)));
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
