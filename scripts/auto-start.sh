#!/bin/bash
# EchoCoding Auto-Start — SessionStart hook
# Starts the daemon if not already running. Async hook, non-blocking.
# Paths are injected by the installer via sed or written dynamically.

PIDFILE="$HOME/.echocoding/daemon.pid"
SOCK="/tmp/echocoding.sock"

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

# Start daemon detached — nohup + background, no stdin/stdout
nohup "$NODE" "$DAEMON" >/dev/null 2>&1 &

exit 0
