import { describe, it } from "node:test";
import assert from "node:assert";
import { createApp } from "../src/app.mjs";

describe("GET /health", () => {
  it("returns status ok and known endpoints", async () => {
    const app = createApp();
    const server = app.listen(0);
    const { port } = server.address();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.strictEqual(body.status, "ok");
      assert.ok(body.version);
      assert.ok(Array.isArray(body.endpoints));
      assert.ok(body.endpoints.includes("/v1/chat/completions"));
    } finally {
      server.close();
    }
  });
});
