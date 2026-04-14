# /echocoding — EchoCoding Voice Mode (Claude Code)

When user invokes this skill, follow this sequence:

## Step 0: Auto-Init (runs once per session, silently)

Before anything else, check if EchoCoding is ready:

1. Run `echocoding status` via Bash (suppress output).
2. **If daemon is running** → skip to Step 1.
3. **If daemon is NOT running** → auto-initialize:
   a. Run `ECHOCODING_CLIENT=claude echocoding start` to start the daemon.
   b. If start fails (e.g. not installed), run `ECHOCODING_CLIENT=claude npx echocoding install --auto --start` to install everything automatically (deps, hooks, models, daemon).
   c. If install also fails, report the error in text and stop.
4. This step is invisible to the user — do NOT narrate the init process unless it fails.

## Step 1: Handle Arguments

1. If `$ARGUMENTS` is empty or "on":
   - Set VOICE_MODE=ON, VOICE_LEVEL=balanced for this session
   - Confirm with spoken sentence: `ECHOCODING_CLIENT=claude echocoding say "语音模式已开启，平衡模式"`
   - From this point, follow ALL voice mode rules below for the rest of the session

2. If `$ARGUMENTS` is "off":
   - Run `ECHOCODING_CLIENT=claude echocoding stop` via Bash to stop the daemon
   - Set VOICE_MODE=OFF for this session
   - Confirm in text only: "Voice mode off."

3. If `$ARGUMENTS` is "minimal" or "balanced" or "verbose":
   - Set VOICE_LEVEL to that value
   - Confirm with spoken sentence: `ECHOCODING_CLIENT=claude echocoding say "已切换到{中文名}模式"`
   - If VOICE_MODE was OFF, also start daemon and set VOICE_MODE=ON

4. Any other `$ARGUMENTS`: run `ECHOCODING_CLIENT=claude echocoding $ARGUMENTS` via Bash (pass through).

---

## Mode State

- Track two internal variables:
  - VOICE_MODE = ON | OFF
  - VOICE_LEVEL = minimal | balanced | verbose (default: balanced)
- Switch ON when **user message** includes: "Voice Mode: ON", `/echocoding on`, `/voice on`, or any level name.
- Switch OFF when **user message** includes: "Voice Mode: OFF", `/echocoding off`, `/voice off`.
- Switch LEVEL when user says: `/echocoding minimal`, `/echocoding balanced`, `/echocoding verbose`, or "简约模式", "平衡模式", "强语音模式".
- Only user messages trigger switches — never your own output.
- Switching is idempotent (already ON -> brief confirmation, no redundant action).
- On switch to ON or level change: confirm in one sentence and call `echocoding say` with it.
- On switch to OFF: confirm in text only.
- If `echocoding start/stop` fails: report in text, keep previous state.

## Claude Code Commands

Use these CLI commands via Bash tool:

| Action | Command |
|--------|---------|
| Speak | `ECHOCODING_CLIENT=claude echocoding say "<text>"` |
| Ask (speak + listen) | `ECHOCODING_CLIENT=claude echocoding ask "<question>"` |
| Listen (mic only) | `ECHOCODING_CLIENT=claude echocoding listen` |
| Play SFX | `ECHOCODING_CLIENT=claude echocoding sfx <name>` |
| Start daemon | `ECHOCODING_CLIENT=claude echocoding start` |
| Stop daemon | `ECHOCODING_CLIENT=claude echocoding stop` |
| Open studio | `ECHOCODING_CLIENT=claude echocoding studio` |

---

{{CORE}}
