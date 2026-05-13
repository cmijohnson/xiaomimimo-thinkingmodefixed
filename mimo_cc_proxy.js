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

function normalizeText(value) {
  if (value == null) {
    return "";
  }

  if (typeof value === "string") {
    return value;
  }

  return JSON.stringify(value);
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
    stream: false,
    thinking: {
      type: "enabled",
    },
  };

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

  const usage = upstreamJson?.usage || {};
  const promptDetails = usage.prompt_tokens_details || {};

  return {
    id:
      upstreamJson.id ||
      `msg_${crypto.randomBytes(12).toString("hex").slice(0, 24)}`,
    type: "message",
    role: "assistant",
    content: blocks,
    stop_reason: mapFinishReason(choice?.finish_reason),
    model: upstreamJson.model,
    usage: {
      input_tokens: usage.prompt_tokens || 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: promptDetails.cached_tokens || 0,
      output_tokens: usage.completion_tokens || 0,
    },
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

  if (mergedGroups > 0) {
    console.error(
      `[mimo-cc-proxy] merged ${mergedGroups} assistant group(s) for ${clientReq.url}`,
    );
  }

  const upstreamUrl = new URL("/v1/chat/completions", UPSTREAM_BASE_URL);
  const upstreamBody = Buffer.from(JSON.stringify(requestBody), "utf-8");
  const upstream = await requestUpstreamJson(
    upstreamUrl,
    "POST",
    resolveUpstreamHeaders(clientReq.headers),
    upstreamBody,
  );

  if (upstream.statusCode < 200 || upstream.statusCode >= 300 || !upstream.json) {
    clientRes.writeHead(upstream.statusCode, {
      "content-type":
        upstream.headers["content-type"] || "application/json; charset=utf-8",
    });
    clientRes.end(upstream.text);
    return;
  }

  const anthropicResponse = openAIResponseToAnthropic(upstream.json);
  sendJson(clientRes, 200, anthropicResponse, {
    "x-mimo-cc-proxy": "anthropic-openai-chat-bridge",
  });
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
    "[mimo-cc-proxy] mode: anthropic /v1/messages -> openai /v1/chat/completions bridge",
  );
});
