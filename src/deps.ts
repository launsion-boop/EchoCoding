import os from 'node:os';
import { execSync } from 'node:child_process';

interface DepStatus {
  name: string;
  command: string;
  required: boolean;
  installed: boolean;
  purpose: string;
  installHint: string;
}

/**
 * Check system-level dependencies required by EchoCoding.
 */
export function checkSystemDeps(): DepStatus[] {
  const platform = os.platform();
  const deps: DepStatus[] = [];

  // sox — needed for microphone recording (ASR)
  deps.push({
    name: 'sox',
    command: 'rec',
    required: true,
    installed: commandExists('rec'),
    purpose: 'Microphone recording (ASR)',
    installHint: platform === 'darwin'
      ? 'brew install sox'
      : platform === 'linux'
        ? 'sudo apt install sox'
        : 'Install SoX from https://sox.sourceforge.net',
  });

  // afplay — macOS only, needed for SFX playback
  if (platform === 'darwin') {
    deps.push({
      name: 'afplay',
      command: 'afplay',
      required: true,
      installed: commandExists('afplay'),
      purpose: 'Sound effect playback',
      installHint: 'Built into macOS — should already be available',
    });
  }

  return deps;
}

/**
 * Try to auto-install missing deps. Returns list of deps that failed to install.
 */
export async function installMissingDeps(deps: DepStatus[]): Promise<DepStatus[]> {
  const missing = deps.filter((d) => !d.installed);
  const failed: DepStatus[] = [];
  const platform = os.platform();

  for (const dep of missing) {
    if (dep.name === 'sox') {
      const ok = await tryInstallSox(platform);
      if (!ok) {
        failed.push(dep);
      }
    } else {
      failed.push(dep);
    }
  }

  return failed;
}

async function tryInstallSox(platform: string): Promise<boolean> {
  try {
    if (platform === 'darwin') {
      // Check brew is available
      if (!commandExists('brew')) {
        return false;
      }
      console.log('[echocoding] Installing sox via Homebrew...');
      execSync('brew install sox', { stdio: 'inherit', timeout: 120_000 });
      return commandExists('rec');
    }

    if (platform === 'linux') {
      // Try apt-get (non-interactive, may fail without sudo)
      console.log('[echocoding] Installing sox via apt-get...');
      execSync('sudo apt-get install -y sox', { stdio: 'inherit', timeout: 120_000 });
      return commandExists('rec');
    }
  } catch {
    return false;
  }

  return false;
}

function commandExists(cmd: string): boolean {
  try {
    execSync(`which ${cmd}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
