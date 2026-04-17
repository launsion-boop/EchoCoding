#!/bin/bash
# voice-ask-nudge.sh — blocking Stop hook
# Detects if the model's last response contains a text question but no echocoding ask call.
# When detected, outputs {"decision":"block","reason":"..."} to force Claude to retry with
# echocoding ask instead of a plain text question.

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

# Analyse the last assistant turn:
# - If it called echocoding ask via tool_use → already correct, skip
# - If it mentions "echocoding ask" in text → model acknowledged it, skip
# - If last paragraph ends with ? → text question detected → block & force retry
RESULT=$(python3 -c "
import json, sys, re

try:
    lines = open('$JSONL').readlines()
    for line in reversed(lines):
        try:
            d = json.loads(line.strip())
            if d.get('type') != 'assistant':
                continue
            content = d.get('message', {}).get('content', [])
            if not isinstance(content, list):
                continue

            # Check if any tool_use block called echocoding ask via Bash
            for block in content:
                if isinstance(block, dict) and block.get('type') == 'tool_use':
                    inp = block.get('input', {})
                    cmd = str(inp.get('command', '') or inp.get('cmd', ''))
                    if 'echocoding ask' in cmd:
                        print('has_ask_call')
                        sys.exit(0)

            # Gather text
            text = ' '.join(
                b.get('text', '') for b in content
                if isinstance(b, dict) and b.get('type') == 'text'
            )
            if not text:
                continue

            # If model already mentioned echocoding ask in text, it's aware
            if 'echocoding ask' in text.lower():
                print('has_ask_mention')
                sys.exit(0)

            # Strip code blocks to avoid false positives from code snippets
            text_clean = re.sub(r'\`\`\`[\s\S]*?\`\`\`', '', text)
            text_clean = re.sub(r'\`[^\`]+\`', '', text_clean)

            # Check if the last non-empty paragraph ends with a question mark
            paras = [p.strip() for p in text_clean.split('\n\n') if p.strip()]
            last_para = paras[-1] if paras else ''
            if re.search(r'[?？]\s*\$', last_para) or re.search(r'[?？]\s*\Z', last_para):
                print('yes')
            else:
                print('no')
            sys.exit(0)
        except:
            continue
    print('no')
except:
    print('no')
" 2>/dev/null)

if [ "$RESULT" = "yes" ]; then
  echo "<stop-hook>💡 检测到文字提问（含？号）。下次反问用户时请改用语音问答：Bash → \`npx echocoding ask \"你的问题\"\`，拿到满意答案后 \`npx echocoding ask-end\` 关闭 HUD。</stop-hook>"
fi
