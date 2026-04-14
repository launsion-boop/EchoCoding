# EchoCoding Voice Mode (Cursor)

## Activation

Voice mode is controlled by user messages:

- **ON:** User says "Voice Mode: ON", "echocoding on", or a level name (minimal/balanced/verbose)
- **OFF:** User says "Voice Mode: OFF" or "echocoding off"
- **Level change:** User says "echocoding minimal", "echocoding balanced", "echocoding verbose"

On activation, confirm with a spoken sentence via the `echocoding_say` tool.
On deactivation, confirm in text only: "Voice mode off."

## Mode State

- Track two internal variables:
  - VOICE_MODE = ON | OFF
  - VOICE_LEVEL = minimal | balanced | verbose (default: balanced)
- Only user messages trigger switches — never your own output.
- Switching is idempotent (already ON -> brief confirmation, no redundant action).

## MCP Tool Reference

EchoCoding exposes voice capabilities as MCP tools. Call them using the standard tool-calling format:

| Action | MCP Tool | Parameters |
|--------|----------|------------|
| Speak | `echocoding_say` | `{ "text": "<spoken sentence>" }` |
| Ask (speak + listen) | `echocoding_ask` | `{ "question": "<question text>" }` |
| Listen (mic only) | `echocoding_listen` | `{}` |
| Play SFX | `echocoding_sfx` | `{ "name": "<sfx_name>" }` |
| Check status | `echocoding_status` | `{}` |

**Example tool call:**
```
Tool: echocoding_say
Arguments: { "text": "Tests all pass, ready to merge" }
```

**Important:** These are MCP tools, not CLI commands. Do not wrap them in terminal/shell calls. Call them directly as tool invocations.

---

{{CORE}}
