#!/bin/bash
# voice-auto-mode.sh — blocking SessionStart hook
# When autoVoiceMode is enabled, automatically activates balanced voice mode
# at the start of each session so the model is ready without /echocoding.
# Must be fast (<20ms) — pure shell, no Node.js.

CONFIG="$HOME/.echocoding/config.yaml"
[ -f "$CONFIG" ] || exit 0

AUTO=$(grep "^autoVoiceMode:" "$CONFIG" 2>/dev/null | awk '{print $2}')
[ "$AUTO" = "true" ] || exit 0

MODE=$(grep "^mode:" "$CONFIG" 2>/dev/null | awk '{print $2}')
LEVEL=$(grep "^voiceLevel:" "$CONFIG" 2>/dev/null | awk '{print $2}')

# Only inject if voice is actually active
case "$MODE" in
  full|voice-only) ;;
  *) exit 0 ;;
esac

case "$LEVEL" in
  balanced|verbose) ;;
  *) exit 0 ;;
esac

LEVEL_NAME="平衡"
[ "$LEVEL" = "verbose" ] && LEVEL_NAME="强语音"
[ "$LEVEL" = "minimal" ] && LEVEL_NAME="简约"

cat <<EOF
<session-start-hook>🎙️ EchoCoding 自动语音模式已开启（${LEVEL_NAME}档）。
规则：
- 有重要信息/结论时先 echocoding say 一句播报，再输出文字
- 需要反问用户时必须用 echocoding ask（不能文字提问）
- ask 返回后 HUD 保持开着 → 满意答案后 ask-end 关闭 → 继续执行
- 答案不够直接再 ask；忘关 60s 自动关
- [timeout]/[error] → HUD 自动关闭，无需 ask-end
用户可随时输入 /echocoding minimal/balanced/verbose 切换档位，或 /echocoding off 关闭语音。
</session-start-hook>
EOF
