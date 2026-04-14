# EchoCoding

> Make your AI coding agent talk, listen, and feel alive.

EchoCoding adds immersive audio feedback to AI coding tools. It turns silent terminal sessions into rich, ambient collaboration — your agent speaks at key moments, plays sound effects for every action, and can listen to your voice.

Works with **Claude Code**, **Cursor**, **Windsurf**, **Codex CLI**, **Gemini CLI**, and any MCP-compatible tool.

## Quick Start

```bash
npm install -g echocoding
echocoding install --auto --start
```

That's it. Auto-detects your AI tools, installs hooks/MCP, downloads models (~1GB), starts daemon.

In Claude Code, type `/echocoding` to activate Voice Mode.
In Cursor/Windsurf, the MCP tools are available automatically after install.

### For AI Agents

If you're an AI coding agent setting up EchoCoding for the user:

```bash
npm i -g echocoding && echocoding install --auto --start && echocoding doctor
```

Verify all checks pass (green), then use the voice tools.

## What It Does

EchoCoding is **pipes, not brains**. It gives your AI agent a mouth and ears:

```bash
echocoding say "Found the root cause, it's a connection leak"
echocoding ask "Two approaches — A is safer, B is faster. Which one?"
echocoding listen
echocoding sfx success
```

The agent decides **when** to speak. EchoCoding just makes it possible.

## Three Layers of Audio

```
Layer 3: Voice Interaction (TTS + ASR)          Agent speaks & listens
Layer 2: Ambient Soundscape (typing, thinking)   Hook-driven atmosphere
Layer 1: Event Sound Effects (22 sounds)         Deterministic feedback
```

**Layer 1** — Deterministic hook sounds: success chimes, error buzzes, typing clicks, git stamps.

**Layer 2** — Ambient awareness: keyboard sounds when editing, page-turn when reading, pulse when thinking. Know what the agent is doing without looking.

**Layer 3** — Voice interaction: milestones ("Done, 3 files changed"), voice questions ("Delete the build directory?"), voice answers.

## Multi-Client Support

| Client | Mechanism | Features |
|--------|-----------|----------|
| **Claude Code** | Hook injection (9 events) | Full: SFX + TTS + ASR + ambient loops |
| **Cursor** | MCP Server | Full: AI calls `echocoding_say/sfx/ask/listen` tools |
| **Windsurf** | MCP Server | Full: same MCP tools |
| **Codex CLI** | Prompt injection | Voice commands via CLI |
| **Gemini CLI** | MCP Server | MCP tools |

## Architecture

```
  AI Client (Claude Code / Cursor / Windsurf / CLI)
       |
       +-- Hook System -----> echocoding-hook (IPC client)
       |                          |
       +-- MCP Server -----> echocoding mcp (stdio)
       |                          |
       +-- CLI commands ----+     |
                            v     v
                     EchoCoding Daemon (Unix socket)
                            |
                            +-- TTS (Kokoro local / Volcengine cloud / macOS say)
                            +-- SFX (22 sounds, ambient loops)
                            +-- ASR (Paraformer local / Volcengine cloud)
```

- **Daemon + IPC**: Unix socket server. Hook handler is ultra-fast IPC client, never blocks the agent.
- **MCP Server**: Exposes 5 tools (`echocoding_say/sfx/ask/listen/status`) via stdio transport.
- **Adapters**: Auto-detect and configure Claude Code, Cursor, Windsurf, Codex, Gemini.
- **Prompt Compiler**: Generates client-specific voice mode prompts from shared core rules.

## TTS Providers

| Provider | Engine | Speakers | Latency | Quality |
|----------|--------|----------|---------|---------|
| **Local** | Kokoro 82M (sherpa-onnx) | 103 (zh+en) | ~200ms | Good |
| **Cloud** | Volcengine | 14+ (zh+en) | ~500ms | Studio |
| **Fallback** | macOS `say` / Linux `espeak` | System | Instant | Basic |

Switch: `echocoding tts-provider cloud` or `echocoding tts-provider local`

## Sound Effects (22)

| Sound | Trigger | Sound | Trigger |
|-------|---------|-------|---------|
| startup | Session start | complete | Task done |
| submit | User prompt | git-commit | git commit |
| write | New file | git-push | git push |
| typing | Edit code (ambient) | test-pass | Tests pass |
| read | Read file | test-fail | Tests fail |
| search | Grep/Glob | agent-spawn | Subagent start |
| working | Bash running | agent-done | Subagent stop |
| thinking | AI thinking (ambient) | install | npm install etc |
| success | Tool success | delete | rm/delete |
| error | Tool failure | compact | Context compact |
| notification | Attention needed | heartbeat | Alive pulse (ambient) |

## Studio

```bash
echocoding studio
```

Opens a localhost web panel:
- **Voice Browser** — preview 103 local + 14 cloud voices, filter by language/gender
- **Local/Cloud toggle** — switch TTS provider and preview voices
- **Voice Input (ASR)** — test speech recognition via browser microphone
- **SFX Preview** — listen to all 22 sound effects
- **Settings** — volume, speed, language, mode toggles

### Microphone Access (Important for ASR)

On macOS, voice input (`echocoding ask/listen`) requires microphone permission. Due to macOS security, CLI tools cannot trigger the permission dialog automatically.

**Solution: Use Studio for first-time microphone setup.**

1. Run `echocoding studio` to open the web panel
2. Click "Hold to Speak" in the Voice Input section
3. Your browser will show a microphone permission dialog — **click Allow**
4. Voice input via Studio works immediately

For CLI-based ASR (`echocoding listen/ask`), you also need to grant microphone access to your terminal app:
- Open **System Settings > Privacy & Security > Microphone**
- Enable your terminal app (Terminal.app / iTerm2) or Claude Code

## CLI Commands

```
echocoding install [--auto] [--start]   Install for all detected agents
echocoding uninstall                    Remove all hooks/MCP configs
echocoding start / stop / status        Control daemon
echocoding say <text>                   Speak text via TTS
echocoding ask <question>               Speak + listen for voice answer
echocoding listen                       Open mic, return speech-to-text
echocoding sfx <name>                   Play a sound effect
echocoding test                         Play test sounds
echocoding config get/set <key> <val>   Manage config
echocoding volume <0-100>               Set master volume
echocoding mode <mode>                  full | sfx-only | voice-only | focus | mute
echocoding tts-provider <local|cloud>   Switch TTS provider
echocoding studio                       Open web config panel
echocoding doctor                       System health check
echocoding mcp                          Start MCP server (stdio)
```

## Voice Mode

Three verbosity tiers control when the AI speaks:

- **Minimal**: Only at critical moments (blockers, errors, major completions)
- **Balanced** (default): Most turns with new information
- **Verbose**: Narrate every action

Switch in Claude Code: `/echocoding minimal`, `/echocoding balanced`, `/echocoding verbose`

## Configuration

Config at `~/.echocoding/config.yaml`:

```yaml
volume: 70
mode: full
tts:
  provider: local       # local | cloud
  engine: kokoro
  voice: default        # SID (0-102) or preset (zh-female, zh-male, en-female)
  speed: 1.0
  language: auto
sfx:
  enabled: true
  volume: 80
```

## Requirements

- Node.js >= 18
- macOS / Linux (Windows partial)
- ~1GB disk for local models (auto-downloaded on install)
- sox (auto-installed) for microphone recording

## Development

```bash
git clone https://github.com/EchoClaw/echocoding.git
cd echocoding && npm install && npm run build
node dist/bin/echocoding.js start
```

## License

MIT

---

# EchoCoding (中文)

> 让 Vibe Coding 有声有色，把枯燥的等待变成沉浸式协作体验

支持 **Claude Code**、**Cursor**、**Windsurf**、**Codex CLI**、**Gemini CLI** 及所有 MCP 兼容工具。

```bash
npm install -g echocoding
echocoding install --auto --start
```

自动检测已安装的 AI 工具，注入 hooks/MCP，下载模型，启动守护进程。一条命令搞定。

在 Claude Code 中输入 `/echocoding` 激活语音模式。
在 Cursor/Windsurf 中，MCP 工具安装后自动可用。

详见英文文档。
