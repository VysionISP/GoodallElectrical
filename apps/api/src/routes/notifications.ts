import { Router } from "express";
import { getDb } from "../db/connection.js";

const router = Router();

/**
 * Types that only mirror something already counted under "Needs You" (a
 * pending approval row, or an open question). Badging them too means one
 * task -- one quote waiting on approval -- lights up the counter twice.
 */
const MIRRORS_NEEDS_YOU = [
  "quote_requires_approval",
  "invoice_requires_approval",
  "outreach_requires_approval",
  "reminder_requires_approval",
  "approval_requested",
  "director_needs_info",
];

router.get("/", (req, res) => {
  const db = getDb();
  const unreadOnly = req.query.unread === "true";
  const rows = unreadOnly
    ? db.prepare("SELECT * FROM notifications WHERE read = 0 ORDER BY created_at DESC").all()
    : db.prepare("SELECT * FROM notifications ORDER BY created_at DESC LIMIT 100").all();

  // The badge answers "how many things are waiting on me", so it counts
  // only unread items that are actually a problem to act on: severity
  // info is a receipt ("sync completed", "quote sent", "leads found") and
  // never badges, and anything duplicating a Needs You row is excluded so
  // the same task isn't counted twice.
  const placeholders = MIRRORS_NEEDS_YOU.map(() => "?").join(", ");
  const unreadCount = (
    db
      .prepare(
        `SELECT COUNT(*) as c FROM notifications
         WHERE read = 0 AND severity IN ('warning', 'critical') AND type NOT IN (${placeholders})`
      )
      .get(...MIRRORS_NEEDS_YOU) as { c: number }
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
