#!/bin/bash
# EchoCoding Voice Reminder — blocking hook for UserPromptSubmit
# Reads ~/.echocoding/config.yaml and outputs a voice-mode reminder
# so the agent remembers to call `echocoding say` before text output.
# Must be fast (<10ms) — pure shell, no Node.js.

CONFIG="$HOME/.echocoding/config.yaml"

# Bail silently if config missing
[ -f "$CONFIG" ] || exit 0

# Read mode and voiceLevel (simple grep, no YAML parser needed)
MODE=$(grep "^mode:" "$CONFIG" 2>/dev/null | awk '{print $2}')
LEVEL=$(grep "^voiceLevel:" "$CONFIG" 2>/dev/null | awk '{print $2}')

# Only remind when voice is active (full or voice-only modes)
case "$MODE" in
  full|voice-only) ;;
  *) exit 0 ;;
esac

case "$LEVEL" in
  balanced)
    echo "<user-prompt-submit-hook>💡 平衡模式：评估本次回复是否需要语音播报。如果有重要信息、阶段性结论或需要用户关注的内容，建议先 echocoding say 一句摘要。纯工具调用或简短确认可以不说。</user-prompt-submit-hook>"
    ;;
  verbose)
    echo "<user-prompt-submit-hook>⚠️ 强语音模式：每个 turn 都必须 echocoding say，包括纯工具调用。绝对不能静默。</user-prompt-submit-hook>"
    ;;
  # minimal: no reminder needed
esac
