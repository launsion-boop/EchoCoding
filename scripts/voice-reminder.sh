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
      "<user-prompt-submit-hook>🔊【必须】完成任务/代码改动/Bug修复/重要结论 → 立即 echocoding say 播报一句摘要，再输出文字。不能只回复文字不播报。⚠️ 反问用户必须用 echocoding ask，禁止文字提问。ASK 流程：ask 返回后 HUD 保持开→满意答案后 ask-end 关闭→继续；忘关 60s 自动关。</user-prompt-submit-hook>" \
      "EchoCoding 平衡模式【必须】：完成任务/代码改动/结论 → 先 \`echocoding say\` 播报，再输出文字，不能只回文字。⚠️ 反问必须 \`echocoding ask\`。ask 返回后 HUD 保持 → 满意后 \`ask-end\` 关→继续；忘关 60s 自动关。"
    ;;
  verbose)
    emit_reminder \
      "<user-prompt-submit-hook>⚠️ 强语音模式：每个 turn 都必须 echocoding say，包括纯工具调用。绝对不能静默。</user-prompt-submit-hook>" \
      "EchoCoding 强语音模式已开启：这个 turn 必须先执行 \`echocoding say\`，再输出文字；即使只是工具调用也不能静默。"
    ;;
  # minimal: no reminder needed
esac
