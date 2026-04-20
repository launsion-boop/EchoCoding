# EchoCoding Awesome Lists PR Playbook

## 目标
把 EchoCoding 提交到高相关的 Claude/Codex/AI Coding awesome lists，按低 spam 风险节奏推进，优先拿下第一梯队。

## 节奏策略
- 每天 `2-3` 个 PR。
- 先发第一梯队 `4` 个仓库。
- 第一梯队至少合并 `1-2` 个后，再开第二梯队。
- 同一作者同一天避免跨太多生态仓库集中发 PR。

## 提交文案（标准版）
> 根据每个仓库现有格式微调标点、换行、是否需要 emoji。

**List 条目**

```md
[EchoCoding](https://github.com/launsion-boop/EchoCoding) by Lopsang —
Make your AI coding agent talk, listen, and feel alive.
Three-layer audio (23 SFX + ambient soundscape + cloud TTS/ASR voice interaction).
Zero config, no API keys. Supports Claude Code, Cursor, Windsurf, Codex CLI, Gemini CLI.
```

**PR 标题**

```text
Add EchoCoding — voice-enabled audio experience for AI coding agents
```

**PR 描述**

```md
EchoCoding adds three layers of audio to AI coding agents:
1. 23 sound effects — automatic hook-triggered
2. Ambient soundscape — continuous typing/reading/thinking audio
3. Voice interaction — cloud TTS + ASR, zero config, no API keys

The AI agent gets `say`, `ask`, and `listen` pipes and decides
when to use them. Works across Claude Code (hooks),
Cursor/Windsurf (MCP), Codex CLI, and Gemini CLI.

GitHub: https://github.com/launsion-boop/EchoCoding
NPM: https://www.npmjs.com/package/echocoding
License: MIT
```

## 第一梯队（优先）
| 仓库 | 目标分类 | 理由 | 状态 |
|---|---|---|---|
| hesreallyhim/awesome-claude-code | Hooks（Claudio 附近） | 最权威 Claude Code curated list | BLOCKED（该仓库要求通过 GitHub 网页 Issue 表单提交，不接受 CLI 自动化） |
| rohitg00/awesome-claude-code-toolkit | Hooks | 有独立 Hooks 且条目密集 | OPEN: https://github.com/rohitg00/awesome-claude-code-toolkit/pull/281 |
| jqueryscript/awesome-claude-code | Tools 或 Hooks | 大型列表、曝光高 | OPEN: https://github.com/jqueryscript/awesome-claude-code/pull/203 |
| ComposioHQ/awesome-claude-plugins | Plugins | EchoCoding 支持 plugin 安装方式 | TODO |

## 第二梯队（跨平台 / Codex）
| 仓库 | 目标分类 | 理由 | 状态 |
|---|---|---|---|
| RoggeOhta/awesome-codex-cli | DX / Hooks / Audio | 150+ Codex 工具 | TODO |
| hashgraph-online/awesome-codex-plugins | Plugins | Codex 插件生态入口 | TODO |
| milisp/awesome-codex-cli | Tools | 另一个 Codex 工具列表 | TODO |

## 第三梯队（泛 AI 编程工具）
| 仓库 | 目标分类 | 理由 | 状态 |
|---|---|---|---|
| bradAGI/awesome-cli-coding-agents | Infrastructure / DX | 终端 AI agent 综合目录 | TODO |
| ai-for-developers/awesome-ai-coding-tools | Developer Tools | 泛 AI 编程工具入口 | TODO |
| gmh5225/awesome-skills | Skills | 跨 Claude/Codex/Gemini skills | TODO |

## 第四梯队（Claude 总表 / Skills）
| 仓库 | 目标分类 | 理由 | 状态 |
|---|---|---|---|
| webfuse-com/awesome-claude | Claude Code Tools | Claude 全生态目录 | TODO |
| travisvn/awesome-claude-skills | Skills | Claude Skills 专门列表 | TODO |
| ComposioHQ/awesome-claude-skills | Skills | 另一个 Skills 列表 | TODO |

## 建议开工顺序（前两天）
- Day 1:
  - hesreallyhim/awesome-claude-code
  - rohitg00/awesome-claude-code-toolkit
- Day 2:
  - jqueryscript/awesome-claude-code
  - ComposioHQ/awesome-claude-plugins

## 今日进展（2026-04-15）
- 已创建 PR:
  - rohitg00/awesome-claude-code-toolkit#281
  - jqueryscript/awesome-claude-code#203
- 特殊处理:
  - hesreallyhim/awesome-claude-code：维护者模板明确要求使用网页 Issue 提交资源推荐，不允许通过 `gh` CLI 自动提交。

## hesreallyhim 仓库手动提交草稿（网页 Issue 表单）
- Title: `[Resource]: EchoCoding`
- Display Name: `EchoCoding`
- Category: `Hooks`
- Sub-Category: `General`
- Primary Link: `https://github.com/launsion-boop/EchoCoding`
- Author Name: `Lopsang`
- Author Link: `https://github.com/launsion-boop`
- License: `MIT`
- Description:
  - `Audio enhancement layer for coding agents with hook-triggered sound effects, ambient soundscape, and optional cloud TTS/ASR voice interaction. Provides say/ask/listen pipes for agent-driven voice workflows. Supports Claude Code hooks and also works with Cursor, Windsurf, Codex CLI, and Gemini CLI.`
- Validate Claims:
  - `Install EchoCoding and run a Claude Code session with hooks enabled. Trigger common lifecycle events (start, think, tool use, completion) and verify that the corresponding audio cues are played automatically.`
- Specific Task(s):
  - `Ask Claude Code to perform a multi-step coding task that includes reading files, editing files, and running commands; confirm that event-driven SFX and ambient audio transitions map to lifecycle stages.`
- Specific Prompt(s):
  - `Implement a small feature end-to-end (edit files + run tests + summarize). Use EchoCoding voice pipes when useful: say key stage transitions, ask for confirmation before risky actions, and listen for spoken user confirmation.`
- Additional Comments:
  - `Voice TTS/ASR uses cloud services when voice interaction is enabled; standard event SFX/ambient behavior does not require API keys. Install and uninstall instructions are documented in the repo README.`

## Agent 标准流程（每个 PR）
1. Fork 目标仓库。
2. 新建分支：`codex/add-echocoding`（若已存在则加日期后缀）。
3. 在对应分类新增 EchoCoding 条目（保持排序规则）。
4. 本地检查 Markdown 格式。
5. Commit：
   - `docs: add EchoCoding to <repo> awesome list`
6. Push 并创建 PR（使用统一标题 + 描述）。
7. 在本表更新状态（`OPEN / MERGED / CHANGES_REQUESTED`）与 PR 链接。

## 质量检查清单
- 分类是否正确（Hooks/Tools/Plugins/Skills）。
- 条目是否遵循仓库原有格式（破折号、句号、大小写、排序）。
- 是否避免营销化措辞（保持事实描述）。
- PR 是否只包含必要改动（通常仅 README）。
- 描述是否包含 GitHub/NPM/License 三要素。
