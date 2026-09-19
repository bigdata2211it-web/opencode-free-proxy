import { Router } from "express";
import { MODELS } from "../config/index.mjs";

const router = Router();

const toModel = (id) => ({
  id, object: "model", created: 1779000000, owned_by: "opencode-free",
});

router.get(["/v1/models", "/models"], (_req, res) => {
  res.json({ object: "list", data: MODELS.map(toModel) });
});

// Clients with custom model names (Cursor, etc.) verify the id with a
// retrieve call before allowing it — answer 200 for any non-empty id.
router.get(["/v1/models/:id", "/models/:id"], (req, res) => {
  const id = req.params.id;
  if (!id) {
    return res
      .status(404)
      .json({ error: { message: "Model not found", type: "not_found_error" } });
  }
  res.json(toModel(id));
});

export default router;
