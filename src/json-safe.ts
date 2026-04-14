/**
 * Safe JSON/JSONC reader.
 * Handles JSON with Comments (JSONC) used by VS Code-based editors
 * (Cursor, Windsurf, VS Code settings).
 * Strips line comments, block comments, and trailing commas before parsing.
 */

/**
 * Parse JSON or JSONC string safely.
 * Strips single-line comments, block comments, and trailing commas.
 */
export function parseJsonSafe(text: string): unknown {
  // Strip single-line comments (// ...) but not inside strings
  // Strip block comments (/* ... */)
  // Strip trailing commas before ] or }
  const stripped = stripJsonComments(text);
  return JSON.parse(stripped);
}

/**
 * Strip comments from JSONC text.
 * Respects string boundaries — won't strip // inside "strings".
 */
function stripJsonComments(text: string): string {
  let result = '';
  let i = 0;
  let inString = false;
  let escape = false;

  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];

    if (inString) {
      result += ch;
      if (escape) {
        escape = false;
      } else if (ch === '\\') {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      i++;
      continue;
    }

    // Start of string
    if (ch === '"') {
      inString = true;
      result += ch;
      i++;
      continue;
    }

    // Single-line comment
    if (ch === '/' && next === '/') {
      // Skip to end of line
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }

    // Block comment
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < text.length - 1 && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2; // skip */
      continue;
    }

    result += ch;
    i++;
  }

  // Strip trailing commas: ,] or ,}
  return result.replace(/,\s*([\]}])/g, '$1');
}
