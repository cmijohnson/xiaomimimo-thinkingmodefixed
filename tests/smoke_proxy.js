#!/usr/bin/env node

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");

const PROXY_PATH = path.join(__dirname, "..", "mimo_cc_proxy.js");

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8") || "{}"));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function getLastUserText(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message && message.role === "user" && typeof message.content === "string") {
      return message.content;
    }
  }

  return "";
}

function sendJsonResponse(res, payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf-8");
  res.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "content-length": body.length,
  });
  res.end(body);
}

async function sendSseResponse(res, payloads) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });

  for (const payload of payloads) {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
    await delay(5);
  }

  res.end("data: [DONE]\n\n");
}

function createMockResponse(body, state) {
  const lastUserText = getLastUserText(body.messages || []);

  if (lastUserText.includes("__proxy_case:ping")) {
    assert.deepEqual(body.thinking, { type: "enabled" });
    return {
      type: "json",
      payload: {
        id: "chatcmpl_ping",
        model: body.model,
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: {
              role: "assistant",
              reasoning_content: "Proxy preserved reasoning.",
              content: "pong",
            },
          },
        ],
        usage: {
          prompt_tokens: 11,
          completion_tokens: 5,
        },
      },
    };
  }

  if (lastUserText.includes("__proxy_case:tool_round_1")) {
    assert.deepEqual(body.thinking, { type: "enabled" });
    assert.equal(body.tools?.[0]?.function?.name, "add");
    assert.equal(body.tool_choice?.function?.name, "add");
    return {
      type: "json",
      payload: {
        id: "chatcmpl_tool_1",
        model: body.model,
        choices: [
          {
            index: 0,
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              reasoning_content: "Need to call add before answering.",
              content: "",
              tool_calls: [
                {
                  id: "call_add_1",
                  type: "function",
                  function: {
                    name: "add",
                    arguments: JSON.stringify({ a: 1, b: 2 }),
                  },
                },
              ],
            },
          },
        ],
        usage: {
          prompt_tokens: 20,
          completion_tokens: 9,
        },
      },
    };
  }

  if (lastUserText.includes("__proxy_case:tool_round_2")) {
    const assistantMessage = (body.messages || []).find(
      (message) => message.role === "assistant",
    );
    const toolMessage = (body.messages || []).find(
      (message) => message.role === "tool",
    );

    assert.equal(
      assistantMessage?.reasoning_content,
      "Need to call add before answering.",
    );
    assert.equal(assistantMessage?.tool_calls?.[0]?.id, "call_add_1");
    assert.equal(assistantMessage?.tool_calls?.[0]?.function?.name, "add");
    assert.equal(
      assistantMessage?.tool_calls?.[0]?.function?.arguments,
      JSON.stringify({ a: 1, b: 2 }),
    );
    assert.equal(toolMessage?.tool_call_id, "call_add_1");
    assert.equal(toolMessage?.content, "3");

    return {
      type: "json",
      payload: {
        id: "chatcmpl_tool_2",
        model: body.model,
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: {
              role: "assistant",
              reasoning_content: "The tool returned 3.",
              content: "The answer is 3.",
            },
          },
        ],
        usage: {
          prompt_tokens: 31,
          completion_tokens: 12,
        },
      },
    };
  }

  if (lastUserText.includes("__proxy_case:stream_text")) {
    assert.equal(body.stream, true);
    assert.deepEqual(body.thinking, { type: "enabled" });
    return {
      type: "sse",
      payloads: [
        {
          id: "chatcmpl_stream_text",
          model: body.model,
          choices: [
            {
              index: 0,
              delta: {
                reasoning_content: "Thinking through the reply.",
              },
              finish_reason: null,
            },
          ],
        },
        {
          id: "chatcmpl_stream_text",
          model: body.model,
          choices: [
            {
              index: 0,
              delta: {
                content: "Hello ",
              },
              finish_reason: null,
            },
          ],
        },
        {
          id: "chatcmpl_stream_text",
          model: body.model,
          choices: [
            {
              index: 0,
              delta: {
                content: "streaming world.",
              },
              finish_reason: null,
            },
          ],
          usage: {
            prompt_tokens: 15,
            completion_tokens: 7,
          },
        },
        {
          id: "chatcmpl_stream_text",
          model: body.model,
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: 15,
            completion_tokens: 8,
          },
        },
      ],
    };
  }

  if (lastUserText.includes("__proxy_case:stream_tool")) {
    assert.equal(body.stream, true);
    assert.equal(body.tool_choice?.function?.name, "add");
    return {
      type: "sse",
      payloads: [
        {
          id: "chatcmpl_stream_tool",
          model: body.model,
          choices: [
            {
              index: 0,
              delta: {
                reasoning_content: "Need the add tool for this.",
              },
              finish_reason: null,
            },
          ],
        },
        {
          id: "chatcmpl_stream_tool",
          model: body.model,
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_add_stream",
                    type: "function",
                    function: {
                      name: "add",
                      arguments: "",
                    },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        },
        {
          id: "chatcmpl_stream_tool",
          model: body.model,
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    function: {
                      arguments: "{\"a\":1,",
                    },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        },
        {
          id: "chatcmpl_stream_tool",
          model: body.model,
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    function: {
                      arguments: "\"b\":2}",
                    },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        },
        {
          id: "chatcmpl_stream_tool",
          model: body.model,
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: "tool_calls",
            },
          ],
          usage: {
            prompt_tokens: 18,
            completion_tokens: 6,
          },
        },
      ],
    };
  }

  if (lastUserText.includes("__proxy_case:stream_fallback")) {
    assert.equal(body.stream, true);
    return {
      type: "json",
      payload: {
        id: "chatcmpl_stream_fallback",
        model: body.model,
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: {
              role: "assistant",
              reasoning_content: "Fallback JSON path still works.",
              content: "fallback ok",
            },
          },
        ],
        usage: {
          prompt_tokens: 12,
          completion_tokens: 6,
        },
      },
    };
  }

  if (lastUserText.includes("__proxy_case:thinking_off")) {
    assert.equal(body.thinking, undefined);
    state.thinkingOffVerified = true;
    return {
      type: "json",
      payload: {
        id: "chatcmpl_thinking_off",
        model: body.model,
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: "thinking off ok",
            },
          },
        ],
        usage: {
          prompt_tokens: 9,
          completion_tokens: 4,
        },
      },
    };
  }

  throw new Error(`Unhandled mock case: ${lastUserText}`);
}

async function startMockUpstream() {
  const state = {
    thinkingOffVerified: false,
    upstreamRequestCount: 0,
  };

  const server = http.createServer(async (req, res) => {
    try {
      state.upstreamRequestCount += 1;
      assert.equal(req.method, "POST");
      assert.equal(req.url, "/v1/chat/completions");
      const body = await readJson(req);
      const response = createMockResponse(body, state);

      if (response.type === "sse") {
        await sendSseResponse(res, response.payloads);
        return;
      }

      sendJsonResponse(res, response.payload);
    } catch (error) {
      res.writeHead(500, {
        "content-type": "application/json; charset=utf-8",
      });
      res.end(
        JSON.stringify({
          error: {
            type: "mock_failure",
            message: error.message,
          },
        }),
      );
    }
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return { port, server, state };
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
    server.on("error", reject);
  });
}

async function waitForPort(port, timeoutMs = 5000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      await new Promise((resolve, reject) => {
        const socket = net.createConnection({ host: "127.0.0.1", port }, () => {
          socket.end();
          resolve();
        });
        socket.on("error", reject);
      });
      return;
    } catch {
      await delay(25);
    }
  }

  throw new Error(`Timed out waiting for port ${port}`);
}

async function startProxy({ upstreamPort, thinkingMode }) {
  const proxyPort = await getFreePort();
  const child = spawn(process.execPath, [PROXY_PATH], {
    cwd: path.dirname(PROXY_PATH),
    env: {
      ...process.env,
      MIMO_CC_PROXY_HOST: "127.0.0.1",
      MIMO_CC_PROXY_PORT: String(proxyPort),
      MIMO_CC_UPSTREAM: `http://127.0.0.1:${upstreamPort}`,
      MIMO_CC_PROXY_TIMEOUT_MS: "30000",
      MIMO_CC_THINKING_MODE: thinkingMode,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stderr = "";
  let stdout = "";

  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf-8");
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf-8");
  });

  child.on("exit", (code) => {
    if (code !== 0 && code !== null) {
      process.stderr.write(
        `proxy exited early with code ${code}\n${stdout}\n${stderr}\n`,
      );
    }
  });

  await waitForPort(proxyPort);
  return { child, proxyPort };
}

function stopProxy(child) {
  return new Promise((resolve) => {
    child.once("exit", resolve);
    child.kill("SIGTERM");
  });
}

function requestProxy(port, body, requestPath = "/v1/messages") {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body), "utf-8");
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: requestPath,
        headers: {
          "content-type": "application/json",
          "content-length": payload.length,
          "x-api-key": "test-key",
          "anthropic-version": "2023-06-01",
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf-8");
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {}

          resolve({
            statusCode: res.statusCode || 0,
            headers: res.headers,
            text,
            json,
          });
        });
      },
    );

    req.on("error", reject);
    req.end(payload);
  });
}

function parseSseEvents(text) {
  return text
    .split(/\r?\n\r?\n/)
    .map((rawEvent) => rawEvent.trim())
    .filter(Boolean)
    .map((rawEvent) => {
      const event = {
        name: "message",
        dataText: "",
        json: null,
      };

      for (const line of rawEvent.split(/\r?\n/)) {
        if (line.startsWith("event:")) {
          event.name = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          const dataText = line.slice(5).trimStart();
          event.dataText = dataText;
          try {
            event.json = JSON.parse(dataText);
          } catch {}
        }
      }

      return event;
    });
}

async function run() {
  const mock = await startMockUpstream();
  let proxy = await startProxy({
    upstreamPort: mock.port,
    thinkingMode: "on",
  });

  try {
    const pingResponse = await requestProxy(proxy.proxyPort, {
      model: "mimo-v2.5-pro",
      max_tokens: 32,
      messages: [
        {
          role: "user",
          content: "__proxy_case:ping",
        },
      ],
    });
    assert.equal(pingResponse.statusCode, 200);
    assert.equal(pingResponse.json?.content?.[0]?.type, "thinking");
    assert.equal(pingResponse.json?.content?.[1]?.text, "pong");

    const upstreamCountBeforeCountTokens = mock.state.upstreamRequestCount;
    const countTokensResponse = await requestProxy(
      proxy.proxyPort,
      {
        model: "mimo-v2.5-pro",
        system: "Count these tokens quickly.",
        messages: [
          {
            role: "user",
            content: "帮我快速估算一下这一段上下文需要多少 token。",
          },
        ],
        tools: [
          {
            name: "add",
            description: "Add two numbers",
            input_schema: {
              type: "object",
              properties: {
                a: { type: "number" },
                b: { type: "number" },
              },
              required: ["a", "b"],
            },
          },
        ],
      },
      "/v1/messages/count_tokens?beta=true",
    );
    assert.equal(countTokensResponse.statusCode, 200);
    assert.ok(Number.isInteger(countTokensResponse.json?.input_tokens));
    assert.ok(countTokensResponse.json.input_tokens > 0);
    assert.equal(
      mock.state.upstreamRequestCount,
      upstreamCountBeforeCountTokens,
    );

    const toolRoundOne = await requestProxy(proxy.proxyPort, {
      model: "mimo-v2.5-pro",
      max_tokens: 64,
      messages: [
        {
          role: "user",
          content: "__proxy_case:tool_round_1",
        },
      ],
      tools: [
        {
          name: "add",
          description: "Add two numbers",
          input_schema: {
            type: "object",
            properties: {
              a: { type: "number" },
              b: { type: "number" },
            },
            required: ["a", "b"],
          },
        },
      ],
      tool_choice: {
        type: "tool",
        name: "add",
      },
    });
    assert.equal(toolRoundOne.statusCode, 200);
    assert.equal(toolRoundOne.json?.stop_reason, "tool_use");
    assert.equal(toolRoundOne.json?.content?.[0]?.type, "thinking");
    assert.equal(toolRoundOne.json?.content?.[1]?.type, "tool_use");
    assert.deepEqual(toolRoundOne.json?.content?.[1]?.input, { a: 1, b: 2 });

    const toolRoundTwo = await requestProxy(proxy.proxyPort, {
      model: "mimo-v2.5-pro",
      max_tokens: 64,
      messages: [
        {
          role: "user",
          content: "__proxy_case:tool_round_1",
        },
        {
          role: "assistant",
          content: toolRoundOne.json.content,
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call_add_1",
              content: "3",
            },
            {
              type: "text",
              text: "__proxy_case:tool_round_2",
            },
          ],
        },
      ],
    });
    assert.equal(toolRoundTwo.statusCode, 200);
    assert.equal(toolRoundTwo.json?.content?.[1]?.text, "The answer is 3.");

    const streamTextResponse = await requestProxy(proxy.proxyPort, {
      model: "mimo-v2.5-pro",
      max_tokens: 64,
      stream: true,
      messages: [
        {
          role: "user",
          content: "__proxy_case:stream_text",
        },
      ],
    });
    assert.equal(streamTextResponse.statusCode, 200);
    assert.match(
      String(streamTextResponse.headers["content-type"] || ""),
      /text\/event-stream/,
    );
    const streamTextEvents = parseSseEvents(streamTextResponse.text);
    assert.equal(streamTextEvents[0]?.name, "message_start");
    assert.equal(streamTextEvents.at(-1)?.name, "message_stop");
    assert.ok(streamTextEvents.some((event) => event.name === "message_delta"));
    assert.ok(
      streamTextEvents.some(
        (event) =>
          event.json?.delta?.type === "thinking_delta" &&
          event.json?.delta?.thinking === "Thinking through the reply.",
      ),
    );
    assert.ok(
      streamTextEvents.some(
        (event) =>
          event.json?.delta?.type === "text_delta" &&
          event.json?.delta?.text === "Hello ",
      ),
    );

    const streamToolResponse = await requestProxy(proxy.proxyPort, {
      model: "mimo-v2.5-pro",
      max_tokens: 64,
      stream: true,
      messages: [
        {
          role: "user",
          content: "__proxy_case:stream_tool",
        },
      ],
      tools: [
        {
          name: "add",
          description: "Add two numbers",
          input_schema: {
            type: "object",
            properties: {
              a: { type: "number" },
              b: { type: "number" },
            },
            required: ["a", "b"],
          },
        },
      ],
      tool_choice: {
        type: "tool",
        name: "add",
      },
    });
    assert.equal(streamToolResponse.statusCode, 200);
    const streamToolEvents = parseSseEvents(streamToolResponse.text);
    assert.ok(
      streamToolEvents.some(
        (event) => event.json?.content_block?.type === "tool_use",
      ),
    );
    assert.ok(
      streamToolEvents.some(
        (event) =>
          event.json?.delta?.type === "input_json_delta" &&
          event.json?.delta?.partial_json === "{\"a\":1,",
      ),
    );
    assert.ok(
      streamToolEvents.some(
        (event) => event.json?.delta?.stop_reason === "tool_use",
      ),
    );

    const fallbackResponse = await requestProxy(proxy.proxyPort, {
      model: "mimo-v2.5-pro",
      max_tokens: 64,
      stream: true,
      messages: [
        {
          role: "user",
          content: "__proxy_case:stream_fallback",
        },
      ],
    });
    assert.equal(fallbackResponse.statusCode, 200);
    assert.match(
      String(fallbackResponse.headers["content-type"] || ""),
      /text\/event-stream/,
    );
    const fallbackEvents = parseSseEvents(fallbackResponse.text);
    assert.ok(
      fallbackEvents.some(
        (event) =>
          event.json?.delta?.type === "text_delta" &&
          event.json?.delta?.text === "fallback ok",
      ),
    );

    await stopProxy(proxy.child);
    proxy = await startProxy({
      upstreamPort: mock.port,
      thinkingMode: "off",
    });

    const thinkingOffResponse = await requestProxy(proxy.proxyPort, {
      model: "mimo-v2.5-pro",
      max_tokens: 32,
      messages: [
        {
          role: "user",
          content: "__proxy_case:thinking_off",
        },
      ],
    });
    assert.equal(thinkingOffResponse.statusCode, 200);
    assert.equal(thinkingOffResponse.json?.content?.[0]?.text, "thinking off ok");
    assert.equal(mock.state.thinkingOffVerified, true);

    await stopProxy(proxy.child);
    await new Promise((resolve, reject) =>
      mock.server.close((error) => (error ? reject(error) : resolve())),
    );

    process.stdout.write("smoke tests passed\n");
  } catch (error) {
    if (proxy?.child) {
      proxy.child.kill("SIGTERM");
    }
    await new Promise((resolve) => mock.server.close(() => resolve()));
    throw error;
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
