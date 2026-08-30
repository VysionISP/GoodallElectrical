import { getDb } from "../db/connection.js";
import { newId, nowIso } from "./ids.js";

export type NotificationSeverity = "info" | "warning" | "critical";

export function createNotification(params: {
  type: string;
  severity?: NotificationSeverity;
  title: string;
  message?: string;
  entityType?: string;
  entityId?: string;
}): string {
  const db = getDb();
  const id = newId("notif");
  db.prepare(
    `INSERT INTO notifications (id, type, severity, title, message, entity_type, entity_id, read, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`
  ).run(
    id,
    params.type,
    params.severity ?? "info",
    params.title,
    params.message ?? null,
    params.entityType ?? null,
    params.entityId ?? null,
    nowIso()
  );
  return id;
}
