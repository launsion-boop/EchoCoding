<p align="center">
  <h1 align="center">EchoCoding</h1>
  <p align="center"><strong>Make your AI coding agent talk, listen, and feel alive.</strong></p>
  <p align="center">
    <a href="https://www.npmjs.com/package/echocoding"><img src="https://img.shields.io/npm/v/echocoding.svg" alt="npm version"></a>
    <a href="https://github.com/launsion-boop/EchoCoding/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/echocoding.svg" alt="license"></a>
    <a href="https://www.npmjs.com/package/echocoding"><img src="https://img.shields.io/node/v/echocoding.svg" alt="node version"></a>
  </p>
</p>

---

**One-line setup** — paste this into your AI coding agent:

```
Install EchoCoding: npm i -g echocoding && echocoding install --auto --start && echocoding doctor
```

Or tell it in Chinese:

```
帮我安装 EchoCoding：npm i -g echocoding && echocoding install --auto --start && echocoding doctor
```

---

EchoCoding turns silent AI coding into an immersive audio experience. Your agent plays sound effects for every action, speaks at key moments, and listens to your voice commands. Zero config. Cloud-powered. Works out of the box.

**Supported clients:** Claude Code, Cursor, Windsurf, Codex CLI, Gemini CLI, and any MCP-compatible tool.

## Quick Start

```bash
npm install -g echocoding
echocoding install --auto --start
```

That's it. No models to download, no API keys to configure.

- **Cursor / Windsurf**: MCP tools are available automatically after install
- Run `echocoding doctor` to verify your setup

After install, EchoCoding starts automatically with every new session. Sound effects play from the first keystroke.

### Claude Code — Activating Voice Mode

Sound effects are on from the moment you install. To unlock TTS speech and voice Q&A, type `/echocoding` at the start of your session:

```
/echocoding
```

This activates **balanced mode** — the default. Your agent will speak at key moments and listen for your voice responses.

**Three voice levels:**

| Level | Agent Speech | Voice Q&A | Best For |
|-------|-------------|-----------|----------|
| `/echocoding minimal` | None | Yes | Focus — SFX only, zero interruptions |
| `/echocoding` (default) | Key moments | Yes | Daily use — speaks when it matters |
| `/echocoding verbose` | Every turn | Yes | Hands-free — full narration |

You can switch levels at any time during a session. Without `/echocoding`, the agent stays in SFX-only mode.

## Three Layers of Audio

### Layer 1 — Sound Effects (23 events, automatic)

Every tool action triggers a distinct sound: success chimes, error buzzes, typing clicks, git stamps, test bells. You hear what your agent is doing without watching the screen.

### Layer 2 — Ambient Soundscape (continuous)

Keyboard clicks while editing. Soft page turns while reading. A gentle pulse while thinking. Ambient audio creates spatial awareness of your agent's state.

### Layer 3 — Voice (TTS + ASR)

Your agent speaks at milestones: "All tests pass, ready to merge." Asks questions by voice: "Two approaches, A is safer. Which one?" Listens for your spoken answers.

## Voice Modes

EchoCoding has two independent audio controls:

| Control | Options | What it controls |
|---------|---------|-----------------|
| **Mode** | `full` `sfx-only` `voice-only` `mute` | Which audio systems are active |
| **Voice Level** | `minimal` `balanced` `verbose` | How often the agent speaks |

### Voice Level (Three Tiers)

| Level | Agent Speech | Sound Effects | Voice Q&A | Best For |
|-------|-------------|---------------|-----------|----------|
| **Minimal** | None | All play | Yes | Focus coding |
| **Balanced** (default) | Important moments + text replies | All play | Yes | Daily use |
| **Verbose** | Every single turn | All play | Yes | Hands-free |

Switch levels: `/echocoding minimal`, `/echocoding balanced`, `/echocoding verbose`

- **Minimal**: pure sound effects, zero speech. Install and forget. Your agent gains a sonic personality without ever interrupting you.
- **Balanced**: the agent evaluates each reply and speaks when there's something worth hearing — findings, completions, errors, questions. Routine operations stay silent.
- **Verbose**: full narration. Every action announced. Perfect for cooking, walking, or any time you're away from the screen.

### Hook-Based Speech Reminders

In balanced and verbose modes, a hook-based reminder system nudges the AI to speak at the right moments. This works at the infrastructure level — no skill prompt needed, no rules to forget.

## How It Works

EchoCoding is **pipes, not brains**. It gives your AI agent a mouth and ears:

```bash
echocoding say "Found the bug, it was a connection leak"
echocoding ask "Delete the build directory. Okay?"
echocoding sfx git-commit
```

The agent decides **when** and **what** to say. EchoCoding just makes it possible.

### Auto-Start

After installation, the daemon starts automatically with every new Claude Code session. No manual `echocoding start` needed. Sound effects work from the first moment.

## Multi-Client Support

| Client | Mechanism | Capabilities |
|--------|-----------|-------------|
| **Claude Code** | Hook injection (9 events) + auto-start | Full: SFX + TTS + ASR + ambient + voice reminders |
| **Cursor** | MCP Server (5 tools) | Full: `say` / `sfx` / `ask` / `listen` / `status` |
| **Windsurf** | MCP Server | Full: same MCP tools |
| **Codex CLI** | Skill + CLI | Voice commands |
| **Gemini CLI** | MCP Server | MCP tools |

## Sound Effects (23)

| Sound | Trigger | Sound | Trigger |
|-------|---------|-------|---------|
| startup | Session start | complete | Task done |
| submit | User prompt | git-commit | `git commit` |
| write | New file | git-push | `git push` |
| typing | Edit code (ambient) | test-pass | Tests pass |
| read | Read file | test-fail | Tests fail |
| search | Grep / Glob | agent-spawn | Subagent start |
| working | Bash running | agent-done | Subagent stop |
| thinking | AI thinking (ambient) | install | `npm install` etc |
| success | Tool success | delete | `rm` / delete |
| error | Tool failure | compact | Context compact |
| notification | Attention needed | heartbeat | Alive pulse (ambient) |
| mic-ready | Microphone activated | | |

## TTS (Text-to-Speech)

| Provider | Voices | Latency | Setup |
|----------|--------|---------|-------|
| **Cloud** (default) | 21 Volcengine voices (zh + en) | ~500ms | Zero config |
| **Local** | 103 Kokoro speakers (zh + en) | ~200ms | Download ~350MB via Studio |
| **Fallback** | macOS `say` / Linux `espeak` | Instant | Built-in |

Features:
- **Emotion tags**: `<laugh>` `<chuckle>` `<sigh>` `<gasp>` — mapped to TTS emotion parameters for natural expression
- **Voice sync**: `say` blocks until playback finishes — text and voice stay aligned
- **Throttle**: dedup window prevents repeated phrases

## ASR (Speech Recognition)

| Provider | Quality | Setup |
|----------|---------|-------|
| **Cloud** (default) | Volcengine V3 BigModel streaming | Zero config |
| **Browser** | Studio MediaRecorder | Open Studio, click "Hold to Speak" |
| **Local** | Paraformer (zh + en bilingual) | Download ~700MB via Studio |

`ask` opens a floating HUD, speaks the question via TTS, streams audio in real-time to the cloud ASR, and returns recognized text. The HUD closes when the result is returned.

**Multi-turn voice conversation:** the model drives the dialog — if the answer is unclear, it calls `ask` again with a follow-up question. The HUD re-opens for each new question. This lets the model use voice as a structured input channel, not just a one-shot prompt.

**Echo suppression:** a 260ms anti-bleed gate and text-level echo detection prevent TTS playback from leaking back into the ASR result. If the recognized text matches the spoken question, EchoCoding automatically re-listens (up to 2 retries).

**macOS mic permissions:** EchoCoding uses a Developer ID-signed MicHelper.app to request microphone access via macOS TCC. No manual privacy settings required.

## Studio

```bash
echocoding studio
```

Browser-based configuration panel:

- **Voice Browser** — preview all 124 voices (21 cloud + 103 local), one-click switch
- **SFX Preview** — listen to all 23 sound effects
- **Voice Input** — test ASR via browser microphone
- **Settings** — volume, mode, voice level, speed, language
- **Model Manager** — one-click local model download (~1GB)

## Architecture

```
  AI Client (Claude Code / Cursor / Windsurf / Codex / Gemini)
       |
       +-- Hook System ---------> echocoding-hook (IPC -> daemon)
       |   +-- auto-start.sh      (SessionStart: daemon auto-launch)
       |   +-- voice-reminder.sh  (UserPromptSubmit: speech gating)
       |
       +-- MCP Server ----------> echocoding mcp (stdio -> daemon)
       +-- CLI commands ---------> echocoding say/sfx (-> daemon)
       +-- CLI recording --------> echocoding ask/listen (foreground mic)
                |
                v
         EchoCoding Daemon (Unix socket IPC)
                |
                +-- TTS --------> Cloud: Volcengine (default)
                |                 Local: Kokoro 82M (optional, 103 speakers)
                |                 Fallback: macOS say / espeak
                |
                +-- SFX --------> 23 sounds + ambient loops (afplay)
                |
                +-- Proxy ------> coding.echoclaw.me (HMAC-SHA256 signed)

  ASR (foreground process, not daemon):
       MicHelper.app (Developer ID signed, TCC mic permission)
         -> streaming PCM via Unix socket
         -> Cloud: Volcengine V3 BigModel WebSocket (streaming)
            Local: Paraformer (optional)
            Browser: Studio MediaRecorder
       Floating HUD (real-time partial text, YOU: cursor)
```

Key design decisions:

- **Cloud-first**: TTS and ASR use cloud APIs by default. Zero config, instant setup.
- **Local optional**: Download ~1GB models via Studio for offline use.
- **Foreground ASR**: Recording runs in the CLI process (not daemon) for proper macOS microphone permissions.
- **Voice sync**: `say` blocks until playback finishes, keeping text and audio aligned.
- **HMAC auth**: Cloud proxy requests are signed. Only EchoCoding can call it.
- **Hook architecture**: Three hooks work together — SFX (async), auto-start (async), voice reminder (blocking).

## CLI Reference

```
echocoding install [--auto] [--start]   Detect agents, install hooks/MCP, optionally start daemon
echocoding uninstall                    Remove all hooks and MCP configs
echocoding start / stop / status        Daemon lifecycle
echocoding say <text>                   Speak via TTS (blocks until playback ends)
echocoding ask <question>               Speak question + open HUD + listen for voice answer
echocoding ask-end                      Close active ASK HUD immediately
echocoding listen                       Open mic, return recognized text
echocoding sfx <name>                   Play a named sound effect
echocoding config get/set <key> <val>   Read or write config values
echocoding volume <0-100>               Set master volume
echocoding tts-provider <local|cloud>   Switch TTS provider
echocoding studio                       Open browser config panel
echocoding doctor                       System health check (adapters, daemon, models)
echocoding mcp                          Start MCP server (stdio mode)
```

## Configuration

Config file: `~/.echocoding/config.yaml`

```yaml
enabled: true
volume: 70
mode: full              # full | sfx-only | voice-only | mute
voiceLevel: balanced    # minimal | balanced | verbose

tts:
  provider: cloud       # cloud (default) | local
  voice: zh_female_wanwanxiaohe_moon_bigtts
  speed: 1.0
  language: auto        # zh | en | auto
  emotion: true         # enable <laugh> <sigh> etc.

asr:
  provider: cloud       # cloud (default) | local
  timeout: 60           # seconds

sfx:
  enabled: true
  volume: 80
```

## Requirements

- **Node.js** >= 18
- **macOS** or **Linux** (Windows: partial support)
- **Internet** for cloud TTS/ASR (default mode)
- Optional: ~1GB disk space for local models

## Development

```bash
git clone https://github.com/launsion-boop/EchoCoding.git
cd echocoding
npm install
npm run build
node dist/bin/echocoding.js install --auto --start
```

Run `echocoding doctor` to verify your dev setup.

## License

MIT

---

<p align="center">
  <h1 align="center">EchoCoding（中文文档）</h1>
  <p align="center"><strong>让你的 AI 编程助手会说、会听、有温度</strong></p>
</p>

---

**一句话安装** — 复制发给你的 AI 助手：

```
帮我安装 EchoCoding：npm i -g echocoding && echocoding install --auto --start && echocoding doctor
```

---

EchoCoding 把安静的 AI 编程变成沉浸式音频体验。每个操作都有专属音效，关键节点 AI 会开口说话，还能听懂你的语音指令。零配置，云端驱动，开箱即用。

支持 **Claude Code**、**Cursor**、**Windsurf**、**Codex CLI**、**Gemini CLI** 及所有 MCP 兼容工具。

## 快速开始

```bash
npm install -g echocoding
echocoding install --auto --start
```

不需要下载模型，不需要 API Key。

- **Cursor / Windsurf**：安装后 MCP 工具自动可用
- 运行 `echocoding doctor` 确认环境正常

安装后，daemon 会随每次新会话自动启动。音效从第一次操作开始就有。

### Claude Code — 开启语音模式

安装即有音效。要解锁 TTS 语音播报和语音问答，在每次会话开始时输入：

```
/echocoding
```

这会激活**平衡模式**（默认）。AI 在关键节点开口说话，并能听你的语音回答。

**三种语音档位：**

| 档位 | AI 说话 | 语音问答 | 适合场景 |
|------|---------|---------|---------|
| `/echocoding minimal` | 无 | 有 | 专注模式，纯音效不打扰 |
| `/echocoding`（默认） | 关键时刻 | 有 | 日常协作，该说才说 |
| `/echocoding verbose` | 每一步 | 有 | 解放双手，全程播报 |

会话中随时切换档位。不输入 `/echocoding` 则保持纯音效模式。

## 三层音频体验

### 第一层：事件音效（23 个，自动触发）

每个工具操作都有对应音效：成功叮咚、错误蜂鸣、打字点击、git 盖章、测试铃声。不看屏幕也知道 AI 在做什么。

### 第二层：环境氛围（持续循环）

编辑代码时键盘敲击声，读文件时翻书声，思考时轻柔脉搏。环境音让你对 AI 的状态有空间感知。

### 第三层：语音互动（TTS + ASR）

AI 在关键节点开口："测试全过了，可以合并。" 语音提问："要删除 build 目录吗？" 听你说话作答。

## 语音模式

EchoCoding 有两个独立的音频控制：

| 控制项 | 选项 | 控制内容 |
|--------|------|---------|
| **模式 (mode)** | `full` `sfx-only` `voice-only` `mute` | 哪些音频系统启用 |
| **语音档位 (voiceLevel)** | `minimal` `balanced` `verbose` | AI 说话的频率 |

### 语音档位（三档）

| 档位 | AI 说话 | 提示音 | 语音问答 | 适合场景 |
|------|---------|--------|---------|---------|
| **简约** | 无 | 全量 | 有 | 专注编码 |
| **平衡**（默认） | 重要时刻 + 文字回复 | 全量 | 有 | 日常协作 |
| **强语音** | 每一步都播报 | 全量 | 有 | 解放双手双眼 |

切换：`/echocoding minimal`、`/echocoding balanced`、`/echocoding verbose`

- **简约模式**：纯音效，零语音。安装即忘。AI 有了声音个性，但绝不打扰你。
- **平衡模式**：AI 评估每次回复，有重要信息时才开口——发现、完成、报错、提问。日常操作保持安静。
- **强语音模式**：全程播报。每个动作都解说。适合做饭、散步、离开屏幕的场景。

### Hook 语音提醒机制

平衡和强语音模式下，hook 提醒系统会在基础设施层面引导 AI 在合适的时机说话。无需依赖 prompt 规则，不会遗忘。

## 核心理念：管道不是大脑

EchoCoding 不做决策。它给 AI 提供三根管道：

```bash
echocoding say "找到 bug 了，是连接泄漏"          # AI 说话
echocoding ask "要删除 build 目录吗？"             # 语音提问 + 听回答
echocoding sfx git-commit                         # 播放音效
```

AI 自己决定什么时候用哪根管道。

### 自动启动

安装后，daemon 会随每次新的 Claude Code 会话自动启动。不需要手动 `echocoding start`。音效从第一刻起就有。

## 多客户端支持

| 客户端 | 接入方式 | 能力 |
|--------|---------|------|
| **Claude Code** | Hook 注入（9 事件）+ 自动启动 | 完整：音效 + 语音 + ASR + 氛围 + 语音提醒 |
| **Cursor** | MCP Server（5 工具） | 完整：`say` / `sfx` / `ask` / `listen` / `status` |
| **Windsurf** | MCP Server | 完整：同上 |
| **Codex CLI** | Skill + CLI | 语音命令 |
| **Gemini CLI** | MCP Server | MCP 工具 |

## 音效列表（23 个）

| 音效 | 触发场景 | 音效 | 触发场景 |
|------|---------|------|---------|
| startup | 会话启动 | complete | 任务完成 |
| submit | 用户发送 | git-commit | `git commit` |
| write | 新建文件 | git-push | `git push` |
| typing | 编辑代码（氛围） | test-pass | 测试通过 |
| read | 读取文件 | test-fail | 测试失败 |
| search | Grep / Glob | agent-spawn | 子代理启动 |
| working | Bash 执行 | agent-done | 子代理完成 |
| thinking | AI 思考（氛围） | install | `npm install` 等 |
| success | 工具成功 | delete | 删除操作 |
| error | 工具失败 | compact | 上下文压缩 |
| notification | 需要关注 | heartbeat | 存活脉搏（氛围） |
| mic-ready | 麦克风就绪 | | |

## 语音合成（TTS）

| 方案 | 音色 | 延迟 | 配置 |
|------|------|------|------|
| **云端**（默认） | 21 个火山引擎音色（中 + 英） | ~500ms | 零配置 |
| **本地** | 103 个 Kokoro 音色（中 + 英） | ~200ms | Studio 下载 ~350MB |
| **兜底** | macOS `say` / Linux `espeak` | 即时 | 内置 |

特性：
- **情绪标签**：`<laugh>` `<chuckle>` `<sigh>` `<gasp>` — 映射为 TTS 情绪参数，表达更自然
- **语音同步**：`say` 阻塞至播放完成，文字和语音对齐
- **节流去重**：防止重复短语

## 语音识别（ASR）

| 方案 | 质量 | 配置 |
|------|------|------|
| **云端**（默认） | 火山引擎 V3 BigModel 流式 | 零配置 |
| **浏览器** | Studio 网页录音 | 打开 Studio 点击录音 |
| **本地** | Paraformer（中英双语） | Studio 下载 ~700MB |

`ask` 弹出悬浮 HUD，TTS 说出问题，实时流式上传音频给云端 ASR，返回识别文本后 HUD 自动关闭。

**模型驱动多轮对话：** 如果回答不够清晰，模型直接再次调用 `ask` 追问。HUD 随每个新问题重新弹出，让模型把语音当作结构化的输入通道，而不是一次性提问。

**防串音：** 260ms 起始门控 + 文本级回声检测，防止 TTS 声音被 ASR 误识别。若识别结果与提问高度相似，自动重新倾听（最多 2 次）。

**macOS 麦克风权限：** EchoCoding 使用 Developer ID 签名的 MicHelper.app 申请 macOS TCC 麦克风权限，无需手动设置隐私配置。

## Studio 配置面板

```bash
echocoding studio
```

浏览器本地面板：

- **声音浏览器** — 全部 124 个音色（云端 21 + 本地 103），试听、一键切换
- **音效预览** — 试听全部 23 个音效
- **语音输入** — 浏览器录音测试 ASR
- **设置** — 音量、模式、语音档位、速度、语言
- **模型管理** — 一键下载本地模型（~1GB）

## 架构

```
  AI 客户端 (Claude Code / Cursor / Windsurf / Codex / Gemini)
       |
       +-- Hook 系统 -----------> echocoding-hook (IPC -> daemon)
       |   +-- auto-start.sh      (SessionStart: 自动启动 daemon)
       |   +-- voice-reminder.sh  (UserPromptSubmit: 语音播报提醒)
       |
       +-- MCP Server ----------> echocoding mcp (stdio -> daemon)
       +-- CLI 命令 ------------> echocoding say/sfx (-> daemon)
       +-- CLI 录音 ------------> echocoding ask/listen (前台麦克风)
                |
                v
         EchoCoding Daemon (Unix socket IPC)
                |
                +-- TTS --------> 云端: 火山引擎（默认）
                |                 本地: Kokoro 82M（可选，103 音色）
                |                 兜底: macOS say / espeak
                |
                +-- SFX --------> 23 个音效 + 氛围循环 (afplay)
                |
                +-- Proxy ------> coding.echoclaw.me (HMAC-SHA256 签名)

  ASR（前台进程，非 daemon）:
       MicHelper.app（Developer ID 签名，TCC 麦克风授权）
         -> 流式 PCM via Unix socket
         -> 云端: 火山引擎 V3 BigModel WebSocket（流式）
            本地: Paraformer（可选）
            浏览器: Studio MediaRecorder
       悬浮 HUD（实时 partial 文本，YOU: 光标）
```

关键设计：

- **云端优先**：TTS 和 ASR 默认走云端，零配置即用
- **本地可选**：Studio 一键下载 ~1GB 模型，切换离线模式
- **前台录音**：`ask`/`listen` 在 CLI 进程录音（非 daemon），确保 macOS 麦克风权限
- **语音同步**：`say` 阻塞至播放完成，文字和语音对齐
- **安全鉴权**：HMAC-SHA256 签名，只有 EchoCoding CLI 能调用云端
- **三层 Hook**：SFX hook（async）、自动启动（async）、语音提醒（blocking）协同工作

## CLI 命令

```
echocoding install [--auto] [--start]   检测客户端，安装 hooks/MCP，可选启动 daemon
echocoding uninstall                    卸载所有 hooks 和 MCP 配置
echocoding start / stop / status        daemon 生命周期管理
echocoding say <text>                   语音播报（阻塞至播放完成）
echocoding ask <question>               语音提问 + 弹出 HUD + 听回答
echocoding ask-end                      立即关闭当前 ASK HUD
echocoding listen                       开麦，返回识别文字
echocoding sfx <name>                   播放指定音效
echocoding config get/set <key> <val>   读写配置
echocoding volume <0-100>               设置主音量
echocoding tts-provider <local|cloud>   切换 TTS 引擎
echocoding studio                       打开浏览器配置面板
echocoding doctor                       系统健康检查（适配器、daemon、模型）
echocoding mcp                          启动 MCP 服务器（stdio 模式）
```

## 配置

配置文件：`~/.echocoding/config.yaml`

```yaml
enabled: true
volume: 70
mode: full              # full | sfx-only | voice-only | mute
voiceLevel: balanced    # minimal | balanced | verbose

tts:
  provider: cloud       # cloud（默认）| local
  voice: zh_female_wanwanxiaohe_moon_bigtts
  speed: 1.0
  language: auto        # zh | en | auto
  emotion: true         # 启用 <laugh> <sigh> 等情绪标签

asr:
  provider: cloud       # cloud（默认）| local
  timeout: 60           # 秒

sfx:
  enabled: true
  volume: 80
```

## 环境要求

- **Node.js** >= 18
- **macOS** 或 **Linux**（Windows 部分支持）
- **网络连接**（云端 TTS/ASR，默认模式）
- 可选：~1GB 磁盘空间（本地模型）

## 开发

```bash
git clone https://github.com/launsion-boop/EchoCoding.git
cd echocoding
npm install
npm run build
node dist/bin/echocoding.js install --auto --start
```

运行 `echocoding doctor` 确认开发环境正常。

## 开源协议

MIT
