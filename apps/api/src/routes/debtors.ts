import { Router } from "express";
import { getDb } from "../db/connection.js";
import { newId, nowIso } from "../lib/ids.js";
import { recordAudit } from "../lib/audit.js";
import { createNotification } from "../lib/notifications.js";
import { requireApproval } from "../lib/approvalFirewall.js";
import { listOverdueInvoices, draftDebtorReminder } from "../agents/debtorAI.js";
import { getIntegrationCredentials } from "../integrations/store.js";
import { sendEmail, type SmtpCredentials } from "../integrations/smtp.js";

const router = Router();

router.get("/overdue", (_req, res) => {
  res.json({ invoices: listOverdueInvoices() });
});

router.get("/reminders/:id", (req, res) => {
  const db = getDb();
  const reminder = db.prepare("SELECT * FROM debtor_reminders WHERE id = ?").get(req.params.id);
  if (!reminder) return res.status(404).json({ error: "NOT_FOUND" });
  res.json({ reminder });
});

router.get("/invoices/:invoiceId/reminders", (req, res) => {
  const db = getDb();
  const reminders = db
    .prepare("SELECT * FROM debtor_reminders WHERE invoice_id = ? ORDER BY created_at DESC")
    .all(req.params.invoiceId);
  res.json({ reminders });
});

router.post("/invoices/:invoiceId/draft-reminder", async (req, res) => {
  try {
    const result = await draftDebtorReminder(req.params.invoiceId);
    res.json({ ok: true, ...result });
  } catch (err: any) {
    const status = err?.code === "NOT_CONFIGURED" ? 400 : err?.code === "NOT_FOUND" ? 404 : 502;
    res.status(status).json({ ok: false, error: err?.code ?? "DRAFT_FAILED", message: err?.message ?? String(err) });
  }
});

router.post("/reminders/:id/submit-for-approval", (req, res) => {
  const db = getDb();
  const reminder = db.prepare("SELECT * FROM debtor_reminders WHERE id = ?").get(req.params.id) as
    | { id: string }
    | undefined;
  if (!reminder) return res.status(404).json({ error: "NOT_FOUND" });

  const now = nowIso();
  db.prepare(`UPDATE debtor_reminders SET status = 'pending_approval', updated_at = ? WHERE id = ?`).run(now, reminder.id);
  const approvalId = newId("appr");
  db.prepare(
    `INSERT INTO approvals (id, entity_type, entity_id, action, status, requested_by, created_at, updated_at)
     VALUES (?, 'other', ?, 'send', 'pending', 'debtor_ai', ?, ?)`
  ).run(approvalId, reminder.id, now, now);

  createNotification({
    type: "reminder_requires_approval",
    severity: "warning",
    title: "Payment reminder requires approval",
    message: "Debtor AI drafted a payment reminder that needs your approval before it can be sent.",
    entityType: "other",
    entityId: reminder.id,
  });
  recordAudit({ actor: "debtor_ai", action: "reminder_submitted_for_approval", entityType: "other", entityId: reminder.id });

  res.json({ reminder: db.prepare("SELECT * FROM debtor_reminders WHERE id = ?").get(reminder.id), approvalId });
});

/**
 * Server-side approval firewall: 403 REMINDER_NOT_APPROVED unless an
 * `approved` approvals row exists for (other, this reminder id, 'send').
 * Requires SMTP configured and the customer to actually have an email on
 * file -- never fabricates a "sent" status.
 */
router.post("/reminders/:id/send", requireApproval("other", "send", "REMINDER_NOT_APPROVED"), async (req, res) => {
  const db = getDb();
  const reminder = db.prepare("SELECT * FROM debtor_reminders WHERE id = ?").get(req.params.id) as
    | { id: string; invoice_id: string; draft_subject: string; draft_body: string }
    | undefined;
  if (!reminder) return res.status(404).json({ error: "NOT_FOUND" });

  const invoice = db
    .prepare(
      `SELECT c.email as customer_email, c.name as customer_name FROM invoices i
       LEFT JOIN customers c ON c.id = i.customer_id WHERE i.id = ?`
    )
    .get(reminder.invoice_id) as { customer_email: string | null; customer_name: string | null } | undefined;

  if (!invoice?.customer_email) {
    return res.status(400).json({
      error: "NO_CONTACT_EMAIL",
      message: `No email on file for ${invoice?.customer_name ?? "this customer"}. Add one before sending.`,
    });
  }

  const smtpCreds = getIntegrationCredentials<SmtpCredentials>("smtp");
  if (!smtpCreds?.host) {
    return res.status(400).json({ error: "SMTP_NOT_CONFIGURED", message: "Configure Email (SMTP) in Integrations before sending." });
  }

  try {
    await sendEmail(smtpCreds, { to: invoice.customer_email, subject: reminder.draft_subject, body: reminder.draft_body });
  } catch (err: any) {
    return res.status(502).json({ error: "SEND_FAILED", message: err?.message ?? String(err) });
  }

  const now = nowIso();
  db.prepare(`UPDATE debtor_reminders SET status = 'sent', sent_at = ?, updated_at = ? WHERE id = ?`).run(now, now, reminder.id);

  recordAudit({ actor: "debtor_ai", action: "reminder_sent", entityType: "other", entityId: reminder.id });
  createNotification({
    type: "reminder_sent",
    severity: "info",
    title: "Payment reminder sent",
    message: `Reminder sent to ${invoice.customer_name ?? "customer"}.`,
    entityType: "other",
    entityId: reminder.id,
  });

  res.json({ reminder: db.prepare("SELECT * FROM debtor_reminders WHERE id = ?").get(reminder.id) });
});

export default router;
