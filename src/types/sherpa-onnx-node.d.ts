declare module 'sherpa-onnx-node' {
  export class OfflineTts {
    constructor(config: Record<string, unknown>);
    static createAsync(config: Record<string, unknown>): Promise<OfflineTts>;
    numSpeakers: number;
    sampleRate: number;
    generate(obj: {
      text: string;
      sid?: number;
      speed?: number;
      generationConfig?: Record<string, unknown>;
    }): { samples: Float32Array; sampleRate: number };
    generateAsync(obj: Record<string, unknown>): Promise<{ samples: Float32Array; sampleRate: number }>;
  }

  export class GenerationConfig {
    constructor(opts?: Record<string, unknown>);
  }

  export class OfflineRecognizer {
    constructor(config: Record<string, unknown>);
    createStream(): OfflineStream;
    decode(stream: OfflineStream): void;
    getResult(stream: OfflineStream): { text: string };
  }

  export class OfflineStream {
    acceptWaveform(obj: { samples: Float32Array; sampleRate: number }): void;
  }

  export class Vad {
    constructor(config: Record<string, unknown>);
  }

  export class CircularBuffer {
    constructor(capacity: number);
  }

  export function readWave(path: string): { samples: Float32Array; sampleRate: number };
  export function writeWave(path: string, obj: { samples: Float32Array; sampleRate: number }): void;

  export const version: string;
}
