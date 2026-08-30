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
  res.json({ invoices: db.prepare("SELECT * FROM invoices ORDER BY created_at DESC").all() });
});

router.get("/:id", (req, res) => {
  const db = getDb();
  const invoice = db.prepare("SELECT * FROM invoices WHERE id = ?").get(req.params.id);
  if (!invoice) return res.status(404).json({ error: "NOT_FOUND" });
  const payments = db.prepare("SELECT * FROM payments WHERE invoice_id = ? ORDER BY paid_at").all(req.params.id);
  res.json({ invoice, payments });
});

router.post("/:id/submit-for-approval", (req, res) => {
  const db = getDb();
  const invoice = db.prepare("SELECT * FROM invoices WHERE id = ?").get(req.params.id) as
    | { id: string }
    | undefined;
  if (!invoice) return res.status(404).json({ error: "NOT_FOUND" });

  const now = nowIso();
  db.prepare(`UPDATE invoices SET status = 'pending_approval', updated_at = ? WHERE id = ?`).run(now, invoice.id);
  const approvalId = newId("appr");
  db.prepare(
    `INSERT INTO approvals (id, entity_type, entity_id, action, status, requested_by, created_at, updated_at)
     VALUES (?, 'invoice', ?, 'send', 'pending', 'finance_ai', ?, ?)`
  ).run(approvalId, invoice.id, now, now);

  createNotification({
    type: "invoice_requires_approval",
    severity: "warning",
    title: "Invoice requires approval",
    message: `Invoice ${invoice.id} needs your approval before it can be sent.`,
    entityType: "invoice",
    entityId: invoice.id,
  });
  recordAudit({ actor: "finance_ai", action: "invoice_submitted_for_approval", entityType: "invoice", entityId: invoice.id });

  res.json({ invoice: db.prepare("SELECT * FROM invoices WHERE id = ?").get(invoice.id), approvalId });
});

/**
 * Server-side approval firewall: fails with 403 INVOICE_NOT_APPROVED
 * unless an `approved` approvals row exists for (invoice, this id, 'send').
 */
router.post("/:id/send", requireApproval("invoice", "send", "INVOICE_NOT_APPROVED"), (req, res) => {
  const db = getDb();
  const invoice = db.prepare("SELECT * FROM invoices WHERE id = ?").get(req.params.id) as { id: string } | undefined;
  if (!invoice) return res.status(404).json({ error: "NOT_FOUND" });

  const now = nowIso();
  db.prepare(`UPDATE invoices SET status = 'sent', sent_at = ?, updated_at = ? WHERE id = ?`).run(now, now, invoice.id);

  recordAudit({ actor: "finance_ai", action: "invoice_sent", entityType: "invoice", entityId: invoice.id });
  createNotification({
    type: "invoice_sent",
    severity: "info",
    title: "Invoice sent",
    message: `Invoice ${invoice.id} was sent to the customer.`,
    entityType: "invoice",
    entityId: invoice.id,
  });

  res.json({ invoice: db.prepare("SELECT * FROM invoices WHERE id = ?").get(invoice.id) });
});

export default router;
