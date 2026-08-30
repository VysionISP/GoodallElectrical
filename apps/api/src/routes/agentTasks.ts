import { Router } from "express";
import { getDb } from "../db/connection.js";

const router = Router();

/**
 * Polled by the frontend HQ to animate workers. Returns the current state
 * of every agent task -- the frontend must derive worker position/status
 * from this data, never from client-side randomness.
 */
router.get("/", (req, res) => {
  const db = getDb();
  const status = typeof req.query.status === "string" ? req.query.status : null;
  const rows = status
    ? db.prepare("SELECT * FROM agent_tasks WHERE status = ? ORDER BY updated_at DESC").all(status)
    : db.prepare("SELECT * FROM agent_tasks ORDER BY updated_at DESC LIMIT 200").all();
  res.json({ tasks: rows });
});

router.get("/:id/events", (req, res) => {
  const db = getDb();
  const events = db
    .prepare("SELECT * FROM agent_events WHERE task_id = ? ORDER BY created_at")
    .all(req.params.id);
  res.json({ events });
});

export default router;
