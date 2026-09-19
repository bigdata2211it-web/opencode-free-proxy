import { describe, it } from "node:test";
import assert from "node:assert";
import { createApp } from "../src/app.mjs";
import { MODELS } from "../src/config/index.mjs";

describe("GET /v1/models", () => {
  it("lists all configured models", async () => {
    const app = createApp();
    const server = app.listen(0);
    const { port } = server.address();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/models`);
      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.strictEqual(body.object, "list");
      assert.strictEqual(body.data.length, MODELS.length);
      for (const item of body.data) {
        assert.strictEqual(item.object, "model");
        assert.ok(MODELS.includes(item.id));
      }
    } finally {
      server.close();
    }
  });
});
