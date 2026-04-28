#!/bin/bash
# EchoCoding Auto-Start — SessionStart hook
# Starts the daemon if not already running. Async hook, non-blocking.
# Paths are injected by the installer via sed or written dynamically.

CLIENT_RAW="${ECHOCODING_CLIENT:-${ECHOCODING_HOOK_CLIENT:-default}}"
case "$CLIENT_RAW" in
  codex|claude) CLIENT="$CLIENT_RAW" ;;
  *) CLIENT="default" ;;
esac

repair_codex_hooks_config() {
  # Codex hooks occasionally keep stale absolute paths (e.g. moved hub dir,
  # upgraded Homebrew node Cellar path), which can cause hook exit code 127.
  [ "$CLIENT" = "codex" ] || return 0
  command -v python3 >/dev/null 2>&1 || return 0

  local hooks_json="$HOME/.codex/hooks.json"
  [ -f "$hooks_json" ] || return 0

  local node_bin
  node_bin="${ECHOCODING_NODE:-$(command -v node 2>/dev/null || true)}"
  local hook_dir_candidates
  hook_dir_candidates="$HOME/Desktop/agent-hub-kit/framework/codex/hooks:$HOME/Desktop/EchoClaw-hub/framework/codex/hooks:$HOME/Desktop/EchoClaw-hub/framework/claude/hooks"

  HOOKS_JSON="$hooks_json" NODE_BIN="$node_bin" HOOK_DIR_CANDIDATES="$hook_dir_candidates" python3 - <<'PY' >/dev/null 2>&1 || true
import json
import os
import re
import shutil
import time
from pathlib import Path

hooks_path = Path(os.environ.get("HOOKS_JSON", ""))
if not hooks_path.is_file():
    raise SystemExit(0)

try:
    data = json.loads(hooks_path.read_text(encoding="utf-8"))
except Exception:
    raise SystemExit(0)

node_bin = (os.environ.get("NODE_BIN") or "").strip()
candidates_raw = (os.environ.get("HOOK_DIR_CANDIDATES") or "").split(":")
hook_dir = ""
for candidate in candidates_raw:
    c = candidate.strip()
    if c and Path(c).is_dir():
        hook_dir = c.rstrip("/") + "/"
        break

legacy_hook_patterns = [
    re.compile(r"/Users/[^/]+/Desktop/EchoClaw/\.claude/hooks/"),
    re.compile(r"/Users/[^/]+/Desktop/EchoClaw-hub/framework/(?:claude|codex)/hooks/"),
]
node_cellar_pattern = re.compile(r"/opt/homebrew/Cellar/node/[^/'\" \t]+/bin/node")

changed = False
hooks_obj = data.get("hooks", {})
if isinstance(hooks_obj, dict):
    for event_blocks in hooks_obj.values():
        if not isinstance(event_blocks, list):
            continue
        for block in event_blocks:
            if not isinstance(block, dict):
                continue
            hook_items = block.get("hooks", [])
            if not isinstance(hook_items, list):
                continue
            for item in hook_items:
                if not isinstance(item, dict):
                    continue
                command = item.get("command")
                if not isinstance(command, str):
                    continue
                updated = command
                if hook_dir:
                    for pattern in legacy_hook_patterns:
                        updated = pattern.sub(hook_dir, updated)
                if node_bin:
                    updated = node_cellar_pattern.sub(node_bin, updated)
                if updated != command:
                    item["command"] = updated
                    changed = True

if not changed:
    raise SystemExit(0)

backup = hooks_path.with_name(f"{hooks_path.name}.autoheal.{int(time.time())}")
try:
    shutil.copy2(hooks_path, backup)
except Exception:
    pass

hooks_path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
PY
}

if [ "$CLIENT" = "default" ]; then
  PIDFILE="$HOME/.echocoding/daemon.pid"
  SOCK="/tmp/echocoding.sock"
else
  PIDFILE="$HOME/.echocoding/daemon.$CLIENT.pid"
  SOCK="/tmp/echocoding.$CLIENT.sock"
fi

# Self-heal first so later hooks in the same session won't hit stale paths.
repair_codex_hooks_config

# Quick check: daemon already running?
if [ -S "$SOCK" ] && [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE" 2>/dev/null)" 2>/dev/null; then
  exit 0
fi

# Resolve paths — installer writes NODE_PATH and DAEMON_SCRIPT as env or we detect
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Node path: prefer ECHOCODING_NODE, then common locations
NODE="${ECHOCODING_NODE:-$(command -v node 2>/dev/null || echo /opt/homebrew/bin/node)}"
DAEMON="$PROJECT_DIR/dist/bin/echocoding-daemon.js"

[ -f "$DAEMON" ] || exit 0
[ -x "$NODE" ] || exit 0

export ECHOCODING_CLIENT="$CLIENT"
# Parent PID is usually the client hook runner process (Claude/Codex). Pass it
# to daemon so it can stop itself when the owning client exits.
export ECHOCODING_OWNER_PID="${PPID:-}"

# Start daemon detached via Node child_process.
# This is more robust than plain nohup in hook runners that clean up child jobs.
"$NODE" -e "const {spawn}=require('node:child_process');const n=process.argv[1];const d=process.argv[2];const c=spawn(n,[d],{detached:true,stdio:'ignore'});c.unref();" "$NODE" "$DAEMON" >/dev/null 2>&1

exit 0
