import fs from "fs";
import crypto from "crypto";
import { KEYS_FILE } from "./config/index.mjs";
import { logLine } from "./logger.mjs";

export const apiKeys = {};

export function loadKeys() {
  try {
    Object.assign(apiKeys, JSON.parse(fs.readFileSync(KEYS_FILE, "utf8")));
  } catch {}
  if (Object.keys(apiKeys).length === 0) {
    Object.assign(apiKeys, {
      admin: process.env.ADMIN_API_KEY || "oc-" + crypto.randomBytes(20).toString("hex"),
      "user-default": process.env.USER_DEFAULT_API_KEY || "oc-" + crypto.randomBytes(20).toString("hex"),
    });
    fs.writeFileSync(KEYS_FILE, JSON.stringify(apiKeys, null, 2));
    logLine("Generated new API keys →", KEYS_FILE);
  }
}

export function auth(req) {
  const hdr = req.headers.authorization || req.headers["x-api-key"] || "";
  const tok = hdr.startsWith("Bearer ") ? hdr.slice(7) : hdr;
  const tokBuf = Buffer.from(tok);
  for (const [name, key] of Object.entries(apiKeys)) {
    const keyBuf = Buffer.from(key);
    if (keyBuf.length === tokBuf.length && crypto.timingSafeEqual(keyBuf, tokBuf)) return name;
  }
  return null;
}
