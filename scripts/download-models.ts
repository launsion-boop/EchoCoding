#!/usr/bin/env node

/**
 * Download TTS and ASR models for local inference.
 * Models are stored in ~/.echocoding/models/
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';

const MODELS_DIR = path.join(os.homedir(), '.echocoding', 'models');

// Model URLs from sherpa-onnx releases / HuggingFace
const MODELS = {
  // Kokoro multi-lang v1.1 (TTS) — 103 speakers, Chinese + English
  'kokoro-tts': {
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-multi-lang-v1_1.tar.bz2',
    dir: 'kokoro-multi-lang-v1_1',
    size: '~350MB',
    description: 'Kokoro TTS (82M params, Chinese+English, 103 speakers)',
  },
  // Paraformer (ASR) — offline, Chinese+English bilingual
  'paraformer-asr': {
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-paraformer-zh-2023-09-14.tar.bz2',
    dir: 'sherpa-onnx-paraformer-zh-2023-09-14',
    size: '~700MB',
    description: 'Paraformer ASR (Chinese+English bilingual)',
  },
  // Silero VAD
  'silero-vad': {
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx',
    dir: 'silero-vad',
    size: '~2MB',
    description: 'Silero VAD (Voice Activity Detection)',
    singleFile: true,
    filename: 'silero_vad.onnx',
  },
} as const;

type ModelKey = keyof typeof MODELS;

async function downloadModel(key: ModelKey): Promise<void> {
  const model = MODELS[key];
  const targetDir = path.join(MODELS_DIR, model.dir);

  if (fs.existsSync(targetDir)) {
    const files = fs.readdirSync(targetDir);
    if (files.length > 0) {
      console.log(`  [skip] ${key} already exists (${targetDir})`);
      return;
    }
  }

  fs.mkdirSync(targetDir, { recursive: true });

  console.log(`  [download] ${key} (${model.size})...`);
  console.log(`    ${model.description}`);
  console.log(`    URL: ${model.url}`);

  if ('singleFile' in model && model.singleFile) {
    // Single file download
    const filePath = path.join(targetDir, model.filename);
    execSync(`curl -fSL -o "${filePath}" "${model.url}"`, { stdio: 'inherit' });
  } else {
    // Archive download + extract
    const tmpFile = path.join(MODELS_DIR, `${key}.tar.bz2`);
    execSync(`curl -fSL -o "${tmpFile}" "${model.url}"`, { stdio: 'inherit' });
    execSync(`tar -xjf "${tmpFile}" -C "${MODELS_DIR}"`, { stdio: 'inherit' });
    try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
  }

  console.log(`  [done] ${key} → ${targetDir}`);
}

async function main() {
  const args = process.argv.slice(2);
  const keys = args.length > 0
    ? args.filter((a): a is ModelKey => a in MODELS)
    : Object.keys(MODELS) as ModelKey[];

  if (keys.length === 0) {
    console.log('Usage: download-models.ts [kokoro-tts] [paraformer-asr] [silero-vad]');
    console.log('  No args = download all');
    process.exit(1);
  }

  fs.mkdirSync(MODELS_DIR, { recursive: true });
  console.log(`[echocoding] Downloading models to ${MODELS_DIR}`);
  console.log();

  for (const key of keys) {
    await downloadModel(key);
    console.log();
  }

  console.log('[echocoding] All models ready.');
}

main().catch((err) => {
  console.error('[echocoding] Download failed:', err.message);
  process.exit(1);
});
