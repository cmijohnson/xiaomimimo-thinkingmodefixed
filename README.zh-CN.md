# MiMo Claude Code Proxy

一个本地兼容代理，用于让 Claude Code 通过 OpenAI 风格中转稳定接入 Xiaomi MiMo，并在多轮工具调用场景下正确保留 `reasoning_content`。

## 项目背景

MiMo 在思考模式下对多轮 Agent 会话有更严格的上下文要求：

- 多轮对话中开启 thinking / reasoning
- 历史会话里存在工具调用
- 后续请求需要回传完整 assistant 上下文

如果历史 assistant 消息中的 `reasoning_content` 没有被完整回传，MiMo 可能直接返回 `400`，常见报错类似：

```text
Param Incorrect
```

而 Claude Code 当前主要使用 Anthropic 风格的 `/v1/messages` 协议；MiMo 官方文档中对 reasoning 的正确回传示例，则主要基于 OpenAI 风格的 `/v1/chat/completions`，并显式依赖 `reasoning_content` 字段。

这就会导致一个典型兼容性问题：

- Claude Code 发的是 Anthropic 风格消息
- 中转层未必能完整保留 MiMo 所需的 reasoning 上下文
- 一旦进入「thinking + tool call + 多轮」组合场景，就可能报 400

## 这个代理做了什么

这个代理专门用来补上这层协议兼容：

- 接收 Claude Code 发出的 Anthropic 风格 `POST /v1/messages`
- 转换为 OpenAI 风格 `POST /v1/chat/completions`
- 显式开启 MiMo thinking 模式
- 将 MiMo 返回的 `reasoning_content` 映射回 Anthropic 风格 `thinking` 块
- 维护工具调用 / 工具结果在多轮会话中的格式一致性

简化理解就是：

```text
Claude Code
  -> /v1/messages
本地代理
  -> /v1/chat/completions
MiMo / 中转
```

## 适用场景

- 使用 `mimo-v2.5-pro` 或同类 MiMo 模型
- Claude Code 通过中转站接入模型
- 需要开启 thinking / reasoning
- 会频繁使用工具调用
- 在多轮上下文里遇到 `400 Param Incorrect`

## 已验证环境

- 客户端：Claude Code
- 模型：`mimo-v2.5-pro`
- 中转：`http://newai.cmiteam.cn`
- 协议桥接：Anthropic `/v1/messages` -> OpenAI `/v1/chat/completions`

## 项目结构

- `mimo_cc_proxy.js`：主代理脚本
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

将 Claude Code 指向本地代理：

- `ANTHROPIC_BASE_URL=http://127.0.0.1:3456`
- `ANTHROPIC_MODEL=mimo-v2.5-pro`
- `ANTHROPIC_AUTH_TOKEN=你的中转 key`
- `alwaysThinkingEnabled=true`

参考文件：

- `examples/claude-settings.example.json`

### 3. 重启 Claude Code

建议直接新开一个会话，不要继续一个已经出错的旧会话。

## 环境变量

```bash
MIMO_CC_PROXY_HOST=127.0.0.1
MIMO_CC_PROXY_PORT=3456
MIMO_CC_UPSTREAM=http://newai.cmiteam.cn
MIMO_CC_PROXY_TIMEOUT_MS=300000
```

## 协议转换说明

### 请求方向

Claude Code 发来的 Anthropic 风格消息：

- `thinking`
- `text`
- `tool_use`
- `tool_result`

代理会转换为 OpenAI chat completions 所需字段：

- `reasoning_content`
- `content`
- `tool_calls`
- `role: "tool"`

### 返回方向

MiMo 返回的 OpenAI 风格响应里，如果存在：

- `reasoning_content`
- `tool_calls`

代理会重新映射成 Claude Code 更熟悉的 Anthropic 风格：

- `thinking`
- `tool_use`

## 验证方法

### 语法检查

```bash
node --check mimo_cc_proxy.js
```

### 通过代理发送基础请求

```bash
curl -s -X POST http://127.0.0.1:3456/v1/messages \
  -H 'content-type: application/json' \
  -H 'x-api-key: YOUR_RELAY_KEY' \
  -H 'anthropic-version: 2023-06-01' \
  --data '{"model":"mimo-v2.5-pro","max_tokens":16,"messages":[{"role":"user","content":"ping"}]}'
```

## 当前限制

- 当前实现面向非流式 `POST /v1/messages`
- 主要针对 Claude Code + MiMo 的兼容场景
- 并不是一个通用的 Anthropic / OpenAI 双向网关

## 适合放在 Release 里的简介

```text
修复 Claude Code 在接入 Xiaomi MiMo thinking 模式时，多轮工具调用场景下因 reasoning_content 回传不完整导致的 400 Param Incorrect 问题。
```

## 发布前提醒

- 不要提交真实 API key
- 如果你不想公开中转地址，建议把 README 和示例配置里的域名替换为占位符
- 如果准备对外开源，建议补充许可证说明和免责声明
