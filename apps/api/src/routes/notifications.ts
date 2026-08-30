import { Router } from "express";
import { getDb } from "../db/connection.js";

const router = Router();

router.get("/", (req, res) => {
  const db = getDb();
  const unreadOnly = req.query.unread === "true";
  const rows = unreadOnly
    ? db.prepare("SELECT * FROM notifications WHERE read = 0 ORDER BY created_at DESC").all()
    : db.prepare("SELECT * FROM notifications ORDER BY created_at DESC LIMIT 100").all();
  const unreadCount = (
    db.prepare("SELECT COUNT(*) as c FROM notifications WHERE read = 0").get() as { c: number }
  ).c;
  res.json({ notifications: rows, unreadCount });
});

router.post("/:id/read", (req, res) => {
  const db = getDb();
  db.prepare("UPDATE notifications SET read = 1 WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

router.post("/read-all", (_req, res) => {
  const db = getDb();
  db.prepare("UPDATE notifications SET read = 1 WHERE read = 0").run();
  res.json({ ok: true });
});

export default router;
