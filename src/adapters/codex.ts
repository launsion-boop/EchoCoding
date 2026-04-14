import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { ClientAdapter, AdapterDetection, AdapterResult } from './types.js';
import { getPackageRoot } from './claude.js';

const CODEX_DIR = path.join(os.homedir(), '.codex');
const CODEX_SKILLS_DIR = path.join(CODEX_DIR, 'skills');
const CODEX_INSTRUCTIONS_PATH = path.join(CODEX_DIR, 'instructions.md');
const SKILL_PATH = path.join(CODEX_SKILLS_DIR, 'echocoding.md');
const MARKER = '<!-- echocoding-voice-mode -->';

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
    if (!fs.existsSync(CODEX_DIR)) {
      return { success: false, message: 'Codex CLI config directory not found' };
    }

    try {
      // Install skill to Codex skills directory
      fs.mkdirSync(CODEX_SKILLS_DIR, { recursive: true });
      const skillSrc = path.join(getPackageRoot(), 'skills', 'echocoding.md');

      if (fs.existsSync(skillSrc)) {
        fs.copyFileSync(skillSrc, SKILL_PATH);
      }

      // Append EchoCoding reference to instructions.md if not already there
      let instructions = '';
      if (fs.existsSync(CODEX_INSTRUCTIONS_PATH)) {
        instructions = fs.readFileSync(CODEX_INSTRUCTIONS_PATH, 'utf-8');
      }

      if (!instructions.includes(MARKER)) {
        const appendix = `\n\n${MARKER}\n## EchoCoding Voice Mode\nWhen user says "/echocoding" or "voice mode on", run \`echocoding start\` and follow the voice mode rules in the echocoding skill.\n`;
        fs.appendFileSync(CODEX_INSTRUCTIONS_PATH, appendix);
      }

      return { success: true, message: 'Installed EchoCoding skill for Codex CLI' };
    } catch (err) {
      return {
        success: false,
        message: `Failed to install Codex adapter: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },

  uninstall(): AdapterResult {
    try {
      // Remove skill file
      try {
        fs.unlinkSync(SKILL_PATH);
      } catch {
        /* ignore */
      }

      // Remove marker section from instructions.md
      if (fs.existsSync(CODEX_INSTRUCTIONS_PATH)) {
        let instructions = fs.readFileSync(CODEX_INSTRUCTIONS_PATH, 'utf-8');
        const markerIdx = instructions.indexOf(MARKER);
        if (markerIdx !== -1) {
          // Remove from marker to end of the section (next ## or end of file)
          const after = instructions.slice(markerIdx);
          const nextSection = after.indexOf('\n## ', 1);
          const removeEnd = nextSection === -1 ? instructions.length : markerIdx + nextSection;
          instructions = instructions.slice(0, markerIdx).trimEnd() + instructions.slice(removeEnd);
          fs.writeFileSync(CODEX_INSTRUCTIONS_PATH, instructions);
        }
      }

      return { success: true, message: 'Removed EchoCoding from Codex CLI' };
    } catch (err) {
      return {
        success: false,
        message: `Failed to uninstall Codex adapter: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },

  getPromptPath(): string | null {
    return SKILL_PATH;
  },
};
