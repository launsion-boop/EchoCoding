# EchoCoding

> Make your AI coding agent talk, listen, and feel alive.

**One-click setup — paste this into your AI coding agent:**

```
Install EchoCoding for me: npm i -g echocoding && echocoding install --auto --start && echocoding doctor — then type /echocoding to activate voice mode. Repo: https://github.com/EchoClaw/echocoding
```

---

EchoCoding adds immersive audio feedback to AI coding tools — your agent speaks at key moments, plays sound effects for every action, and can listen to your voice. Zero config, cloud-powered by default.

Works with **Claude Code**, **Cursor**, **Windsurf**, **Codex CLI**, **Gemini CLI**, and any MCP-compatible tool.

## Quick Start

```bash
npm install -g echocoding
echocoding install --auto --start
```

No models to download, no API keys. Cloud TTS/ASR works out of the box.

- **Claude Code**: type `/echocoding` to activate Voice Mode
- **Cursor / Windsurf**: MCP tools available automatically after install
- Run `echocoding doctor` to verify everything is green

## How It Works

EchoCoding is **pipes, not brains**. It gives your AI agent a mouth and ears:

```bash
echocoding say "Found the root cause, it's a connection leak"
echocoding ask "Two approaches — A is safer. Which one?"
echocoding sfx success
```

The agent decides **when** to speak. EchoCoding just makes it possible.

## Three Layers of Audio

**Layer 1 — Event Sound Effects** (22 sounds, auto-triggered)
Success chimes, error buzzes, typing clicks, git stamps — deterministic feedback for every tool action.

**Layer 2 — Ambient Soundscape** (continuous loops)
Keyboard sounds when editing, page-turn when reading, pulse when thinking — ambient awareness without looking at the screen.

**Layer 3 — Voice Interaction** (TTS + ASR)
Milestones ("Done, 3 files changed"), voice questions ("Delete the build directory?"), spoken answers.

## Voice Modes (Three Tiers)

| Mode | Voice (say) | Hook SFX | Voice Q&A (ask) | Best for |
|------|------------|----------|-----------------|----------|
| **Minimal** | None | All sounds play | Yes | Focus coding |
| **Balanced** (default) | Every text reply + notable events | Yes | Yes | Daily collaboration |
| **Verbose** | Every action narrated | Yes | Yes | Hands-free, eyes-free |

Switch: `/echocoding minimal`, `/echocoding balanced`, `/echocoding verbose`

- **Minimal**: only hook SFX, zero voice — pure ambient awareness
- **Balanced**: AI speaks at every meaningful moment — spoken headlines + full text
- **Verbose**: every single turn narrated, including tool calls — full audio play-by-play

## Multi-Client Support

| Client | Mechanism | Status |
|--------|-----------|--------|
| **Claude Code** | Hook injection (9 events) | Full: SFX + TTS + ASR + ambient |
| **Cursor** | MCP Server (5 tools) | Full: `echocoding_say/sfx/ask/listen/status` |
| **Windsurf** | MCP Server | Full: same MCP tools |
| **Codex CLI** | Skill + CLI | Voice commands |
| **Gemini CLI** | MCP Server | MCP tools |

## Architecture

```
  AI Client (Claude Code / Cursor / Windsurf / Codex / Gemini)
       |
       +-- Hook System ------> echocoding-hook (IPC → daemon)
       +-- MCP Server -------> echocoding mcp (stdio → daemon)
       +-- CLI commands -----> echocoding say/sfx (→ daemon)
       +-- CLI recording ----> echocoding ask/listen (foreground mic → cloud ASR)
                |
                v
         EchoCoding Daemon (Unix socket)
                |
                +-- TTS -----> Cloud: Volcengine (default, 21 voices)
                |              Local: Kokoro 82M (optional, 103 speakers)
                |              Fallback: macOS say / espeak
                |
                +-- SFX -----> 22 sounds + ambient loops
                |
                +-- Proxy ---> coding.echoclaw.me (HMAC-SHA256 auth)

  ASR (foreground, not daemon):
       mic recording (sox) → Cloud: Volcengine V2 WebSocket
                             Local: Paraformer (optional)
                             Browser: Studio MediaRecorder
```

- **Cloud-first**: TTS and ASR use Volcengine by default. Zero config.
- **Local optional**: Download ~1GB models via `echocoding studio` for offline use.
- **Foreground ASR**: `ask`/`listen` record in the CLI process (not daemon) for proper macOS mic permissions.
- **Emotion tags**: `<laugh>` `<chuckle>` `<sigh>` `<gasp>` mapped to Volcengine emotion param on multi-emotion voices.
- **Voice sync**: `say` blocks until TTS playback finishes — text and voice stay aligned.
- **HMAC Auth**: Cloud proxy is signed — only EchoCoding CLI can call it.

## TTS (Text-to-Speech)

| Provider | Voices | Latency | Setup |
|----------|--------|---------|-------|
| **Cloud** (default) | 21 Volcengine voices (zh+en) | ~500ms | Zero config |
| **Local** | 103 Kokoro speakers (zh+en) | ~200ms | Download ~350MB via Studio |
| **Fallback** | macOS `say` / Linux `espeak` | Instant | Built-in |

Switch: `echocoding tts-provider cloud` or `echocoding tts-provider local`

Preview and switch voices in `echocoding studio`.

## ASR (Speech Recognition)

| Provider | Quality | Setup |
|----------|---------|-------|
| **Cloud** (default) | Volcengine V2 streaming (excellent) | Zero config |
| **Browser** | Studio MediaRecorder | Open Studio, click "Hold to Speak" |
| **Local** | Paraformer (zh+en) | Download ~700MB via Studio |

ASR has a 60-second recording window. `ask` speaks the question via TTS, opens mic, returns recognized text.

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

Web panel for voice preview and configuration:
- **Voice Browser** — 21 cloud + 103 local voices, play preview, one-click switch
- **Voice Input** — test ASR via browser microphone
- **SFX Preview** — listen to all 22 sound effects
- **Settings** — volume, mode, voice level, provider-specific settings
- **Model Download** — one-click local model installation (~1GB)

## CLI Commands

```
echocoding install [--auto] [--start]   Auto-detect agents, install hooks/MCP, start daemon
echocoding uninstall                    Remove all hooks/MCP configs
echocoding start / stop / status        Control daemon
echocoding say <text>                   Speak text via TTS (blocks until done)
echocoding ask <question>               Speak + listen for voice answer
echocoding listen                       Open mic, return recognized text
echocoding sfx <name>                   Play a sound effect
echocoding config get/set <key> <val>   Manage configuration
echocoding volume <0-100>               Set master volume
echocoding tts-provider <local|cloud>   Switch TTS provider
echocoding studio                       Open web config panel
echocoding doctor                       System health check
echocoding mcp                          Start MCP server (stdio)
```

## Configuration

Config at `~/.echocoding/config.yaml`:

```yaml
volume: 70
mode: full
voiceLevel: balanced    # minimal | balanced | verbose
tts:
  provider: cloud       # cloud (default) | local
  voice: default        # Volcengine voice ID or local SID (0-102)
  speed: 1.0
  language: auto
asr:
  provider: cloud       # cloud (default) | local
  timeout: 60           # seconds
sfx:
  enabled: true
  volume: 80
```

## Requirements

- Node.js >= 18
- macOS / Linux (Windows partial)
- Internet connection (for cloud TTS/ASR, default mode)
- Optional: ~1GB disk for local models

## Development

```bash
git clone https://github.com/EchoClaw/echocoding.git
cd echocoding && npm install && npm run build
node dist/bin/echocoding.js start
```

## License

MIT

---

# EchoCoding（中文）

> 让 AI 编程有声有色，把枯燥的终端变成沉浸式协作空间

**一键安装 — 复制以下内容发给你的 AI 编程助手：**

```
帮我安装 EchoCoding 语音模式：npm i -g echocoding && echocoding install --auto --start && echocoding doctor — 安装完成后输入 /echocoding 激活语音。仓库：https://github.com/EchoClaw/echocoding
```

---

EchoCoding 为 AI 编程工具提供沉浸式音频反馈——你的 AI 助手会在关键节点开口说话，每个操作都有对应音效，还能听懂你的语音指令。零配置，开箱即用。

支持 **Claude Code**、**Cursor**、**Windsurf**、**Codex CLI**、**Gemini CLI** 及所有 MCP 兼容工具。

## 快速开始

```bash
npm install -g echocoding
echocoding install --auto --start
```

不需要下载模型，不需要配置 API Key。云端语音开箱即用。

- **Claude Code**：输入 `/echocoding` 激活语音模式
- **Cursor / Windsurf**：安装后 MCP 工具自动可用
- 运行 `echocoding doctor` 确认所有检查项为绿色

## 核心理念：管道不是大脑

EchoCoding 不做判断、不决策。它提供三根管道：

```bash
echocoding say "找到根因了，是连接泄漏"        # AI 说话
echocoding ask "两个方案，A 更安全。选哪个？"    # 语音提问 + 听回答
echocoding sfx success                          # 播放音效
```

AI 模型自己决定什么时候用哪根管道。

## 三层音频体验

**第一层：事件音效**（22 个，自动触发）
工具成功/失败、git 操作、测试结果 → 对应音效自动播放

**第二层：环境氛围**（持续循环）
编辑代码 → 键盘敲击声，读文件 → 翻书声，思考中 → 轻柔脉搏。不看屏幕也能感知 AI 在做什么。

**第三层：语音互动**（AI 主动发声）
关键播报："改好了，3 个文件"。语音提问："要删除 build 目录吗？"。听取语音回复。

## 语音模式（三档）

| 档位 | 语音 (say) | 提示音 (SFX) | 语音问答 (ask) | 适合场景 |
|------|-----------|-------------|---------------|---------|
| **简约** | 无 | 全量播放 | 有 | 专注编码 |
| **平衡**（默认） | 每次文字回复 + 重要事件 | 有 | 有 | 日常协作 |
| **强语音** | 每个动作都播报 | 有 | 有 | 解放双手双眼 |

切换：`/echocoding minimal`、`/echocoding balanced`、`/echocoding verbose`

- **简约模式**：只有 hook 提示音，零语音输出——纯氛围感知
- **平衡模式**：AI 在每个有意义的时刻都会开口——语音摘要 + 完整文字
- **强语音模式**：每一步都播报，包括纯工具调用——全程语音解说

## 多客户端支持

| 客户端 | 接入方式 | 功能 |
|--------|---------|------|
| **Claude Code** | Hook 注入（9 个事件） | 完整：音效 + 语音 + ASR + 氛围 |
| **Cursor** | MCP Server（5 个工具） | 完整：`echocoding_say/sfx/ask/listen/status` |
| **Windsurf** | MCP Server | 完整：同上 |
| **Codex CLI** | Skill + CLI | 语音命令 |
| **Gemini CLI** | MCP Server | MCP 工具 |

## 架构

```
  AI 客户端 (Claude Code / Cursor / Windsurf / Codex / Gemini)
       |
       +-- Hook 系统 ------> echocoding-hook (IPC → daemon)
       +-- MCP Server ------> echocoding mcp (stdio → daemon)
       +-- CLI 命令 --------> echocoding say/sfx (→ daemon)
       +-- CLI 录音 --------> echocoding ask/listen (前台麦克风 → 云端 ASR)
                |
                v
         EchoCoding Daemon (Unix socket)
                |
                +-- TTS -----> 云端: 火山引擎（默认，21 音色）
                |              本地: Kokoro 82M（可选，103 音色）
                +-- SFX -----> 22 个音效 + 氛围循环
                +-- Proxy ---> coding.echoclaw.me (HMAC-SHA256 签名鉴权)

  ASR（前台进程，非 daemon）:
       麦克风录音 (sox) → 云端: 火山引擎 V2 WebSocket
                         本地: Paraformer（可选）
                         浏览器: Studio MediaRecorder
```

- **云端优先**：TTS 和 ASR 默认走火山引擎云端，零配置即用
- **本地可选**：在 Studio 一键下载 ~1GB 模型，切换为离线模式
- **前台录音**：`ask`/`listen` 在 CLI 进程录音（非 daemon），确保 macOS 麦克风权限正确
- **情绪标签**：`<laugh>` `<chuckle>` `<sigh>` `<gasp>` 映射为火山引擎 emotion 参数
- **语音同步**：`say` 阻塞至播放完成——文字和语音对齐输出
- **安全鉴权**：HMAC-SHA256 签名，只有 EchoCoding CLI 能调用云端

## 语音合成（TTS）

| 方案 | 音色数量 | 延迟 | 配置 |
|------|---------|------|------|
| **云端**（默认） | 21 个火山引擎音色（中英） | ~500ms | 零配置 |
| **本地** | 103 个 Kokoro 音色（中英） | ~200ms | 在 Studio 下载 ~350MB |
| **兜底** | macOS `say` / Linux `espeak` | 即时 | 内置 |

在 `echocoding studio` 中预览和切换音色。

## 语音识别（ASR）

| 方案 | 质量 | 配置 |
|------|------|------|
| **云端**（默认） | 火山引擎 V2 流式（优秀） | 零配置 |
| **浏览器** | Studio 网页录音 | 打开 Studio，点击"Hold to Speak" |
| **本地** | Paraformer（中英双语） | 在 Studio 下载 ~700MB |

ASR 录音窗口 60 秒。`ask` 先用 TTS 说出问题，再开麦等回答。

## Studio 声音面板

```bash
echocoding studio
```

浏览器本地面板：
- **声音浏览器** — 云端 21 个 + 本地 103 个音色，播放试听，一键切换
- **语音输入** — 浏览器录音测试 ASR
- **音效预览** — 试听全部 22 个音效
- **设置面板** — 音量、模式、语音档位、引擎专属设置
- **模型下载** — 一键下载本地模型（~1GB）

## CLI 命令

```
echocoding install [--auto] [--start]   自动检测客户端，安装 hooks/MCP，启动
echocoding uninstall                    卸载所有 hooks/MCP 配置
echocoding start / stop / status        控制守护进程
echocoding say <text>                   语音播报（阻塞至播放完成）
echocoding ask <question>               语音提问 + 听回答
echocoding listen                       开麦，返回识别文字
echocoding sfx <name>                   播放音效
echocoding config get/set <key> <val>   管理配置
echocoding volume <0-100>               设置主音量
echocoding tts-provider <local|cloud>   切换 TTS 引擎
echocoding studio                       打开声音配置面板
echocoding doctor                       系统健康检查
echocoding mcp                          启动 MCP 服务器 (stdio)
```

## 配置

配置文件：`~/.echocoding/config.yaml`

```yaml
volume: 70
mode: full
voiceLevel: balanced    # minimal | balanced | verbose
tts:
  provider: cloud       # cloud（默认）| local
  voice: default        # 火山音色 ID 或本地 SID (0-102)
  speed: 1.0
  language: auto
asr:
  provider: cloud       # cloud（默认）| local
  timeout: 60           # 秒
sfx:
  enabled: true
  volume: 80
```

## 环境要求

- Node.js >= 18
- macOS / Linux（Windows 部分支持）
- 网络连接（云端 TTS/ASR，默认模式）
- 可选：~1GB 磁盘（本地模型）

## 开发

```bash
git clone https://github.com/EchoClaw/echocoding.git
cd echocoding && npm install && npm run build
node dist/bin/echocoding.js start
```

## 开源协议

MIT
