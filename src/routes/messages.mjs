import { Router } from "express";
import { MAX_RETRIES } from "../config/index.mjs";
import { aggregateSseToCompletion } from "../pipe-openai.mjs";
import { auth } from "../auth.mjs";
import { getSession } from "../session.mjs";
import { zenRequest, zenRequestFull } from "../client.mjs";
import { pipeZenAsAnthropic } from "../pipe-anthropic.mjs";
import { anthropicToOpenAI } from "../to-openai.mjs";
import { openAIToAnthropic } from "../to-anthropic.mjs";
import { logLine, logIO, msgSummary } from "../logger.mjs";
import {
  rateLimitRetryDelay,
  delayFromRetryAfter,
  sleep,
  isClientGone,
  isRateLimitResponse,
  isTransientHttpStatus,
  isTransientNetworkError,
  parseErrorPayload,
  withFreshSession,
  withFreshRequestId,
} from "../retry.mjs";

const router = Router();

// Express 5 auto-forwards rejected promises from async handlers to the error middleware.
router.post("/v1/messages", async (req, res) => {
  const user = auth(req);
  if (!user) {
    return res
      .status(401)
      .json({
        type: "error",
        error: { type: "authentication_error", message: "Invalid API key" },
      });
  }

  // Express 5: unparsed body is `undefined` (was `{}` in v4)
  if (req.body == null || typeof req.body !== "object") {
    return res.status(400).json({
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "Request body must be JSON",
      },
    });
  }

  const { model, stream } = req.body;
  if (typeof model !== "string" || !model.trim()) {
    return res.status(400).json({
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "model is required",
      },
    });
  }

  const sessionId = getSession(user);
  const { messages, tools } = anthropicToOpenAI(req.body);
  const inputTokens = (JSON.stringify(messages).length / 4) | 0;

  logLine(
    user,
    model,
    stream ? "stream" : "sync",
    "msgs:",
    JSON.stringify(msgSummary(messages)),
  );
  logIO("INPUT", {
    model,
    stream: !!stream,
    system: req.body.system,
    tools: req.body.tools?.length ? req.body.tools : undefined,
    messages: req.body.messages,
    _converted: { messages, tools: tools?.length ? tools : undefined },
  });

  let { body, options } = zenRequest(
    model,
    messages,
    stream,
    tools,
    undefined,
    sessionId,
  );

  if (stream) {
    pipeZenAsAnthropic(options, body, model, res, inputTokens, {
      user,
      clientReq: req,
    });
    return;
  }

  try {
    const t0 = Date.now();
    let zenResp;
    let lastTransientErr = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (isClientGone(req, res)) {
        logLine("CLIENT GONE, aborting retries");
        return;
      }

      try {
        zenResp = await zenRequestFull(options, body);
        lastTransientErr = null;
      } catch (e) {
        lastTransientErr = e;
        if (attempt < MAX_RETRIES && isTransientNetworkError(e)) {
          const delay = rateLimitRetryDelay(attempt);
          logLine(
            `TRANSIENT, retrying (${MAX_RETRIES - attempt} left, wait ${delay}ms)`,
            e.message,
          );
          options = withFreshRequestId(options);
          await sleep(delay);
          continue;
        }
        throw e;
      }

      const rateLimited = isRateLimitResponse(
        zenResp.status,
        zenResp.data,
        zenResp.raw,
      );
      if (rateLimited) {
        if (attempt < MAX_RETRIES) {
          const errMsg = zenResp.data?.error?.message || "Rate limit exceeded";
          const delay = delayFromRetryAfter(zenResp.headers, attempt);
          logLine(
            `RATE LIMITED, retrying (${MAX_RETRIES - attempt} left, wait ${delay}ms)`,
            errMsg,
          );
          options = withFreshSession(options, user);
          await sleep(delay);
          continue;
        }
        break;
      }

      // Non-rate-limit API error — surface immediately, do not burn retries
      const errInfo = parseErrorPayload(zenResp.data, zenResp.raw);
      if (errInfo) break;

      if (isTransientHttpStatus(zenResp.status) && attempt < MAX_RETRIES) {
        const delay = rateLimitRetryDelay(attempt);
        logLine(
          `TRANSIENT, retrying (${MAX_RETRIES - attempt} left, wait ${delay}ms)`,
          `HTTP ${zenResp.status}`,
        );
        options = withFreshRequestId(options);
        await sleep(delay);
        continue;
      }

      break;
    }

    if (isClientGone(req, res)) return;

    const ms = Date.now() - t0;

    if (lastTransientErr) {
      logIO(`OUTPUT (error, ${ms}ms)`, { error: lastTransientErr.message });
      return res.status(502).json({
        type: "error",
        error: { type: "upstream_error", message: lastTransientErr.message },
      });
    }

    if (isRateLimitResponse(zenResp.status, zenResp.data, zenResp.raw)) {
      const errMsg = zenResp.data?.error?.message || "Rate limit exceeded";
      logIO(`OUTPUT (rate_limit, ${ms}ms)`, { error: errMsg });
      return res.status(429).json({
        type: "error",
        error: {
          type: "rate_limit_error",
          message: errMsg + " (free model rate limit)",
        },
      });
    }

    const errInfo = parseErrorPayload(zenResp.data, zenResp.raw);
    if (errInfo) {
      logIO(`OUTPUT (error, ${ms}ms)`, { error: errInfo.message });
      let status = zenResp.status >= 400 ? zenResp.status : 502;
      return res.status(status).json({
        type: "error",
        error: {
          type: errInfo.data?.error?.type || "upstream_error",
          message: errInfo.message,
        },
      });
    }

    if (isTransientHttpStatus(zenResp.status)) {
      logIO(`OUTPUT (error, ${ms}ms)`, { error: `HTTP ${zenResp.status}` });
      return res.status(zenResp.status).json({
        type: "error",
        error: {
          type: "upstream_error",
          message: `Upstream HTTP ${zenResp.status}`,
        },
      });
    }

    if (!zenResp.data?.choices && zenResp.raw) {
      zenResp.data = aggregateSseToCompletion(zenResp.raw, model);
    }
    if (!zenResp.data?.choices) {
      logIO(`OUTPUT (invalid, ${ms}ms)`, { raw: zenResp.raw });
      return res.status(502).json({
        type: "error",
        error: { type: "upstream_error", message: "Invalid upstream response" },
      });
    }
    const antResp = openAIToAnthropic(zenResp.data, model, inputTokens);
    logIO(`OUTPUT (sync, ${ms}ms)`, antResp);
    res.json(antResp);
  } catch (e) {
    logLine("ZEN", "ERROR", e.message);
    logIO("OUTPUT (error)", { error: e.message });
    res
      .status(502)
      .json({
        type: "error",
        error: { type: "upstream_error", message: e.message },
      });
  }
});

export default router;
