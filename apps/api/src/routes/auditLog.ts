import { Router } from "express";
import { getDb } from "../db/connection.js";

const router = Router();

router.get("/", (req, res) => {
  const db = getDb();
  const { entityType, entityId } = req.query;
  let rows;
  if (typeof entityType === "string" && typeof entityId === "string") {
    rows = db
      .prepare("SELECT * FROM audit_log WHERE entity_type = ? AND entity_id = ? ORDER BY created_at DESC")
      .all(entityType, entityId);
  } else {
    rows = db.prepare("SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 200").all();
  }
  res.json({ auditLog: rows });
});

export default router;
