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
  # Best-effort: if Codex executes only the first UserPromptSubmit group,
  # still forward the submit event so thinking ambient can start.
  [ -n "$NODE_BIN" ] || return 0
  [ -f "$HOOK_BIN" ] || return 0
  (
    printf '{"hook_event_name":"UserPromptSubmit"}' \
      | ECHOCODING_CLIENT="${ECHOCODING_CLIENT:-codex}" "$NODE_BIN" "$HOOK_BIN" >/dev/null 2>&1
  ) &
}

forward_user_prompt_submit_hook

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
      "<user-prompt-submit-hook>💡 平衡模式：评估本次回复是否需要语音播报。如果有重要信息、阶段性结论或需要用户关注的内容，建议先 echocoding say 一句摘要。纯工具调用或简短确认可以不说。</user-prompt-submit-hook>" \
      "EchoCoding 平衡模式已开启：如果这次回复有重要信息、阶段性结论或需要用户注意的内容，请先执行 \`echocoding say\` 用一句话播报，再输出完整文字。"
    ;;
  verbose)
    emit_reminder \
      "<user-prompt-submit-hook>⚠️ 强语音模式：每个 turn 都必须 echocoding say，包括纯工具调用。绝对不能静默。</user-prompt-submit-hook>" \
      "EchoCoding 强语音模式已开启：这个 turn 必须先执行 \`echocoding say\`，再输出文字；即使只是工具调用也不能静默。"
    ;;
  # minimal: no reminder needed
esac
