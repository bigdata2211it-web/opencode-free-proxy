import { Router } from "express";
import { auth } from "../auth.mjs";
import { getSession } from "../session.mjs";
import { zenRequest } from "../client.mjs";
import { pipeZenResponse } from "../pipe-openai.mjs";
import { ensureAssistantReasoning } from "../reasoning.mjs";
import { logLine, logIO, msgSummary } from "../logger.mjs";

const router = Router();

router.post(["/v1/chat/completions", "/chat/completions"], (req, res) => {
  const user = auth(req);
  if (!user) return res.status(401).json({ error: { message: "Invalid API key" } });

  // Express 5: unparsed body is `undefined` (was `{}` in v4)
  if (req.body == null || typeof req.body !== "object") {
    return res.status(400).json({ error: { message: "Request body must be JSON", type: "invalid_request_error" } });
  }

  const { model, messages, stream, tools, tool_choice } = req.body;
  // Cursor (and cursor++) verifies custom model ids; unknown names go upstream.
  if (typeof model !== "string" || !model.trim()) {
    return res.status(400).json({ error: { message: "model is required", type: "invalid_request_error" } });
  }

  const sessionId = getSession(user);
  // Thinking-mode models require reasoning_content on assistant history messages.
  ensureAssistantReasoning(messages);
  logLine(user, model, stream ? "stream" : "sync", "msgs:", JSON.stringify(msgSummary(messages)));
  logIO("INPUT", {
    model,
    stream: !!stream,
    tool_choice: tool_choice || undefined,
    tools: tools?.length ? tools : undefined,
    messages,
  });

  const { body, options } = zenRequest(model, messages, stream, tools, tool_choice, sessionId);
  pipeZenResponse(options, body, stream, res, { user, clientReq: req });
});

export default router;
