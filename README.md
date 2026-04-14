# EchoCoding

> Make your AI coding agent talk, listen, and feel alive.

EchoCoding adds immersive audio feedback to AI coding agents like [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [Codex CLI](https://github.com/openai/codex), and [Gemini CLI](https://github.com/google-gemini/gemini-cli). It turns silent terminal sessions into rich, ambient collaboration — your agent speaks at key moments, plays sound effects for every action, and can even listen to your voice.

```
npm install -g echocoding
echocoding install     # injects hooks + downloads models (~1GB)
echocoding start       # start the audio daemon
```

In Claude Code, type `/echocoding` to activate Voice Mode.

## What It Does

EchoCoding is **pipes, not brains**. It gives your AI agent a mouth and ears:

```
echocoding say "Found the root cause, it's a connection leak"
echocoding ask "Two approaches — A is safer, B is faster. Which one?"
echocoding listen
echocoding sfx success
```

The agent decides **when** to speak. EchoCoding just makes it possible.

### Three Layers of Audio

```
┌─────────────────────────────────────────────────────┐
│  Layer 3: Voice Interaction (TTS + ASR)             │  Agent speaks & listens
├─────────────────────────────────────────────────────┤
│  Layer 2: Ambient Soundscape (typing, thinking)     │  Hook-driven atmosphere
├─────────────────────────────────────────────────────┤
│  Layer 1: Event Sound Effects (21 sounds)           │  Deterministic feedback
└─────────────────────────────────────────────────────┘
```

**Layer 1** — Deterministic hook sounds: success chimes, error buzzes, typing clicks, git stamps. Plays automatically, no model involvement.

**Layer 2** — Ambient awareness: mechanical keyboard sounds when editing code, page-turn sounds when reading files, soft blips when a command is running. You know what the agent is doing without looking.

**Layer 3** — Voice interaction: the agent speaks milestones ("Done, 3 files changed"), asks questions via voice ("Delete the build directory?"), and listens to your spoken answers.

## Architecture

```
  Coding Agent (Claude Code / Codex / Gemini CLI)
       │
       ├── Skill Prompt → Agent calls: echocoding say/ask/listen
       │
       ├── Hook System  → Automatic SFX for tool events
       │
       ▼
  EchoCoding Daemon (Unix socket IPC)
       │
       ├── TTS Engine  (Kokoro local / Cloud API / macOS say)
       ├── ASR Engine  (Paraformer local / Cloud API)
       ├── SFX Engine  (21 synthesized effects, fallback chains)
       └── Audio Output
```

- **Daemon + IPC**: Lightweight Unix socket server. Hook handler is an ultra-fast IPC client that never blocks the agent.
- **TTS**: Local Kokoro 82M (103 speakers, Chinese + English) via sherpa-onnx. One-key switch to cloud API.
- **ASR**: Local Paraformer (Chinese + English bilingual). One-key switch to cloud API.
- **SFX**: 21 synthesized WAV effects with intelligent fallback chains.

## Sound Effects

| Sound | Trigger | Description |
|-------|---------|-------------|
| `startup` | Session start | Ascending chord |
| `submit` | User prompt | Upward sweep |
| `write` | Write new file | Single keystroke |
| `typing` | Edit code | Rapid keystroke sequence |
| `read` | Read file | Soft page turn |
| `search` | Grep / Glob | Quick scan blip |
| `working` | Bash running | Periodic soft blips (3s) |
| `thinking` | Agent thinking | Ambient pulse |
| `success` | Tool success | Bright double ping |
| `error` | Tool failure | Low buzz |
| `notification` | Notification | Bell chime |
| `complete` | Task done | Triumphant ascent |
| `git-commit` | git commit | Stamp / thud |
| `git-push` | git push | Launch sweep |
| `test-pass` | Tests pass | Happy ding-ding |
| `test-fail` | Tests fail | Descending doh-doh |
| `compact` | Context compact | Compression sweep |
| `agent-spawn` | Subagent start | Fork / split |
| `agent-done` | Subagent stop | Merge / converge |
| `install` | npm install etc | Ratcheting clicks |
| `delete` | rm / delete | Crumple noise |

## Studio

Preview voices and configure audio settings in your browser:

```
echocoding studio
```

Opens a localhost web panel with:
- **Voice Browser** — preview all 103 Kokoro speakers, filter by language/gender
- **SFX Preview** — listen to all 21 sound effects
- **Settings** — volume, speed, language, mode toggles

## CLI Commands

```
echocoding install          # Inject hooks + download models
echocoding start            # Start daemon
echocoding stop             # Stop daemon
echocoding status           # Show daemon status
echocoding say <text>       # Speak text via TTS
echocoding ask <question>   # Speak + listen for answer
echocoding listen           # Open microphone, return speech-to-text
echocoding sfx <name>       # Play a sound effect
echocoding studio           # Open voice config web panel
echocoding download         # Download/re-download models
echocoding config set <k> <v>  # Set config value
echocoding volume <0-100>   # Set master volume
echocoding mode <mode>      # full | sfx-only | voice-only | focus | mute
echocoding tts-provider <p> # local | cloud
echocoding tts-engine <e>   # kokoro | orpheus | system
```

## Configuration

Config lives at `~/.echocoding/config.yaml`. Key settings:

```yaml
volume: 70              # Master volume (0-100)
mode: full              # full | sfx-only | voice-only | focus | mute
tts:
  provider: local       # local | cloud
  engine: kokoro        # kokoro | orpheus | system
  voice: default        # speaker ID (0-102) or preset (zh-female, zh-male, en-female)
  speed: 1.0
  language: auto        # auto | zh | en
sfx:
  enabled: true
  volume: 80
```

## Supported Agents

| Agent | Hook Events | Status |
|-------|-------------|--------|
| Claude Code | 12+ events | Full support |
| Codex CLI | 5+ events | Supported |
| Gemini CLI | 5+ events | Compatible |

## Requirements

- Node.js >= 18
- macOS / Linux (Windows partial)
- ~1GB disk for local TTS/ASR models

## License

MIT

---

# EchoCoding（中文）

> 让 Vibe Coding 有声有色，把枯燥的等待变成沉浸式协作体验

EchoCoding 为 AI 编程代理（Claude Code、Codex CLI、Gemini CLI）提供沉浸式音频反馈。它把沉默的终端变成有声音、有氛围、会说话的协作空间。

```
npm install -g echocoding
echocoding install     # 注入 hooks + 下载模型（~1GB）
echocoding start       # 启动音频守护进程
```

在 Claude Code 中输入 `/echocoding` 即可激活语音模式。

## 核心理念：管道不是大脑

EchoCoding 不做判断、不过滤、不决策。它提供三根管道：

```
🔊 echocoding say "..."     →  文字变声音，播出去
🎤 echocoding ask "..."     →  语音提问 + 开麦等回答
👂 echocoding listen         →  开麦，听一句话回来
🔔 echocoding sfx <name>    →  播放音效
```

模型自己决定什么时候用哪根管道。模型比任何规则引擎都更擅长评估"这段输出值不值得说出来"。

## 三层音频体验

**第一层：事件音效**（确定性 Hook 驱动）
- 工具调用成功/失败、git 操作、测试结果 → 自动播放对应音效
- 21 个合成音效，覆盖所有编程场景

**第二层：环境音景**（沉浸感）
- 编辑代码 → 机械键盘敲击声
- 读文件 → 翻书声
- 执行命令 → 轻微工作指示音
- 不看屏幕也能感知 agent 在做什么

**第三层：语音互动**（模型主动发声）
- 关键节点播报："搞定了，改了 3 个文件"
- 语音提问："两个方案，选 A 还是 B？"
- 语音识别用户回答

## Studio 声音面板

```
echocoding studio
```

打开浏览器本地面板：
- **声音浏览器** — 预览 103 个语音角色，按语言/性别筛选
- **音效预览** — 试听全部 21 个音效
- **设置面板** — 音量、语速、语言、模式切换

## 技术架构

- **守护进程 + IPC**：Unix socket 通信，hook 处理器极轻量，不阻塞 agent
- **TTS**：本地 Kokoro 82M（103 speakers，中英文）/ 云端 API 一键切换
- **ASR**：本地 Paraformer（中英双语）/ 云端 API 一键切换
- **SFX**：21 个合成音效，智能回退链
- **模型自动下载**：首次安装自动下载 ~1GB 模型

## 支持的编程代理

| 代理 | Hook 事件数 | 状态 |
|------|------------|------|
| Claude Code | 12+ | 完全支持 |
| Codex CLI | 5+ | 支持 |
| Gemini CLI | 5+ | 兼容 |

## 环境要求

- Node.js >= 18
- macOS / Linux（Windows 部分支持）
- ~1GB 磁盘空间（本地 TTS/ASR 模型）

## 开源协议

MIT
