// Detailed I/O logging for the proxy.
// LOG_DETAIL=0 to disable full dumps; LOG_MAX_CHARS=N to truncate (0 = unlimited).
// NO_COLOR=1 disables ANSI color; FORCE_COLOR=1 forces it (default: auto on TTY).

export const LOG_DETAIL = process.env.LOG_DETAIL !== "0";
export const LOG_MAX_CHARS = Number(process.env.LOG_MAX_CHARS || 0) || 0;

// ── ANSI color helpers ──────────────────────────────────────────────────────

const USE_COLOR =
  process.env.FORCE_COLOR !== undefined
    ? true
    : process.env.NO_COLOR === undefined && process.stdout.isTTY;

const c = USE_COLOR
  ? {
      reset: "\x1b[0m",
      bright: "\x1b[1m",
      dim: "\x1b[2m",
      cyan: "\x1b[36m",
      yellow: "\x1b[33m",
      green: "\x1b[32m",
      red: "\x1b[31m",
      gray: "\x1b[90m",
    }
  : // No-op passthrough when colors are off
    { reset: "", bright: "", dim: "", cyan: "", yellow: "", green: "", red: "", gray: "" };

function labelStr(label) {
  return `${c.yellow}${c.bright}[${label}]${c.reset}`;
}

// ── helpers ─────────────────────────────────────────────────────────────────

function trunc(str) {
  if (typeof str !== "string") str = String(str);
  if (!LOG_MAX_CHARS || str.length <= LOG_MAX_CHARS) return str;
  return str.slice(0, LOG_MAX_CHARS) + `\n... [truncated, total ${str.length} chars]`;
}

/** Log a one-line summary with timestamp. */
export function logLine(...args) {
  console.log("[proxy]", new Date().toISOString(), ...args);
}

/** Pretty-print a labeled I/O block (request/response body). */
export function logIO(label, payload) {
  if (!LOG_DETAIL) return;
  const body = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
  console.log(
    `${labelStr(label)}\n${trunc(body)}\n${labelStr("/" + label)}`,
  );
}

export function logStatusLine() {
  console.log(
    `  ${c.dim}Log detail:${c.reset}`,
    LOG_DETAIL ? `${c.green}on${c.reset}` : `${c.red}off${c.reset}`,
    LOG_MAX_CHARS ? `${c.gray}(max ${LOG_MAX_CHARS} chars)${c.reset}` : `${c.gray}(unlimited)${c.reset}`,
    USE_COLOR ? `${c.gray}(color)${c.reset}` : "",
  );
}

// ── downstream helpers (unchanged) ─���────────────────────────────────────────

export function msgSummary(messages) {
  return (messages || []).map((m) => {
    const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content || "");
    const s = { role: m.role, len: content.length };
    if (m.tool_calls?.length) s.tool_calls = m.tool_calls.length;
    if (m.tool_call_id) s.tool_call_id = m.tool_call_id;
    return s;
  });
}


