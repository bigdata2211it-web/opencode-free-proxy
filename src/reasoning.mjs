/**
 * Thinking-mode (DeepSeek-style) API compatibility.
 *
 * Reasoning models on the upstream (Console provider) require every prior
 * `assistant` message to carry a `reasoning_content` field on multi-turn
 * continuations — otherwise the API rejects the request with:
 *   "The reasoning_content in the thinking mode must be passed back to the API."
 *
 * Chat UIs (VS Code Copilot's OpenAI path, Anthropic SDK clients) do not
 * supply that field on history, so we inject an empty string. The upstream
 * only checks that the field is present, so an empty value satisfies it while
 * letting any real reasoning pass through untouched.
 *
 * Mutates and returns the same array.
 */
export function ensureAssistantReasoning(messages) {
  for (const m of messages || []) {
    if (m && typeof m === "object" && m.role === "assistant") {
      if (typeof m.reasoning_content !== "string") {
        m.reasoning_content = "";
      }
    }
  }
  return messages;
}