import { Router } from "express";
import { z } from "zod";
import { getDb } from "../db/connection.js";
import { newId, nowIso } from "../lib/ids.js";
import { recordAudit } from "../lib/audit.js";
import { createNotification } from "../lib/notifications.js";
import { requireApproval } from "../lib/approvalFirewall.js";

const router = Router();

router.get("/", (_req, res) => {
  const db = getDb();
  const quotes = db.prepare("SELECT * FROM quotes ORDER BY created_at DESC").all();
  res.json({ quotes });
});

router.get("/:id", (req, res) => {
  const db = getDb();
  const quote = db.prepare("SELECT * FROM quotes WHERE id = ?").get(req.params.id);
  if (!quote) return res.status(404).json({ error: "NOT_FOUND" });
  const items = db.prepare("SELECT * FROM quote_items WHERE quote_id = ? ORDER BY sort_order").all(req.params.id);
  res.json({ quote, items });
});

const itemSchema = z.object({
  description: z.string(),
  quantity: z.number().default(1),
  unit: z.string().optional(),
  unitCost: z.number().optional(),
  unitPrice: z.number().optional(),
  category: z.enum(["materials", "labour", "testing", "other"]).default("other"),
});

const createSchema = z.object({
  jobId: z.string().optional(),
  customerId: z.string().optional(),
  notes: z.string().optional(),
  items: z.array(itemSchema).default([]),
  createdBy: z.string().default("estimator_ai"),
});

/** Estimator AI (or the owner) drafts a quote. Draft-only -- never sent without going through /submit-for-approval and /send. */
router.post("/", (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "INVALID_BODY", details: parsed.error.flatten() });

  const db = getDb();
  const id = newId("quote");
  const now = nowIso();

  const materialCost = sumCategory(parsed.data.items, "materials", "cost");
  const labourCost = sumCategory(parsed.data.items, "labour", "cost");
  const otherCost = sumCategory(parsed.data.items, "testing", "cost") + sumCategory(parsed.data.items, "other", "cost");
  const totalCost = materialCost + labourCost + otherCost;
  const subtotal = parsed.data.items.reduce((sum, i) => sum + i.quantity * (i.unitPrice ?? 0), 0);
  const gst = round2(subtotal * 0.1);
  const total = round2(subtotal + gst);
  const grossProfit = round2(subtotal - totalCost);
  const margin = subtotal > 0 ? round2((grossProfit / subtotal) * 100) : null;

  db.prepare(
    `INSERT INTO quotes (id, job_id, customer_id, status, subtotal, gst, total, internal_material_cost, internal_labour_cost, internal_other_cost, internal_total_cost, forecast_gross_profit, forecast_margin, notes, created_by, created_at, updated_at)
     VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    parsed.data.jobId ?? null,
    parsed.data.customerId ?? null,
    round2(subtotal),
    gst,
    total,
    round2(materialCost),
    round2(labourCost),
    round2(otherCost),
    round2(totalCost),
    grossProfit,
    margin,
    parsed.data.notes ?? null,
    parsed.data.createdBy,
    now,
    now
  );

  parsed.data.items.forEach((item, idx) => {
    db.prepare(
      `INSERT INTO quote_items (id, quote_id, description, quantity, unit, unit_cost, unit_price, category, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(newId("qitem"), id, item.description, item.quantity, item.unit ?? null, item.unitCost ?? null, item.unitPrice ?? null, item.category, idx, now, now);
  });

  recordAudit({ actor: parsed.data.createdBy, action: "quote_drafted", entityType: "quote", entityId: id, details: { total, margin } });

  res.status(201).json({ quote: db.prepare("SELECT * FROM quotes WHERE id = ?").get(id) });
});

/** Moves a draft quote to pending_approval and opens an approval request. This is the ONLY path that can ever lead to /send succeeding. */
router.post("/:id/submit-for-approval", (req, res) => {
  const db = getDb();
  const quote = db.prepare("SELECT * FROM quotes WHERE id = ?").get(req.params.id) as { id: string; status: string } | undefined;
  if (!quote) return res.status(404).json({ error: "NOT_FOUND" });

  const now = nowIso();
  db.prepare(`UPDATE quotes SET status = 'pending_approval', updated_at = ? WHERE id = ?`).run(now, quote.id);

  const approvalId = newId("appr");
  db.prepare(
    `INSERT INTO approvals (id, entity_type, entity_id, action, status, requested_by, created_at, updated_at)
     VALUES (?, 'quote', ?, 'send', 'pending', 'estimator_ai', ?, ?)`
  ).run(approvalId, quote.id, now, now);

  createNotification({
    type: "quote_requires_approval",
    severity: "warning",
    title: "Quote requires approval",
    message: `Quote ${quote.id} is ready and needs your approval before it can be sent.`,
    entityType: "quote",
    entityId: quote.id,
  });
  recordAudit({ actor: "estimator_ai", action: "quote_submitted_for_approval", entityType: "quote", entityId: quote.id });

  res.json({ quote: db.prepare("SELECT * FROM quotes WHERE id = ?").get(quote.id), approvalId });
});

/**
 * Sends the quote to the customer. Server-side approval firewall: fails
 * with 403 QUOTE_NOT_APPROVED unless an `approved` approvals row exists
 * for (quote, this id, 'send'). This cannot be bypassed by the frontend --
 * see requireApproval in lib/approvalFirewall.ts.
 */
router.post("/:id/send", requireApproval("quote", "send", "QUOTE_NOT_APPROVED"), (req, res) => {
  const db = getDb();
  const quote = db.prepare("SELECT * FROM quotes WHERE id = ?").get(req.params.id) as { id: string } | undefined;
  if (!quote) return res.status(404).json({ error: "NOT_FOUND" });

  const now = nowIso();
  db.prepare(`UPDATE quotes SET status = 'sent', sent_at = ?, updated_at = ? WHERE id = ?`).run(now, now, quote.id);

  recordAudit({ actor: "sales_ai", action: "quote_sent", entityType: "quote", entityId: quote.id });
  createNotification({
    type: "quote_sent",
    severity: "info",
    title: "Quote sent",
    message: `Quote ${quote.id} was sent to the customer.`,
    entityType: "quote",
    entityId: quote.id,
  });

  res.json({ quote: db.prepare("SELECT * FROM quotes WHERE id = ?").get(quote.id) });
});

function sumCategory(items: z.infer<typeof itemSchema>[], category: string, _kind: "cost"): number {
  return items.filter((i) => i.category === category).reduce((sum, i) => sum + i.quantity * (i.unitCost ?? 0), 0);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export default router;
