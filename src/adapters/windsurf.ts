import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { ClientAdapter, AdapterDetection, AdapterResult } from './types.js';
import { getPackageRoot, writeSettingsSafe } from './claude.js';
import { parseJsonSafe } from '../json-safe.js';

const WINDSURF_DIR = path.join(os.homedir(), '.windsurf');
const CODEIUM_DIR = path.join(os.homedir(), '.codeium', 'windsurf');

// Windsurf MCP config can live in either location
const WINDSURF_MCP_PATH = path.join(WINDSURF_DIR, 'mcp.json');
const CODEIUM_MCP_PATH = path.join(CODEIUM_DIR, 'mcp_config.json');

const WINDSURF_RULES_DIR = path.join(WINDSURF_DIR, 'rules');
const CODEIUM_RULES_DIR = path.join(CODEIUM_DIR, 'rules');

function getActiveDir(): string | null {
  if (fs.existsSync(WINDSURF_DIR)) return WINDSURF_DIR;
  if (fs.existsSync(CODEIUM_DIR)) return CODEIUM_DIR;
  return null;
}

function getMcpConfigPath(): string | null {
  // Prefer existing config; fall back to the directory that exists
  if (fs.existsSync(CODEIUM_MCP_PATH)) return CODEIUM_MCP_PATH;
  if (fs.existsSync(WINDSURF_MCP_PATH)) return WINDSURF_MCP_PATH;
  if (fs.existsSync(CODEIUM_DIR)) return CODEIUM_MCP_PATH;
  if (fs.existsSync(WINDSURF_DIR)) return WINDSURF_MCP_PATH;
  return null;
}

function getRulesDir(): string | null {
  if (fs.existsSync(CODEIUM_DIR)) return CODEIUM_RULES_DIR;
  if (fs.existsSync(WINDSURF_DIR)) return WINDSURF_RULES_DIR;
  return null;
}

function getRulesPath(): string | null {
  const dir = getRulesDir();
  return dir ? path.join(dir, 'echocoding.md') : null;
}

function getMcpServerEntry(): { command: string; args: string[] } {
  return {
    command: process.execPath,
    args: [path.join(getPackageRoot(), 'dist', 'bin', 'echocoding.js'), 'mcp'],
  };
}

export const windsurfAdapter: ClientAdapter = {
  id: 'windsurf',
  name: 'Windsurf',
  mechanism: 'mcp',

  detect(): AdapterDetection {
    const activeDir = getActiveDir();
    const installed = activeDir !== null;
    const detection: AdapterDetection = { installed };
    if (installed) {
      detection.configPath = getMcpConfigPath() ?? undefined;
    }
    return detection;
  },

  install(): AdapterResult {
    const activeDir = getActiveDir();
    if (!activeDir) {
      return { success: false, message: 'Windsurf config directory not found (~/.windsurf or ~/.codeium/windsurf)' };
    }

    try {
      // 1. Write/merge MCP config
      const mcpPath = getMcpConfigPath();
      if (!mcpPath) {
        return { success: false, message: 'Could not determine Windsurf MCP config path' };
      }

      let mcpConfig: Record<string, unknown> = {};
      if (fs.existsSync(mcpPath)) {
        try {
          mcpConfig = parseJsonSafe(fs.readFileSync(mcpPath, 'utf-8')) as Record<string, unknown>;
        } catch {
          mcpConfig = {};
        }
      } else {
        // Ensure parent directory exists
        fs.mkdirSync(path.dirname(mcpPath), { recursive: true });
      }

      if (!mcpConfig.mcpServers || typeof mcpConfig.mcpServers !== 'object') {
        mcpConfig.mcpServers = {};
      }

      (mcpConfig.mcpServers as Record<string, unknown>).echocoding = getMcpServerEntry();
      writeSettingsSafe(mcpPath, mcpConfig);

      // 2. Write rules file
      const rulesDir = getRulesDir();
      if (rulesDir) {
        fs.mkdirSync(rulesDir, { recursive: true });
        const rulesPath = path.join(rulesDir, 'echocoding.md');
        const rulesContent = [
          '# EchoCoding Voice Mode',
          '',
          'EchoCoding MCP tools are available for voice feedback.',
          'Use `echocoding_say` to speak text aloud at key moments.',
          'Use `echocoding_sfx` to play sound effects for events.',
          'Use `echocoding_ask` to ask the user a question and get a spoken answer.',
          'Use `echocoding_listen` to listen for voice commands.',
          '',
          'Speak at milestones: task start, findings, completions, errors, and questions.',
          '',
        ].join('\n');
        fs.writeFileSync(rulesPath, rulesContent);
      }

      return { success: true, message: 'Installed EchoCoding MCP server and rules for Windsurf' };
    } catch (err) {
      return {
        success: false,
        message: `Failed to install Windsurf adapter: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },

  uninstall(): AdapterResult {
    try {
      // Remove echocoding from both possible MCP config locations
      for (const mcpPath of [WINDSURF_MCP_PATH, CODEIUM_MCP_PATH]) {
        if (fs.existsSync(mcpPath)) {
          try {
            const mcpConfig = parseJsonSafe(fs.readFileSync(mcpPath, 'utf-8')) as Record<string, unknown>;
            if (mcpConfig.mcpServers && typeof mcpConfig.mcpServers === 'object') {
              delete (mcpConfig.mcpServers as Record<string, unknown>).echocoding;
              if (Object.keys(mcpConfig.mcpServers).length === 0) {
                delete mcpConfig.mcpServers;
              }
            }
            writeSettingsSafe(mcpPath, mcpConfig);
          } catch {
            /* ignore parse errors during uninstall */
          }
        }
      }

      // Remove rules files from both possible locations
      for (const rulesDir of [WINDSURF_RULES_DIR, CODEIUM_RULES_DIR]) {
        try {
          fs.unlinkSync(path.join(rulesDir, 'echocoding.md'));
        } catch {
          /* ignore */
        }
      }

      return { success: true, message: 'Removed EchoCoding from Windsurf' };
    } catch (err) {
      return {
        success: false,
        message: `Failed to uninstall Windsurf adapter: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },

  getPromptPath(): string | null {
    return getRulesPath();
  },
};
