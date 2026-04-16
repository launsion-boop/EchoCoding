#!/bin/bash
# EchoCoding Auto-Start — SessionStart hook
# Starts the daemon if not already running. Async hook, non-blocking.
# Paths are injected by the installer via sed or written dynamically.

CLIENT_RAW="${ECHOCODING_CLIENT:-${ECHOCODING_HOOK_CLIENT:-default}}"
case "$CLIENT_RAW" in
  codex|claude) CLIENT="$CLIENT_RAW" ;;
  *) CLIENT="default" ;;
esac

if [ "$CLIENT" = "default" ]; then
  PIDFILE="$HOME/.echocoding/daemon.pid"
  SOCK="/tmp/echocoding.sock"
else
  PIDFILE="$HOME/.echocoding/daemon.$CLIENT.pid"
  SOCK="/tmp/echocoding.$CLIENT.sock"
fi

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
