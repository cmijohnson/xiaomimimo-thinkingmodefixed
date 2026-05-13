#!/usr/bin/env node

const http = require("node:http");
const https = require("node:https");
const crypto = require("node:crypto");
const { URL } = require("node:url");

const LISTEN_HOST = process.env.MIMO_CC_PROXY_HOST || "127.0.0.1";
const LISTEN_PORT = Number(process.env.MIMO_CC_PROXY_PORT || "3456");
const UPSTREAM_BASE_URL =
  process.env.MIMO_CC_UPSTREAM || "http://newai.cmiteam.cn";
const REQUEST_TIMEOUT_MS = Number(
  process.env.MIMO_CC_PROXY_TIMEOUT_MS || "300000",
);
const DEFAULT_THINKING_MODE = "on";
const SSE_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
  "x-accel-buffering": "no",
};
const BLOCK_CHUNK_SIZE = 96;

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sendJson(res, statusCode, payload, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(payload), "utf-8");
  res.writeHead(statusCode, {
    "content-type": "application/json",
    "content-length": body.length,
    ...extraHeaders,
  });
  res.end(body);
}

function cloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function copyHeaders(headers) {
  const nextHeaders = { ...headers };
  delete nextHeaders.host;
  delete nextHeaders["content-length"];
  return nextHeaders;
}

function blocksFromContent(content) {
  if (Array.isArray(content)) {
    return cloneJson(content);
  }

  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }

  return [];
}

function blockText(block) {
  if (!block || typeof block !== "object") {
    return "";
  }

  if (typeof block.text === "string") {
    return block.text;
  }

  if (typeof block.thinking === "string") {
    return block.thinking;
  }

  if (typeof block.content === "string") {
    return block.content;
  }

  return "";
}

function textFromAnthropicContent(content) {
  const blocks = blocksFromContent(content);
  return blocks
    .map((block) => blockText(block))
    .filter(Boolean)
    .join("\n");
}

function mergeAssistantGroup(group) {
  const merged = cloneJson(group[0]) || { role: "assistant" };
  merged.role = "assistant";
  merged.content = [];

  for (const message of group) {
    merged.content.push(...blocksFromContent(message.content));
  }

  return merged;
}

function collapseConsecutiveAssistantMessages(messages) {
  const result = [];
  let mergedGroups = 0;

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];

    if (!message || message.role !== "assistant") {
      result.push(cloneJson(message));
      continue;
    }

    const group = [message];
    while (
      index + 1 < messages.length &&
      messages[index + 1] &&
      messages[index + 1].role === "assistant"
    ) {
      index += 1;
      group.push(messages[index]);
    }

    if (group.length === 1) {
      result.push(cloneJson(group[0]));
      continue;
    }

    mergedGroups += 1;
    result.push(mergeAssistantGroup(group));
  }

  return {
    messages: result,
    mergedGroups,
  };
}

function anthropicSystemToOpenAI(body) {
  const messages = [];

  if (body.system == null) {
    return messages;
  }

  const text = textFromAnthropicContent(body.system);
  if (text) {
    messages.push({
      role: "system",
      content: text,
    });
  }

  return messages;
}

function anthropicAssistantToOpenAI(message) {
  const blocks = blocksFromContent(message.content);
  const reasoningParts = [];
  const textParts = [];
  const toolCalls = [];

  for (const block of blocks) {
    if (!block || typeof block !== "object") {
      continue;
    }

    if (block.type === "thinking") {
      if (block.thinking) {
        reasoningParts.push(block.thinking);
      }
      continue;
    }

    if (block.type === "text") {
      if (block.text) {
        textParts.push(block.text);
      }
      continue;
    }

    if (block.type === "tool_use") {
      toolCalls.push({
        id:
          block.id ||
          `call_${crypto.randomBytes(12).toString("hex").slice(0, 24)}`,
        type: "function",
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input || {}),
        },
      });
    }
  }

  const assistant = {
    role: "assistant",
    content: textParts.join("\n"),
  };

  if (reasoningParts.length > 0) {
    assistant.reasoning_content = reasoningParts.join("\n");
  }

  if (toolCalls.length > 0) {
    assistant.tool_calls = toolCalls;
  }

  return assistant;
}

function anthropicUserToOpenAI(message) {
  const blocks = blocksFromContent(message.content);
  const result = [];
  let pendingText = [];

  function flushPendingText() {
    const text = pendingText.join("\n").trim();
    if (text) {
      result.push({
        role: "user",
        content: text,
      });
    }
    pendingText = [];
  }

  for (const block of blocks) {
    if (!block || typeof block !== "object") {
      continue;
    }

    if (block.type === "tool_result") {
      flushPendingText();
      result.push({
        role: "tool",
        tool_call_id: block.tool_use_id,
        content: textFromAnthropicContent(block.content),
      });
      continue;
    }

    const text = blockText(block);
    if (text) {
      pendingText.push(text);
    }
  }

  flushPendingText();
  return result;
}

function anthropicToolsToOpenAI(tools) {
  if (!Array.isArray(tools) || tools.length === 0) {
    return undefined;
  }

  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description || "",
      parameters: cloneJson(tool.input_schema || { type: "object" }),
    },
  }));
}

function anthropicToolChoiceToOpenAI(toolChoice) {
  if (!toolChoice || typeof toolChoice !== "object") {
    return undefined;
  }

  if (toolChoice.type === "auto") {
    return "auto";
  }

  if (toolChoice.type === "any") {
    return "required";
  }

  if (toolChoice.type === "tool" && toolChoice.name) {
    return {
      type: "function",
      function: {
        name: toolChoice.name,
      },
    };
  }

  return undefined;
}

function getThinkingModeSetting() {
  const raw = String(
    process.env.MIMO_CC_THINKING_MODE || DEFAULT_THINKING_MODE,
  ).trim();
  return raw.toLowerCase() === "off" ? "off" : "on";
}

function isThinkingEnabled() {
  return getThinkingModeSetting() === "on";
}

function anthropicRequestToOpenAI(body) {
  const { messages, mergedGroups } = collapseConsecutiveAssistantMessages(
    Array.isArray(body.messages) ? body.messages : [],
  );

  const openAIMessages = [...anthropicSystemToOpenAI(body)];

  for (const message of messages) {
    if (!message || typeof message !== "object") {
      continue;
    }

    if (message.role === "assistant") {
      openAIMessages.push(anthropicAssistantToOpenAI(message));
      continue;
    }

    if (message.role === "user") {
      openAIMessages.push(...anthropicUserToOpenAI(message));
      continue;
    }
  }

  const requestBody = {
    model: body.model,
    messages: openAIMessages,
    max_tokens: body.max_tokens,
    temperature: body.temperature,
    top_p: body.top_p,
    presence_penalty: body.presence_penalty,
    frequency_penalty: body.frequency_penalty,
    stream: body.stream === true,
  };

  if (isThinkingEnabled()) {
    requestBody.thinking = {
      type: "enabled",
    };
  }

  const tools = anthropicToolsToOpenAI(body.tools);
  if (tools) {
    requestBody.tools = tools;
  }

  const toolChoice = anthropicToolChoiceToOpenAI(body.tool_choice);
  if (toolChoice) {
    requestBody.tool_choice = toolChoice;
  }

  return {
    requestBody,
    mergedGroups,
  };
}

function parseToolArguments(args) {
  if (typeof args !== "string") {
    return args || {};
  }

  try {
    return JSON.parse(args);
  } catch {
    return { raw: args };
  }
}

function mapFinishReason(reason) {
  if (reason === "tool_calls") {
    return "tool_use";
  }

  if (reason === "length") {
    return "max_tokens";
  }

  return "end_turn";
}

function buildAnthropicUsageFromOpenAIUsage(usage) {
  const promptDetails = usage?.prompt_tokens_details || {};
  return {
    input_tokens: usage?.prompt_tokens || 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: promptDetails.cached_tokens || 0,
    output_tokens: usage?.completion_tokens || 0,
  };
}

function openAIResponseToAnthropic(upstreamJson) {
  const choice = upstreamJson?.choices?.[0];
  const message = choice?.message || {};
  const blocks = [];

  if (message.reasoning_content) {
    blocks.push({
      type: "thinking",
      thinking: message.reasoning_content,
      signature: "",
    });
  }

  if (typeof message.content === "string" && message.content.length > 0) {
    blocks.push({
      type: "text",
      text: message.content,
    });
  }

  if (Array.isArray(message.tool_calls)) {
    for (const toolCall of message.tool_calls) {
      blocks.push({
        type: "tool_use",
        id:
          toolCall.id ||
          `call_${crypto.randomBytes(12).toString("hex").slice(0, 24)}`,
        name: toolCall.function?.name || "tool",
        input: parseToolArguments(toolCall.function?.arguments),
      });
    }
  }

  return {
    id:
      upstreamJson.id ||
      `msg_${crypto.randomBytes(12).toString("hex").slice(0, 24)}`,
    type: "message",
    role: "assistant",
    content: blocks,
    stop_reason: mapFinishReason(choice?.finish_reason),
    model: upstreamJson.model,
    usage: buildAnthropicUsageFromOpenAIUsage(upstreamJson?.usage),
  };
}

function resolveUpstreamHeaders(clientHeaders) {
  const headers = {
    "content-type": "application/json",
  };

  const authHeader = clientHeaders.authorization;
  const apiKeyHeader = clientHeaders["x-api-key"];

  if (authHeader) {
    headers.authorization = authHeader;
  } else if (apiKeyHeader) {
    headers.authorization = `Bearer ${apiKeyHeader}`;
  }

  return headers;
}

function requestUpstreamJson(upstreamUrl, method, headers, bodyBuffer) {
  return new Promise((resolve, reject) => {
    const transport = upstreamUrl.protocol === "https:" ? https : http;
    const req = transport.request(
      {
        protocol: upstreamUrl.protocol,
        hostname: upstreamUrl.hostname,
        port: upstreamUrl.port || undefined,
        method,
        path: `${upstreamUrl.pathname}${upstreamUrl.search}`,
        headers: {
          ...headers,
          "content-length": Buffer.byteLength(bodyBuffer),
        },
        timeout: REQUEST_TIMEOUT_MS,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const responseBody = Buffer.concat(chunks);
          const text = responseBody.toString("utf-8");
          let json;

          try {
            json = JSON.parse(text);
          } catch {
            json = null;
          }

          resolve({
            statusCode: res.statusCode || 502,
            headers: res.headers,
            text,
            json,
          });
        });
      },
    );

    req.on("timeout", () => req.destroy(new Error("upstream timeout")));
    req.on("error", reject);
    req.end(bodyBuffer);
  });
}

function createRequestLogContext(mode, requestPath, mergedGroups) {
  return {
    mode,
    path: requestPath,
    thinkingMode: getThinkingModeSetting(),
    mergedGroups,
    startedAt: Date.now(),
    upstreamStatus: null,
    upstreamConnectedMs: null,
    firstUpstreamChunkMs: null,
    firstAnthropicEventMs: null,
    fallbackMode: "none",
  };
}

function elapsedMs(context) {
  return Date.now() - context.startedAt;
}

function markOnce(context, key) {
  if (context[key] == null) {
    context[key] = elapsedMs(context);
  }
}

function logRequestSummary(context, extra = {}) {
  console.error(
    `[mimo-cc-proxy] ${JSON.stringify({
      mode: context.mode,
      path: context.path,
      thinkingMode: context.thinkingMode,
      mergedGroups: context.mergedGroups,
      fallbackMode: context.fallbackMode,
      upstreamStatus: context.upstreamStatus,
      upstreamConnectedMs: context.upstreamConnectedMs,
      firstUpstreamChunkMs: context.firstUpstreamChunkMs,
      firstAnthropicEventMs: context.firstAnthropicEventMs,
      totalMs: elapsedMs(context),
      ...extra,
    })}`,
  );
}

function startAnthropicSseResponse(res) {
  res.writeHead(200, {
    ...SSE_HEADERS,
    "x-mimo-cc-proxy": "anthropic-openai-chat-bridge",
  });
  if (typeof res.flushHeaders === "function") {
    res.flushHeaders();
  }
  if (res.socket && typeof res.socket.setNoDelay === "function") {
    res.socket.setNoDelay(true);
  }
}

function writeSseEvent(res, event, payload, context) {
  markOnce(context, "firstAnthropicEventMs");
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function closeStreamWithSseError(res, context, type, message) {
  if (res.writableEnded || res.destroyed) {
    return;
  }

  if (!res.headersSent) {
    sendJson(res, 502, {
      error: {
        type,
        message,
      },
    });
    return;
  }

  writeSseEvent(
    res,
    "error",
    {
      type: "error",
      error: {
        type,
        message,
      },
    },
    context,
  );
  res.end();
}

function createSseParser(onEvent) {
  let buffer = "";

  function parseRawEvent(rawEvent) {
    const lines = rawEvent.split(/\r?\n/);
    let eventName = "message";
    const dataLines = [];

    for (const line of lines) {
      if (!line || line.startsWith(":")) {
        continue;
      }

      if (line.startsWith("event:")) {
        eventName = line.slice(6).trim();
        continue;
      }

      if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trimStart());
      }
    }

    if (dataLines.length === 0) {
      return;
    }

    const dataText = dataLines.join("\n");
    onEvent(eventName, dataText);
  }

  return {
    push(chunk) {
      buffer += chunk;
      let boundaryIndex = buffer.search(/\r?\n\r?\n/);

      while (boundaryIndex !== -1) {
        const rawEvent = buffer.slice(0, boundaryIndex);
        const separator = buffer[boundaryIndex] === "\r" ? 4 : 2;
        buffer = buffer.slice(boundaryIndex + separator);
        parseRawEvent(rawEvent);
        boundaryIndex = buffer.search(/\r?\n\r?\n/);
      }
    },
    flush() {
      if (buffer.trim()) {
        parseRawEvent(buffer);
      }
      buffer = "";
    },
  };
}

function splitIntoChunks(value, size = BLOCK_CHUNK_SIZE) {
  if (!value) {
    return [];
  }

  const text = String(value);
  const parts = [];

  for (let index = 0; index < text.length; index += size) {
    parts.push(text.slice(index, index + size));
  }

  return parts;
}

function createToolBlock(upstreamIndex, anthropicIndex) {
  return {
    kind: "tool_use",
    upstreamIndex,
    anthropicIndex,
    id: null,
    name: null,
    inputJson: "",
    pendingInputJson: "",
    started: false,
    stopped: false,
  };
}

function createAnthropicStreamState(requestBody) {
  return {
    messageId: `msg_proxy_${crypto.randomBytes(12).toString("hex").slice(0, 24)}`,
    model: requestBody.model,
    usage: buildAnthropicUsageFromOpenAIUsage(),
    stopReason: null,
    messageStarted: false,
    currentBlockIndex: null,
    blockSequence: [],
    nextBlockIndex: 0,
    thinkingBlock: null,
    textBlock: null,
    toolBlocksByUpstreamIndex: new Map(),
  };
}

function ensureMessageStart(res, state, context) {
  if (state.messageStarted) {
    return;
  }

  state.messageStarted = true;
  writeSseEvent(
    res,
    "message_start",
    {
      type: "message_start",
      message: {
        id: state.messageId,
        type: "message",
        role: "assistant",
        model: state.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: state.usage,
      },
    },
    context,
  );
}

function closeCurrentBlock(res, state, context) {
  if (state.currentBlockIndex == null) {
    return;
  }

  writeSseEvent(
    res,
    "content_block_stop",
    {
      type: "content_block_stop",
      index: state.currentBlockIndex,
    },
    context,
  );
  const block = state.blockSequence[state.currentBlockIndex];
  if (block) {
    block.stopped = true;
  }
  state.currentBlockIndex = null;
}

function startBlockIfNeeded(res, state, block, context) {
  ensureMessageStart(res, state, context);

  if (block.started) {
    if (state.currentBlockIndex !== block.anthropicIndex) {
      closeCurrentBlock(res, state, context);
      block.stopped = false;
      state.currentBlockIndex = block.anthropicIndex;
    }
    return;
  }

  closeCurrentBlock(res, state, context);

  let contentBlock;
  if (block.kind === "thinking") {
    contentBlock = {
      type: "thinking",
      thinking: "",
      signature: "",
    };
  } else if (block.kind === "text") {
    contentBlock = {
      type: "text",
      text: "",
    };
  } else {
    contentBlock = {
      type: "tool_use",
      id: block.id,
      name: block.name || "tool",
      input: {},
    };
  }

  block.started = true;
  block.stopped = false;
  state.currentBlockIndex = block.anthropicIndex;

  writeSseEvent(
    res,
    "content_block_start",
    {
      type: "content_block_start",
      index: block.anthropicIndex,
      content_block: contentBlock,
    },
    context,
  );
}

function ensureThinkingBlock(state) {
  if (!state.thinkingBlock) {
    state.thinkingBlock = {
      kind: "thinking",
      anthropicIndex: state.nextBlockIndex,
      started: false,
      stopped: false,
      value: "",
    };
    state.blockSequence[state.nextBlockIndex] = state.thinkingBlock;
    state.nextBlockIndex += 1;
  }

  return state.thinkingBlock;
}

function ensureTextBlock(state) {
  if (!state.textBlock) {
    state.textBlock = {
      kind: "text",
      anthropicIndex: state.nextBlockIndex,
      started: false,
      stopped: false,
      value: "",
    };
    state.blockSequence[state.nextBlockIndex] = state.textBlock;
    state.nextBlockIndex += 1;
  }

  return state.textBlock;
}

function ensureToolBlock(state, upstreamIndex) {
  if (!state.toolBlocksByUpstreamIndex.has(upstreamIndex)) {
    const block = createToolBlock(upstreamIndex, state.nextBlockIndex);
    state.toolBlocksByUpstreamIndex.set(upstreamIndex, block);
    state.blockSequence[state.nextBlockIndex] = block;
    state.nextBlockIndex += 1;
  }

  return state.toolBlocksByUpstreamIndex.get(upstreamIndex);
}

function emitThinkingDelta(res, state, context, value) {
  if (!value) {
    return;
  }

  const block = ensureThinkingBlock(state);
  startBlockIfNeeded(res, state, block, context);
  block.value += value;
  writeSseEvent(
    res,
    "content_block_delta",
    {
      type: "content_block_delta",
      index: block.anthropicIndex,
      delta: {
        type: "thinking_delta",
        thinking: value,
      },
    },
    context,
  );
}

function emitTextDelta(res, state, context, value) {
  if (!value) {
    return;
  }

  const block = ensureTextBlock(state);
  startBlockIfNeeded(res, state, block, context);
  block.value += value;
  writeSseEvent(
    res,
    "content_block_delta",
    {
      type: "content_block_delta",
      index: block.anthropicIndex,
      delta: {
        type: "text_delta",
        text: value,
      },
    },
    context,
  );
}

function flushToolInputDelta(res, state, block, context) {
  if (!block.pendingInputJson) {
    return;
  }

  startBlockIfNeeded(res, state, block, context);
  writeSseEvent(
    res,
    "content_block_delta",
    {
      type: "content_block_delta",
      index: block.anthropicIndex,
      delta: {
        type: "input_json_delta",
        partial_json: block.pendingInputJson,
      },
    },
    context,
  );
  block.inputJson += block.pendingInputJson;
  block.pendingInputJson = "";
}

function updateToolBlockFromOpenAI(res, state, context, delta) {
  const upstreamIndex = Number.isInteger(delta?.index) ? delta.index : 0;
  const block = ensureToolBlock(state, upstreamIndex);

  if (delta?.id) {
    block.id = delta.id;
  }

  if (delta?.function?.name) {
    block.name = delta.function.name;
  }

  if (typeof delta?.function?.arguments === "string") {
    block.pendingInputJson += delta.function.arguments;
  }

  if (!block.started && (block.name || block.pendingInputJson)) {
    if (!block.id) {
      block.id = `call_${crypto.randomBytes(12).toString("hex").slice(0, 24)}`;
    }
    if (!block.name) {
      block.name = "tool";
    }
    startBlockIfNeeded(res, state, block, context);
  }

  if (block.started) {
    flushToolInputDelta(res, state, block, context);
  }
}

function updateUsageFromOpenAIPayload(state, payload) {
  if (!payload || typeof payload !== "object") {
    return;
  }

  if (payload.id) {
    state.messageId = payload.id;
  }

  if (payload.model) {
    state.model = payload.model;
  }

  if (payload.usage) {
    state.usage = buildAnthropicUsageFromOpenAIUsage(payload.usage);
  }
}

function finalizePendingToolBlocks(res, state, context) {
  const blocks = [...state.toolBlocksByUpstreamIndex.values()].sort(
    (left, right) => left.anthropicIndex - right.anthropicIndex,
  );

  for (const block of blocks) {
    if (!block.started && (block.name || block.pendingInputJson)) {
      if (!block.id) {
        block.id = `call_${crypto.randomBytes(12).toString("hex").slice(0, 24)}`;
      }
      if (!block.name) {
        block.name = "tool";
      }
      startBlockIfNeeded(res, state, block, context);
      flushToolInputDelta(res, state, block, context);
    }
  }
}

function emitMessageStop(res, state, context) {
  ensureMessageStart(res, state, context);
  finalizePendingToolBlocks(res, state, context);
  closeCurrentBlock(res, state, context);
  writeSseEvent(
    res,
    "message_delta",
    {
      type: "message_delta",
      delta: {
        stop_reason: mapFinishReason(state.stopReason),
        stop_sequence: null,
      },
      usage: {
        output_tokens: state.usage.output_tokens,
      },
    },
    context,
  );
  writeSseEvent(
    res,
    "message_stop",
    {
      type: "message_stop",
    },
    context,
  );
}

function applyOpenAIStreamChunk(res, state, context, payload) {
  updateUsageFromOpenAIPayload(state, payload);

  const choice = payload?.choices?.[0];
  if (!choice) {
    return;
  }

  const delta = choice.delta || {};

  if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
    emitThinkingDelta(res, state, context, delta.reasoning_content);
  }

  if (typeof delta.content === "string" && delta.content) {
    emitTextDelta(res, state, context, delta.content);
  }

  if (Array.isArray(delta.tool_calls)) {
    for (const toolDelta of delta.tool_calls) {
      updateToolBlockFromOpenAI(res, state, context, toolDelta);
    }
  }

  if (choice.finish_reason) {
    state.stopReason = choice.finish_reason;
  }
}

function emitPseudoDelta(res, event, payload, context) {
  writeSseEvent(res, event, payload, context);
}

function emitPseudoAnthropicStreamFromMessage(res, anthropicMessage, context) {
  const state = {
    messageId: anthropicMessage.id,
    model: anthropicMessage.model,
    usage: anthropicMessage.usage || buildAnthropicUsageFromOpenAIUsage(),
    stopReason: anthropicMessage.stop_reason,
    messageStarted: false,
    currentBlockIndex: null,
    blockSequence: [],
    nextBlockIndex: 0,
    thinkingBlock: null,
    textBlock: null,
    toolBlocksByUpstreamIndex: new Map(),
  };

  ensureMessageStart(res, state, context);

  let blockIndex = 0;
  for (const block of anthropicMessage.content || []) {
    if (block.type === "thinking") {
      const streamBlock = {
        kind: "thinking",
        anthropicIndex: blockIndex,
        started: false,
        stopped: false,
        value: "",
      };
      state.blockSequence[blockIndex] = streamBlock;
      startBlockIfNeeded(res, state, streamBlock, context);
      for (const part of splitIntoChunks(block.thinking)) {
        emitPseudoDelta(
          res,
          "content_block_delta",
          {
            type: "content_block_delta",
            index: blockIndex,
            delta: {
              type: "thinking_delta",
              thinking: part,
            },
          },
          context,
        );
      }
      closeCurrentBlock(res, state, context);
      blockIndex += 1;
      continue;
    }

    if (block.type === "text") {
      const streamBlock = {
        kind: "text",
        anthropicIndex: blockIndex,
        started: false,
        stopped: false,
        value: "",
      };
      state.blockSequence[blockIndex] = streamBlock;
      startBlockIfNeeded(res, state, streamBlock, context);
      for (const part of splitIntoChunks(block.text)) {
        emitPseudoDelta(
          res,
          "content_block_delta",
          {
            type: "content_block_delta",
            index: blockIndex,
            delta: {
              type: "text_delta",
              text: part,
            },
          },
          context,
        );
      }
      closeCurrentBlock(res, state, context);
      blockIndex += 1;
      continue;
    }

    if (block.type === "tool_use") {
      const streamBlock = {
        kind: "tool_use",
        anthropicIndex: blockIndex,
        started: false,
        stopped: false,
        id:
          block.id ||
          `call_${crypto.randomBytes(12).toString("hex").slice(0, 24)}`,
        name: block.name || "tool",
      };
      state.blockSequence[blockIndex] = streamBlock;
      startBlockIfNeeded(res, state, streamBlock, context);
      const serializedInput =
        block.input && Object.keys(block.input).length > 0
          ? JSON.stringify(block.input)
          : "";
      for (const part of splitIntoChunks(serializedInput)) {
        emitPseudoDelta(
          res,
          "content_block_delta",
          {
            type: "content_block_delta",
            index: blockIndex,
            delta: {
              type: "input_json_delta",
              partial_json: part,
            },
          },
          context,
        );
      }
      closeCurrentBlock(res, state, context);
      blockIndex += 1;
    }
  }

  emitPseudoDelta(
    res,
    "message_delta",
    {
      type: "message_delta",
      delta: {
        stop_reason: anthropicMessage.stop_reason,
        stop_sequence: null,
      },
      usage: {
        output_tokens: anthropicMessage.usage?.output_tokens || 0,
      },
    },
    context,
  );
  emitPseudoDelta(
    res,
    "message_stop",
    {
      type: "message_stop",
    },
    context,
  );
}

function collectStreamResponse(res) {
  return new Promise((resolve) => {
    const chunks = [];
    res.on("data", (chunk) => chunks.push(chunk));
    res.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf-8");
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
      resolve({
        statusCode: res.statusCode || 502,
        headers: res.headers,
        text,
        json,
      });
    });
  });
}

async function handleAnthropicMessagesJson(
  clientReq,
  clientRes,
  requestBody,
  context,
) {
  const upstreamUrl = new URL("/v1/chat/completions", UPSTREAM_BASE_URL);
  const upstreamBody = Buffer.from(JSON.stringify(requestBody), "utf-8");
  const upstream = await requestUpstreamJson(
    upstreamUrl,
    "POST",
    resolveUpstreamHeaders(clientReq.headers),
    upstreamBody,
  );

  context.upstreamStatus = upstream.statusCode;
  markOnce(context, "upstreamConnectedMs");
  markOnce(context, "firstUpstreamChunkMs");

  if (upstream.statusCode < 200 || upstream.statusCode >= 300 || !upstream.json) {
    clientRes.writeHead(upstream.statusCode, {
      "content-type":
        upstream.headers["content-type"] || "application/json; charset=utf-8",
    });
    clientRes.end(upstream.text);
    logRequestSummary(context, { result: "upstream_error" });
    return;
  }

  const anthropicResponse = openAIResponseToAnthropic(upstream.json);
  sendJson(clientRes, 200, anthropicResponse, {
    "x-mimo-cc-proxy": "anthropic-openai-chat-bridge",
  });
  logRequestSummary(context, { result: "ok" });
}

async function handleAnthropicMessagesStream(
  clientReq,
  clientRes,
  requestBody,
  context,
) {
  const upstreamUrl = new URL("/v1/chat/completions", UPSTREAM_BASE_URL);
  const upstreamBody = Buffer.from(JSON.stringify(requestBody), "utf-8");
  const transport = upstreamUrl.protocol === "https:" ? https : http;
  const upstreamReq = transport.request(
    {
      protocol: upstreamUrl.protocol,
      hostname: upstreamUrl.hostname,
      port: upstreamUrl.port || undefined,
      method: "POST",
      path: `${upstreamUrl.pathname}${upstreamUrl.search}`,
      headers: {
        ...resolveUpstreamHeaders(clientReq.headers),
        "content-length": Buffer.byteLength(upstreamBody),
      },
      timeout: REQUEST_TIMEOUT_MS,
    },
    async (upstreamRes) => {
      let streamFailed = false;

      function failStream(type, message, result) {
        if (streamFailed) {
          return;
        }

        streamFailed = true;
        closeStreamWithSseError(clientRes, context, type, message);
        logRequestSummary(context, {
          result,
          error: message,
        });
      }

      context.upstreamStatus = upstreamRes.statusCode || 502;
      markOnce(context, "upstreamConnectedMs");

      if (
        (upstreamRes.statusCode || 502) < 200 ||
        (upstreamRes.statusCode || 502) >= 300
      ) {
        const upstreamError = await collectStreamResponse(upstreamRes);
        clientRes.writeHead(upstreamError.statusCode, {
          "content-type":
            upstreamError.headers["content-type"] ||
            "application/json; charset=utf-8",
        });
        clientRes.end(upstreamError.text);
        logRequestSummary(context, { result: "upstream_error" });
        return;
      }

      const contentType = String(upstreamRes.headers["content-type"] || "");
      startAnthropicSseResponse(clientRes);

      if (!contentType.includes("text/event-stream")) {
        context.fallbackMode = "json_to_sse";
        const upstreamJsonResponse = await collectStreamResponse(upstreamRes);
        markOnce(context, "firstUpstreamChunkMs");

        if (!upstreamJsonResponse.json) {
          failStream(
            "proxy_bad_upstream_response",
            "Upstream returned non-SSE, non-JSON content for stream request.",
            "invalid_upstream_stream",
          );
          return;
        }

        const anthropicMessage = openAIResponseToAnthropic(
          upstreamJsonResponse.json,
        );
        emitPseudoAnthropicStreamFromMessage(clientRes, anthropicMessage, context);
        clientRes.end();
        logRequestSummary(context, { result: "ok" });
        return;
      }

      const streamState = createAnthropicStreamState(requestBody);
      const parser = createSseParser((eventName, dataText) => {
        if (dataText === "[DONE]") {
          return;
        }

        let payload;
        try {
          payload = JSON.parse(dataText);
        } catch (error) {
          throw new Error(
            `Failed to parse upstream SSE JSON for event ${eventName}: ${error.message}`,
          );
        }

        applyOpenAIStreamChunk(clientRes, streamState, context, payload);
      });

      upstreamRes.on("data", (chunk) => {
        if (streamFailed) {
          return;
        }

        markOnce(context, "firstUpstreamChunkMs");
        try {
          parser.push(chunk.toString("utf-8"));
        } catch (error) {
          failStream(
            "proxy_stream_parse_error",
            error.message,
            "stream_parse_error",
          );
        }
      });

      upstreamRes.on("end", () => {
        if (streamFailed) {
          return;
        }

        try {
          parser.flush();
          emitMessageStop(clientRes, streamState, context);
          clientRes.end();
          logRequestSummary(context, { result: "ok" });
        } catch (error) {
          failStream(
            "proxy_stream_parse_error",
            error.message,
            "stream_parse_error",
          );
        }
      });

      upstreamRes.on("error", (error) => {
        failStream("proxy_stream_error", error.message, "stream_error");
      });
    },
  );

  clientReq.on("close", () => {
    if (!clientRes.writableEnded) {
      upstreamReq.destroy(new Error("client disconnected"));
    }
  });

  upstreamReq.on("timeout", () => {
    upstreamReq.destroy(new Error("upstream timeout"));
  });

  upstreamReq.on("error", (error) => {
    closeStreamWithSseError(clientRes, context, "proxy_error", error.message);
    logRequestSummary(context, {
      result: "request_error",
      error: error.message,
    });
  });

  upstreamReq.end(upstreamBody);
}

async function handleAnthropicMessages(clientReq, clientRes, rawBody) {
  let requestJson;

  try {
    requestJson = JSON.parse(rawBody.toString("utf-8"));
  } catch (error) {
    sendJson(clientRes, 400, {
      error: {
        type: "proxy_bad_request",
        message: `Invalid JSON request: ${error.message}`,
      },
    });
    return;
  }

  const { requestBody, mergedGroups } = anthropicRequestToOpenAI(requestJson);
  const context = createRequestLogContext(
    requestJson.stream === true ? "stream" : "json",
    clientReq.url,
    mergedGroups,
  );

  if (mergedGroups > 0) {
    console.error(
      `[mimo-cc-proxy] merged ${mergedGroups} assistant group(s) for ${clientReq.url}`,
    );
  }

  if (requestJson.stream === true) {
    await handleAnthropicMessagesStream(clientReq, clientRes, requestBody, context);
    return;
  }

  await handleAnthropicMessagesJson(clientReq, clientRes, requestBody, context);
}

function proxyPassthrough(clientReq, clientRes, bodyBuffer) {
  const upstreamUrl = new URL(clientReq.url, UPSTREAM_BASE_URL);
  const transport = upstreamUrl.protocol === "https:" ? https : http;

  const upstreamReq = transport.request(
    {
      protocol: upstreamUrl.protocol,
      hostname: upstreamUrl.hostname,
      port: upstreamUrl.port || undefined,
      method: clientReq.method,
      path: `${upstreamUrl.pathname}${upstreamUrl.search}`,
      headers: {
        ...copyHeaders(clientReq.headers),
        "content-length": Buffer.byteLength(bodyBuffer),
      },
      timeout: REQUEST_TIMEOUT_MS,
    },
    (upstreamRes) => {
      clientRes.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
      upstreamRes.pipe(clientRes);
    },
  );

  upstreamReq.on("timeout", () => {
    upstreamReq.destroy(new Error("upstream timeout"));
  });

  upstreamReq.on("error", (error) => {
    sendJson(clientRes, 502, {
      error: {
        type: "proxy_error",
        message: error.message,
      },
    });
  });

  upstreamReq.end(bodyBuffer);
}

async function handleRequest(clientReq, clientRes) {
  const rawBody = await readRequestBody(clientReq);
  const contentType = clientReq.headers["content-type"] || "";

  if (
    clientReq.method === "POST" &&
    clientReq.url &&
    clientReq.url.startsWith("/v1/messages") &&
    contentType.includes("application/json")
  ) {
    await handleAnthropicMessages(clientReq, clientRes, rawBody);
    return;
  }

  proxyPassthrough(clientReq, clientRes, rawBody);
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((error) => {
    sendJson(res, 500, {
      error: {
        type: "proxy_internal_error",
        message: error.message,
      },
    });
  });
});

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  console.log(
    `[mimo-cc-proxy] listening on http://${LISTEN_HOST}:${LISTEN_PORT} -> ${UPSTREAM_BASE_URL}`,
  );
  console.log(
    `[mimo-cc-proxy] mode: anthropic /v1/messages -> openai /v1/chat/completions bridge (${getThinkingModeSetting()} thinking)`,
  );
});
