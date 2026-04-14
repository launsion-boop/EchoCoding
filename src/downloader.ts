/**
 * Model auto-download module.
 * Downloads TTS/ASR models from sherpa-onnx releases on demand.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { getConfig, ensureConfigDir } from './config.js';

export interface ModelInfo {
  key: string;
  url: string;
  dir: string;
  size: string;
  description: string;
  singleFile?: boolean;
  filename?: string;
}

const MODELS: Record<string, ModelInfo> = {
  'kokoro-tts': {
    key: 'kokoro-tts',
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-multi-lang-v1_1.tar.bz2',
    dir: 'kokoro-multi-lang-v1_1',
    size: '~350MB',
    description: 'Kokoro TTS (82M params, Chinese+English, 103 speakers)',
  },
  'paraformer-asr': {
    key: 'paraformer-asr',
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-paraformer-zh-2023-09-14.tar.bz2',
    dir: 'sherpa-onnx-paraformer-zh-2023-09-14',
    size: '~700MB',
    description: 'Paraformer ASR (Chinese+English bilingual)',
  },
  'silero-vad': {
    key: 'silero-vad',
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx',
    dir: 'silero-vad',
    size: '~2MB',
    description: 'Silero VAD (Voice Activity Detection)',
    singleFile: true,
    filename: 'silero_vad.onnx',
  },
};

export function getModelsDir(): string {
  return getConfig().tts.local.modelsDir;
}

export function getModelList(): ModelInfo[] {
  return Object.values(MODELS);
}

export interface ModelStatus {
  key: string;
  installed: boolean;
  path: string;
  description: string;
  size: string;
}

/**
 * Check which models are installed.
 */
export function checkModels(): ModelStatus[] {
  const modelsDir = getModelsDir();
  return Object.values(MODELS).map((model) => {
    const targetDir = path.join(modelsDir, model.dir);
    let installed = false;
    if (fs.existsSync(targetDir)) {
      const files = fs.readdirSync(targetDir);
      installed = files.length > 0;
    }
    return {
      key: model.key,
      installed,
      path: targetDir,
      description: model.description,
      size: model.size,
    };
  });
}

/**
 * Check if essential models (TTS at minimum) are installed.
 */
export function hasEssentialModels(): boolean {
  const statuses = checkModels();
  const kokoro = statuses.find((s) => s.key === 'kokoro-tts');
  return kokoro?.installed ?? false;
}

/**
 * Download one or more models. Shows progress via stdout.
 */
export async function downloadModels(keys?: string[]): Promise<void> {
  const modelsDir = getModelsDir();
  ensureConfigDir();
  fs.mkdirSync(modelsDir, { recursive: true });

  const toDownload = keys
    ? keys.filter((k) => k in MODELS).map((k) => MODELS[k])
    : Object.values(MODELS);

  if (toDownload.length === 0) {
    console.log('[echocoding] No valid models specified.');
    return;
  }

  const statuses = checkModels();
  const needed = toDownload.filter((model) => {
    const status = statuses.find((s) => s.key === model.key);
    return !status?.installed;
  });

  if (needed.length === 0) {
    console.log('[echocoding] All requested models already installed.');
    return;
  }

  const totalSize = needed.map((m) => m.size).join(' + ');
  console.log(`[echocoding] Downloading ${needed.length} model(s) (${totalSize})...`);
  console.log(`[echocoding] Target: ${modelsDir}`);
  console.log();

  for (const model of needed) {
    await downloadSingleModel(model, modelsDir);
    console.log();
  }

  console.log('[echocoding] All models ready.');
}

async function downloadSingleModel(model: ModelInfo, modelsDir: string): Promise<void> {
  const targetDir = path.join(modelsDir, model.dir);
  fs.mkdirSync(targetDir, { recursive: true });

  console.log(`  Downloading ${model.key} (${model.size})...`);
  console.log(`  ${model.description}`);

  if (model.singleFile && model.filename) {
    const filePath = path.join(targetDir, model.filename);
    execSync(`curl -fSL --progress-bar -o "${filePath}" "${model.url}"`, { stdio: 'inherit' });
  } else {
    const tmpFile = path.join(modelsDir, `${model.key}.tar.bz2`);
    execSync(`curl -fSL --progress-bar -o "${tmpFile}" "${model.url}"`, { stdio: 'inherit' });
    console.log(`  Extracting...`);
    execSync(`tar -xjf "${tmpFile}" -C "${modelsDir}"`, { stdio: 'inherit' });
    try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
  }

  console.log(`  Done: ${targetDir}`);
}
