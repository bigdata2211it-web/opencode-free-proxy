import https from "https";
import { MAX_RETRIES } from "./config/index.mjs";
import { logLine, logIO } from "./logger.mjs";
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

const NO_CACHE = { cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };

// ── main pipe ──────────────────────────────────────────────────────────────

/**
 * Relay an OpenAI-format request to the Zen API and pipe the response back
 * as an Anthropic SSE stream (message_start / content_block_* / message_delta).
 * Retries on rate-limit / transient errors with backoff; rotates session on 429.
 *
 * @param {object} [ctx]
 * @param {string} [ctx.user]
 * @param {import("http").IncomingMessage} [ctx.clientReq]
 * @param {number} [ctx.retries]
 */
export function pipeZenAsAnthropic(
  zenOpts,
  body,
  model,
  res,
  inputTokens,
  ctx = {},
) {
  const { user, clientReq, retries = MAX_RETRIES } = ctx;
  const msgId = ocId("msg");

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

    const t0 = Date.now();
    let collectedText = "";
    const collectedTools = {};
    let stopReasonLogged = null;
    let intentionalClose = false;
    let terminalHandled = false;

    function failRateLimit(errMsg) {
      if (terminalHandled || res.headersSent) return;
      terminalHandled = true;
      logLine("RATE LIMITED, exhausted retries", errMsg);
      logIO("OUTPUT (rate_limit)", { error: errMsg });
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          type: "error",
          error: {
            type: "rate_limit_error",
            message: errMsg + " (free model rate limit)",
          },
        }),
      );
    }

    function failUpstream(status, errMsg, type = "upstream_error") {
      if (terminalHandled || res.headersSent) return;
      terminalHandled = true;
      logLine("UPSTREAM ERROR", errMsg);
      logIO("OUTPUT (error)", { error: errMsg });
      res
        .status(status)
        .json({ type: "error", error: { type, message: errMsg } });
    }

    /** @returns {boolean} true if a retry was scheduled */
    function trySchedule(kind, errMsg, headers) {
      if (gone()) {
        logLine("CLIENT GONE, aborting retries");
        intentionalClose = true;
        return true;
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
      let headersSent = false;
      let buffer = "";
      let outputTokens = 0;
      let contentIdx = 0;
      let toolIdx = -1;
      let firstChunkHandled = false;
      let skipEnd = false;
      const startedBlocks = new Set();
      const status = zenRes.statusCode || 0;

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
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        res.flushHeaders();

        sendSSE("message_start", {
          type: "message_start",
          message: {
            id: msgId,
            type: "message",
            role: "assistant",
            content: [],
            model,
            stop_reason: null,
            usage: {
              input_tokens: inputTokens || 0,
              output_tokens: 0,
              ...NO_CACHE,
            },
          },
        });
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
        const str = chunk.toString();

        if (!firstChunkHandled) {
          firstChunkHandled = true;
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
        }

        buffer += str;
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const payload = line.slice(6).trim();
          if (payload === "[DONE]") continue;

          let parsed;
          try {
            parsed = JSON.parse(payload);
          } catch {
            continue;
          }
          const delta = parsed.choices?.[0]?.delta;
          if (!delta) continue;

          sendHeaders();

          if (delta.content) {
            collectedText += delta.content;
            if (contentIdx === 0 && toolIdx === -1) {
              sendSSE("content_block_start", {
                type: "content_block_start",
                index: 0,
                content_block: { type: "text", text: "" },
              });
              startedBlocks.add(0);
              contentIdx = 1;
            }
            sendSSE("content_block_delta", {
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: delta.content },
            });
            outputTokens += Math.ceil(delta.content.length / 4);
          }

          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              if (idx > toolIdx) {
                if (toolIdx === -1 && contentIdx > 0) {
                  sendSSE("content_block_stop", {
                    type: "content_block_stop",
                    index: 0,
                  });
                }
                toolIdx = idx;
                const blockIdx = contentIdx > 0 ? idx + 1 : idx;
                const toolId = tc.id || ocId("toolu");
                collectedTools[idx] = {
                  id: toolId,
                  name: tc.function?.name || "",
                  arguments: "",
                };
                sendSSE("content_block_start", {
                  type: "content_block_start",
                  index: blockIdx,
                  content_block: {
                    type: "tool_use",
                    id: toolId,
                    name: tc.function?.name || "",
                  },
                });
                startedBlocks.add(blockIdx);
              }
              if (tc.function?.arguments) {
                if (collectedTools[idx])
                  collectedTools[idx].arguments += tc.function.arguments;
                const blockIdx = contentIdx > 0 ? idx + 1 : idx;
                sendSSE("content_block_delta", {
                  type: "content_block_delta",
                  index: blockIdx,
                  delta: {
                    type: "input_json_delta",
                    partial_json: tc.function.arguments,
                  },
                });
                outputTokens += Math.ceil(tc.function.arguments.length / 4);
              }
            }
          }

          if (parsed.choices?.[0]?.finish_reason) {
            const fr = parsed.choices[0].finish_reason;
            const sortedBlocks = [...startedBlocks].sort((a, b) => a - b);
            for (const i of sortedBlocks) {
              sendSSE("content_block_stop", {
                type: "content_block_stop",
                index: i,
              });
            }

            let stopReason = "end_turn";
            if (fr === "tool_calls") stopReason = "tool_use";
            else if (fr === "length") stopReason = "max_tokens";
            stopReasonLogged = stopReason;

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
        if (skipEnd || terminalHandled) return;
        if (!headersSent) {
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
          logIO("OUTPUT (empty)", { error: "Empty response" });
          if (!res.headersSent) {
            res
              .status(502)
              .json({
                type: "error",
                error: { type: "upstream_error", message: "Empty response" },
              });
          }
          return;
        }
        const ms = Date.now() - t0;
        const out = {
          content: collectedText || null,
          stop_reason: stopReasonLogged,
          output_tokens: outputTokens,
        };
        const tools = Object.values(collectedTools);
        if (tools.length) out.tool_calls = tools;
        logIO(`OUTPUT (stream, ${ms}ms)`, out);
        res.end();
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
            type: "error",
            error: { type: "upstream_error", message: e.message },
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
            type: "error",
            error: { type: "timeout_error", message: "Upstream timeout" },
          });
      }
    });

    req.write(body);
    req.end();
  }

  attempt(retries);
}
