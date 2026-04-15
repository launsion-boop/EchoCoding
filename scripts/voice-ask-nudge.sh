#!/bin/bash
# voice-ask-nudge.sh — blocking Stop hook
# Detects if the model's last text response contains a question mark (? ？)
# and reminds it to use echocoding ask for voice Q&A instead of text questions.
# Must be fast — reads JSONL transcript, no Node.js.

CONFIG="$HOME/.echocoding/config.yaml"
[ -f "$CONFIG" ] || exit 0

MODE=$(grep "^mode:" "$CONFIG" 2>/dev/null | awk '{print $2}')
LEVEL=$(grep "^voiceLevel:" "$CONFIG" 2>/dev/null | awk '{print $2}')

# Only fire in active voice modes
case "$MODE" in
  full|voice-only) ;;
  *) exit 0 ;;
esac

case "$LEVEL" in
  balanced|verbose) ;;
  *) exit 0 ;;
esac

# Read Stop hook event JSON from stdin
INPUT=$(cat)

# Extract session_id and derive JSONL path
SESSION_ID=$(echo "$INPUT" | python3 -c "
import json, sys
try:
    print(json.load(sys.stdin).get('session_id', ''))
except:
    print('')
" 2>/dev/null)

# Derive project hash from cwd (same encoding Claude Code uses)
PROJECT_HASH=$(echo "$PWD" | sed 's|/|-|g')
PROJECTS_DIR="$HOME/.claude/projects"
JSONL="$PROJECTS_DIR/${PROJECT_HASH}/${SESSION_ID}.jsonl"

# Fallback: most recently modified JSONL in the project dir
if [ ! -f "$JSONL" ] && [ -d "$PROJECTS_DIR/${PROJECT_HASH}" ]; then
  JSONL=$(ls -t "$PROJECTS_DIR/${PROJECT_HASH}"/*.jsonl 2>/dev/null | head -1)
fi

[ -f "$JSONL" ] || exit 0

# Parse the last assistant text and check for question marks
HAS_QUESTION=$(python3 -c "
import json, sys, re
try:
    lines = open('$JSONL').readlines()
    for line in reversed(lines):
        try:
            d = json.loads(line.strip())
            if d.get('type') != 'assistant':
                continue
            content = d.get('message', {}).get('content', [])
            text = ' '.join(
                b.get('text', '') for b in (content if isinstance(content, list) else [])
                if isinstance(b, dict) and b.get('type') == 'text'
            )
            if text:
                print('yes' if re.search(r'[?？]', text) else 'no')
                sys.exit(0)
        except:
            continue
    print('no')
except:
    print('no')
" 2>/dev/null)

if [ "$HAS_QUESTION" = "yes" ]; then
  echo "<stop-hook>⚠️ 检测到你刚才用文字提问（含？号）。语音模式下请改用 echocoding ask 发起语音问答，不要用文字提问。拿到满意答案后调用 ask-end 关闭 HUD。</stop-hook>"
fi
