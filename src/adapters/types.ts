export interface AdapterDetection {
  installed: boolean;       // agent itself is present (e.g. ~/.claude/ exists)
  integrated?: boolean;     // EchoCoding hooks/config are injected into the agent
  version?: string;
  configPath?: string;
}

export interface AdapterResult {
  success: boolean;
  message: string;
}

export interface ClientAdapter {
  id: string;
  name: string;
  mechanism: 'hook' | 'mcp' | 'prompt-only' | 'proxy';
  detect(): AdapterDetection;
  install(): AdapterResult;
  uninstall(): AdapterResult;
  getPromptPath(): string | null;
}
