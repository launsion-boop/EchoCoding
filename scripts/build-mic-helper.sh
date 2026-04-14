#!/bin/bash
# Build mic-helper as a macOS .app bundle with NSMicrophoneUsageDescription
# so it can trigger the system permission dialog from any parent process.
# Output: tools/MicHelper.app/

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
SRC="$ROOT_DIR/tools/mic-helper.swift"
APP_DIR="$ROOT_DIR/tools/MicHelper.app"
CONTENTS="$APP_DIR/Contents"
MACOS_DIR="$CONTENTS/MacOS"

if [ "$(uname)" != "Darwin" ]; then
  echo "mic-helper is macOS only, skipping build"
  exit 0
fi

echo "Building MicHelper.app..."

# Clean previous build
rm -rf "$APP_DIR"
mkdir -p "$MACOS_DIR"

# Compile Swift binary
swiftc "$SRC" \
  -o "$MACOS_DIR/mic-helper" \
  -framework AVFoundation \
  -framework CoreAudio \
  -O

# Create Info.plist with microphone usage description
cat > "$CONTENTS/Info.plist" << 'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>com.echoclaw.mic-helper</string>
  <key>CFBundleName</key>
  <string>EchoCoding Mic Helper</string>
  <key>CFBundleExecutable</key>
  <string>mic-helper</string>
  <key>CFBundleVersion</key>
  <string>1.0</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>LSUIElement</key>
  <true/>
  <key>NSMicrophoneUsageDescription</key>
  <string>EchoCoding needs microphone access for voice input (ASR).</string>
</dict>
</plist>
PLIST

# Create wrapper that runs the binary directly.
# Authorization dialog goes to the PARENT process (Claude Code / Terminal / Codex).
# This is correct: each coding agent gets its own mic permission independently.
cat > "$ROOT_DIR/tools/mic-helper" << 'WRAPPER'
#!/bin/bash
DIR="$(cd "$(dirname "$0")" && pwd)"
exec "$DIR/MicHelper.app/Contents/MacOS/mic-helper" "$@"
WRAPPER
chmod +x "$ROOT_DIR/tools/mic-helper"

echo "Built: $APP_DIR"
echo "Wrapper: $ROOT_DIR/tools/mic-helper"
