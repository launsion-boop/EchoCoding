#!/bin/bash
# EchoCoding Voice Reminder — blocking hook for UserPromptSubmit
# Reads ~/.echocoding/config.yaml and outputs a voice-mode reminder
# so the agent remembers to call `echocoding say` before text output.
# Must be fast (<10ms) — pure shell, no Node.js.

CONFIG="$HOME/.echocoding/config.yaml"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK_BIN="$SCRIPT_DIR/../dist/bin/echocoding-hook.js"
NODE_BIN="${ECHOCODING_NODE:-$(command -v node 2>/dev/null || true)}"

forward_user_prompt_submit_hook() {
  # Compatibility fallback for old runners that execute only the first
  # UserPromptSubmit hook command.
  [ -n "$NODE_BIN" ] || return 0
  [ -f "$HOOK_BIN" ] || return 0
  (
    printf '{"hook_event_name":"UserPromptSubmit"}' \
      | ECHOCODING_CLIENT="${ECHOCODING_CLIENT:-codex}" "$NODE_BIN" "$HOOK_BIN" >/dev/null 2>&1
  ) &
}

# Default OFF to avoid duplicate UserPromptSubmit events in modern Codex,
# which would otherwise cause repeated "thinking" cues.
if [ "${ECHOCODING_FORWARD_SUBMIT:-0}" = "1" ]; then
  forward_user_prompt_submit_hook
fi

# Bail silently if config missing
[ -f "$CONFIG" ] || exit 0

# Read mode and voiceLevel (simple grep, no YAML parser needed)
MODE=$(grep "^mode:" "$CONFIG" 2>/dev/null | awk '{print $2}')
LEVEL=$(grep "^voiceLevel:" "$CONFIG" 2>/dev/null | awk '{print $2}')
CLIENT="${ECHOCODING_HOOK_CLIENT:-claude}"

emit_reminder() {
  if [ "$CLIENT" = "codex" ]; then
    echo "$2"
  else
    echo "$1"
  fi
}

# Only remind when voice is active (full or voice-only modes)
case "$MODE" in
  full|voice-only) ;;
  *) exit 0 ;;
esac

case "$LEVEL" in
  balanced)
    emit_reminder \
      "<user-prompt-submit-hook>🔊【必须】完成任务/代码改动/Bug修复/重要结论 → Bash调用 \`npx echocoding say \"摘要\"\` 播报，再输出文字。⚠️ 需要反问用户 → Bash调用 \`npx echocoding ask \"问题\"\`，严禁文字提问。ASK流程：ask返回→HUD保持开→满意后Bash调用 \`npx echocoding ask-end\` 关闭→继续；60s自动关。</user-prompt-submit-hook>" \
      "EchoCoding 平衡模式【必须】：完成任务/结论 → 先 Bash: \`npx echocoding say \"摘要\"\`，再输出文字。⚠️ 反问用户 → Bash: \`npx echocoding ask \"问题\"\`（禁止文字提问）。答案满意后 Bash: \`npx echocoding ask-end\` 关闭 HUD。"
    ;;
  verbose)
    emit_reminder \
      "<user-prompt-submit-hook>⚠️ 强语音模式：每个 turn 必须 Bash调用 \`npx echocoding say \"摘要\"\`，绝对不能静默。需要提问 → \`npx echocoding ask \"问题\"\`，严禁文字提问。</user-prompt-submit-hook>" \
      "EchoCoding 强语音模式：必须 Bash: \`npx echocoding say \"摘要\"\`，不能静默。提问 → \`npx echocoding ask \"问题\"\`。"
    ;;
  # minimal: no reminder needed
esac
