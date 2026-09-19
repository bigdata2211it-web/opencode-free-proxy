import { describe, it, after } from "node:test";
import assert from "node:assert";
import fs from "fs";
import os from "os";
import path from "path";

const tmpKeys = path.join(os.tmpdir(), `opencode-test-keys-${Date.now()}.json`);
process.env.KEYS_FILE = tmpKeys;

const { loadKeys, apiKeys, auth } = await import("../src/auth.mjs");

describe("auth", () => {
  after(() => {
    try { fs.unlinkSync(tmpKeys); } catch {}
  });

  it("generates default keys when file is missing", () => {
    loadKeys();
    assert.ok(apiKeys.admin, "admin key missing");
    assert.ok(apiKeys["user-default"], "user-default key missing");
    assert.ok(fs.existsSync(tmpKeys), "keys file was not written");
  });

  it("authenticates with Authorization: Bearer", () => {
    const req = { headers: { authorization: `Bearer ${apiKeys.admin}` } };
    assert.strictEqual(auth(req), "admin");
  });

  it("authenticates with x-api-key header", () => {
    const req = { headers: { "x-api-key": apiKeys["user-default"] } };
    assert.strictEqual(auth(req), "user-default");
  });

  it("rejects invalid keys", () => {
    const req = { headers: { authorization: "Bearer invalid-key" } };
    assert.strictEqual(auth(req), null);
  });
});
