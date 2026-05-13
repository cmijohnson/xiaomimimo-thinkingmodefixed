# MiMo Claude Code Proxy

一个本地兼容代理，用来让 Claude Code 通过 OpenAI 风格中转稳定接入 Xiaomi MiMo，并正确保留 MiMo 在多轮工具调用场景下要求回传的 `reasoning_content`。

## 这个代理解决什么问题

MiMo 的 thinking 模式对多轮 Agent 会话要求更严格：

- 多轮对话里开启了 thinking
- 历史 assistant 轮次里出现过工具调用
- 后续请求需要把之前 assistant 的完整上下文重新带回去

如果历史 assistant 消息里缺少 `reasoning_content`，上游很容易直接返回：

```text
400 Param Incorrect
```

Claude Code 走的是 Anthropic 风格 `POST /v1/messages`，而 MiMo 官方文档针对 reasoning 回传的示例，核心是 OpenAI 风格 `POST /v1/chat/completions`。

这个代理就是专门补这层协议兼容的。

## 这一版新增能力

- 完整流式桥接：Anthropic SSE <-> OpenAI chat completions stream
- 非流式请求继续支持 JSON 直返
- 新增 `MIMO_CC_THINKING_MODE=on|off`，默认 `on`
- 将 MiMo `reasoning_content` 映射回 Anthropic `thinking` block
- 保留多轮 `tool_use` / `tool_result` 兼容修复
- 新增结构化耗时日志，方便判断卡顿发生在本地代理还是上游

## 已验证目标

- 客户端：Claude Code
- 模型：`mimo-v2.5-pro`
- 中转：`http://newai.cmiteam.cn`

## 环境要求

- Node.js 18+

不需要额外 npm 依赖。

## 项目文件

- `mimo_cc_proxy.js`：主代理脚本
- `README.md`：英文说明
- `README.zh-CN.md`：中文说明
- `examples/claude-settings.example.json`：Claude Code 示例配置
- `examples/proxy.env.example`：代理环境变量示例

## 快速开始

### 1. 启动代理

```bash
node mimo_cc_proxy.js
```

默认监听：

```text
http://127.0.0.1:3456
```

默认上游：

```text
http://newai.cmiteam.cn
```

### 2. 配置 Claude Code

让 Claude Code 指向本地代理：

- `ANTHROPIC_BASE_URL=http://127.0.0.1:3456`
- `ANTHROPIC_MODEL=mimo-v2.5-pro`
- `ANTHROPIC_AUTH_TOKEN=你的中转 key`

参考：

- `examples/claude-settings.example.json`

### 3. 重启 Claude Code

如果你要对比“是否变快”，建议直接开一个新会话，不要继续一个已经很长的旧线程。

## 环境变量

```bash
MIMO_CC_PROXY_HOST=127.0.0.1
MIMO_CC_PROXY_PORT=3456
MIMO_CC_UPSTREAM=http://newai.cmiteam.cn
MIMO_CC_PROXY_TIMEOUT_MS=300000
MIMO_CC_THINKING_MODE=on
```

`MIMO_CC_THINKING_MODE` 说明：

- `on`：默认值，代理会向上游附带 `thinking: { type: "enabled" }`
- `off`：关闭 MiMo thinking，不需要改 Claude Code 配置

## 代理行为说明

### 请求路由

- `POST /v1/messages` -> 转换成 OpenAI 风格 `POST /v1/chat/completions`
- `stream: true` -> 优先走真实流式桥接
- `stream` 关闭或未传 -> 走非流式 JSON 桥接

### 协议字段映射

- Anthropic `thinking` -> OpenAI `reasoning_content`
- Anthropic `text` -> OpenAI `content`
- Anthropic `tool_use` -> OpenAI `tool_calls`
- Anthropic `tool_result` -> OpenAI `role: "tool"`

### 流式降级策略

如果上游收到 `stream: true`，但返回的不是 SSE，而是整包 JSON，代理会把这份 JSON 转成 Anthropic 风格 SSE 继续吐给 Claude Code，避免客户端因为格式不符直接失败。

## 验证命令

### 语法检查

```bash
node --check mimo_cc_proxy.js
```

### 非流式基础请求

```bash
curl -s -X POST http://127.0.0.1:3456/v1/messages \
  -H 'content-type: application/json' \
  -H 'x-api-key: YOUR_RELAY_KEY' \
  -H 'anthropic-version: 2023-06-01' \
  --data '{"model":"mimo-v2.5-pro","max_tokens":32,"messages":[{"role":"user","content":"ping"}]}'
```

### 流式文本验证

```bash
curl -N -X POST http://127.0.0.1:3456/v1/messages \
  -H 'content-type: application/json' \
  -H 'x-api-key: YOUR_RELAY_KEY' \
  -H 'anthropic-version: 2023-06-01' \
  --data '{"model":"mimo-v2.5-pro","max_tokens":64,"stream":true,"messages":[{"role":"user","content":"Reply with one short sentence."}]}'
```

正常应能看到类似顺序：

- `event: message_start`
- `event: content_block_start`
- 一个或多个 `event: content_block_delta`
- `event: content_block_stop`
- `event: message_delta`
- `event: message_stop`

## 故障排查

### 为什么本地还是感觉慢

这版代理解决的是“之前被整包返回卡住、Claude Code 长时间没字出来”的核心问题，但下面两种情况仍然会慢：

- MiMo thinking 本身会增加延迟
- 旧 Claude Code 线程太长，上游上下文本来就重

所以测速和体验对比，最好用新会话做基线。

如果你更在意速度，可以直接这样启动代理：

```bash
MIMO_CC_THINKING_MODE=off node mimo_cc_proxy.js
```

### 如何看日志判断卡在哪

代理会输出类似这样的结构化日志：

```text
[mimo-cc-proxy] {"mode":"stream","thinkingMode":"on","upstreamConnectedMs":123,"firstUpstreamChunkMs":412,"firstAnthropicEventMs":414,"totalMs":1860}
```

可以重点看：

- `mode`：本次是 `stream` 还是 `json`
- `thinkingMode`：当前代理是否开启 thinking
- `upstreamConnectedMs`：连上游并拿到响应头用了多久
- `firstUpstreamChunkMs`：上游第一个 chunk 多久出来
- `firstAnthropicEventMs`：代理第一个 Anthropic SSE 事件多久发出
- `totalMs`：整轮总耗时

如果 `firstUpstreamChunkMs` 本来就很大，慢的主要是上游或模型；如果它很小，但 `firstAnthropicEventMs` 明显更大，才更像是代理本地处理有问题。

## 当前范围

- 主要面向 Claude Code + MiMo 兼容场景，不是通用 Anthropic/OpenAI 网关
- 重点解决 MiMo 在 thinking + tool call + 多轮回传下的兼容问题
- 对外接入方式保持不变：`ANTHROPIC_BASE_URL=http://127.0.0.1:3456`

## 适合作为仓库简介的一句话

```text
让 Claude Code 稳定接入 Xiaomi MiMo，并补齐 reasoning_content 回传、工具调用兼容和 Anthropic 风格流式输出。
```

## 发布前提醒

- 不要提交真实 API key
- 如果不想暴露自己的中转域名，README 和示例配置请自行替换成占位符
- 如果准备长期开源，建议补充 License 和免责声明
