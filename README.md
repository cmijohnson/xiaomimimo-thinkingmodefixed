# MiMo Claude Code Proxy

A local compatibility proxy for running Claude Code against Xiaomi MiMo models through an OpenAI-style relay while preserving multi-turn `reasoning_content` across tool calls.

## Why this exists

MiMo's recent tool-calling requirement is stricter than many Anthropic-compatible clients expect:

- in multi-turn agent conversations
- when thinking mode is enabled
- and assistant turns contain tool calls

the full assistant turn, including `reasoning_content`, must be sent back on later requests.

Claude Code currently talks to Anthropic-style `/v1/messages`, while MiMo's officially documented behavior is centered on OpenAI-style `/v1/chat/completions` with `reasoning_content`.

This proxy bridges that gap:

- accepts Anthropic-style `POST /v1/messages`
- converts requests to OpenAI-style `POST /v1/chat/completions`
- enables MiMo thinking mode explicitly
- maps MiMo `reasoning_content` back into Anthropic-style `thinking` blocks
- carries tool call / tool result turns across rounds

## Tested target

- Relay: `http://newai.cmiteam.cn`
- Model: `mimo-v2.5-pro`
- Client: Claude Code

## Requirements

- Node.js 18+

No npm dependencies are required.

## Files

- `mimo_cc_proxy.js`: main proxy
- `examples/claude-settings.example.json`: Claude Code settings example
- `examples/proxy.env.example`: proxy environment example

## Quick start

### 1. Start the proxy

```bash
node mimo_cc_proxy.js
```

By default it listens on `http://127.0.0.1:3456` and forwards to `http://newai.cmiteam.cn`.

### 2. Point Claude Code to the proxy

Set Claude Code to use:

- `ANTHROPIC_BASE_URL=http://127.0.0.1:3456`
- `ANTHROPIC_MODEL=mimo-v2.5-pro`
- your existing relay key in `ANTHROPIC_AUTH_TOKEN`

See `examples/claude-settings.example.json`.

### 3. Restart Claude Code

Start a fresh conversation rather than resuming a broken old session.

## Environment variables

```bash
MIMO_CC_PROXY_HOST=127.0.0.1
MIMO_CC_PROXY_PORT=3456
MIMO_CC_UPSTREAM=http://newai.cmiteam.cn
MIMO_CC_PROXY_TIMEOUT_MS=300000
```

## What the proxy translates

### Request path

Claude Code request:

- Anthropic-style `POST /v1/messages`

Proxy forwards as:

- OpenAI-style `POST /v1/chat/completions`

### Assistant message mapping

Anthropic assistant blocks:

- `thinking`
- `text`
- `tool_use`

are converted into OpenAI chat message fields:

- `reasoning_content`
- `content`
- `tool_calls`

### Tool result mapping

Anthropic user-side `tool_result` blocks are converted into:

- OpenAI `role: "tool"`

## Validation commands

### Syntax check

```bash
node --check mimo_cc_proxy.js
```

### Basic ping through the proxy

```bash
curl -s -X POST http://127.0.0.1:3456/v1/messages \
  -H 'content-type: application/json' \
  -H 'x-api-key: YOUR_RELAY_KEY' \
  -H 'anthropic-version: 2023-06-01' \
  --data '{"model":"mimo-v2.5-pro","max_tokens":16,"messages":[{"role":"user","content":"ping"}]}'
```

## Known limitations

- currently built for non-streaming `POST /v1/messages`
- designed for MiMo via OpenAI chat completions, not generic Anthropic upstreams
- only bridges the Claude Code path that mattered for this MiMo fix

## Suggested repo description

`Local Claude Code compatibility proxy for Xiaomi MiMo reasoning_content + tool-call roundtrips`

## Before publishing

- replace example placeholders with your own values locally only
- do not commit real API keys
- add a license file if you want others to reuse it formally
