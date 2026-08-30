import { Router } from "express";
import { z } from "zod";
import { getDb } from "../db/connection.js";
import { newId, nowIso } from "../lib/ids.js";
import { recordAudit } from "../lib/audit.js";
import { createNotification } from "../lib/notifications.js";

const router = Router();

router.get("/", (req, res) => {
  const db = getDb();
  const status = typeof req.query.status === "string" ? req.query.status : null;
  const rows = status
    ? db.prepare("SELECT * FROM approvals WHERE status = ? ORDER BY created_at DESC").all(status)
    : db.prepare("SELECT * FROM approvals ORDER BY created_at DESC").all();
  res.json({ approvals: rows });
});

const createSchema = z.object({
  entityType: z.enum(["quote", "invoice", "sales_outreach", "purchase", "job_cancellation", "other"]),
  entityId: z.string(),
  action: z.string(),
  requestedBy: z.string().optional(),
  notes: z.string().optional(),
});

/** Requests approval for a consequential action. Status starts 'pending' until the owner decides. */
router.post("/", (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "INVALID_BODY", details: parsed.error.flatten() });
  const db = getDb();
  const id = newId("appr");
  const now = nowIso();
  db.prepare(
    `INSERT INTO approvals (id, entity_type, entity_id, action, status, requested_by, notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)`
  ).run(id, parsed.data.entityType, parsed.data.entityId, parsed.data.action, parsed.data.requestedBy ?? null, parsed.data.notes ?? null, now, now);

  recordAudit({
    actor: parsed.data.requestedBy ?? "system",
    action: "approval_requested",
    entityType: parsed.data.entityType,
    entityId: parsed.data.entityId,
    details: { action: parsed.data.action },
  });
  createNotification({
    type: "approval_requested",
    severity: "warning",
    title: `${parsed.data.entityType} requires approval`,
    message: `Action "${parsed.data.action}" on ${parsed.data.entityType} ${parsed.data.entityId} is waiting for your approval.`,
    entityType: parsed.data.entityType,
    entityId: parsed.data.entityId,
  });

  res.status(201).json({ approval: db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) });
});

const decisionSchema = z.object({
  decision: z.enum(["approved", "rejected"]),
  notes: z.string().optional(),
  decidedBy: z.string().default("owner"),
});

router.post("/:id/decide", (req, res) => {
  const parsed = decisionSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "INVALID_BODY", details: parsed.error.flatten() });
  const db = getDb();
  const approval = db.prepare("SELECT * FROM approvals WHERE id = ?").get(req.params.id) as
    | { id: string; entity_type: string; entity_id: string; action: string; status: string }
    | undefined;
  if (!approval) return res.status(404).json({ error: "NOT_FOUND" });

  const now = nowIso();
  db.prepare(
    `UPDATE approvals SET status = ?, approved_by = ?, approved_at = ?, notes = COALESCE(?, notes), updated_at = ? WHERE id = ?`
  ).run(parsed.data.decision, parsed.data.decidedBy, now, parsed.data.notes ?? null, now, approval.id);

  db.prepare(
    `INSERT INTO approval_events (id, approval_id, event_type, actor, notes, created_at) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(newId("aevt"), approval.id, parsed.data.decision, parsed.data.decidedBy, parsed.data.notes ?? null, now);

  // Reflect the decision on the owning quote/invoice/outreach record so its
  // own status stays in sync with the approval outcome.
  if (approval.entity_type === "quote" && parsed.data.decision === "approved") {
    db.prepare(`UPDATE quotes SET status = 'approved', approved_by = ?, approved_at = ?, updated_at = ? WHERE id = ?`).run(
      parsed.data.decidedBy,
      now,
      now,
      approval.entity_id
    );
  } else if (approval.entity_type === "invoice" && parsed.data.decision === "approved") {
    db.prepare(`UPDATE invoices SET status = 'approved', approved_by = ?, approved_at = ?, updated_at = ? WHERE id = ?`).run(
      parsed.data.decidedBy,
      now,
      now,
      approval.entity_id
    );
  } else if (approval.entity_type === "sales_outreach" && parsed.data.decision === "approved") {
    db.prepare(`UPDATE sales_outreach SET status = 'approved', approved_by = ?, approved_at = ?, updated_at = ? WHERE id = ?`).run(
      parsed.data.decidedBy,
      now,
      now,
      approval.entity_id
    );
  }

  recordAudit({
    actor: parsed.data.decidedBy,
    action: `approval_${parsed.data.decision}`,
    entityType: approval.entity_type,
    entityId: approval.entity_id,
    details: { action: approval.action, notes: parsed.data.notes },
  });

  res.json({ approval: db.prepare("SELECT * FROM approvals WHERE id = ?").get(approval.id) });
});

export default router;
