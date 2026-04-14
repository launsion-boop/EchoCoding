import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const configModulePath = path.resolve(__dirname, '..', 'src', 'config.ts');

function makeTempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'echocoding-config-client-test-'));
}

async function loadConfigModule(homeDir: string) {
  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;
  return import(`${pathToFileURL(configModulePath).href}?home=${encodeURIComponent(homeDir)}&ts=${Date.now()}-${Math.random()}`);
}

function setRuntimeClient(clientId: 'default' | 'claude' | 'codex'): void {
  process.env.ECHOCODING_CLIENT = clientId;
  delete process.env.ECHOCODING_HOOK_CLIENT;
}

function setLocale(lang: string): void {
  delete process.env.LC_ALL;
  delete process.env.LC_MESSAGES;
  delete process.env.LANGUAGE;
  process.env.LANG = lang;
}

test('mode and voiceLevel are isolated per runtime client', async () => {
  const originalClient = process.env.ECHOCODING_CLIENT;
  const originalHookClient = process.env.ECHOCODING_HOOK_CLIENT;

  try {
    const homeDir = makeTempHome();
    const configModule = await loadConfigModule(homeDir);

    setRuntimeClient('codex');
    configModule.setConfigValue('mode', 'focus');
    configModule.setConfigValue('voiceLevel', 'verbose');
    assert.equal(configModule.getConfig().mode, 'focus');
    assert.equal(configModule.getConfig().voiceLevel, 'verbose');

    setRuntimeClient('claude');
    configModule.setConfigValue('mode', 'voice-only');
    configModule.setConfigValue('voiceLevel', 'minimal');
    assert.equal(configModule.getConfig().mode, 'voice-only');
    assert.equal(configModule.getConfig().voiceLevel, 'minimal');

    setRuntimeClient('default');
    assert.equal(configModule.getConfig().mode, 'full');
    assert.equal(configModule.getConfig().voiceLevel, 'balanced');

    setRuntimeClient('codex');
    assert.equal(configModule.getConfig().mode, 'focus');
    assert.equal(configModule.getConfig().voiceLevel, 'verbose');

    const configFile = path.join(homeDir, '.echocoding', 'config.yaml');
    const raw = fs.readFileSync(configFile, 'utf-8');
    assert.match(raw, /clients:/);
    assert.match(raw, /codex:/);
    assert.match(raw, /claude:/);
  } finally {
    if (originalClient === undefined) {
      delete process.env.ECHOCODING_CLIENT;
    } else {
      process.env.ECHOCODING_CLIENT = originalClient;
    }

    if (originalHookClient === undefined) {
      delete process.env.ECHOCODING_HOOK_CLIENT;
    } else {
      process.env.ECHOCODING_HOOK_CLIENT = originalHookClient;
    }
  }
});

test('runtime settings are scoped while base provider settings remain shared', async () => {
  const originalClient = process.env.ECHOCODING_CLIENT;
  const originalHookClient = process.env.ECHOCODING_HOOK_CLIENT;

  try {
    const homeDir = makeTempHome();
    const configModule = await loadConfigModule(homeDir);

    setRuntimeClient('default');
    configModule.setConfigValue('mode', 'sfx-only');
    configModule.setConfigValue('voiceLevel', 'minimal');
    configModule.setConfigValue('enabled', 'true');
    configModule.setConfigValue('volume', '66');
    configModule.setConfigValue('tts.enabled', 'true');
    configModule.setConfigValue('sfx.enabled', 'true');
    configModule.setConfigValue('sfx.volume', '88');

    setRuntimeClient('codex');
    configModule.setConfigValue('mode', 'focus');
    configModule.setConfigValue('voiceLevel', 'verbose');
    configModule.setConfigValue('volume', '55');
    configModule.setConfigValue('enabled', 'false');
    configModule.setConfigValue('tts.enabled', 'false');
    configModule.setConfigValue('sfx.enabled', 'false');
    configModule.setConfigValue('sfx.volume', '22');
    configModule.setConfigValue('tts.provider', 'local');

    setRuntimeClient('default');
    const globalConfig = configModule.getConfig();
    assert.equal(globalConfig.mode, 'sfx-only');
    assert.equal(globalConfig.voiceLevel, 'minimal');
    assert.equal(globalConfig.enabled, true);
    assert.equal(globalConfig.volume, 66);
    assert.equal(globalConfig.tts.enabled, true);
    assert.equal(globalConfig.sfx.enabled, true);
    assert.equal(globalConfig.sfx.volume, 88);
    assert.equal(globalConfig.tts.provider, 'local');

    setRuntimeClient('codex');
    const codexConfig = configModule.getConfig();
    assert.equal(codexConfig.mode, 'focus');
    assert.equal(codexConfig.voiceLevel, 'verbose');
    assert.equal(codexConfig.volume, 55);
    assert.equal(codexConfig.enabled, false);
    assert.equal(codexConfig.tts.enabled, false);
    assert.equal(codexConfig.sfx.enabled, false);
    assert.equal(codexConfig.sfx.volume, 22);
    assert.equal(codexConfig.tts.provider, 'local');
  } finally {
    if (originalClient === undefined) {
      delete process.env.ECHOCODING_CLIENT;
    } else {
      process.env.ECHOCODING_CLIENT = originalClient;
    }

    if (originalHookClient === undefined) {
      delete process.env.ECHOCODING_HOOK_CLIENT;
    } else {
      process.env.ECHOCODING_HOOK_CLIENT = originalHookClient;
    }
  }
});

test('first-run default cloud voice follows system locale', async () => {
  const originalLang = process.env.LANG;
  const originalLcAll = process.env.LC_ALL;
  const originalLcMessages = process.env.LC_MESSAGES;
  const originalLanguage = process.env.LANGUAGE;
  const originalClient = process.env.ECHOCODING_CLIENT;
  const originalHookClient = process.env.ECHOCODING_HOOK_CLIENT;

  try {
    setRuntimeClient('default');

    const zhHome = makeTempHome();
    setLocale('zh_CN.UTF-8');
    const zhConfigModule = await loadConfigModule(zhHome);
    assert.equal(zhConfigModule.getConfig().tts.voice, 'zh_female_wanwanxiaohe_moon_bigtts');

    const enHome = makeTempHome();
    setLocale('fr_FR.UTF-8'); // non-Chinese locale should use English female default
    const enConfigModule = await loadConfigModule(enHome);
    assert.equal(enConfigModule.getConfig().tts.voice, 'BV001_streaming');
  } finally {
    if (originalLang === undefined) delete process.env.LANG;
    else process.env.LANG = originalLang;
    if (originalLcAll === undefined) delete process.env.LC_ALL;
    else process.env.LC_ALL = originalLcAll;
    if (originalLcMessages === undefined) delete process.env.LC_MESSAGES;
    else process.env.LC_MESSAGES = originalLcMessages;
    if (originalLanguage === undefined) delete process.env.LANGUAGE;
    else process.env.LANGUAGE = originalLanguage;
    if (originalClient === undefined) delete process.env.ECHOCODING_CLIENT;
    else process.env.ECHOCODING_CLIENT = originalClient;
    if (originalHookClient === undefined) delete process.env.ECHOCODING_HOOK_CLIENT;
    else process.env.ECHOCODING_HOOK_CLIENT = originalHookClient;
  }
});

test('saved voice is not overwritten by locale changes after first run', async () => {
  const originalLang = process.env.LANG;
  const originalLcAll = process.env.LC_ALL;
  const originalLcMessages = process.env.LC_MESSAGES;
  const originalLanguage = process.env.LANGUAGE;
  const originalClient = process.env.ECHOCODING_CLIENT;
  const originalHookClient = process.env.ECHOCODING_HOOK_CLIENT;

  try {
    setRuntimeClient('default');

    const homeDir = makeTempHome();
    setLocale('zh_CN.UTF-8');
    const firstModule = await loadConfigModule(homeDir);
    assert.equal(firstModule.getConfig().tts.voice, 'zh_female_wanwanxiaohe_moon_bigtts');

    firstModule.setConfigValue('tts.voice', 'BV002_streaming');
    assert.equal(firstModule.getConfig().tts.voice, 'BV002_streaming');

    setLocale('en_US.UTF-8');
    const secondModule = await loadConfigModule(homeDir);
    assert.equal(secondModule.getConfig().tts.voice, 'BV002_streaming');
  } finally {
    if (originalLang === undefined) delete process.env.LANG;
    else process.env.LANG = originalLang;
    if (originalLcAll === undefined) delete process.env.LC_ALL;
    else process.env.LC_ALL = originalLcAll;
    if (originalLcMessages === undefined) delete process.env.LC_MESSAGES;
    else process.env.LC_MESSAGES = originalLcMessages;
    if (originalLanguage === undefined) delete process.env.LANGUAGE;
    else process.env.LANGUAGE = originalLanguage;
    if (originalClient === undefined) delete process.env.ECHOCODING_CLIENT;
    else process.env.ECHOCODING_CLIENT = originalClient;
    if (originalHookClient === undefined) delete process.env.ECHOCODING_HOOK_CLIENT;
    else process.env.ECHOCODING_HOOK_CLIENT = originalHookClient;
  }
});
