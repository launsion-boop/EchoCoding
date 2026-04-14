/**
 * Prompt Compiler — builds client-specific voice mode prompts
 * by combining core.md rules with client-specific templates.
 *
 * Usage:
 *   import { compilePrompt, writeCompiledPrompt } from './prompt-compiler.js';
 *   const prompt = compilePrompt('claude');
 *   writeCompiledPrompt('cursor', './output/cursor-prompt.md');
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Supported client IDs
export type ClientId = 'claude' | 'cursor' | 'codex' | 'windsurf' | 'generic';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Resolve the skills directory relative to the package root.
 * Works both from src/ (dev via tsx) and dist/src/ (compiled).
 */
function getSkillsDir(): string {
  // From src/prompt-compiler.ts  -> ../skills
  // From dist/src/prompt-compiler.js -> ../../skills
  let candidate = path.resolve(__dirname, '..', 'skills');
  if (fs.existsSync(candidate)) return candidate;

  candidate = path.resolve(__dirname, '..', '..', 'skills');
  if (fs.existsSync(candidate)) return candidate;

  throw new Error(
    `Cannot find skills directory. Looked relative to ${__dirname}`,
  );
}

/**
 * Return the client-specific command placeholders.
 * MCP-based clients (cursor, windsurf) use tool names.
 * CLI-based clients (claude, codex, generic) use shell commands.
 */
function getClientCommands(clientId: string): {
  say: string;
  ask: string;
  listen: string;
  sfx: string;
} {
  if (clientId === 'cursor' || clientId === 'windsurf') {
    // MCP tools — called via the client's tool-calling mechanism
    return {
      say: 'echocoding_say tool',
      ask: 'echocoding_ask tool',
      listen: 'echocoding_listen tool',
      sfx: 'echocoding_sfx tool',
    };
  }

  // CLI commands — executed via Bash / shell
  return {
    say: '`echocoding say "<text>"`',
    ask: '`echocoding ask "<question>"`',
    listen: '`echocoding listen`',
    sfx: '`echocoding sfx <name>`',
  };
}

/**
 * Compile a complete voice-mode prompt for a given client.
 *
 * 1. Reads the core specification (skills/core.md)
 * 2. Reads the client template (skills/templates/<clientId>.md), falling
 *    back to generic.md if no specific template exists
 * 3. Replaces {{CORE}} with the core content
 * 4. Replaces {{SAY_COMMAND}}, {{ASK_COMMAND}}, {{LISTEN_COMMAND}},
 *    {{SFX_COMMAND}} with client-appropriate values
 */
export function compilePrompt(clientId: string): string {
  const skillsDir = getSkillsDir();
  const corePath = path.join(skillsDir, 'core.md');
  const templatePath = path.join(skillsDir, 'templates', `${clientId}.md`);
  const genericPath = path.join(skillsDir, 'templates', 'generic.md');

  // Read core content
  if (!fs.existsSync(corePath)) {
    throw new Error(`Core spec not found: ${corePath}`);
  }
  const core = fs.readFileSync(corePath, 'utf-8');

  // Read template (fall back to generic)
  let template: string;
  if (fs.existsSync(templatePath)) {
    template = fs.readFileSync(templatePath, 'utf-8');
  } else if (fs.existsSync(genericPath)) {
    template = fs.readFileSync(genericPath, 'utf-8');
  } else {
    throw new Error(
      `No template found for client "${clientId}" and no generic fallback at ${genericPath}`,
    );
  }

  // Replace {{CORE}} placeholder with the full core spec
  let result = template.replace('{{CORE}}', core);

  // Replace client-specific command placeholders
  const commands = getClientCommands(clientId);
  result = result.replace(/\{\{SAY_COMMAND\}\}/g, commands.say);
  result = result.replace(/\{\{ASK_COMMAND\}\}/g, commands.ask);
  result = result.replace(/\{\{LISTEN_COMMAND\}\}/g, commands.listen);
  result = result.replace(/\{\{SFX_COMMAND\}\}/g, commands.sfx);

  return result;
}

/**
 * Compile a prompt and write it to a file.
 * Creates parent directories if needed.
 */
export function writeCompiledPrompt(
  clientId: string,
  outputPath: string,
): void {
  const content = compilePrompt(clientId);
  const dir = path.dirname(outputPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(outputPath, content, 'utf-8');
}

/**
 * List all available template client IDs (based on files in skills/templates/).
 */
export function listClients(): string[] {
  const skillsDir = getSkillsDir();
  const templatesDir = path.join(skillsDir, 'templates');

  if (!fs.existsSync(templatesDir)) return [];

  return fs
    .readdirSync(templatesDir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => f.replace(/\.md$/, ''));
}
