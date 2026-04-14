/**
 * EchoCoding — Immersive audio feedback for Vibe Coding.
 * Public API for programmatic use.
 */
export { getConfig, saveConfig, setConfigValue, getConfigValue } from './config.js';
export { checkModels, downloadModels, hasEssentialModels } from './downloader.js';
export { speak, disposeTts } from './engines/voice-engine.js';
export { playSfx, listAvailableSfx } from './engines/sfx-engine.js';
export { installClaudeCode, uninstallClaudeCode } from './installer.js';
