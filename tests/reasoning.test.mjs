import { describe, it } from "node:test";
import assert from "node:assert";
import { ensureAssistantReasoning } from "../src/reasoning.mjs";
import { anthropicToOpenAI } from "../src/to-openai.mjs";

describe("ensureAssistantReasoning", () => {
  it("adds empty reasoning_content to assistant messages that lack it", () => {
    const messages = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "user", content: "again" },
    ];
    ensureAssistantReasoning(messages);
    assert.strictEqual(messages[1].reasoning_content, "");
  });

  it("preserves existing reasoning_content", () => {
    const messages = [
      { role: "assistant", content: "sum", reasoning_content: "I compute 1+1" },
    ];
    ensureAssistantReasoning(messages);
    assert.strictEqual(messages[0].reasoning_content, "I compute 1+1");
  });

  it("leaves user and tool messages untouched", () => {
    const messages = [
      { role: "user", content: "x" },
      { role: "tool", content: "r" },
    ];
    ensureAssistantReasoning(messages);
    assert.strictEqual(messages[0].reasoning_content, undefined);
    assert.strictEqual(messages[1].reasoning_content, undefined);
  });

  it("handles undefined / null messages gracefully", () => {
    const messages = [null, undefined, { role: "assistant" }];
    ensureAssistantReasoning(messages);
    assert.strictEqual(messages[2].reasoning_content, "");
  });
});

describe("anthropicToOpenAI reasoning passthrough", () => {
  it("maps Anthropic thinking content blocks to reasoning_content", () => {
    const body = {
      model: "x",
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "let me compute 1+1" },
            { type: "text", text: "2" },
          ],
        },
      ],
    };
    const { messages } = anthropicToOpenAI(body);
    assert.strictEqual(messages[1].content, "2");
    assert.strictEqual(messages[1].reasoning_content, "let me compute 1+1");
    assert.strictEqual(messages[0].reasoning_content, undefined);
  });

  it("adds empty reasoning_content to assistant messages without thinking blocks", () => {
    const body = {
      model: "x",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "plain answer" },
      ],
    };
    const { messages } = anthropicToOpenAI(body);
    assert.strictEqual(messages[1].content, "plain answer");
    assert.strictEqual(messages[1].reasoning_content, "");
  });
});