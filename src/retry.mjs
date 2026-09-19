import { RETRY_BASE_MS, RETRY_MAX_MS } from "./config/index.mjs";
import { rotateSession } from "./session.mjs";
import { ocId } from "./utils.mjs";
import { logLine } from "./logger.mjs";

/**
 * Exponential backoff with ±20% jitter.
 * @param {number} attemptIndex 0 = first retry after initial failure
 */
export function rateLimitRetryDelay(
  attemptIndex,
  baseMs = RETRY_BASE_MS,
  maxMs = RETRY_MAX_MS,
) {
  const exp = Math.max(0, attemptIndex | 0);
  const base = Math.min(maxMs, baseMs * 2 ** exp);
  const jitter = base * 0.2 * (Math.random() * 2 - 1);
  return Math.max(0, Math.min(maxMs, Math.round(base + jitter)));
}

/** Prefer Retry-After header when present; otherwise exponential backoff. */
export function delayFromRetryAfter(headers, attemptIndex) {
  const ra = headers?.["retry-after"] ?? headers?.["Retry-After"];
  if (ra != null && ra !== "") {
    const sec = Number(ra);
    if (Number.isFinite(sec) && sec >= 0) {
      return Math.min(RETRY_MAX_MS, Math.round(sec * 1000));
    }
  }
  return rateLimitRetryDelay(attemptIndex);
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function isClientGone(clientReq, res) {
  // A response that is ended/destroyed/closed means the client connection is
  // done (we finished, or it dropped before we could finish).
  if (res?.writableEnded || res?.destroyed || res?.closed) return true;
  // The request's 'close'/'destroyed' are NOT reliable here: Node auto-destroys
  // the req stream as soon as the request body is fully consumed (so `destroyed`
  // becomes true) even though the client is still connected and waiting for our
  // response. Only `req.aborted` is set on a genuine early client abort.
  if (clientReq?.aborted) return true;
  return false;
}

/** New session id + fresh request id (for rate-limit retries). */
export function withFreshSession(zenOpts, user) {
  const sessionId = user
    ? rotateSession(user)
    : zenOpts.headers?.["x-opencode-session"];
  return {
    ...zenOpts,
    headers: {
      ...zenOpts.headers,
      "x-opencode-session": sessionId,
      "x-opencode-request": ocId("msg"),
    },
  };
}

/** Keep session, mint a new request id (for transient retries). */
export function withFreshRequestId(zenOpts) {
  return {
    ...zenOpts,
    headers: {
      ...zenOpts.headers,
      "x-opencode-request": ocId("msg"),
    },
  };
}

export function isTransientNetworkError(err) {
  if (!err) return false;
  const code = err.code || "";
  const msg = String(err.message || "");
  if (msg === "timeout" || code === "ETIMEDOUT" || code === "ESOCKETTIMEDOUT")
    return true;
  if (
    [
      "ECONNRESET",
      "ECONNREFUSED",
      "EPIPE",
      "ENOTFOUND",
      "EAI_AGAIN",
      "ECONNABORTED",
    ].includes(code)
  ) {
    return true;
  }
  if (/socket hang up/i.test(msg)) return true;
  return false;
}

export function isTransientHttpStatus(status) {
  return status === 502 || status === 503 || status === 504;
}

export function isRateLimitPayload(data, raw = "") {
  const s = raw || (data ? JSON.stringify(data) : "");
  if (s.includes("FreeUsageLimitError")) return true;
  const type = data?.error?.type || data?.type;
  const code = data?.error?.code;
  if (type === "rate_limit_error" || code === "rate_limit_exceeded")
    return true;
  const msg = data?.error?.message || data?.message || "";
  if (/rate\s*limit|usage\s*limit|too many requests|freeusage/i.test(msg))
    return true;
  return false;
}

export function isRateLimitResponse(status, data, raw = "") {
  if (status === 429) return true;
  return isRateLimitPayload(data, raw);
}

/**
 * Parse a Zen first-chunk / body that may be a JSON error object.
 * @returns {null | { message: string, rateLimited: boolean, data: object }}
 */
export function parseErrorPayload(chunkOrData, raw = "") {
  let data = chunkOrData;
  let str = raw;
  if (Buffer.isBuffer(chunkOrData) || typeof chunkOrData === "string") {
    str = chunkOrData.toString().trim();
    if (!str.startsWith("{")) return null;
    if (!str.includes("FreeUsageLimitError") && !str.includes('"error"'))
      return null;
    try {
      data = JSON.parse(str);
    } catch {
      return null;
    }
  }
  if (!data || typeof data !== "object") return null;
  if (!data.error && data.type !== "error") return null;
  const message = data.error?.message || data.message || "Upstream error";
  return {
    message,
    rateLimited: isRateLimitPayload(data, str || JSON.stringify(data)),
    data,
  };
}

/**
 * Shared retry decision for streaming pipes.
 * Mutates nothing; caller applies session/opts and schedules.
 */
export function planRetry({ remaining, retries, kind, headers, errMsg }) {
  if (remaining <= 0) return null;
  const attemptIndex = retries - remaining;
  const delay =
    kind === "rate_limit"
      ? delayFromRetryAfter(headers, attemptIndex)
      : rateLimitRetryDelay(attemptIndex);
  return {
    delay,
    rotateSession: kind === "rate_limit",
    label:
      kind === "rate_limit" ? "RATE LIMITED, retrying" : "TRANSIENT, retrying",
    errMsg: errMsg || kind,
  };
}

export function logAndScheduleRetry(plan, remaining, schedule) {
  logLine(plan.label, `(${remaining} left, wait ${plan.delay}ms)`, plan.errMsg);
  schedule(plan.delay);
}
