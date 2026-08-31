import { Router } from "express";
import { z } from "zod";
import { getDb } from "../db/connection.js";
import { newId, nowIso } from "../lib/ids.js";
import { recordAudit } from "../lib/audit.js";
import { createNotification } from "../lib/notifications.js";
import { requireApproval } from "../lib/approvalFirewall.js";
import { runLeadSearch, suggestSearchQueries, runAreaSweep } from "../agents/leadHunter.js";
import { runLeadResearch } from "../agents/researchAI.js";
import { draftOutreach } from "../agents/salesAI.js";
import { getIntegrationCredentials } from "../integrations/store.js";
import { sendEmail, type SmtpCredentials } from "../integrations/smtp.js";

const router = Router();

router.get("/", (_req, res) => {
  const db = getDb();
  const leads = db.prepare("SELECT * FROM leads ORDER BY created_at DESC").all();
  res.json({ leads });
});

router.get("/:id", (req, res) => {
  const db = getDb();
  const lead = db.prepare("SELECT * FROM leads WHERE id = ?").get(req.params.id);
  if (!lead) return res.status(404).json({ error: "NOT_FOUND" });
  const research = db.prepare("SELECT * FROM lead_research WHERE lead_id = ? ORDER BY created_at DESC").all(req.params.id);
  const outreach = db.prepare("SELECT * FROM sales_outreach WHERE lead_id = ? ORDER BY created_at DESC").all(req.params.id);
  res.json({ lead, research, outreach });
});

const patchSchema = z.object({
  contactName: z.string().optional(),
  contactEmail: z.string().email().optional(),
  contactPhone: z.string().optional(),
  estimatedOpportunity: z.number().optional(),
});

/** Manual owner edits -- e.g. adding a contact email Google Places didn't supply, so outreach can actually be sent. */
router.patch("/:id", (req, res) => {
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "INVALID_BODY", details: parsed.error.flatten() });
  const db = getDb();
  const lead = db.prepare("SELECT id FROM leads WHERE id = ?").get(req.params.id) as { id: string } | undefined;
  if (!lead) return res.status(404).json({ error: "NOT_FOUND" });

  const fields: string[] = [];
  const values: unknown[] = [];
  if (parsed.data.contactName !== undefined) { fields.push("contact_name = ?"); values.push(parsed.data.contactName); }
  if (parsed.data.contactEmail !== undefined) { fields.push("contact_email = ?"); values.push(parsed.data.contactEmail); }
  if (parsed.data.contactPhone !== undefined) { fields.push("contact_phone = ?"); values.push(parsed.data.contactPhone); }
  if (parsed.data.estimatedOpportunity !== undefined) { fields.push("estimated_opportunity = ?"); values.push(parsed.data.estimatedOpportunity); }
  if (fields.length === 0) return res.status(400).json({ error: "NO_FIELDS" });

  fields.push("updated_at = ?");
  values.push(nowIso());
  values.push(lead.id);
  db.prepare(`UPDATE leads SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  recordAudit({ actor: "owner", action: "lead_updated", entityType: "lead", entityId: lead.id, details: parsed.data });
  res.json({ lead: db.prepare("SELECT * FROM leads WHERE id = ?").get(lead.id) });
});

const searchSchema = z.object({ query: z.string().min(1) });

router.post("/suggest-queries", async (_req, res) => {
  try {
    const queries = await suggestSearchQueries();
    res.json({ ok: true, queries });
  } catch (err: any) {
    const status = err?.code === "NOT_CONFIGURED" || err?.code === "NO_SERVICES" ? 400 : 502;
    res.status(status).json({ ok: false, error: err?.code ?? "SUGGEST_FAILED", message: err?.message ?? String(err) });
  }
});

router.post("/sweep", async (_req, res) => {
  try {
    const result = await runAreaSweep();
    res.json({ ok: true, ...result });
  } catch (err: any) {
    const status = ["NOT_CONFIGURED", "NO_SERVICES", "NO_QUERIES"].includes(err?.code) ? 400 : 502;
    res.status(status).json({ ok: false, error: err?.code ?? "SWEEP_FAILED", message: err?.message ?? String(err) });
  }
});

router.post("/search", async (req, res) => {
  const parsed = searchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "INVALID_BODY", details: parsed.error.flatten() });
  try {
    const result = await runLeadSearch(parsed.data.query);
    res.json({ ok: true, ...result });
  } catch (err: any) {
    const status = err?.code === "NOT_CONFIGURED" ? 400 : 502;
    res.status(status).json({ ok: false, error: err?.code ?? "SEARCH_FAILED", message: err?.message ?? String(err) });
  }
});

router.post("/:id/research", async (req, res) => {
  try {
    const result = await runLeadResearch(req.params.id);
    res.json({ ok: true, ...result });
  } catch (err: any) {
    const status = err?.code === "NOT_CONFIGURED" ? 400 : err?.code === "NOT_FOUND" ? 404 : 502;
    res.status(status).json({ ok: false, error: err?.code ?? "RESEARCH_FAILED", message: err?.message ?? String(err) });
  }
});

router.post("/:id/draft-outreach", async (req, res) => {
  try {
    const result = await draftOutreach(req.params.id);
    res.json({ ok: true, ...result });
  } catch (err: any) {
    const status = err?.code === "NOT_CONFIGURED" ? 400 : err?.code === "NOT_FOUND" ? 404 : 502;
    res.status(status).json({ ok: false, error: err?.code ?? "DRAFT_FAILED", message: err?.message ?? String(err) });
  }
});

router.post("/outreach/:id/submit-for-approval", (req, res) => {
  const db = getDb();
  const outreach = db.prepare("SELECT * FROM sales_outreach WHERE id = ?").get(req.params.id) as { id: string } | undefined;
  if (!outreach) return res.status(404).json({ error: "NOT_FOUND" });

  const now = nowIso();
  db.prepare(`UPDATE sales_outreach SET status = 'pending_approval', updated_at = ? WHERE id = ?`).run(now, outreach.id);
  const approvalId = newId("appr");
  db.prepare(
    `INSERT INTO approvals (id, entity_type, entity_id, action, status, requested_by, created_at, updated_at)
     VALUES (?, 'sales_outreach', ?, 'send', 'pending', 'sales_ai', ?, ?)`
  ).run(approvalId, outreach.id, now, now);

  createNotification({
    type: "outreach_requires_approval",
    severity: "warning",
    title: "Outreach requires approval",
    message: `A draft email is ready and needs your approval before it can be sent.`,
    entityType: "sales_outreach",
    entityId: outreach.id,
  });
  recordAudit({ actor: "sales_ai", action: "outreach_submitted_for_approval", entityType: "sales_outreach", entityId: outreach.id });

  res.json({ outreach: db.prepare("SELECT * FROM sales_outreach WHERE id = ?").get(outreach.id), approvalId });
});

/**
 * Server-side approval firewall: 403 OUTREACH_NOT_APPROVED unless an
 * `approved` approvals row exists for (sales_outreach, this id, 'send').
 * Also requires SMTP to be configured and the lead to actually have a
 * contact email -- we never fabricate a "sent" status.
 */
router.post("/outreach/:id/send", requireApproval("sales_outreach", "send", "OUTREACH_NOT_APPROVED"), async (req, res) => {
  const db = getDb();
  const outreach = db.prepare("SELECT * FROM sales_outreach WHERE id = ?").get(req.params.id) as
    | { id: string; lead_id: string; draft_subject: string; draft_body: string }
    | undefined;
  if (!outreach) return res.status(404).json({ error: "NOT_FOUND" });

  const lead = db.prepare("SELECT contact_email, business_name FROM leads WHERE id = ?").get(outreach.lead_id) as
    | { contact_email: string | null; business_name: string }
    | undefined;
  if (!lead?.contact_email) {
    return res.status(400).json({
      error: "NO_CONTACT_EMAIL",
      message: `No contact email on file for ${lead?.business_name ?? "this lead"}. Add one (PATCH /api/leads/${outreach.lead_id}) before sending.`,
    });
  }

  const smtpCreds = getIntegrationCredentials<SmtpCredentials>("smtp");
  if (!smtpCreds?.host) {
    return res.status(400).json({ error: "SMTP_NOT_CONFIGURED", message: "Configure Email (SMTP) in Integrations before sending." });
  }

  try {
    await sendEmail(smtpCreds, { to: lead.contact_email, subject: outreach.draft_subject, body: outreach.draft_body });
  } catch (err: any) {
    return res.status(502).json({ error: "SEND_FAILED", message: err?.message ?? String(err) });
  }

  const now = nowIso();
  db.prepare(`UPDATE sales_outreach SET status = 'sent', sent_at = ?, updated_at = ? WHERE id = ?`).run(now, now, outreach.id);
  db.prepare(`UPDATE leads SET status = 'contacted', updated_at = ? WHERE id = ?`).run(now, outreach.lead_id);

  recordAudit({ actor: "sales_ai", action: "outreach_sent", entityType: "sales_outreach", entityId: outreach.id });
  createNotification({
    type: "outreach_sent",
    severity: "info",
    title: "Outreach sent",
    message: `Email sent to ${lead.business_name}.`,
    entityType: "sales_outreach",
    entityId: outreach.id,
  });

  res.json({ outreach: db.prepare("SELECT * FROM sales_outreach WHERE id = ?").get(outreach.id) });
});

export default router;
