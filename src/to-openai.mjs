import { ensureAssistantReasoning } from "./reasoning.mjs";

/** Extract plain text from an Anthropic content field that may be a string or an array of content blocks. */
function contentText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(c => c.text || "").join("\n");
  return "";
}

/** Joins Anthropic `thinking` content blocks into a single reasoning string. */
function reasoningText(blocks) {
  const text = (blocks || [])
    .filter(b => b.type === "thinking")
    .map(b => (typeof b.thinking === "string" ? b.thinking : b.text || ""))
    .join("\n");
  return text;
}

/** Build an assistant message with tool_calls from tool_use blocks. */
function buildToolUseMessage(text, toolUses) {
  return {
    role: "assistant",
    content: text || null,
    tool_calls: toolUses.map(t => ({
      id: t.id,
      type: "function",
      function: { name: t.name, arguments: JSON.stringify(t.input || {}) },
    })),
  };
}

/** Build tool-result messages from tool_result blocks. */
function buildToolResultMessages(toolResults) {
  return toolResults
    .filter(b => b.type === "tool_result")
    .map(b => ({ role: "tool", tool_call_id: b.tool_use_id, content: contentText(b.content) }));
}

/** Convert a single Anthropic message with array content into one or more OpenAI messages. */
function convertContentBlock(msg) {
  const blocks = msg.content;
  const text = contentText(blocks.filter(b => b.type === "text"));
  const toolUses = blocks.filter(b => b.type === "tool_use");
  const reasoning = reasoningText(blocks);

  // Assistant with tool calls
  if (toolUses.length && msg.role === "assistant") {
    const m = buildToolUseMessage(text, toolUses);
    m.reasoning_content = reasoning;
    return [m];
  }

  // Tool result blocks
  if (blocks.some(b => b.type === "tool_result")) {
    return buildToolResultMessages(blocks);
  }

  // Plain text array (or non-tool content blocks)
  const m = { role: msg.role, content: text };
  if (msg.role === "assistant") m.reasoning_content = reasoning;
  return [m];
}

/** Convert an Anthropic /v1/messages body into OpenAI /v1/chat/completions format. */
export function anthropicToOpenAI(body) {
  const messages = [];

  if (body.system) {
    const sys = contentText(body.system);
    if (sys) messages.push({ role: "system", content: sys });
  }

  for (const msg of body.messages || []) {
    if (typeof msg.content === "string") {
      messages.push({ role: msg.role, content: msg.content });
    } else if (Array.isArray(msg.content)) {
      messages.push(...convertContentBlock(msg));
    }
  }

  const tools = (body.tools || []).map(t => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description || "",
      parameters: t.input_schema || {},
    },
  }));

  // Thinking-mode models require reasoning_content on assistant history messages.
  ensureAssistantReasoning(messages);

  return { messages, tools: tools.length ? tools : undefined };
}
