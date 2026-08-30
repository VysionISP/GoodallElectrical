import { getDb } from "../db/connection.js";
import { newId, nowIso } from "./ids.js";

/**
 * Records one row in audit_log. Every consequential AI or owner action
 * (imports, questions asked/answered, forecast recalculations, approvals,
 * sends) should call this -- section 24 of the product brief treats this
 * as non-negotiable for any software that lets AI take actions.
 */
export function recordAudit(params: {
  actor: string;
  action: string;
  entityType?: string;
  entityId?: string;
  details?: unknown;
}): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO audit_log (id, actor, action, entity_type, entity_id, details, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    newId("audit"),
    params.actor,
    params.action,
    params.entityType ?? null,
    params.entityId ?? null,
    params.details !== undefined ? JSON.stringify(params.details) : null,
    nowIso()
  );
}
