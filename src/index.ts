/**
 * EchoCoding — Immersive audio feedback for Vibe Coding.
 * Public API for programmatic use.
 */
export { getConfig, saveConfig, setConfigValue, getConfigValue } from './config.js';
export { checkModels, downloadModels, hasEssentialModels } from './downloader.js';
export { speak, disposeTts } from './engines/voice-engine.js';
export { playSfx, listAvailableSfx } from './engines/sfx-engine.js';
export { installClaudeCode, uninstallClaudeCode, installCodex, uninstallCodex } from './installer.js';
export { compilePrompt, writeCompiledPrompt, listClients } from './prompt-compiler.js';
export type { ClientId } from './prompt-compiler.js';
