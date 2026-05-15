# MiMo Claude Code Proxy

A local compatibility proxy that lets Claude Code talk to Xiaomi MiMo models through an OpenAI-style relay while preserving MiMo's required `reasoning_content` history.

## What this fixes

MiMo thinking mode is stricter than many Anthropic-compatible clients:

- in multi-turn agent conversations
- when earlier assistant turns used tools
- and later requests replay those assistant turns

MiMo expects the full assistant history, including `reasoning_content`, to be sent back. If that reasoning history is missing, the upstream can return `400 Param Incorrect`.

Claude Code speaks Anthropic-style `POST /v1/messages`, while MiMo documents this behavior around OpenAI-style `POST /v1/chat/completions`.

This proxy bridges the two formats and keeps the missing reasoning/tool context intact.

## What this version adds

- full streaming bridge: Anthropic SSE <-> OpenAI chat completions stream
- non-streaming fallback path for clients that do not request streaming
- `MIMO_CC_THINKING_MODE=on|off`, defaulting to `on`
- local fast path for `POST /v1/messages/count_tokens` so token estimation no longer blocks on upstream
- upstream keep-alive connection pooling for better parallel throughput
- MiMo `reasoning_content` mapped back to Anthropic `thinking` blocks
- tool call / tool result roundtrips preserved across turns
- timing logs for stream mode, first upstream chunk, first emitted Anthropic event, and total time

## Tested target

- Relay: `http://newai.cmiteam.cn`
- Model: `mimo-v2.5-pro`
- Client: Claude Code

## Requirements

- Node.js 18+

No npm dependencies are required.

## Files

- `mimo_cc_proxy.js`: main proxy
- `README.zh-CN.md`: Chinese README
- `examples/claude-settings.example.json`: Claude Code settings example
- `examples/proxy.env.example`: proxy environment example

## Quick start

### 1. Start the proxy

```bash
node mimo_cc_proxy.js
```

By default it listens on `http://127.0.0.1:3456` and forwards to `http://newai.cmiteam.cn`.

### 2. Point Claude Code to the proxy

Use these Claude Code settings:

- `ANTHROPIC_BASE_URL=http://127.0.0.1:3456`
- `ANTHROPIC_MODEL=mimo-v2.5-pro`
- your relay key in `ANTHROPIC_AUTH_TOKEN`

See `examples/claude-settings.example.json`.

### 3. Restart Claude Code

For performance validation, start a fresh conversation instead of resuming a very large old thread.

## Environment variables

```bash
MIMO_CC_PROXY_HOST=127.0.0.1
MIMO_CC_PROXY_PORT=3456
MIMO_CC_UPSTREAM=http://newai.cmiteam.cn
MIMO_CC_PROXY_TIMEOUT_MS=300000
MIMO_CC_PROXY_KEEPALIVE_MS=30000
MIMO_CC_PROXY_MAX_SOCKETS=64
MIMO_CC_THINKING_MODE=on
```

`MIMO_CC_THINKING_MODE` behavior:

- `on`: default, sends `thinking: { type: "enabled" }` upstream
- `off`: disables MiMo thinking without changing Claude Code config
- `MIMO_CC_PROXY_KEEPALIVE_MS`: upstream socket keep-alive duration
- `MIMO_CC_PROXY_MAX_SOCKETS`: max parallel upstream sockets kept in the shared pool

## How the proxy behaves

### Request routing

- `POST /v1/messages` -> translated into OpenAI-style `POST /v1/chat/completions`
- `stream: true` -> real stream bridge when upstream returns SSE
- `stream: false` or omitted -> JSON bridge

### Block mapping

- Anthropic `thinking` -> OpenAI `reasoning_content`
- Anthropic `text` -> OpenAI `content`
- Anthropic `tool_use` -> OpenAI `tool_calls`
- Anthropic `tool_result` -> OpenAI `role: "tool"`

### Stream fallback

If the upstream receives `stream: true` but returns a non-SSE JSON body, the proxy converts that full JSON reply into Anthropic-style SSE so Claude Code still gets a streaming-shaped response.

### Count tokens fast path

`POST /v1/messages/count_tokens` is handled locally with a conservative estimate instead of being forwarded upstream. This removes a major source of parallel slowdowns in Claude Code sessions that frequently preflight token counts.

## Validation commands

### Syntax check

```bash
node --check mimo_cc_proxy.js
```

### Non-streaming ping

```bash
curl -s -X POST http://127.0.0.1:3456/v1/messages \
  -H 'content-type: application/json' \
  -H 'x-api-key: YOUR_RELAY_KEY' \
  -H 'anthropic-version: 2023-06-01' \
  --data '{"model":"mimo-v2.5-pro","max_tokens":32,"messages":[{"role":"user","content":"ping"}]}'
```

### Streaming text check

```bash
curl -N -X POST http://127.0.0.1:3456/v1/messages \
  -H 'content-type: application/json' \
  -H 'x-api-key: YOUR_RELAY_KEY' \
  -H 'anthropic-version: 2023-06-01' \
  --data '{"model":"mimo-v2.5-pro","max_tokens":64,"stream":true,"messages":[{"role":"user","content":"Reply with one short sentence."}]}'
```

Expected shape:

- `event: message_start`
- `event: content_block_start`
- one or more `event: content_block_delta`
- `event: content_block_stop`
- `event: message_delta`
- `event: message_stop`

## Troubleshooting

### Claude Code still feels slow

This proxy removes the biggest local bottleneck when the previous setup forced non-streaming replies, but two things can still make the experience feel slow:

- MiMo thinking mode itself can add latency
- very large old Claude Code threads still take longer because the upstream context is large
- upstream relay rate limits or queueing can still dominate total latency under heavy parallel use

For a fair comparison, validate with a fresh Claude Code conversation.

If you want lower latency, keep the same Claude Code settings and start the proxy with:

```bash
MIMO_CC_THINKING_MODE=off node mimo_cc_proxy.js
```

### How to inspect timing

The proxy writes structured logs like this:

```text
[mimo-cc-proxy] {"mode":"stream","thinkingMode":"on","upstreamConnectedMs":123,"firstUpstreamChunkMs":412,"firstAnthropicEventMs":414,"totalMs":1860}
```

Useful fields:

- `mode`: `stream` or `json`
- `mode: "count_tokens_local"`: local token estimate path, which should return quickly without upstream latency
- `thinkingMode`: `on` or `off`
- `upstreamConnectedMs`: time to upstream response headers
- `firstUpstreamChunkMs`: time to first upstream stream chunk
- `firstAnthropicEventMs`: time to first emitted Anthropic SSE event
- `totalMs`: full request time

## Known scope

- focused on Claude Code + MiMo compatibility, not a general-purpose Anthropic/OpenAI gateway
- optimized for MiMo models that require reasoning replay across tool rounds
- keeps the external Claude Code interface unchanged: `ANTHROPIC_BASE_URL=http://127.0.0.1:3456`

## Suggested repo description

`Local Claude Code proxy for Xiaomi MiMo with reasoning_content replay, tool-call compatibility, and Anthropic SSE streaming`

## Before publishing

- do not commit real API keys
- replace relay placeholders locally if you do not want to expose your relay host
- add a license if you want formal reuse terms
