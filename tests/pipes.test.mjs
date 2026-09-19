import { describe, it } from "node:test";
import assert from "node:assert";
import { ensureOpenAIIds, aggregateSseToCompletion } from "../src/pipe-openai.mjs";

describe("ensureOpenAIIds", () => {
  it("injects a top-level id when missing", () => {
    const payload = { object: "chat.completion", choices: [] };
    ensureOpenAIIds(payload);
    assert.match(payload.id, /^chatcmpl_/);
  });

  it("injects object, created, and model when missing", () => {
    const payload = { choices: [] };
    ensureOpenAIIds(payload, {}, "test-model");
    assert.strictEqual(payload.object, "chat.completion");
    assert.strictEqual(typeof payload.created, "number");
    assert.strictEqual(payload.model, "test-model");
  });

  it("keeps an existing top-level id", () => {
    const payload = { id: "chatcmpl-keep", choices: [] };
    ensureOpenAIIds(payload);
    assert.strictEqual(payload.id, "chatcmpl-keep");
  });

  it("injects ids and type into non-streaming message.tool_calls", () => {
    const payload = {
      id: "chatcmpl-1",
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            { function: { name: "grep", arguments: "{}" } },
            { function: { name: "ls", arguments: "{}" } },
          ],
        },
        finish_reason: "tool_calls",
      }],
    };
    ensureOpenAIIds(payload);
    const tcs = payload.choices[0].message.tool_calls;
    assert.match(tcs[0].id, /^call_/);
    assert.match(tcs[1].id, /^call_/);
    assert.notStrictEqual(tcs[0].id, tcs[1].id);
    assert.strictEqual(tcs[0].type, "function");
    assert.strictEqual(tcs[1].type, "function");
  });

  it("caches ids across streaming deltas for the same tool call index", () => {
    const toolCallIds = {};
    const p1 = {
      id: "chatcmpl-2",
      choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "grep" } }] } }],
    };
    const p2 = {
      id: "chatcmpl-2",
      choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "{\"p" } }] } }],
    };
    const p3 = {
      id: "chatcmpl-2",
      choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "attern\":\"x\"}" } }] } }],
    };
    ensureOpenAIIds(p1, toolCallIds);
    ensureOpenAIIds(p2, toolCallIds);
    ensureOpenAIIds(p3, toolCallIds);

    assert.match(p1.choices[0].delta.tool_calls[0].id, /^call_/);
    assert.strictEqual(p2.choices[0].delta.tool_calls[0].id, p1.choices[0].delta.tool_calls[0].id);
    assert.strictEqual(p3.choices[0].delta.tool_calls[0].id, p1.choices[0].delta.tool_calls[0].id);
  });

  it("uses existing ids when provided by upstream", () => {
    const payload = {
      id: "chatcmpl-3",
      choices: [{
        message: {
          tool_calls: [{ id: "call_existing", function: { name: "grep" } }],
        },
      }],
    };
    ensureOpenAIIds(payload);
    assert.strictEqual(payload.choices[0].message.tool_calls[0].id, "call_existing");
  });
});

describe("aggregateSseToCompletion", () => {
  it("folds streamed content deltas into one assistant message", () => {
    const raw = [
      'data: {"id":"chatcmpl-x","object":"chat.completion.chunk","created":1,"model":"mimo-v2.5-free","choices":[{"index":0,"delta":{"role":"assistant","content":"Hel"}}]}',
      'data: {"choices":[{"index":0,"delta":{"content":"lo"}}]}',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
      "data: [DONE]",
    ].join("\n");
    const out = aggregateSseToCompletion(raw, "mimo-v2.5-free");
    assert.strictEqual(out.object, "chat.completion");
    assert.strictEqual(out.choices[0].message.content, "Hello");
    assert.strictEqual(out.choices[0].finish_reason, "stop");
    assert.strictEqual(out.model, "mimo-v2.5-free");
  });
});
