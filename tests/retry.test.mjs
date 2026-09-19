import { describe, it } from "node:test";
import assert from "node:assert";
import {
  rateLimitRetryDelay,
  delayFromRetryAfter,
  isRateLimitPayload,
  isRateLimitResponse,
  isTransientNetworkError,
  isTransientHttpStatus,
  parseErrorPayload,
  planRetry,
  isClientGone,
  withFreshSession,
  withFreshRequestId,
} from "../src/retry.mjs";
import { getSession, rotateSession } from "../src/session.mjs";

describe("rateLimitRetryDelay", () => {
  it("stays near exponential base with ±20% jitter", () => {
    for (let i = 0; i < 20; i++) {
      const d0 = rateLimitRetryDelay(0, 1000, 60_000);
      assert.ok(d0 >= 800 && d0 <= 1200, `attempt0=${d0}`);
      const d2 = rateLimitRetryDelay(2, 1000, 60_000);
      assert.ok(d2 >= 3200 && d2 <= 4800, `attempt2=${d2}`);
    }
  });

  it("caps near maxMs", () => {
    for (let i = 0; i < 10; i++) {
      const d = rateLimitRetryDelay(10, 1000, 30_000);
      assert.ok(d >= 24_000 && d <= 30_000, `capped=${d}`);
    }
  });

  it("treats negative attempt as 0", () => {
    const d = rateLimitRetryDelay(-1, 1000, 30_000);
    assert.ok(d >= 800 && d <= 1200);
  });
});

describe("delayFromRetryAfter", () => {
  it("uses Retry-After seconds when valid", () => {
    assert.strictEqual(delayFromRetryAfter({ "retry-after": "5" }, 0), 5000);
  });

  it("falls back to exponential when header missing", () => {
    const d = delayFromRetryAfter({}, 0);
    assert.ok(d >= 800 && d <= 1200);
  });
});

describe("rate limit classification", () => {
  it("detects FreeUsageLimitError and 429", () => {
    assert.ok(isRateLimitPayload({ error: { message: "x", type: "FreeUsageLimitError" } }, "FreeUsageLimitError"));
    assert.ok(isRateLimitResponse(429, null, ""));
    assert.ok(isRateLimitPayload({ error: { type: "rate_limit_error", message: "slow down" } }));
  });

  it("does not treat generic errors as rate limit", () => {
    assert.ok(!isRateLimitPayload({ error: { type: "invalid_request_error", message: "bad model" } }));
    assert.ok(!isRateLimitResponse(400, { error: { message: "bad" } }));
  });

  it("parseErrorPayload flags rate-limited vs other", () => {
    const rl = parseErrorPayload(Buffer.from(JSON.stringify({
      error: { message: "quota", type: "rate_limit_error" },
    })));
    assert.ok(rl.rateLimited);
    assert.strictEqual(rl.message, "quota");

    const other = parseErrorPayload(Buffer.from(JSON.stringify({
      error: { message: "nope", type: "invalid_request_error" },
    })));
    assert.ok(other);
    assert.ok(!other.rateLimited);
  });
});

describe("transient helpers", () => {
  it("classifies network errors and http statuses", () => {
    assert.ok(isTransientNetworkError({ code: "ECONNRESET", message: "reset" }));
    assert.ok(isTransientNetworkError({ message: "timeout" }));
    assert.ok(isTransientNetworkError({ message: "socket hang up" }));
    assert.ok(!isTransientNetworkError({ message: "certificate error" }));
    assert.ok(isTransientHttpStatus(502));
    assert.ok(isTransientHttpStatus(503));
    assert.ok(!isTransientHttpStatus(400));
  });
});

describe("planRetry", () => {
  it("rotates only for rate_limit", () => {
    const rl = planRetry({ remaining: 3, retries: 12, kind: "rate_limit", errMsg: "x" });
    assert.ok(rl.rotateSession);
    assert.ok(rl.delay >= 0);
    const tr = planRetry({ remaining: 3, retries: 12, kind: "transient", errMsg: "y" });
    assert.ok(!tr.rotateSession);
    assert.strictEqual(planRetry({ remaining: 0, retries: 12, kind: "rate_limit" }), null);
  });
});

describe("isClientGone", () => {
  // A request whose body was fully consumed has req.destroyed === true and its
  // 'close' event has fired — but the client is still connected and waiting.
  // This must NOT be treated as client-gone (regression: false CLIENT GONE logs
  // caused the proxy to return without ever responding, hanging the client).
  it("does not treat a fully-consumed request as client-gone while res is open", () => {
    const consumedReq = { destroyed: true, aborted: false, complete: true };
    const openRes = { writableEnded: false, destroyed: false, closed: false };
    assert.strictEqual(isClientGone(consumedReq, openRes), false);
  });

  it("treats a genuinely aborted request as client-gone", () => {
    const abortedReq = { destroyed: true, aborted: true };
    const openRes = { writableEnded: false, destroyed: false, closed: false };
    assert.strictEqual(isClientGone(abortedReq, openRes), true);
  });

  it("treats a destroyed/closed response as client-gone", () => {
    const req = { destroyed: true, aborted: false };
    assert.strictEqual(isClientGone(req, { writableEnded: true }), true);
    assert.strictEqual(isClientGone(req, { destroyed: true }), true);
    assert.strictEqual(isClientGone(req, { closed: true }), true);
  });

  it("is false when everything is still open and waiting", () => {
    assert.strictEqual(
      isClientGone({ destroyed: false, aborted: false }, { writableEnded: false, destroyed: false, closed: false }),
      false,
    );
  });
});

describe("session rotation helpers", () => {
  it("rotateSession issues a new id", () => {
    const a = getSession("retry-test-user");
    const b = rotateSession("retry-test-user");
    assert.notStrictEqual(a, b);
    assert.strictEqual(getSession("retry-test-user"), b);
  });

  it("withFreshSession rewrites session and request headers", () => {
    const opts = {
      headers: {
        "x-opencode-session": "ses_old",
        "x-opencode-request": "msg_old",
      },
    };
    const next = withFreshSession(opts, "retry-test-user-2");
    assert.notStrictEqual(next.headers["x-opencode-session"], "ses_old");
    assert.notStrictEqual(next.headers["x-opencode-request"], "msg_old");
    assert.match(next.headers["x-opencode-session"], /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
    assert.match(next.headers["x-opencode-request"], /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
  });

  it("withFreshRequestId keeps session", () => {
    const opts = {
      headers: {
        "x-opencode-session": "ses_keep",
        "x-opencode-request": "msg_old",
      },
    };
    const next = withFreshRequestId(opts);
    assert.strictEqual(next.headers["x-opencode-session"], "ses_keep");
    assert.notStrictEqual(next.headers["x-opencode-request"], "msg_old");
    assert.match(next.headers["x-opencode-request"], /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
  });
});
