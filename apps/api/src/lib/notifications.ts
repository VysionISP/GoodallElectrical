import { getDb } from "../db/connection.js";
import { newId, nowIso } from "./ids.js";

export type NotificationSeverity = "info" | "warning" | "critical";

/**
 * Creates a notification, unless an identical one is already sitting
 * unread.
 *
 * Without this, anything on a timer piles up: the background review runs
 * every 30 minutes and raised a fresh "Director needs information" every
 * cycle, so an owner who didn't answer came back to dozens of copies of
 * one message. A notification the owner hasn't read yet is not made more
 * useful by being sent again -- it's the same task, so it stays one row.
 */
export function createNotification(params: {
  type: string;
  severity?: NotificationSeverity;
  title: string;
  message?: string;
  entityType?: string;
  entityId?: string;
}): string {
  const db = getDb();

  const existing = (
    params.entityId
      ? db.prepare("SELECT id FROM notifications WHERE read = 0 AND type = ? AND entity_id = ?").get(params.type, params.entityId)
      : db.prepare("SELECT id FROM notifications WHERE read = 0 AND type = ? AND entity_id IS NULL").get(params.type)
  ) as { id: string } | undefined;
  if (existing) return existing.id;

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
