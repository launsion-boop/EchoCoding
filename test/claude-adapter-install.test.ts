import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const adapterPath = path.resolve(__dirname, '..', 'src', 'adapters', 'claude.ts');

function makeTempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'echocoding-claude-adapter-test-'));
}

async function loadAdapter(homeDir: string) {
  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;
  return import(
    `${pathToFileURL(adapterPath).href}?home=${encodeURIComponent(homeDir)}&ts=${Date.now()}-${Math.random()}`
  ) as Promise<typeof import('../src/adapters/claude.js')>;
}

function countManagedCommands(
  hooks: Record<string, Array<{ hooks: Array<{ command?: string }> }>>,
  eventName: string,
  needle: string,
): number {
  return (hooks[eventName] ?? [])
    .flatMap((group) => group.hooks ?? [])
    .filter((hook) => hook.command?.includes(needle))
    .length;
}

test('claude adapter install co-locates managed SessionStart/UserPromptSubmit hooks and stays idempotent', async () => {
  const homeDir = makeTempHome();
  const claudeDir = path.join(homeDir, '.claude');
  const settingsPath = path.join(claudeDir, 'settings.json');
  fs.mkdirSync(claudeDir, { recursive: true });

  fs.writeFileSync(
    settingsPath,
    JSON.stringify(
      {
        hooks: {
          SessionStart: [
            {
              matcher: '',
              hooks: [{ type: 'command', command: '/usr/bin/env echo unrelated-session' }],
            },
            {
              matcher: '',
              hooks: [{ type: 'command', command: 'node /tmp/echocoding-hook.js', async: true }],
            },
          ],
          UserPromptSubmit: [
            {
              matcher: '',
              hooks: [{ type: 'command', command: 'bash /tmp/voice-reminder.sh' }],
            },
          ],
        },
      },
      null,
      2,
    ) + '\n',
    'utf-8',
  );

  const { claudeAdapter } = await loadAdapter(homeDir);
  assert.equal(claudeAdapter.install().success, true);
  assert.equal(claudeAdapter.install().success, true);

  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as {
    hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command?: string }> }>>;
  };

  const sessionStart = settings.hooks.SessionStart ?? [];
  const userPromptSubmit = settings.hooks.UserPromptSubmit ?? [];

  assert.equal(
    sessionStart.some((group) =>
      group.hooks.some((hook) => hook.command?.includes('auto-start')) &&
      group.hooks.some((hook) => hook.command?.includes('echocoding-hook')),
    ),
    true,
  );
  assert.equal(
    userPromptSubmit.some((group) =>
      group.hooks.some((hook) => hook.command?.includes('voice-reminder')) &&
      group.hooks.some((hook) => hook.command?.includes('echocoding-hook')),
    ),
    true,
  );

  assert.equal(countManagedCommands(settings.hooks, 'SessionStart', 'auto-start'), 1);
  assert.equal(countManagedCommands(settings.hooks, 'SessionStart', 'echocoding-hook'), 1);
  assert.equal(countManagedCommands(settings.hooks, 'UserPromptSubmit', 'voice-reminder'), 1);
  assert.equal(countManagedCommands(settings.hooks, 'UserPromptSubmit', 'echocoding-hook'), 1);
  assert.equal(
    sessionStart.some((group) =>
      group.hooks.some((hook) => hook.command?.includes('unrelated-session')),
    ),
    true,
  );
});

test('claude adapter uninstall removes managed hooks and preserves unrelated hooks', async () => {
  const homeDir = makeTempHome();
  const claudeDir = path.join(homeDir, '.claude');
  const settingsPath = path.join(claudeDir, 'settings.json');
  fs.mkdirSync(claudeDir, { recursive: true });

  const { claudeAdapter } = await loadAdapter(homeDir);
  assert.equal(claudeAdapter.install().success, true);

  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as {
    hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ type: string; command: string }> }>>;
  };
  settings.hooks.Stop = [
    {
      matcher: '',
      hooks: [{ type: 'command', command: '/usr/bin/env echo keep-stop' }],
    },
  ];
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');

  assert.equal(claudeAdapter.uninstall().success, true);

  const after = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as {
    hooks?: Record<string, Array<{ matcher?: string; hooks: Array<{ command?: string }> }>>;
  };
  const raw = JSON.stringify(after);
  assert.doesNotMatch(raw, /echocoding-hook/);
  assert.doesNotMatch(raw, /voice-reminder/);
  assert.doesNotMatch(raw, /auto-start/);
  assert.equal(
    (after.hooks?.Stop ?? []).some((group) =>
      group.hooks.some((hook) => hook.command?.includes('keep-stop')),
    ),
    true,
  );
});
