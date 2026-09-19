import express from "express";
import modelsRouter from "./routes/models.mjs";
import chatRouter from "./routes/chat.mjs";
import messagesRouter from "./routes/messages.mjs";
import healthRouter from "./routes/health.mjs";
import { logLine } from "./logger.mjs";

export function createApp() {
  const app = express();
  app.use(express.json({ limit: "10mb" }));
  app.use(modelsRouter);
  app.use(chatRouter);
  app.use(messagesRouter);
  app.use(healthRouter);

  // 404 fallback — return JSON for unknown routes
  app.use((_req, res) => {
    res
      .status(404)
      .json({ error: { message: "Not found", type: "not_found_error" } });
  });

  // Global error handler — Express 5 also forwards rejected promises from async routes here.
  app.use((err, req, res, next) => {
    logLine("UNHANDLED ERROR", err.message, err.stack);
    if (res.headersSent) {
      return res.end();
    }

    // Express 5: res.status() only accepts integers in 100–999
    let status = Number(err.status || err.statusCode) || 500;
    if (!Number.isInteger(status) || status < 100 || status > 999) status = 500;
    const message = err.message || "Internal server error";
    const type = err.type || "server_error";

    if (req.path === "/v1/messages") {
      res.status(status).json({ type: "error", error: { type, message } });
    } else {
      res.status(status).json({ error: { message, type, code: err.code } });
    }
  });

  return app;
}
