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
  const instructionsPath = path.join(codexDir, 'instructions.md');

  fs.mkdirSync(skillsDir, { recursive: true });
  fs.writeFileSync(path.join(skillsDir, 'echocoding.md'), '# legacy flat skill\n', 'utf-8');
  fs.writeFileSync(
    instructionsPath,
    [
      '# Existing Instructions',
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
});

test('installCodex is idempotent and uninstallCodex removes managed artifacts', async () => {
  const homeDir = makeTempHome();
  const codexDir = path.join(homeDir, '.codex');
  const instructionsPath = path.join(codexDir, 'instructions.md');

  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(instructionsPath, '# Existing Instructions\n', 'utf-8');

  const { installCodex, uninstallCodex } = await loadInstaller(homeDir);

  assert.equal(installCodex().success, true);
  assert.equal(installCodex().success, true);

  const instructionsAfterInstall = fs.readFileSync(instructionsPath, 'utf-8');
  assert.equal((instructionsAfterInstall.match(/## EchoCoding Voice Mode/g) ?? []).length, 1);

  const uninstallResult = uninstallCodex();
  assert.equal(uninstallResult.success, true);

  const instructionsAfterUninstall = fs.readFileSync(instructionsPath, 'utf-8');
  assert.doesNotMatch(instructionsAfterUninstall, /EchoCoding Voice Mode/);
  assert.equal(
    fs.existsSync(path.join(codexDir, 'skills', 'echocoding', 'SKILL.md')),
    false,
  );
});
