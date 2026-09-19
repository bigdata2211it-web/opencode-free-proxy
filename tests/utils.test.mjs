import { describe, it } from "node:test";
import assert from "node:assert";
import { ocId } from "../src/utils.mjs";

/** OpenCode Identifier.create("ascending"): prefix_ + 12 hex time bytes + 14 base62. */
const OC_ID = /^[a-z]+_[0-9a-f]{12}[0-9A-Za-z]{14}$/;

describe("ocId", () => {
  it("matches the OpenCode Identifier format Zen now validates", () => {
    const ses = ocId("ses");
    const msg = ocId("msg");
    assert.match(ses, OC_ID);
    assert.match(msg, OC_ID);
    assert.ok(ses.startsWith("ses_"));
    assert.ok(msg.startsWith("msg_"));
    assert.strictEqual(ses.length, "ses_".length + 26);
  });

  it("does not emit base64url characters that fail the free-tier gate", () => {
    for (let i = 0; i < 40; i++) {
      const id = ocId("ses");
      assert.doesNotMatch(id, /[-]/);
      assert.equal(id.split("_").length, 2);
    }
  });

  it("is unique across rapid calls", () => {
    const ids = new Set(Array.from({ length: 50 }, () => ocId("ses")));
    assert.strictEqual(ids.size, 50);
  });
});
