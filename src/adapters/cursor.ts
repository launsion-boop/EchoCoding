import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { ClientAdapter, AdapterDetection, AdapterResult } from './types.js';
import { getPackageRoot, writeSettingsSafe } from './claude.js';
import { parseJsonSafe } from '../json-safe.js';

const CURSOR_DIR = path.join(os.homedir(), '.cursor');
const MCP_CONFIG_PATH = path.join(CURSOR_DIR, 'mcp.json');
const RULES_DIR = path.join(CURSOR_DIR, 'rules');
const RULES_PATH = path.join(RULES_DIR, 'echocoding.mdc');

function getMcpServerEntry(): { command: string; args: string[] } {
  return {
    command: process.execPath,
    args: [path.join(getPackageRoot(), 'dist', 'bin', 'echocoding.js'), 'mcp'],
  };
}

function hasEchocodingMcpConfig(configPath = MCP_CONFIG_PATH): boolean {
  if (!fs.existsSync(configPath)) return false;
  try {
    const parsed = parseJsonSafe(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    const mcpServers = parsed.mcpServers;
    return !!mcpServers && typeof mcpServers === 'object' && 'echocoding' in mcpServers;
  } catch {
    return false;
  }
}

function hasEchocodingRules(): boolean {
  return fs.existsSync(RULES_PATH);
}

export const cursorAdapter: ClientAdapter = {
  id: 'cursor',
  name: 'Cursor',
  mechanism: 'mcp',

  detect(): AdapterDetection {
    const installed = fs.existsSync(CURSOR_DIR);
    const detection: AdapterDetection = { installed };
    if (installed) {
      detection.configPath = MCP_CONFIG_PATH;
      detection.integrated = hasEchocodingMcpConfig() && hasEchocodingRules();
    }
    return detection;
  },

  install(): AdapterResult {
    if (!fs.existsSync(CURSOR_DIR)) {
      return { success: false, message: 'Cursor config directory not found: ~/.cursor' };
    }

    try {
      // 1. Write/merge MCP config
      let mcpConfig: Record<string, unknown> = {};
      if (fs.existsSync(MCP_CONFIG_PATH)) {
        try {
          mcpConfig = parseJsonSafe(fs.readFileSync(MCP_CONFIG_PATH, 'utf-8')) as Record<string, unknown>;
        } catch {
          // If parse fails, start fresh but back up
          mcpConfig = {};
        }
      }

      if (!mcpConfig.mcpServers || typeof mcpConfig.mcpServers !== 'object') {
        mcpConfig.mcpServers = {};
      }

      (mcpConfig.mcpServers as Record<string, unknown>).echocoding = getMcpServerEntry();
      writeSettingsSafe(MCP_CONFIG_PATH, mcpConfig);

      // 2. Write prompt rules file
      fs.mkdirSync(RULES_DIR, { recursive: true });
      const rulesContent = [
        '---',
        'description: EchoCoding voice mode integration',
        'globs: *',
        '---',
        '',
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
      fs.writeFileSync(RULES_PATH, rulesContent);

      return { success: true, message: 'Installed EchoCoding MCP server and rules for Cursor' };
    } catch (err) {
      return {
        success: false,
        message: `Failed to install Cursor adapter: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },

  uninstall(): AdapterResult {
    try {
      // Remove echocoding from MCP config
      if (fs.existsSync(MCP_CONFIG_PATH)) {
        try {
          const mcpConfig = parseJsonSafe(fs.readFileSync(MCP_CONFIG_PATH, 'utf-8')) as Record<string, unknown>;
          if (mcpConfig.mcpServers && typeof mcpConfig.mcpServers === 'object') {
            delete (mcpConfig.mcpServers as Record<string, unknown>).echocoding;

            // Clean up empty mcpServers object
            if (Object.keys(mcpConfig.mcpServers).length === 0) {
              delete mcpConfig.mcpServers;
            }
          }
          writeSettingsSafe(MCP_CONFIG_PATH, mcpConfig);
        } catch {
          /* ignore parse errors during uninstall */
        }
      }

      // Remove rules file
      try {
        fs.unlinkSync(RULES_PATH);
      } catch {
        /* ignore */
      }

      return { success: true, message: 'Removed EchoCoding from Cursor' };
    } catch (err) {
      return {
        success: false,
        message: `Failed to uninstall Cursor adapter: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },

  getPromptPath(): string | null {
    return RULES_PATH;
  },
};
