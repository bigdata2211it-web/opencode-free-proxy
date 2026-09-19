import { Router } from "express";
import { PROXY_VERSION, MODELS } from "../config/index.mjs";

const router = Router();

router.get("/health", (_req, res) => res.json({
  status: "ok", version: `v${PROXY_VERSION}`, models: MODELS.length,
  endpoints: ["/v1/chat/completions", "/v1/messages", "/v1/models"],
}));

export default router;
