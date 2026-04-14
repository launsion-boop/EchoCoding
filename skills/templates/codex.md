---
name: "echocoding"
description: "Use when the user explicitly wants EchoCoding voice mode, says /echocoding, asks for voice mode on or off, or wants spoken status updates via EchoCoding."
---

# EchoCoding Voice Mode (Codex CLI)

## Activation

Voice mode is controlled by user messages:

- **ON:** User says "Voice Mode: ON", "echocoding on", or a level name (minimal/balanced/verbose)
- **OFF:** User says "Voice Mode: OFF" or "echocoding off"
- **Level change:** User says "echocoding minimal", "echocoding balanced", "echocoding verbose"

Treat `/echocoding` as a user trigger phrase, not as a built-in Codex slash command.

On activation:
1. Run `ECHOCODING_CLIENT=codex echocoding start` to start the daemon
2. Confirm with: `ECHOCODING_CLIENT=codex echocoding say "Voice mode on, balanced mode"`

On deactivation:
1. Run `ECHOCODING_CLIENT=codex echocoding stop` to stop the daemon
2. Confirm in text only: "Voice mode off."

## Mode State

- Track two internal variables:
  - VOICE_MODE = ON | OFF
  - VOICE_LEVEL = minimal | balanced | verbose (default: balanced)
- Only user messages trigger switches — never your own output.
- Switching is idempotent (already ON -> brief confirmation, no redundant action).
- If `echocoding start/stop` fails: report in text, keep previous state.

## CLI Commands

Run these commands via shell:

| Action | Command |
|--------|---------|
| Speak | `ECHOCODING_CLIENT=codex echocoding say "<text>"` |
| Ask (speak + listen) | `ECHOCODING_CLIENT=codex echocoding ask "<question>"` |
| Listen (mic only) | `ECHOCODING_CLIENT=codex echocoding listen` |
| Play SFX | `ECHOCODING_CLIENT=codex echocoding sfx <name>` |
| Start daemon | `ECHOCODING_CLIENT=codex echocoding start` |
| Stop daemon | `ECHOCODING_CLIENT=codex echocoding stop` |

## Codex-Specific Notes

- Codex runs in a sandboxed environment. Ensure `echocoding` is in PATH or use the full path.
- This file is installed as a global Codex skill and is discovered from the Codex skills directory.
- When Codex hooks are installed, the daemon is usually auto-started when the session opens.
- `echocoding start` is still safe and idempotent if you need to ensure the daemon is running.

---

{{CORE}}
