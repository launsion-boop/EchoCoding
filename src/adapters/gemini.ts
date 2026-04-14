import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { ClientAdapter, AdapterDetection, AdapterResult } from './types.js';
import { getPackageRoot, writeSettingsSafe } from './claude.js';
import { parseJsonSafe } from '../json-safe.js';

const GEMINI_DIR = path.join(os.homedir(), '.gemini');
const GEMINI_SETTINGS_PATH = path.join(GEMINI_DIR, 'settings.json');

function getMcpServerEntry(): { command: string; args: string[] } {
  return {
    command: process.execPath,
    args: [path.join(getPackageRoot(), 'dist', 'bin', 'echocoding.js'), 'mcp'],
  };
}

export const geminiAdapter: ClientAdapter = {
  id: 'gemini',
  name: 'Gemini CLI',
  mechanism: 'mcp',

  detect(): AdapterDetection {
    const installed = fs.existsSync(GEMINI_DIR);
    const detection: AdapterDetection = { installed };
    if (installed) {
      detection.configPath = GEMINI_SETTINGS_PATH;
    }
    return detection;
  },

  install(): AdapterResult {
    if (!fs.existsSync(GEMINI_DIR)) {
      return { success: false, message: 'Gemini CLI config directory not found: ~/.gemini' };
    }

    try {
      // Read existing settings
      let settings: Record<string, unknown> = {};
      if (fs.existsSync(GEMINI_SETTINGS_PATH)) {
        try {
          settings = parseJsonSafe(fs.readFileSync(GEMINI_SETTINGS_PATH, 'utf-8')) as Record<string, unknown>;
        } catch {
          settings = {};
        }
      }

      // Inject MCP server config
      if (!settings.mcpServers || typeof settings.mcpServers !== 'object') {
        settings.mcpServers = {};
      }

      (settings.mcpServers as Record<string, unknown>).echocoding = getMcpServerEntry();
      writeSettingsSafe(GEMINI_SETTINGS_PATH, settings);

      return { success: true, message: 'Installed EchoCoding MCP server for Gemini CLI' };
    } catch (err) {
      return {
        success: false,
        message: `Failed to install Gemini adapter: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },

  uninstall(): AdapterResult {
    try {
      if (fs.existsSync(GEMINI_SETTINGS_PATH)) {
        try {
          const settings = parseJsonSafe(fs.readFileSync(GEMINI_SETTINGS_PATH, 'utf-8')) as Record<string, unknown>;
          if (settings.mcpServers && typeof settings.mcpServers === 'object') {
            delete (settings.mcpServers as Record<string, unknown>).echocoding;
            if (Object.keys(settings.mcpServers).length === 0) {
              delete settings.mcpServers;
            }
          }
          writeSettingsSafe(GEMINI_SETTINGS_PATH, settings);
        } catch {
          /* ignore parse errors during uninstall */
        }
      }

      return { success: true, message: 'Removed EchoCoding from Gemini CLI' };
    } catch (err) {
      return {
        success: false,
        message: `Failed to uninstall Gemini adapter: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },

  getPromptPath(): string | null {
    // Gemini CLI uses MCP-only, no separate prompt file
    return null;
  },
};
