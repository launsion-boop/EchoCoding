# EchoCoding TTS / ASR 接口需求

> 给运维的接口规格说明，请按此提供两个 HTTP 端点

---

## 1. TTS 接口 — `POST /v1/tts`

### 用途
将短文本（通常 < 50 字）合成为语音音频，支持流式返回。

### 请求

```
POST /v1/tts
Content-Type: application/json
Authorization: Bearer <API_KEY>   # 可选，如果需要鉴权
```

```json
{
  "text": "任务完成了，改了 3 个文件",
  "voice": "default",
  "speed": 1.0,
  "language": "auto",
  "stream": true,
  "format": "mp3"
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `text` | string | 是 | 要合成的文本，通常 1-50 字，最长 200 字 |
| `voice` | string | 否 | 音色 ID，默认 `"default"`。后续需要支持多音色（Multi-Agent 场景每个 agent 不同声音） |
| `speed` | number | 否 | 语速倍率，默认 `1.0`，范围 `0.5-2.0` |
| `language` | string | 否 | `"zh"` / `"en"` / `"auto"`（自动检测），默认 `"auto"` |
| `stream` | boolean | 否 | `true` = 流式返回（边生成边传输），`false` = 等全部生成完再返回。默认 `true` |
| `format` | string | 否 | 音频格式：`"mp3"` / `"wav"` / `"pcm"`，默认 `"mp3"` |

### 响应

#### 流式模式 (`stream: true`)

```
HTTP/1.1 200 OK
Content-Type: audio/mpeg
Transfer-Encoding: chunked
```

直接返回音频二进制流（chunked transfer），客户端边收边写文件边播放。

#### 非流式模式 (`stream: false`)

```
HTTP/1.1 200 OK
Content-Type: audio/mpeg
Content-Length: 12345
```

返回完整音频文件的二进制内容。

#### 错误

```json
{
  "error": {
    "code": "rate_limited",
    "message": "请求过于频繁，请稍后再试"
  }
}
```

### 性能要求

| 指标 | 目标 |
|------|------|
| 首字节延迟（流式） | < 300ms |
| 完整延迟（非流式，20 字） | < 500ms |
| 高频短句缓存 | 支持。相同 text+voice+speed 重复请求应命中缓存，接近 0ms |
| 并发 | 单用户至少支持 2 并发请求（Multi-Agent 场景） |

### 调用量预估

- 典型 coding session：50-200 次 TTS 调用 / 小时
- 每次文本长度：5-50 字（平均 20 字）
- 峰值：连续 5 秒内最多 3-5 次调用

---

## 2. ASR 接口 — `POST /v1/asr`

### 用途
将用户的短语音（通常 1-10 秒）识别为文本。

### 请求

```
POST /v1/asr
Content-Type: multipart/form-data
Authorization: Bearer <API_KEY>   # 可选
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `audio` | file | 是 | 音频文件，支持 `wav` / `mp3` / `webm`，最大 30 秒 |
| `language` | string | 否 | `"zh"` / `"en"` / `"auto"`，默认 `"auto"` |
| `hotwords` | string | 否 | 热词列表（逗号分隔），提高特定词的识别率。如 `"确认,取消,继续,方案A,方案B"` |

### 响应

```json
{
  "text": "好的，选方案 A",
  "language": "zh",
  "duration": 2.3,
  "confidence": 0.95
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `text` | string | 识别结果文本 |
| `language` | string | 检测到的语言 |
| `duration` | number | 音频时长（秒） |
| `confidence` | number | 置信度 0-1 |

### 性能要求

| 指标 | 目标 |
|------|------|
| 识别延迟（5 秒音频） | < 1s |
| 短句识别准确率（中文） | > 95%（热词场景 > 98%） |
| 短句识别准确率（英文） | > 95% |

### 调用量预估

- 典型 coding session：5-20 次 ASR 调用 / 小时（远低于 TTS）
- 每次音频长度：1-10 秒（平均 3 秒）

---

## 3. 可选：音色列表接口 — `GET /v1/voices`

### 用途
获取可用音色列表（用于 Multi-Agent 自动分配不同声音）。

### 响应

```json
{
  "voices": [
    { "id": "default", "name": "默认", "language": ["zh", "en"], "gender": "female" },
    { "id": "male_1", "name": "男声1", "language": ["zh", "en"], "gender": "male" },
    { "id": "female_2", "name": "女声2", "language": ["zh", "en"], "gender": "female" }
  ]
}
```

---

## 4. 鉴权方式

建议以下任一方式：
- **API Key**：`Authorization: Bearer <key>`（最简单）
- **设备指纹**：客户端生成机器唯一 ID，首次自动注册，防脚本滥用

EchoCoding 客户端会把 API Key 存在 `~/.echocoding/config.yaml` 中。如果能做到零配置（内置默认 key 或设备自动注册），用户体验最佳。

---

## 5. 端点地址

请提供：
```
TTS:    https://api.echoclaw.com/v1/tts
ASR:    https://api.echoclaw.com/v1/asr
Voices: https://api.echoclaw.com/v1/voices  (可选)
```
