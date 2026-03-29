# Whisper on Cloudflare Workers AI

一个基于 Cloudflare Workers AI 的在线音频转写工具，采用“静态前端 + Worker API”结构，便于部署、维护与二次开发。

本项目默认面向个人或小规模使用场景，支持常见音频转写输出，也支持将外语语音内容转换为中文字幕文本。

## 功能概览

- 支持音频转写与字幕生成
- 支持输出 `Raw JSON`、`SRT`、`VTT`、`TXT`
- 支持中文语音转中文
- 支持外语语音保留原文转写
- 支持外语语音转中文
- 支持上传 `SRT` / `VTT` 字幕文件后单独翻译为中文
- 支持语言指定、提示词、前缀、VAD、束搜索等高级参数

## 工作模式

页面当前提供以下三种模式：

1. `中文语音转中文`
2. `外语语音保留原文`
3. `外语语音转中文`

其中“外语语音转中文”采用两段式处理：

1. 使用 `@cf/openai/whisper-large-v3-turbo` 进行原语言转写
2. 使用 `@cf/meta/m2m100-1.2b` 将转写文本翻译为中文

这样可以在尽量保留时间轴信息的前提下生成中文结果。

## API 接口

Worker 处理以下五个接口：

- `POST /raw`：返回结构化 JSON 数据
- `POST /srt`：返回 SRT 字幕内容
- `POST /vtt`：返回 VTT 字幕内容
- `POST /txt`：返回纯文本内容
- `POST /subtitle`：上传现有字幕文件并返回翻译后的结构化 JSON 数据

### 音频接口请求方式

- 方法：`POST`
- 请求体：音频文件二进制内容
- 建议的 `Content-Type`：`audio/mpeg`、`audio/wav`、`audio/mp4`、`audio/webm`

说明：

- 推荐优先使用 `MP3` 或 `WAV`
- `M4A`、`MP4`、`WEBM` 等常见格式通常也可尝试
- 实际能否成功解码，仍取决于音频文件内部编码
- 如果解码失败，建议先转为 `MP3` 或 `WAV`

### 查询参数

| 参数名 | 类型 | 说明 |
| --- | --- | --- |
| `task` | string | 可选 `transcribe` 或 `translate` |
| `language` | string | 语言代码，例如 `en`、`zh`、`ja`，留空时自动检测 |
| `vad_filter` | boolean | 是否启用语音活动检测过滤 |
| `initial_prompt` | string | 初始提示词 |
| `prefix` | string | 输出前缀 |
| `beam_size` | integer | 束搜索宽度 |
| `condition_on_previous_text` | boolean | 是否参考上一段文本 |
| `no_speech_threshold` | number | 静音判断阈值 |
| `compression_ratio_threshold` | number | 压缩比过滤阈值 |
| `log_prob_threshold` | number | 低置信度过滤阈值 |
| `hallucination_silence_threshold` | number | 静音抗幻觉阈值 |

### 字幕翻译接口

- 路径：`POST /subtitle`
- 请求体：`SRT` 或 `VTT` 字幕文件文本内容
- 查询参数：

| 参数名 | 类型 | 说明 |
| --- | --- | --- |
| `language` | string | 必填，字幕原语言代码，例如 `en`、`ja`、`ko` |
| `filename` | string | 可选，帮助服务端判断字幕格式 |

## 输出说明

- `Raw JSON`：适合调试、二次开发、保留完整结构化信息
- `SRT`：适合视频剪辑软件或播放器字幕导入
- `VTT`：适合网页视频字幕轨道使用
- `TXT`：适合纯文本整理、摘要与复制

当使用“外语语音转中文”模式时，`/raw` 返回内容中还会包含：

- `response`：最终处理后的结果
- `original_response`：Whisper 原始转写结果
- `translation`：翻译阶段元信息
- `mode`：当前处理模式

## 页面参数说明

当前页面已开放常用与高级参数，主要包括：

- 处理模式选择
- 输出格式选择
- 语言快捷选择与自定义语言输入
- `task`、`language`、`initial_prompt`、`prefix`
- `vad_filter`、`condition_on_previous_text`
- `beam_size`、`no_speech_threshold`、`compression_ratio_threshold`、`log_prob_threshold`、`hallucination_silence_threshold`

同时内置几组推荐预设：

- `标准默认`
- `快速优先`
- `长音频抗重复`
- `嘈杂环境`

## 隐私与安全说明

本项目在文档和代码层面尽量避免暴露不必要的信息，但仍建议在部署和使用时注意以下事项：

- 不要在公开文档中写入真实服务地址、个人域名、内部测试地址或账号信息
- 不要在文档中附带带有个人信息的截图、示例文件或访问记录
- 不要将用户上传音频、转写结果、翻译结果写入持久化存储，除非你明确有此需求并已告知用户
- API 返回已增加 `no-store` 缓存控制，避免中间缓存保留转写内容
- Worker 错误日志已尽量避免直接输出用户音频内容或完整请求对象
- 如果需要公开部署，建议在页面中补充清晰的隐私提示，说明音频会发送到 Cloudflare Workers AI 进行处理

注意：

- 本项目默认不会主动保存上传音频
- 但音频内容会被发送给 Cloudflare Workers AI 模型进行推理
- 因此不建议上传高敏感、强隐私或受严格合规限制的音频内容

## 资源限制说明

Cloudflare Worker 和 Workers AI 都存在平台资源限制。较长音频、较大文件、较高码率音频，或者“外语语音转中文”这类两阶段处理流程，都更容易触发限制。

当前实现已将外语转中文里的字幕段翻译改成分批请求，避免每个 segment 单独触发一次 `env.AI.run()`；这能显著减少子请求数量，但超长音频仍可能接近平台上限。

如果你使用的是 `Workers Free` 账号，建议特别注意下面这些官方限制：

### Workers Free 相关官方限制

| 项目 | 官方限制 | 说明 |
| --- | --- | --- |
| 单次 Worker invocation 子请求数 | `50 / request` | Free 账号最关键的限制之一，超出后会报 `Too many subrequests by single Worker invocation` |
| 单次 HTTP 请求 CPU 时间 | `10 ms` | Free 账号 CPU 时间很短，复杂字幕处理更容易不稳 |
| 内存 | `128 MB` | 每个 isolate 的内存上限 |
| 请求体大小 | `100 MB` | Free / Pro 都是 `100 MB`，这是 Cloudflare plan 限制，不是 Workers plan 限制 |
| Static Assets 单文件大小 | `25 MiB` | 适用于静态资源，不是上传音频本身，但部署资源时也要注意 |
| Workers AI 语音识别速率 | `720 requests/min` | Automatic Speech Recognition |
| Workers AI 翻译速率 | `720 requests/min` | Translation |

补充说明：

- Wrangler 的 `limits.subrequests` 配置虽然存在，但 `Free` 账号最大仍然只能到 `50`
- 官方文档把 Worker 调用 Cloudflare 内部服务也归入 subrequest 范畴；Workers AI 文档没有单独把 `env.AI.run()` 写进这条说明里，但在本项目里应当按消耗内部服务请求预算来保守看待
- 因此在 `Free` 账号上，长字幕或长音频的“转写 + 翻译”流程天然更容易触发平台限制
- 这里的“容易超限”不一定表示文件字节体积大；字幕文件哪怕只有几百 KB，只要段数很多、总文本很多，仍然可能因为单次 Worker invocation 内部处理工作量过高而触发 subrequest 限制

### 本项目的 Free 保守模式

为了尽量兼容当前字幕翻译场景，字幕文件翻译现在默认采用“官方数组批量翻译”模式：

- 服务端会把每条字幕文本作为一个数组项，通过 `@cf/meta/m2m100-1.2b` 的 Batch API 提交
- Worker 先拿到 `request_id`，再轮询 Batch API 结果，最后按返回项索引回填到原字幕段
- 这样可以避免把字幕拼成一大段文本，也能保持字幕段与翻译结果的一一对应

这能提升 Free 账号下的成功率，但代价是：

- 超长字幕仍可能因为 Free 账号的单次 Worker invocation 限制而失败
- 官方 Workers AI Batch API 在提交时要求总 payload 小于 `10 MB`
- Free 账号并不适合稳定处理特别长的双阶段翻译任务

建议：

- 优先上传较短、较小、编码标准的音频文件
- 优先使用 `MP3` 或 `WAV`
- 如遇解码失败，先转换格式再上传
- 如遇资源限制错误，尝试缩短音频时长或降低文件体积
- 若音频较长，先使用“外语语音保留原文”导出 `SRT` / `VTT`，再通过 `/subtitle` 或页面里的“字幕文件翻译”单独翻译
- 若字幕很长，建议先按时长或段数手动拆成多份再上传，Free 账号会更稳

## 项目结构

- `public/index.html`：前端页面
- `public/app.js`：前端交互逻辑
- `public/styles.css`：页面样式
- `index.js`：Worker API 入口与转写处理逻辑
- `wrangler.toml`：Workers 配置文件

## 部署说明

### 1. 安装依赖

```bash
npm install
```

### 2. 配置 Workers AI 绑定

确保 `wrangler.toml` 中已存在：

```toml
[ai]
binding = "AI"
```

同时保留静态资源配置：

```toml
[assets]
directory = "./public"
binding = "ASSETS"
run_worker_first = ["/raw", "/srt", "/vtt", "/txt", "/subtitle"]
```

### 3. 本地开发

```bash
npm run dev
```

### 4. 部署

```bash
npm run deploy
```
