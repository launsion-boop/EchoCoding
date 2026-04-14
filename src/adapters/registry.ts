import type { ClientAdapter } from './types.js';
import { claudeAdapter } from './claude.js';
import { codexAdapter } from './codex.js';
import { cursorAdapter } from './cursor.js';
import { windsurfAdapter } from './windsurf.js';
import { geminiAdapter } from './gemini.js';

const ALL_ADAPTERS: ClientAdapter[] = [
  claudeAdapter,
  codexAdapter,
  cursorAdapter,
  windsurfAdapter,
  geminiAdapter,
];

/**
 * Return every registered adapter.
 */
export function getAllAdapters(): ClientAdapter[] {
  return ALL_ADAPTERS;
}

/** Alias used by doctor.ts and other callers. */
export const getAdapters = getAllAdapters;

/**
 * Return only adapters whose detect().installed is true.
 */
export function detectInstalledClients(): ClientAdapter[] {
  return ALL_ADAPTERS.filter((a) => a.detect().installed);
}

/**
 * Look up a single adapter by its id string.
 */
export function getAdapter(id: string): ClientAdapter | undefined {
  return ALL_ADAPTERS.find((a) => a.id === id);
}
