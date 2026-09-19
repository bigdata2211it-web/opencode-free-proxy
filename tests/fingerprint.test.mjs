import { describe, it } from "node:test";
import assert from "node:assert";
import { ensureFingerprintTools, zenRequest } from "../src/client.mjs";

describe("ensureFingerprintTools", () => {
  it("injects bash, glob, grep, read when the client sent no tools", () => {
    const out = ensureFingerprintTools(undefined);
    assert.deepStrictEqual(
      out.map((t) => t.function.name).sort(),
      ["bash", "glob", "grep", "read"],
    );
  });

  it("keeps Cursor-style tools and only fills missing fingerprint names", () => {
    const cursor = ["read_file", "list_dir", "grep", "codebase_search", "run_terminal_cmd"].map(
      (name) => ({
        type: "function",
        function: { name, parameters: { type: "object", properties: {} } },
      }),
    );
    const out = ensureFingerprintTools(cursor);
    const names = out.map((t) => t.function.name);
    assert.ok(names.includes("read_file"));
    assert.ok(names.includes("grep"));
    assert.ok(names.includes("bash"));
    assert.ok(names.includes("read"));
    assert.ok(names.includes("glob"));
    assert.strictEqual(names.filter((n) => n === "grep").length, 1);
  });
});

describe("zenRequest fingerprint", () => {
  it("always sends stream:true upstream even when the client asked for sync", () => {
    const { body } = zenRequest(
      "mimo-v2.5-free",
      [{ role: "user", content: "hi" }],
      false,
      undefined,
      undefined,
      "ses_aaaaaaaaaaaaAAAAAAAAAAAA",
    );
    const parsed = JSON.parse(body);
    assert.strictEqual(parsed.stream, true);
  });

  it("injects the fingerprint tool quartet for a plain chat request", () => {
    const { body } = zenRequest(
      "mimo-v2.5-free",
      [{ role: "user", content: "hi" }],
      true,
      undefined,
      undefined,
      "ses_aaaaaaaaaaaaAAAAAAAAAAAA",
    );
    const parsed = JSON.parse(body);
    const names = (parsed.tools || []).map((t) => t.function?.name).sort();
    assert.deepStrictEqual(names, ["bash", "glob", "grep", "read"]);
    assert.strictEqual(parsed.tool_choice, "none");
  });

  it("does not force tool_choice none when the client already sent tools", () => {
    const { body } = zenRequest(
      "mimo-v2.5-free",
      [{ role: "user", content: "hi" }],
      true,
      [
        {
          type: "function",
          function: { name: "read_file", parameters: { type: "object", properties: {} } },
        },
      ],
      "auto",
      "ses_aaaaaaaaaaaaAAAAAAAAAAAA",
    );
    const parsed = JSON.parse(body);
    assert.strictEqual(parsed.tool_choice, "auto");
    const names = parsed.tools.map((t) => t.function.name);
    assert.ok(names.includes("read_file"));
    assert.ok(names.includes("bash"));
    assert.ok(names.includes("read"));
  });
});
