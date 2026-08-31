import { getDb } from "../db/connection.js";
import { newId, nowIso } from "../lib/ids.js";
import { recordAudit } from "../lib/audit.js";
import { createNotification } from "../lib/notifications.js";
import { getIntegrationCredentials } from "./store.js";
import { fergusWrite, type FergusCredentials, type FergusMethod } from "./fergus.js";

/**
 * The approval-gated pipeline for changing the owner's live Fergus account.
 *
 * Nothing here performs a write when an agent asks for one. A request is
 * recorded, an approval is raised, and the write happens only after the
 * owner says yes -- the same firewall that stands in front of sending a
 * quote. That matters more here than anywhere else in the app: the
 * Director has already, on real data, confidently attributed one
 * customer's job to a different customer. Something capable of that must
 * not be able to mark jobs complete or raise invoices unsupervised.
 *
 * The exact method/path/body are stored on the request rather than implied
 * by the action name, so what will be sent is reviewable before it happens
 * and recorded after.
 */

export interface ProposedFergusWrite {
  summary: string;
  action: string;
  method: Exclude<FergusMethod, "GET">;
  path: string;
  body?: unknown;
  jobId?: string | null;
  requestedBy?: string;
}

export function proposeFergusWrite(proposal: ProposedFergusWrite): { requestId: string; approvalId: string } {
  const db = getDb();
  const now = nowIso();
  const requestId = newId("fwreq");

  db.prepare(
    `INSERT INTO fergus_write_requests (id, summary, action, method, path, body, job_id, requested_by, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending_approval', ?, ?)`
  ).run(
    requestId,
    proposal.summary,
    proposal.action,
    proposal.method,
    proposal.path,
    proposal.body !== undefined ? JSON.stringify(proposal.body) : null,
    proposal.jobId ?? null,
    proposal.requestedBy ?? "director",
    now,
    now
  );

  // entity_type 'other' deliberately: the approvals table's CHECK
  // constraint can't be widened without recreating the table, which was
  // measured here to cascade-delete the approval_events audit trail.
  const approvalId = newId("appr");
  db.prepare(
    `INSERT INTO approvals (id, entity_type, entity_id, action, status, requested_by, notes, created_at, updated_at)
     VALUES (?, 'other', ?, 'fergus_write', 'pending', ?, ?, ?, ?)`
  ).run(approvalId, requestId, proposal.requestedBy ?? "director", proposal.summary, now, now);

  createNotification({
    type: "fergus_write_requires_approval",
    severity: "warning",
    title: "Change to Fergus needs your approval",
    message: `${proposal.summary} (${proposal.method} ${proposal.path}). Nothing has been changed in Fergus yet.`,
    entityType: "other",
    entityId: requestId,
  });
  recordAudit({
    actor: proposal.requestedBy ?? "director",
    action: "fergus_write_proposed",
    entityType: "fergus_write_request",
    entityId: requestId,
    details: { summary: proposal.summary, method: proposal.method, path: proposal.path },
  });

  return { requestId, approvalId };
}

/**
 * Executes a request the owner has approved. Called from the approvals
 * decision handler -- never directly by an agent.
 */
export async function executeFergusWriteRequest(requestId: string): Promise<{ ok: boolean; error?: string }> {
  const db = getDb();
  const req = db.prepare("SELECT * FROM fergus_write_requests WHERE id = ?").get(requestId) as
    | { id: string; summary: string; method: FergusMethod; path: string; body: string | null; status: string }
    | undefined;
  if (!req) return { ok: false, error: "Write request not found" };

  // Guard against double-execution: an approval decided twice, or a retry,
  // must not send the same POST to Fergus again.
  if (req.status === "executed") return { ok: true };
  if (req.status !== "approved" && req.status !== "pending_approval") {
    return { ok: false, error: `Request is ${req.status}, not executable` };
  }

  const creds = getIntegrationCredentials<FergusCredentials>("fergus");
  if (!creds) {
    const error = "Fergus is not configured, so the approved change could not be sent.";
    db.prepare(`UPDATE fergus_write_requests SET status = 'failed', error = ?, updated_at = ? WHERE id = ?`).run(
      error,
      nowIso(),
      requestId
    );
    return { ok: false, error };
  }

  try {
    const response = await fergusWrite(
      creds,
      req.method as Exclude<FergusMethod, "GET">,
      req.path,
      req.body ? JSON.parse(req.body) : undefined
    );
    const now = nowIso();
    db.prepare(
      `UPDATE fergus_write_requests SET status = 'executed', response = ?, executed_at = ?, updated_at = ? WHERE id = ?`
    ).run(JSON.stringify(response ?? null).slice(0, 4000), now, now, requestId);

    recordAudit({
      actor: "owner",
      action: "fergus_write_executed",
      entityType: "fergus_write_request",
      entityId: requestId,
      details: { summary: req.summary, method: req.method, path: req.path },
    });
    createNotification({
      type: "fergus_write_executed",
      severity: "info",
      title: "Fergus updated",
      message: `${req.summary} — sent to Fergus successfully.`,
      entityType: "other",
      entityId: requestId,
    });
    return { ok: true };
  } catch (err: any) {
    const error = err?.message ?? String(err);
    const now = nowIso();
    db.prepare(`UPDATE fergus_write_requests SET status = 'failed', error = ?, updated_at = ? WHERE id = ?`).run(
      error,
      now,
      requestId
    );
    recordAudit({
      actor: "owner",
      action: "fergus_write_failed",
      entityType: "fergus_write_request",
      entityId: requestId,
      details: { error },
    });
    createNotification({
      type: "fergus_write_failed",
      severity: "critical",
      title: "Change to Fergus failed",
      message: `${req.summary} — ${error}`,
      entityType: "other",
      entityId: requestId,
    });
    return { ok: false, error };
  }
}

export function markFergusWriteRejected(requestId: string): void {
  const db = getDb();
  db.prepare(`UPDATE fergus_write_requests SET status = 'rejected', updated_at = ? WHERE id = ? AND status = 'pending_approval'`).run(
    nowIso(),
    requestId
  );
}
