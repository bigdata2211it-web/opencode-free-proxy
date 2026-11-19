import express from "express";
import crypto from "crypto";
import https from "https";
import fs from "fs";

const app = express();
app.use(express.json({ limit: "10mb" }));

const PORT = process.env.PROXY_PORT || 6446;
const OC_VERSION = "1.15.0";
const PROXY_VERSION = "9";

// ── API Keys ───────────────────────────────────────────────────────
const keysFile = process.env.KEYS_FILE || "./api-keys.json";
let apiKeys = {};
function loadKeys() {
  try { apiKeys = JSON.parse(fs.readFileSync(keysFile, "utf8")); } catch {}
  if (Object.keys(apiKeys).length === 0) {
    apiKeys = {
      admin: "oc-" + crypto.randomBytes(20).toString("hex"),
      "user-default": "oc-" + crypto.randomBytes(20).toString("hex"),
    };
    fs.writeFileSync(keysFile, JSON.stringify(apiKeys, null, 2));
    console.log("[INIT] Generated new API keys →", keysFile);
  }
}
loadKeys();

function auth(req) {
  const hdr = req.headers.authorization || req.headers["x-api-key"] || "";
  const tok = hdr.startsWith("Bearer ") ? hdr.slice(7) : hdr;
  for (const [name, key] of Object.entries(apiKeys)) {
    if (tok === key) return name;
  }
  return null;
}

// ── Helpers ────────────────────────────────────────────────────────
function ocId(prefix) {
  const ts = Date.now().toString(16);
  const rnd = crypto.randomBytes(12).toString("base64url").slice(0, 16);
  return `${prefix}_${ts}${rnd}`;
}

// ── Upstream credential ────────────────────────────────────────────
// 上游 opencode.ai/zen 的匿名通道(Bearer public)自 2026-10 起被限流：
//   FreeUsageLimitError: Free usage limit reached.
// 设置 OPENCODE_TOKEN 为自己的 OpenCode 账号 token 即可恢复。
const ZEN_TOKEN = process.env.OPENCODE_TOKEN || "public";
const ZEN_HOST = process.env.ZEN_HOST || "opencode.ai";

function zenHeaders(requestId, sessionId) {
  return {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${ZEN_TOKEN}`,
    "User-Agent": `opencode/${OC_VERSION} ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.13`,
    "x-opencode-client": "cli",
    "x-opencode-project": "global",
    "x-opencode-request": requestId || ocId("msg"),
    "x-opencode-session": sessionId || ocId("ses"),
  };
}

// ── Models ─────────────────────────────────────────────────────────
// 兜底名单：2026-11 实测上游仍存在的免费模型；启动时会被 refreshModels() 覆盖。
const FALLBACK_MODELS = [
  "big-pickle",
  "mimo-v2.6-flash-free",
  "deepseek-v4.1-flash-free",
  "hy4-flash-free",
  "longcat-2.5-free",
  "iceman-free",
  "inkling-2-small-free",
  "beam-free",
  "flint-40b-free",
  "nemotron-3.5-super-vl-free",
  "nemotron-3.5-lightning-free",
  "tidepool-alpha-free",
];
let MODELS = FALLBACK_MODELS.slice();
let MODELS_SOURCE = "fallback";

async function refreshModels() {
  const override = (process.env.MODELS || "").split(",").map((x) => x.trim()).filter(Boolean);
  if (override.length) {
    MODELS = override;
    MODELS_SOURCE = "env";
    return MODELS;
  }
  try {
    const data = await new Promise((resolve, reject) => {
      const req = https.request(
        { hostname: ZEN_HOST, port: 443, path: "/zen/v1/models", method: "GET", headers: zenHeaders(), timeout: 20000 },
        (r) => {
          let b = "";
          r.on("data", (c) => (b += c));
          r.on("end", () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
        }
      );
      req.on("error", reject);
      req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
      req.end();
    });
    const ids = (data.data || []).map((m) => m.id).filter(Boolean);
    const free = ids.filter((id) => /-free$/.test(id) || id === "big-pickle");
    if (free.length) {
      MODELS = free.sort();
      MODELS_SOURCE = "upstream " + new Date().toISOString();
      console.log(`[MODELS] loaded ${MODELS.length} free models from upstream`);
    }
  } catch (e) {
    console.error("[MODELS] refresh failed, using fallback:", e.message);
  }
  return MODELS;
}

function isModelAllowed(model) {
  return MODELS.includes(model) || process.env.ALLOW_ANY_MODEL === "1";
}

// Track sessions per user (rotate every 30 min)
const userSessions = {};
function getSession(user) {
  const now = Date.now();
  if (!userSessions[user] || now - userSessions[user].ts > 30 * 60 * 1000) {
    userSessions[user] = { id: ocId("ses"), ts: now };
  }
  return userSessions[user].id;
}

// ── Zen API transport ──────────────────────────────────────────────
function zenRequest(model, messages, stream, tools, tool_choice, sessionId) {
  const reqBody = { model, messages, stream: !!stream };
  if (tools?.length) reqBody.tools = tools;
  if (tool_choice) reqBody.tool_choice = tool_choice;
  const body = JSON.stringify(reqBody);
  const requestId = ocId("msg");

  return {
    body,
    options: {
      hostname: "opencode.ai",
      port: 443,
      path: "/zen/v1/chat/completions",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        "Authorization": `Bearer ${ZEN_TOKEN}`,
        "User-Agent": `opencode/${OC_VERSION} ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.13`,
        "x-opencode-client": "cli",
        "x-opencode-project": "global",
        "x-opencode-request": requestId,
        "x-opencode-session": sessionId,
      },
      timeout: 120000,
    },
  };
}

// Pipe Zen response to client (OpenAI format passthrough)
function pipeZenResponse(zenOpts, body, stream, res) {
  const req = https.request(zenOpts, (zenRes) => {
    let firstChunk = null;
    let headersSent = false;

    zenRes.on("data", (chunk) => {
      if (!firstChunk) {
        firstChunk = chunk;
        const str = chunk.toString().trim();

        if (str.startsWith("{") && (str.includes("FreeUsageLimitError") || str.includes('"error"'))) {
          try {
            const parsed = JSON.parse(str);
            if (parsed.error || parsed.type === "error") {
              const errMsg = parsed.error?.message || parsed.message || "Rate limit exceeded";
              console.log("[ZEN RATE LIMITED]", errMsg);
              if (!res.headersSent) {
                res.status(429).json({
                  error: { message: errMsg + " (free model rate limit)", type: "rate_limit_error", code: "rate_limit_exceeded" }
                });
              }
              zenRes.resume();
              return;
            }
          } catch {}
        }

        headersSent = true;
        if (stream) {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
            "Transfer-Encoding": "chunked",
          });
          res.flushHeaders();
        } else {
          res.writeHead(zenRes.statusCode, { "Content-Type": "application/json" });
        }
        res.write(firstChunk);
        if (res.flush) res.flush();
        return;
      }
      if (headersSent) {
        res.write(chunk);
        if (res.flush) res.flush();
      }
    });

    zenRes.on("end", () => {
      if (!headersSent && !firstChunk) {
        console.log("[ZEN EMPTY] No response from Zen API");
        if (!res.headersSent) {
          res.status(502).json({ error: { message: "Empty response from upstream", type: "upstream_error" } });
        }
        return;
      }
      if (headersSent) res.end();
    });
  });

  req.on("error", (e) => {
    console.log("[ZEN ERROR]", e.message);
    if (!res.headersSent) {
      res.status(502).json({ error: { message: "Upstream error: " + e.message, type: "upstream_error" } });
    }
  });

  req.on("timeout", () => {
    req.destroy();
    console.log("[ZEN TIMEOUT]");
    if (!res.headersSent) {
      res.status(504).json({ error: { message: "Upstream timeout", type: "timeout_error" } });
    }
  });

  req.write(body);
  req.end();
}

// Collect full Zen response (non-streaming) and return parsed JSON
function zenRequestFull(zenOpts, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(zenOpts, (zenRes) => {
      const chunks = [];
      zenRes.on("data", (c) => chunks.push(c));
      zenRes.on("end", () => {
        const raw = Buffer.concat(chunks).toString();
        try {
          resolve({ status: zenRes.statusCode, data: JSON.parse(raw), raw });
        } catch {
          resolve({ status: zenRes.statusCode, data: null, raw });
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.write(body);
    req.end();
  });
}

// ── Anthropic Messages → OpenAI conversion ─────────────────────────
function anthropicToOpenAI(body) {
  const messages = [];
  if (body.system) {
    const sys = typeof body.system === "string" ? body.system
      : Array.isArray(body.system) ? body.system.map(b => b.text || "").join("\n") : "";
    if (sys) messages.push({ role: "system", content: sys });
  }
  for (const msg of body.messages || []) {
    if (typeof msg.content === "string") {
      messages.push({ role: msg.role, content: msg.content });
    } else if (Array.isArray(msg.content)) {
      const text = msg.content
        .filter(b => b.type === "text")
        .map(b => b.text)
        .join("\n");
      // tool_use blocks → assistant tool_calls
      const toolUses = msg.content.filter(b => b.type === "tool_use");
      if (toolUses.length && msg.role === "assistant") {
        messages.push({
          role: "assistant",
          content: text || null,
          tool_calls: toolUses.map(t => ({
            id: t.id,
            type: "function",
            function: { name: t.name, arguments: JSON.stringify(t.input || {}) },
          })),
        });
      } else if (msg.content.some(b => b.type === "tool_result")) {
        for (const b of msg.content.filter(b => b.type === "tool_result")) {
          const resultText = typeof b.content === "string" ? b.content
            : Array.isArray(b.content) ? b.content.map(c => c.text || "").join("\n") : "";
          messages.push({ role: "tool", tool_call_id: b.tool_use_id, content: resultText });
        }
      } else {
        messages.push({ role: msg.role, content: text });
      }
    }
  }

  const tools = (body.tools || []).map(t => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description || "",
      parameters: t.input_schema || {},
    },
  }));

  return { messages, tools: tools.length ? tools : undefined };
}

// OpenAI response → Anthropic Messages format
function openAIToAnthropic(oaiResp, model, inputTokens) {
  const choice = oaiResp.choices?.[0];
  if (!choice) {
    return {
      id: ocId("msg"),
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "" }],
      model,
      stop_reason: "end_turn",
      usage: { input_tokens: inputTokens || 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    };
  }

  const content = [];
  if (choice.message?.content) {
    content.push({ type: "text", text: choice.message.content });
  }
  if (choice.message?.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      let input = {};
      try { input = JSON.parse(tc.function.arguments); } catch {}
      content.push({
        type: "tool_use",
        id: tc.id || ocId("toolu"),
        name: tc.function.name,
        input,
      });
    }
  }
  if (!content.length) content.push({ type: "text", text: "" });

  let stopReason = "end_turn";
  if (choice.finish_reason === "tool_calls") stopReason = "tool_use";
  else if (choice.finish_reason === "length") stopReason = "max_tokens";
  else if (choice.finish_reason === "stop") stopReason = "end_turn";

  return {
    id: ocId("msg"),
    type: "message",
    role: "assistant",
    content,
    model,
    stop_reason: stopReason,
    usage: {
      input_tokens: oaiResp.usage?.prompt_tokens || inputTokens || 0,
      output_tokens: oaiResp.usage?.completion_tokens || 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  };
}

// Stream OpenAI SSE → Anthropic SSE
function pipeZenAsAnthropic(zenOpts, body, model, res, inputTokens) {
  const msgId = ocId("msg");

  const req = https.request(zenOpts, (zenRes) => {
    let headersSent = false;
    let buffer = "";
    let outputTokens = 0;
    let contentIdx = 0;
    let toolIdx = -1;
    let firstChunkHandled = false;

    function sendSSE(event, data) {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      if (res.flush) res.flush();
    }

    function sendHeaders() {
      if (headersSent) return;
      headersSent = true;
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.flushHeaders();

      sendSSE("message_start", {
        type: "message_start",
        message: {
          id: msgId, type: "message", role: "assistant", content: [],
          model, stop_reason: null,
          usage: { input_tokens: inputTokens || 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
      });
    }

    zenRes.on("data", (chunk) => {
      const str = chunk.toString();

      // Check for errors on first chunk
      if (!firstChunkHandled) {
        firstChunkHandled = true;
        const trimmed = str.trim();
        if (trimmed.startsWith("{") && (trimmed.includes("FreeUsageLimitError") || trimmed.includes('"error"'))) {
          try {
            const parsed = JSON.parse(trimmed);
            if (parsed.error || parsed.type === "error") {
              const errMsg = parsed.error?.message || parsed.message || "Rate limit";
              if (!res.headersSent) {
                res.writeHead(429, { "Content-Type": "application/json" });
                res.end(JSON.stringify({
                  type: "error",
                  error: { type: "rate_limit_error", message: errMsg + " (free model rate limit)" },
                }));
              }
              zenRes.resume();
              return;
            }
          } catch {}
        }
      }

      buffer += str;
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const payload = line.slice(6).trim();
        if (payload === "[DONE]") continue;

        let parsed;
        try { parsed = JSON.parse(payload); } catch { continue; }
        const delta = parsed.choices?.[0]?.delta;
        if (!delta) continue;

        sendHeaders();

        // Text content
        if (delta.content) {
          if (contentIdx === 0 && toolIdx === -1) {
            sendSSE("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
            contentIdx = 1;
          }
          sendSSE("content_block_delta", {
            type: "content_block_delta", index: 0,
            delta: { type: "text_delta", text: delta.content },
          });
          outputTokens += Math.ceil(delta.content.length / 4);
        }

        // Tool calls
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            if (idx > toolIdx) {
              // Close previous text block if open
              if (toolIdx === -1 && contentIdx > 0) {
                sendSSE("content_block_stop", { type: "content_block_stop", index: 0 });
              }
              toolIdx = idx;
              const blockIdx = contentIdx > 0 ? idx + 1 : idx;
              sendSSE("content_block_start", {
                type: "content_block_start", index: blockIdx,
                content_block: { type: "tool_use", id: tc.id || ocId("toolu"), name: tc.function?.name || "" },
              });
            }
            if (tc.function?.arguments) {
              const blockIdx = contentIdx > 0 ? idx + 1 : idx;
              sendSSE("content_block_delta", {
                type: "content_block_delta", index: blockIdx,
                delta: { type: "input_json_delta", partial_json: tc.function.arguments },
              });
              outputTokens += Math.ceil(tc.function.arguments.length / 4);
            }
          }
        }

        // Finish
        if (parsed.choices?.[0]?.finish_reason) {
          const fr = parsed.choices[0].finish_reason;
          // Close open blocks
          const totalBlocks = (contentIdx > 0 ? 1 : 0) + (toolIdx >= 0 ? toolIdx + 1 : 0);
          for (let i = 0; i < totalBlocks; i++) {
            sendSSE("content_block_stop", { type: "content_block_stop", index: i });
          }

          let stopReason = "end_turn";
          if (fr === "tool_calls") stopReason = "tool_use";
          else if (fr === "length") stopReason = "max_tokens";

          sendSSE("message_delta", {
            type: "message_delta",
            delta: { stop_reason: stopReason },
            usage: { output_tokens: outputTokens },
          });
          sendSSE("message_stop", { type: "message_stop" });
        }
      }
    });

    zenRes.on("end", () => {
      if (!headersSent) {
        if (!res.headersSent) {
          res.status(502).json({ type: "error", error: { type: "upstream_error", message: "Empty response" } });
        }
        return;
      }
      res.end();
    });
  });

  req.on("error", (e) => {
    console.log("[ZEN ERROR]", e.message);
    if (!res.headersSent) {
      res.status(502).json({ type: "error", error: { type: "upstream_error", message: e.message } });
    }
  });

  req.on("timeout", () => {
    req.destroy();
    if (!res.headersSent) {
      res.status(504).json({ type: "error", error: { type: "timeout_error", message: "Upstream timeout" } });
    }
  });

  req.write(body);
  req.end();
}

// ── Routes: OpenAI format ──────────────────────────────────────────
app.get("/v1/models", (_req, res) => {
  res.json({
    object: "list",
    data: MODELS.map((id) => ({
      id, object: "model", created: 1779000000, owned_by: "opencode-free",
    })),
  });
});

app.post("/v1/chat/completions", (req, res) => {
  const user = auth(req);
  if (!user) return res.status(401).json({ error: { message: "Invalid API key" } });

  const { model, messages, stream, tools, tool_choice } = req.body;
  if (!isModelAllowed(model)) {
    return res.status(400).json({ error: { message: `Unknown model: ${model}. Available: ${MODELS.join(", ")}` } });
  }

  const sessionId = getSession(user);
  const msgSummary = (messages || []).map(m => ({ role: m.role, len: (typeof m.content === "string" ? m.content : JSON.stringify(m.content || "")).length }));
  console.log("[OAI]", new Date().toISOString(), user, model, stream ? "stream" : "sync", "msgs:", JSON.stringify(msgSummary));

  const { body, options } = zenRequest(model, messages, stream, tools, tool_choice, sessionId);
  pipeZenResponse(options, body, stream, res);
});

// ── Routes: Anthropic Messages format ──────────────────────────────
app.post("/v1/messages", async (req, res) => {
  const user = auth(req);
  if (!user) {
    return res.status(401).json({ type: "error", error: { type: "authentication_error", message: "Invalid API key" } });
  }

  const { model, stream } = req.body;
  if (!isModelAllowed(model)) {
    return res.status(400).json({
      type: "error",
      error: { type: "invalid_request_error", message: `Unknown model: ${model}. Available: ${MODELS.join(", ")}` },
    });
  }

  const sessionId = getSession(user);
  const { messages, tools } = anthropicToOpenAI(req.body);
  const inputTokens = JSON.stringify(messages).length / 4 | 0;

  console.log("[ANT]", new Date().toISOString(), user, model, stream ? "stream" : "sync", "msgs:", messages.length);

  const { body, options } = zenRequest(model, messages, stream, tools, undefined, sessionId);

  if (stream) {
    pipeZenAsAnthropic(options, body, model, res, inputTokens);
  } else {
    try {
      const zenResp = await zenRequestFull(options, body);
      if (zenResp.status === 429 || zenResp.data?.error) {
        const errMsg = zenResp.data?.error?.message || "Rate limit exceeded";
        return res.status(429).json({
          type: "error", error: { type: "rate_limit_error", message: errMsg + " (free model rate limit)" },
        });
      }
      if (!zenResp.data?.choices) {
        return res.status(502).json({
          type: "error", error: { type: "upstream_error", message: "Invalid upstream response" },
        });
      }
      res.json(openAIToAnthropic(zenResp.data, model, inputTokens));
    } catch (e) {
      console.log("[ZEN ERROR]", e.message);
      res.status(502).json({ type: "error", error: { type: "upstream_error", message: e.message } });
    }
  }
});

// ── Health ──────────────────────────────────────────────────────────
app.get("/health", (_req, res) => res.json({
  status: "ok", version: `v${PROXY_VERSION}`, models: MODELS.length,
  endpoints: ["/v1/chat/completions", "/v1/messages", "/v1/responses", "/v1/models"],
  upstream: ZEN_TOKEN === "public" ? "anonymous(Bearer public)" : "token(env)",
  models_source: MODELS_SOURCE,
}));

// ── Start ──────────────────────────────────────────────────────────
// ── OpenAI Responses API (/v1/responses) ───────────────────────────
function responsesContentToText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((c) => {
      if (typeof c === "string") return c;
      if (c && (c.type === "input_text" || c.type === "output_text" || c.type === "text")) return c.text || "";
      if (c && c.type === "input_image") return "[image omitted]";
      return c && c.text ? c.text : "";
    }).join("");
  }
  return content == null ? "" : String(content);
}

function responsesToMessages(body) {
  const messages = [];
  if (body.instructions) messages.push({ role: "system", content: body.instructions });
  const input = body.input;
  if (typeof input === "string") {
    messages.push({ role: "user", content: input });
  } else if (Array.isArray(input)) {
    for (const item of input) {
      if (!item) continue;
      if (typeof item === "string") { messages.push({ role: "user", content: item }); continue; }
      const role = item.role || (item.type === "message" ? "user" : null);
      if (role) messages.push({ role, content: responsesContentToText(item.content) });
      else if (item.type === "function_call_output") messages.push({ role: "tool", tool_call_id: item.call_id, content: responsesContentToText(item.output) });
    }
  }
  if (!messages.length) messages.push({ role: "user", content: "" });
  return messages;
}

function responsesToolsToChat(tools) {
  if (!Array.isArray(tools)) return undefined;
  const out = tools.filter((t) => t && t.type === "function").map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description || "", parameters: t.parameters || { type: "object", properties: {} } },
  }));
  return out.length ? out : undefined;
}

app.post("/v1/responses", async (req, res) => {
  const user = auth(req);
  if (!user) return res.status(401).json({ error: { type: "authentication_error", message: "Invalid API key" } });

  const body = req.body || {};
  const model = body.model;
  if (!model || !isModelAllowed(model)) {
    return res.status(400).json({ error: { type: "invalid_request_error", message: `Unknown model: ${model}. Available: ${MODELS.join(", ")}` } });
  }

  const sessionId = getSession(user);
  const { body: upstreamBody, options } = zenRequest(model, responsesToMessages(body), false, responsesToolsToChat(body.tools), body.tool_choice, sessionId);

  let zenResp;
  try {
    zenResp = await zenRequestFull(options, upstreamBody);
  } catch (e) {
    return res.status(502).json({ error: { type: "upstream_error", message: e.message === "timeout" ? "Upstream timeout" : "Upstream error: " + e.message } });
  }

  const data = zenResp && zenResp.data;
  if (zenResp && (zenResp.status === 429 || (data && data.error))) {
    const msg = (data && data.error && (data.error.message || data.error.type)) || "rate_limit_error";
    return res.status(429).json({ error: { type: "rate_limit_error", message: `${msg} (set OPENCODE_TOKEN to use your own account quota)` } });
  }
  if (!data || !data.choices) return res.status(502).json({ error: { type: "upstream_error", message: "Invalid upstream response" } });

  const text = (data.choices[0].message && data.choices[0].message.content) || "";
  const usage = data.usage || {};
  const created = Math.floor(Date.now() / 1000);
  const respId = "resp_" + crypto.randomBytes(12).toString("hex");
  const itemId = "msg_" + crypto.randomBytes(8).toString("hex");
  const usageOut = { input_tokens: usage.prompt_tokens || 0, output_tokens: usage.completion_tokens || 0, total_tokens: usage.total_tokens || 0 };

  if (body.stream) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });
    const send = (obj) => res.write(`event: ${obj.type}\ndata: ${JSON.stringify(obj)}\n\n`);
    const part = { type: "output_text", text: "", annotations: [] };
    send({ type: "response.created", response: { id: respId, object: "response", created_at: created, model, status: "in_progress", output: [] } });
    send({ type: "response.output_item.added", output_index: 0, item: { id: itemId, type: "message", role: "assistant", status: "in_progress", content: [] } });
    send({ type: "response.content_part.added", item_id: itemId, output_index: 0, content_index: 0, part });
    for (let i = 0; i < text.length; i += 200) {
      send({ type: "response.output_text.delta", item_id: itemId, output_index: 0, content_index: 0, delta: text.slice(i, i + 200) });
    }
    send({ type: "response.output_text.done", item_id: itemId, output_index: 0, content_index: 0, text });
    send({ type: "response.output_item.done", output_index: 0, item: { id: itemId, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] } });
    send({ type: "response.completed", response: { id: respId, object: "response", created_at: created, model, status: "completed", output: [{ id: itemId, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] }], usage: usageOut } });
    return res.end();
  }

  return res.json({
    id: respId,
    object: "response",
    created_at: created,
    model,
    status: "completed",
    output: [{ id: itemId, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] }],
    usage: usageOut,
  });
});

app.listen(PORT, "0.0.0.0", () => {
  refreshModels();
  console.log(`OpenCode Free Proxy v${PROXY_VERSION} on http://0.0.0.0:${PORT}`);
  console.log("  OpenAI:    POST /v1/chat/completions");
  console.log("  Anthropic: POST /v1/messages");
  console.log("  Models:    GET  /v1/models");
  console.log("  Health:    GET  /health");
  console.log("  Models:", MODELS.join(", "));
  for (const [name, key] of Object.entries(apiKeys)) {
    console.log(`  ${name.padEnd(15)} ${key}`);
  }
});
