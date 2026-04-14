# EchoCoding Voice Mode (Codex CLI)

## Activation

Voice mode is controlled by user messages:

- **ON:** User says "Voice Mode: ON", "echocoding on", or a level name (minimal/balanced/verbose)
- **OFF:** User says "Voice Mode: OFF" or "echocoding off"
- **Level change:** User says "echocoding minimal", "echocoding balanced", "echocoding verbose"

On activation:
1. Run `echocoding start` to start the daemon
2. Confirm with: `echocoding say "Voice mode on, balanced mode"`

On deactivation:
1. Run `echocoding stop` to stop the daemon
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
| Speak | `echocoding say "<text>"` |
| Ask (speak + listen) | `echocoding ask "<question>"` |
| Listen (mic only) | `echocoding listen` |
| Play SFX | `echocoding sfx <name>` |
| Start daemon | `echocoding start` |
| Stop daemon | `echocoding stop` |

## Codex-Specific Notes

- Codex runs in a sandboxed environment. Ensure `echocoding` is in PATH or use the full path.
- Place this file as `instructions.md` in your project root for Codex to pick up.
- The daemon must be started before any say/ask/sfx commands will work.

---

{{CORE}}
