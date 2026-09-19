import https from "https";
import { MAX_RETRIES } from "./config/index.mjs";
import { logLine, logIO, LOG_DETAIL } from "./logger.mjs";
import { ocId } from "./utils.mjs";
import {
  parseErrorPayload,
  planRetry,
  logAndScheduleRetry,
  isClientGone,
  isTransientNetworkError,
  isTransientHttpStatus,
  withFreshSession,
  withFreshRequestId,
} from "./retry.mjs";

// ── shared helpers ─────────────────────────────────────────────────────────

/** Transform an SSE data line: inject missing OpenAI ids. */
function transformSseLine(line, toolCallIds, requestModel) {
  if (!line.startsWith("data: ")) return line;
  const payload = line.slice(6).trim();
  if (!payload || payload === "[DONE]") return line;
  try {
    const parsed = JSON.parse(payload);
    const updated = ensureOpenAIIds(parsed, toolCallIds, requestModel);
    return "data: " + JSON.stringify(updated);
  } catch {
    return line;
  }
}

/**
 * Zen's free-tier gate rejects stream:false, so we always stream upstream
 * and fold SSE chunks back into one chat.completion for sync clients.
 */
export function aggregateSseToCompletion(raw, model = "") {
  let id;
  let created;
  let outModel = model;
  let content = "";
  let reasoning = "";
  const toolCalls = {};
  let finish = "stop";

  for (const line of String(raw).split(/\r?\n/)) {
    if (!line.startsWith("data: ")) continue;
    const payload = line.slice(6).trim();
    if (!payload || payload === "[DONE]") continue;
    let parsed;
    try {
      parsed = JSON.parse(payload);
    } catch {
      continue;
    }
    if (parsed.id) id = parsed.id;
    if (parsed.created) created = parsed.created;
    if (parsed.model) outModel = parsed.model;
    const choice = parsed.choices?.[0];
    if (!choice) continue;
    const d = choice.delta || {};
    if (typeof d.content === "string") content += d.content;
    if (typeof d.reasoning_content === "string") reasoning += d.reasoning_content;
    if (Array.isArray(d.tool_calls)) {
      for (const tc of d.tool_calls) {
        const idx = tc.index ?? 0;
        const slot = (toolCalls[idx] ??= {
          id: tc.id,
          type: "function",
          function: { name: "", arguments: "" },
        });
        if (tc.id) slot.id = tc.id;
        if (tc.function?.name) slot.function.name += tc.function.name;
        if (tc.function?.arguments) slot.function.arguments += tc.function.arguments;
      }
    }
    if (choice.finish_reason) finish = choice.finish_reason;
  }

  const tcs = Object.keys(toolCalls)
    .sort((a, b) => Number(a) - Number(b))
    .map((k) => toolCalls[k]);
  const message = {
    role: "assistant",
    content: content || (tcs.length ? null : ""),
  };
  if (reasoning) message.reasoning_content = reasoning;
  if (tcs.length) message.tool_calls = tcs;

  return {
    id: id || ocId("chatcmpl"),
    object: "chat.completion",
    created: created || Math.floor(Date.now() / 1000),
    model: outModel,
    choices: [{ index: 0, message, finish_reason: finish }],
  };
}

export function ensureOpenAIIds(payload, toolCallIds = {}, model = "") {
  if (typeof payload.object !== "string" || !payload.object) {
    payload.object = "chat.completion";
  }
  if (typeof payload.id !== "string" || !payload.id) {
    payload.id = ocId("chatcmpl");
  }
  if (typeof payload.created !== "number") {
    payload.created = Math.floor(Date.now() / 1000);
  }
  if (typeof payload.model !== "string" || !payload.model) {
    payload.model = model || payload.model || "";
  }
  const choice = payload.choices?.[0];
  const tcs = choice?.delta?.tool_calls ?? choice?.message?.tool_calls;
  if (Array.isArray(tcs)) {
    tcs.forEach((tc, arrayIdx) => {
      const idx = tc.index ?? arrayIdx;
      if (tc.id) {
        toolCallIds[idx] = tc.id;
      } else {
        tc.id = toolCallIds[idx] ??= ocId("call");
      }
      if (!tc.type) tc.type = "function";
    });
  }
  return payload;
}

// ── main pipe ──────────────────────────────────────────────────────────────

/**
 * Relay an OpenAI-format request to the Zen API and pipe the response back
 * in OpenAI format (supports both streaming SSE and sync JSON).
 * Retries on rate-limit / transient errors with backoff; rotates session on 429.
 *
 * @param {object} [ctx]
 * @param {string} [ctx.user] API key user id (for session rotation)
 * @param {import("http").IncomingMessage} [ctx.clientReq] client request (abort detection)
 * @param {number} [ctx.retries]
 */
export function pipeZenResponse(zenOpts, body, stream, res, ctx = {}) {
  const { user, clientReq, retries = MAX_RETRIES } = ctx;
  const toolCallIds = {};
  let requestModel = "";
  try {
    requestModel = JSON.parse(body).model || "";
  } catch {}

  let currentOpts = zenOpts;
  let aborted = false;
  // Do NOT key off req 'close' / req.destroyed: Node fires 'close' and marks
  // destroyed as soon as the request body is fully consumed, even though the
  // client is still connected and waiting. Detect a real disconnect via the
  // response socket closing before the response was sent.
  res.on("close", () => {
    if (!res.writableEnded) aborted = true;
  });

  function gone() {
    return aborted || isClientGone(clientReq, res);
  }

  function attempt(remaining) {
    if (gone()) {
      logLine("CLIENT GONE, stop attempt");
      return;
    }

    const chunks = [];
    const t0 = Date.now();
    /** Accumulate transformed SSE lines for stream-mode logging (only if LOG_DETAIL is on). */
    let streamLogLines = LOG_DETAIL ? "" : null;
    let intentionalClose = false;
    let terminalHandled = false;

    function failRateLimit(errMsg) {
      if (terminalHandled || res.headersSent) return;
      terminalHandled = true;
      logLine("RATE LIMITED, exhausted retries", errMsg);
      logIO("OUTPUT (rate_limit)", { error: errMsg });
      res.status(429).json({
        error: {
          message: errMsg + " (free model rate limit)",
          type: "rate_limit_error",
          code: "rate_limit_exceeded",
        },
      });
    }

    function failUpstream(status, errMsg, type = "upstream_error") {
      if (terminalHandled || res.headersSent) return;
      terminalHandled = true;
      logLine("UPSTREAM ERROR", errMsg);
      logIO("OUTPUT (error)", { error: errMsg });
      res.status(status).json({ error: { message: errMsg, type } });
    }

    /** @returns {boolean} true if a retry was scheduled */
    function trySchedule(kind, errMsg, headers) {
      if (gone()) {
        logLine("CLIENT GONE, aborting retries");
        intentionalClose = true;
        return true; // treat as handled (do not fail to client)
      }
      const plan = planRetry({ remaining, retries, kind, headers, errMsg });
      if (!plan) return false;
      intentionalClose = true;
      logAndScheduleRetry(plan, remaining, (delay) => {
        setTimeout(() => {
          if (gone()) {
            logLine("CLIENT GONE, stop retry");
            return;
          }
          if (plan.rotateSession && user) {
            currentOpts = withFreshSession(currentOpts, user);
          } else {
            currentOpts = withFreshRequestId(currentOpts);
          }
          attempt(remaining - 1);
        }, delay);
      });
      return true;
    }

    const req = https.request(currentOpts, (zenRes) => {
      let firstChunk = null;
      let headersSent = false;
      let skipEnd = false;
      let sseBuffer = "";
      const status = zenRes.statusCode || 0;

      function sendHeaders() {
        if (headersSent) return;
        headersSent = true;
        if (stream) {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
            "Transfer-Encoding": "chunked",
          });
          res.flushHeaders();
        }
        // Sync clients: Zen always replies SSE (stream forced). Hold headers
        // until we fold chunks into one JSON body.
      }

      function flushSseBuffer(final = false) {
        if (!stream) return;
        const lines = sseBuffer.split("\n");
        sseBuffer = final ? "" : lines.pop() || "";
        for (const line of lines) {
          const out = transformSseLine(line, toolCallIds, requestModel);
          if (streamLogLines !== null) streamLogLines += out + "\n";
          res.write(out + "\n");
        }
        if (final && sseBuffer) {
          const out = transformSseLine(sseBuffer, toolCallIds, requestModel);
          if (streamLogLines !== null) streamLogLines += out + "\n";
          res.write(out + "\n");
        }
        if (res.flush) res.flush();
      }

      function handleRetryable(kind, errMsg) {
        if (trySchedule(kind, errMsg, zenRes.headers)) {
          skipEnd = true;
          zenRes.destroy();
          req.destroy();
          return true;
        }
        return false;
      }

      zenRes.on("data", (chunk) => {
        if (skipEnd || terminalHandled) return;
        if (!firstChunk) {
          firstChunk = chunk;
          const errInfo = parseErrorPayload(chunk);
          const rateLimited = status === 429 || errInfo?.rateLimited;

          if (rateLimited) {
            const errMsg = errInfo?.message || "Rate limit exceeded";
            if (handleRetryable("rate_limit", errMsg)) return;
            failRateLimit(errMsg);
            zenRes.resume();
            skipEnd = true;
            return;
          }

          if (errInfo) {
            // Non-rate-limit upstream error — do not retry as rate limit
            failUpstream(status >= 400 ? status : 502, errInfo.message);
            zenRes.resume();
            skipEnd = true;
            return;
          }

          if (isTransientHttpStatus(status)) {
            if (handleRetryable("transient", `HTTP ${status}`)) return;
            failUpstream(status, `Upstream HTTP ${status}`);
            zenRes.resume();
            skipEnd = true;
            return;
          }

          sendHeaders();
          if (stream) {
            sseBuffer += chunk.toString();
            flushSseBuffer();
          } else {
            chunks.push(chunk);
          }
          return;
        }
        if (headersSent) {
          if (stream) {
            sseBuffer += chunk.toString();
            flushSseBuffer();
          } else {
            chunks.push(chunk);
          }
        }
      });

      zenRes.on("end", () => {
        if (skipEnd || terminalHandled) return;
        if (!headersSent && !firstChunk) {
          if (status === 429) {
            if (handleRetryable("rate_limit", "Rate limit exceeded")) return;
            failRateLimit("Rate limit exceeded");
            return;
          }
          if (isTransientHttpStatus(status)) {
            if (handleRetryable("transient", `HTTP ${status}`)) return;
            failUpstream(status, `Upstream HTTP ${status}`);
            return;
          }
          logLine("EMPTY", "No response from Zen API");
          logIO("OUTPUT (empty)", { error: "Empty response from upstream" });
          if (!res.headersSent) {
            res
              .status(502)
              .json({
                error: {
                  message: "Empty response from upstream",
                  type: "upstream_error",
                },
              });
          }
          return;
        }
        if (headersSent) {
          const ms = Date.now() - t0;
          if (stream) {
            flushSseBuffer(true);
            if (streamLogLines !== null) {
              logIO(`OUTPUT (stream, ${ms}ms)`, streamLogLines);
            }
            res.end();
          } else {
            const raw = Buffer.concat(chunks).toString();
            const aggregated = aggregateSseToCompletion(raw, requestModel);
            const updated = ensureOpenAIIds(
              aggregated,
              toolCallIds,
              requestModel,
            );
            logIO(`OUTPUT (sync, ${ms}ms)`, updated);
            res.status(200).json(updated);
          }
        }
      });
    });

    req.on("error", (e) => {
      if (intentionalClose || terminalHandled) return;
      if (remaining > 0 && isTransientNetworkError(e)) {
        if (trySchedule("transient", e.message)) return;
      }
      logLine("ERROR", e.message);
      logIO("OUTPUT (error)", { error: e.message });
      if (!res.headersSent) {
        res
          .status(502)
          .json({
            error: {
              message: "Upstream error: " + e.message,
              type: "upstream_error",
            },
          });
      }
    });

    req.on("timeout", () => {
      if (intentionalClose || terminalHandled) return;
      intentionalClose = true;
      req.destroy();
      if (remaining > 0 && trySchedule("transient", "Upstream timeout")) return;
      intentionalClose = false;
      logLine("TIMEOUT");
      logIO("OUTPUT (timeout)", { error: "Upstream timeout" });
      if (!res.headersSent) {
        res
          .status(504)
          .json({
            error: { message: "Upstream timeout", type: "timeout_error" },
          });
      }
    });

    req.write(body);
    req.end();
  }

  attempt(retries);
}
