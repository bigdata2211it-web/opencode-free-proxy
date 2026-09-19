import fs from "fs";

export const PORT = process.env.PROXY_PORT || 6446;
export const OC_VERSION = "1.18.31";

const pkg = JSON.parse(
  fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
);
export const PROXY_VERSION = pkg.version;

export const MODELS = JSON.parse(
  fs.readFileSync(new URL("../../models.json", import.meta.url), "utf8"),
);
export const KEYS_FILE = process.env.KEYS_FILE || "./api-keys.json";

/** Max rate-limit retries after the first attempt (default 12). */
export const MAX_RETRIES = Math.max(0, Number(process.env.MAX_RETRIES) || 12);
/** Base delay for first retry; doubles each attempt (default 1000ms). */
export const RETRY_BASE_MS = Math.max(0, Number(process.env.RETRY_BASE_MS) || 1000);
/** Cap for exponential backoff (default 30000ms). */
export const RETRY_MAX_MS = Math.max(0, Number(process.env.RETRY_MAX_MS) || 30_000);
