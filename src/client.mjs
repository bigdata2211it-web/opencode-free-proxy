import https from "https";
import { ocId } from "./utils.mjs";
import { OC_VERSION } from "./config/index.mjs";

/** Names Zen's free-tier gate requires on the request. Extras are allowed. */
export const FINGERPRINT_TOOLS = ["bash", "glob", "grep", "read"];

const DECOY_DESCRIPTION = "This tool is currently unavailable and must not be used.";

function decoyTool(name) {
  return {
    type: "function",
    function: {
      name,
      description: DECOY_DESCRIPTION,
      parameters: { type: "object", properties: {} },
    },
  };
}

function toolName(t) {
  return t?.function?.name || t?.name || "";
}

/** Merge caller tools with the fingerprint quartet. Never duplicates a name. */
export function ensureFingerprintTools(tools) {
  const list = Array.isArray(tools) ? tools.filter((t) => toolName(t)) : [];
  const names = new Set(list.map(toolName));
  for (const name of FINGERPRINT_TOOLS) {
    if (!names.has(name)) list.push(decoyTool(name));
  }
  return list;
}

export function zenRequest(model, messages, _stream, tools, tool_choice, sessionId) {
  // Zen 403s FreeTierError unless the request looks like the official client:
  // stream:true + {bash, glob, grep, read} (caller tools are kept).
  const hadClientTools = Array.isArray(tools) && tools.length > 0;
  const reqBody = {
    model,
    messages,
    stream: true,
    tools: ensureFingerprintTools(tools),
  };
  if (tool_choice) reqBody.tool_choice = tool_choice;
  else if (!hadClientTools) reqBody.tool_choice = "none";
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
        "Accept": "text/event-stream",
        "Content-Length": Buffer.byteLength(body),
        "Authorization": "Bearer public",
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

export function zenRequestFull(zenOpts, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(zenOpts, (zenRes) => {
      const chunks = [];
      zenRes.on("data", (c) => chunks.push(c));
      zenRes.on("end", () => {
        const raw = Buffer.concat(chunks).toString();
        const headers = zenRes.headers;
        try {
          resolve({ status: zenRes.statusCode, data: JSON.parse(raw), raw, headers });
        } catch {
          resolve({ status: zenRes.statusCode, data: null, raw, headers });
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.write(body);
    req.end();
  });
}
