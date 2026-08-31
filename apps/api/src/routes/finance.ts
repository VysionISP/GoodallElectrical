import { Router } from "express";
import { z } from "zod";
import { getDb } from "../db/connection.js";
import { newId, nowIso } from "../lib/ids.js";
import { recordAudit } from "../lib/audit.js";
import { computeCashflowForecast } from "../agents/financeAI.js";

const router = Router();

router.get("/forecast", (_req, res) => {
  res.json(computeCashflowForecast());
});

router.get("/recurring-costs", (_req, res) => {
  const db = getDb();
  const costs = db.prepare("SELECT * FROM recurring_costs WHERE active = 1 ORDER BY category, created_at DESC").all();
  res.json({ recurringCosts: costs });
});

const createSchema = z.object({
  name: z.string().min(1),
  category: z.enum(["wages", "super", "fixed", "materials", "other"]),
  amount: z.number().positive(),
  frequency: z.enum(["weekly", "fortnightly", "monthly"]),
});

router.post("/recurring-costs", (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "INVALID_BODY", details: parsed.error.flatten() });
  const db = getDb();
  const id = newId("rcost");
  const now = nowIso();
  db.prepare(
    `INSERT INTO recurring_costs (id, name, category, amount, frequency, active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?)`
  ).run(id, parsed.data.name, parsed.data.category, parsed.data.amount, parsed.data.frequency, now, now);
  recordAudit({ actor: "owner", action: "recurring_cost_added", entityType: "recurring_cost", entityId: id, details: parsed.data });
  res.status(201).json({ recurringCost: db.prepare("SELECT * FROM recurring_costs WHERE id = ?").get(id) });
});

router.delete("/recurring-costs/:id", (req, res) => {
  const db = getDb();
  const existing = db.prepare("SELECT id FROM recurring_costs WHERE id = ?").get(req.params.id) as
    | { id: string }
    | undefined;
  if (!existing) return res.status(404).json({ error: "NOT_FOUND" });
  db.prepare("UPDATE recurring_costs SET active = 0, updated_at = ? WHERE id = ?").run(nowIso(), existing.id);
  recordAudit({ actor: "owner", action: "recurring_cost_removed", entityType: "recurring_cost", entityId: existing.id });
  res.json({ ok: true });
});

export default router;
