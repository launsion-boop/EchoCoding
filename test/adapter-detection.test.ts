import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

function makeTempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'echocoding-adapter-test-'));
}

async function loadModule<T>(relativePath: string, homeDir: string): Promise<T> {
  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;
  const filePath = path.resolve(repoRoot, relativePath);
  return import(`${pathToFileURL(filePath).href}?home=${encodeURIComponent(homeDir)}&ts=${Date.now()}-${Math.random()}`) as Promise<T>;
}

test('cursor adapter reports integrated only after MCP config and rules exist', async () => {
  const homeDir = makeTempHome();
  const cursorDir = path.join(homeDir, '.cursor');
  const rulesPath = path.join(cursorDir, 'rules', 'echocoding.mdc');
  const mcpPath = path.join(cursorDir, 'mcp.json');

  fs.mkdirSync(cursorDir, { recursive: true });
  const { cursorAdapter } = await loadModule<typeof import('../src/adapters/cursor.js')>('src/adapters/cursor.ts', homeDir);

  assert.equal(cursorAdapter.detect().installed, true);
  assert.equal(cursorAdapter.detect().integrated, false);

  fs.mkdirSync(path.dirname(rulesPath), { recursive: true });
  fs.writeFileSync(rulesPath, '# EchoCoding Voice Mode\n', 'utf-8');
  fs.writeFileSync(mcpPath, JSON.stringify({ mcpServers: { echocoding: { command: 'node', args: ['echocoding', 'mcp'] } } }), 'utf-8');

  assert.equal(cursorAdapter.detect().integrated, true);
});

test('claude adapter reports integrated only after hooks include echocoding-hook', async () => {
  const homeDir = makeTempHome();
  const claudeDir = path.join(homeDir, '.claude');
  const settingsPath = path.join(claudeDir, 'settings.json');

  fs.mkdirSync(claudeDir, { recursive: true });
  const { claudeAdapter } = await loadModule<typeof import('../src/adapters/claude.js')>('src/adapters/claude.ts', homeDir);

  assert.equal(claudeAdapter.detect().installed, true);
  assert.equal(claudeAdapter.detect().integrated, false);

  fs.writeFileSync(
    settingsPath,
    JSON.stringify({
      hooks: {
        SessionStart: [
          {
            matcher: '',
            hooks: [
              {
                type: 'command',
                command: '/usr/bin/node /tmp/echocoding-hook.js',
                async: true,
              },
            ],
          },
        ],
      },
    }),
    'utf-8',
  );

  assert.equal(claudeAdapter.detect().integrated, true);
});

test('windsurf adapter reports integrated only after MCP config and rules exist', async () => {
  const homeDir = makeTempHome();
  const windsurfDir = path.join(homeDir, '.windsurf');
  const rulesPath = path.join(windsurfDir, 'rules', 'echocoding.md');
  const mcpPath = path.join(windsurfDir, 'mcp.json');

  fs.mkdirSync(windsurfDir, { recursive: true });
  const { windsurfAdapter } = await loadModule<typeof import('../src/adapters/windsurf.js')>('src/adapters/windsurf.ts', homeDir);

  assert.equal(windsurfAdapter.detect().installed, true);
  assert.equal(windsurfAdapter.detect().integrated, false);

  fs.mkdirSync(path.dirname(rulesPath), { recursive: true });
  fs.writeFileSync(rulesPath, '# EchoCoding Voice Mode\n', 'utf-8');
  fs.writeFileSync(mcpPath, JSON.stringify({ mcpServers: { echocoding: { command: 'node', args: ['echocoding', 'mcp'] } } }), 'utf-8');

  assert.equal(windsurfAdapter.detect().integrated, true);
});

test('gemini adapter reports integrated only after MCP config exists', async () => {
  const homeDir = makeTempHome();
  const geminiDir = path.join(homeDir, '.gemini');
  const settingsPath = path.join(geminiDir, 'settings.json');

  fs.mkdirSync(geminiDir, { recursive: true });
  const { geminiAdapter } = await loadModule<typeof import('../src/adapters/gemini.js')>('src/adapters/gemini.ts', homeDir);

  assert.equal(geminiAdapter.detect().installed, true);
  assert.equal(geminiAdapter.detect().integrated, false);

  fs.writeFileSync(settingsPath, JSON.stringify({ mcpServers: { echocoding: { command: 'node', args: ['echocoding', 'mcp'] } } }), 'utf-8');

  assert.equal(geminiAdapter.detect().integrated, true);
});

test('codex adapter reports integrated only after skill and managed instructions exist', async () => {
  const homeDir = makeTempHome();
  const codexDir = path.join(homeDir, '.codex');
  const skillPath = path.join(codexDir, 'skills', 'echocoding', 'SKILL.md');
  const instructionsPath = path.join(codexDir, 'instructions.md');

  fs.mkdirSync(codexDir, { recursive: true });
  const { codexAdapter } = await loadModule<typeof import('../src/adapters/codex.js')>('src/adapters/codex.ts', homeDir);

  assert.equal(codexAdapter.detect().installed, true);
  assert.equal(codexAdapter.detect().integrated, false);

  fs.mkdirSync(path.dirname(skillPath), { recursive: true });
  fs.writeFileSync(skillPath, '---\nname: "echocoding"\n---\n', 'utf-8');
  fs.writeFileSync(
    instructionsPath,
    [
      '<!-- echocoding-voice-mode:start -->',
      '## EchoCoding Voice Mode',
      '<!-- echocoding-voice-mode:end -->',
      '',
    ].join('\n'),
    'utf-8',
  );

  assert.equal(codexAdapter.detect().integrated, true);
});
