import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { ClientAdapter, AdapterDetection, AdapterResult } from './types.js';
import { installCodex, uninstallCodex } from '../installer.js';

const CODEX_DIR = path.join(os.homedir(), '.codex');
const CODEX_SKILLS_DIR = path.join(CODEX_DIR, 'skills');
const CODEX_INSTRUCTIONS_PATH = path.join(CODEX_DIR, 'instructions.md');
const SKILL_PATH = path.join(CODEX_SKILLS_DIR, 'echocoding', 'SKILL.md');

export const codexAdapter: ClientAdapter = {
  id: 'codex',
  name: 'Codex CLI',
  mechanism: 'prompt-only',

  detect(): AdapterDetection {
    const installed = fs.existsSync(CODEX_DIR);
    const detection: AdapterDetection = { installed };
    if (installed) {
      detection.configPath = CODEX_INSTRUCTIONS_PATH;
    }
    return detection;
  },

  install(): AdapterResult {
    return installCodex();
  },

  uninstall(): AdapterResult {
    return uninstallCodex();
  },

  getPromptPath(): string | null {
    return SKILL_PATH;
  },
};
