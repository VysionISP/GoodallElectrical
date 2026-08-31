import { Router } from "express";
import { z } from "zod";
import { getDb } from "../db/connection.js";
import { newId, nowIso } from "../lib/ids.js";
import { recordAudit } from "../lib/audit.js";

const router = Router();

router.get("/", (_req, res) => {
  const db = getDb();
  const memory = db
    .prepare("SELECT * FROM business_memory WHERE active = 1 ORDER BY category, created_at DESC")
    .all();
  res.json({ memory });
});

const createSchema = z.object({
  content: z.string().min(1),
  category: z.enum(["services", "service_area", "pricing", "exclusions", "other"]).default("other"),
});

/** Owner-authored business knowledge -- e.g. what services Goodall Electrical offers.
 *  Read by Research AI (assessing lead fit) and the Director (chat context). */
router.post("/", (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "INVALID_BODY", details: parsed.error.flatten() });
  const db = getDb();
  const id = newId("bmem");
  const now = nowIso();
  db.prepare(
    `INSERT INTO business_memory (id, content, category, created_by, active, created_at, updated_at)
     VALUES (?, ?, ?, 'owner', 1, ?, ?)`
  ).run(id, parsed.data.content, parsed.data.category, now, now);
  recordAudit({ actor: "owner", action: "business_memory_added", entityType: "business_memory", entityId: id, details: parsed.data });
  res.status(201).json({ memory: db.prepare("SELECT * FROM business_memory WHERE id = ?").get(id) });
});

/** Soft-delete -- keeps history in audit_log/the row itself rather than losing it outright. */
router.delete("/:id", (req, res) => {
  const db = getDb();
  const existing = db.prepare("SELECT id FROM business_memory WHERE id = ?").get(req.params.id) as
    | { id: string }
    | undefined;
  if (!existing) return res.status(404).json({ error: "NOT_FOUND" });
  db.prepare("UPDATE business_memory SET active = 0, updated_at = ? WHERE id = ?").run(nowIso(), existing.id);
  recordAudit({ actor: "owner", action: "business_memory_removed", entityType: "business_memory", entityId: existing.id });
  res.json({ ok: true });
});

export default router;
