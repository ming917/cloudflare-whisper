# Whisper on Cloudflare Workers AI

一个基于 Cloudflare Workers AI 的在线音频转写工具，采用“静态前端 + Worker API”结构，便于部署、维护与二次开发。

本项目默认面向个人或小规模使用场景，支持常见音频转写输出，也支持将外语语音内容转换为中文字幕文本。

## 功能概览

- 支持音频转写与字幕生成
- 支持输出 `Raw JSON`、`SRT`、`VTT`、`TXT`
- 支持中文语音转中文
- 支持外语语音保留原文转写
- 支持外语语音转中文
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

Worker 只处理以下四个接口：

- `POST /raw`：返回结构化 JSON 数据
- `POST /srt`：返回 SRT 字幕内容
- `POST /vtt`：返回 VTT 字幕内容
- `POST /txt`：返回纯文本内容

### 请求方式

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

建议：

- 优先上传较短、较小、编码标准的音频文件
- 优先使用 `MP3` 或 `WAV`
- 如遇解码失败，先转换格式再上传
- 如遇资源限制错误，尝试缩短音频时长或降低文件体积

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
run_worker_first = ["/raw", "/srt", "/vtt", "/txt"]
```

### 3. 本地开发

```bash
npm run dev
```

### 4. 部署

```bash
npm run deploy
```
