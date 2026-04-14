import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const installerPath = path.resolve(__dirname, '..', 'src', 'installer.ts');

function makeTempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'echocoding-codex-test-'));
}

async function loadInstaller(homeDir: string) {
  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;
  return import(`${pathToFileURL(installerPath).href}?home=${encodeURIComponent(homeDir)}&ts=${Date.now()}-${Math.random()}`);
}

test('installCodex writes a Codex skill directory and migrates legacy instructions', async () => {
  const homeDir = makeTempHome();
  const codexDir = path.join(homeDir, '.codex');
  const skillsDir = path.join(codexDir, 'skills');
  const configPath = path.join(codexDir, 'config.toml');
  const hooksPath = path.join(codexDir, 'hooks.json');
  const instructionsPath = path.join(codexDir, 'instructions.md');

  fs.mkdirSync(skillsDir, { recursive: true });
  fs.writeFileSync(configPath, 'model = "gpt-5.4"\n', 'utf-8');
  fs.writeFileSync(path.join(skillsDir, 'echocoding.md'), '# legacy flat skill\n', 'utf-8');
  fs.writeFileSync(
    instructionsPath,
    [
      '# Existing Instructions',
      '',
      '<!-- echocoding-voice-mode:start -->',
      '## EchoCoding Voice Mode',
      'stale managed block',
      '<!-- echocoding-voice-mode:end -->',
      '',
      '## EchoCoding Voice Mode',
      'When user says "/echocoding" or "voice mode on", run `echocoding start` and follow the voice mode rules in the echocoding skill.',
      '',
      '<!-- echocoding-voice-mode -->',
      '## EchoCoding Voice Mode',
      'When user says "/echocoding" or "voice mode on", run `echocoding start` and follow the voice mode rules in the echocoding skill.',
      '',
    ].join('\n'),
    'utf-8',
  );

  const { installCodex } = await loadInstaller(homeDir);
  const result = installCodex();

  assert.equal(result.success, true);

  const skillPath = path.join(skillsDir, 'echocoding', 'SKILL.md');
  assert.equal(fs.existsSync(skillPath), true);
  assert.equal(fs.existsSync(path.join(skillsDir, 'echocoding.md')), false);

  const skill = fs.readFileSync(skillPath, 'utf-8');
  assert.match(skill, /^---\nname: "echocoding"/);
  assert.match(skill, /Treat `\/echocoding` as a user trigger phrase/);

  const instructions = fs.readFileSync(instructionsPath, 'utf-8');
  assert.equal((instructions.match(/## EchoCoding Voice Mode/g) ?? []).length, 1);
  assert.match(instructions, /<!-- echocoding-voice-mode:start -->/);
  assert.match(instructions, /<!-- echocoding-voice-mode:end -->/);
  assert.doesNotMatch(instructions, /<!-- echocoding-voice-mode -->/);

  const config = fs.readFileSync(configPath, 'utf-8');
  assert.match(config, /model = "gpt-5\.4"/);
  assert.match(config, /features\.codex_hooks = true/);

  const hooks = JSON.parse(fs.readFileSync(hooksPath, 'utf-8'));
  assert.equal(Array.isArray(hooks.hooks?.SessionStart), true);
  assert.equal(Array.isArray(hooks.hooks?.UserPromptSubmit), true);
  assert.equal(Array.isArray(hooks.hooks?.PreToolUse), true);
  assert.equal(Array.isArray(hooks.hooks?.PostToolUse), true);
  assert.equal(Array.isArray(hooks.hooks?.Notification), true);
  assert.equal(Array.isArray(hooks.hooks?.Stop), true);
  assert.equal(Array.isArray(hooks.hooks?.SubagentStart), true);
  assert.equal(Array.isArray(hooks.hooks?.SubagentStop), true);
  assert.equal(Array.isArray(hooks.hooks?.PreCompact), true);
  const sessionStartCommands = hooks.hooks.SessionStart
    .flatMap((g: { hooks: Array<{ command?: string }> }) => g.hooks.map((h) => h.command))
    .join('\n');
  assert.match(
    sessionStartCommands,
    /echocoding-hook/,
  );
  assert.match(
    sessionStartCommands,
    /ECHOCODING_CLIENT=codex .*auto-start\.sh/,
  );
  assert.match(
    hooks.hooks.PreToolUse[0].hooks[0].command,
    /ECHOCODING_CLIENT=codex .*echocoding-hook\.js/,
  );
  assert.match(
    hooks.hooks.PostToolUse[0].hooks[0].command,
    /ECHOCODING_CLIENT=codex .*echocoding-hook\.js/,
  );
  assert.equal(
    hooks.hooks.SessionStart.find((g: { hooks: Array<{ command?: string; statusMessage?: string }> }) =>
      g.hooks.some((h) => h.command?.includes('auto-start')),
    ).hooks.find((h: { command?: string }) => h.command?.includes('auto-start')).statusMessage,
    'Starting EchoCoding daemon',
  );
  assert.equal(
    hooks.hooks.SessionStart.some((g: { hooks: Array<{ command?: string }> }) =>
      g.hooks.some((h) => h.command?.includes('auto-start')) &&
      g.hooks.some((h) => h.command?.includes('echocoding-hook')),
    ),
    true,
  );
  const userPromptSubmitCommands = hooks.hooks.UserPromptSubmit
    .flatMap((g: { hooks: Array<{ command?: string }> }) => g.hooks.map((h) => h.command))
    .join('\n');
  assert.match(
    userPromptSubmitCommands,
    /echocoding-hook/,
  );
  assert.match(
    userPromptSubmitCommands,
    /ECHOCODING_HOOK_CLIENT=codex ECHOCODING_CLIENT=codex .*voice-reminder\.sh/,
  );
  assert.equal(
    hooks.hooks.UserPromptSubmit.some((g: { hooks: Array<{ command?: string }> }) =>
      g.hooks.some((h) => h.command?.includes('voice-reminder')) &&
      g.hooks.some((h) => h.command?.includes('echocoding-hook')),
    ),
    true,
  );
});

test('installCodex is idempotent and uninstallCodex removes managed artifacts while preserving unrelated hooks', async () => {
  const homeDir = makeTempHome();
  const codexDir = path.join(homeDir, '.codex');
  const configPath = path.join(codexDir, 'config.toml');
  const hooksPath = path.join(codexDir, 'hooks.json');
  const instructionsPath = path.join(codexDir, 'instructions.md');

  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(instructionsPath, '# Existing Instructions\n', 'utf-8');
  fs.writeFileSync(
    configPath,
    [
      'model = "gpt-5.4"',
      '',
      '[features]',
      'fast_mode = true',
      '',
    ].join('\n'),
    'utf-8',
  );
  fs.writeFileSync(
    hooksPath,
    JSON.stringify(
      {
        hooks: {
          Stop: [
            {
              hooks: [
                {
                  type: 'command',
                  command: '/usr/bin/env true',
                },
              ],
            },
          ],
        },
      },
      null,
      2,
    ) + '\n',
    'utf-8',
  );

  const { installCodex, uninstallCodex } = await loadInstaller(homeDir);

  assert.equal(installCodex().success, true);
  assert.equal(installCodex().success, true);

  const instructionsAfterInstall = fs.readFileSync(instructionsPath, 'utf-8');
  assert.equal((instructionsAfterInstall.match(/## EchoCoding Voice Mode/g) ?? []).length, 1);

  const configAfterInstall = fs.readFileSync(configPath, 'utf-8');
  assert.equal((configAfterInstall.match(/codex_hooks = true/g) ?? []).length, 1);
  assert.match(configAfterInstall, /\[features\][\s\S]*fast_mode = true/);

  const hooksAfterInstall = JSON.parse(fs.readFileSync(hooksPath, 'utf-8'));
  assert.equal(hooksAfterInstall.hooks.Stop.length >= 2, true);
  assert.equal(hooksAfterInstall.hooks.SessionStart.length >= 1, true);
  assert.equal(hooksAfterInstall.hooks.UserPromptSubmit.length >= 1, true);
  assert.equal(
    hooksAfterInstall.hooks.SessionStart.some((g: { hooks: Array<{ command?: string }> }) =>
      g.hooks.some((h) => h.command?.includes('auto-start')) &&
      g.hooks.some((h) => h.command?.includes('echocoding-hook')),
    ),
    true,
  );
  assert.equal(
    hooksAfterInstall.hooks.UserPromptSubmit.some((g: { hooks: Array<{ command?: string }> }) =>
      g.hooks.some((h) => h.command?.includes('voice-reminder')) &&
      g.hooks.some((h) => h.command?.includes('echocoding-hook')),
    ),
    true,
  );
  assert.equal(Array.isArray(hooksAfterInstall.hooks.PreToolUse), true);
  assert.equal(Array.isArray(hooksAfterInstall.hooks.PostToolUse), true);
  assert.equal(Array.isArray(hooksAfterInstall.hooks.Notification), true);
  assert.equal(Array.isArray(hooksAfterInstall.hooks.SubagentStart), true);
  assert.equal(Array.isArray(hooksAfterInstall.hooks.SubagentStop), true);
  assert.equal(Array.isArray(hooksAfterInstall.hooks.PreCompact), true);

  const uninstallResult = uninstallCodex();
  assert.equal(uninstallResult.success, true);

  const instructionsAfterUninstall = fs.readFileSync(instructionsPath, 'utf-8');
  assert.doesNotMatch(instructionsAfterUninstall, /EchoCoding Voice Mode/);
  const configAfterUninstall = fs.readFileSync(configPath, 'utf-8');
  assert.doesNotMatch(configAfterUninstall, /echocoding-codex-hooks/);
  assert.doesNotMatch(configAfterUninstall, /codex_hooks = true/);
  assert.match(configAfterUninstall, /fast_mode = true/);
  assert.equal(
    fs.existsSync(path.join(codexDir, 'skills', 'echocoding', 'SKILL.md')),
    false,
  );

  const hooksAfterUninstall = JSON.parse(fs.readFileSync(hooksPath, 'utf-8'));
  assert.equal(hooksAfterUninstall.hooks.Stop.length, 1);
  assert.equal(hooksAfterUninstall.hooks.SessionStart, undefined);
  assert.equal(hooksAfterUninstall.hooks.UserPromptSubmit, undefined);
});
