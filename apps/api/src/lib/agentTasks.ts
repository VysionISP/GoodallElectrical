import { getDb } from "../db/connection.js";
import { newId, nowIso } from "./ids.js";

export type AgentName =
  | "director"
  | "operations_ai"
  | "estimator_ai"
  | "finance_ai"
  | "debtor_ai"
  | "lead_hunter"
  | "research_ai"
  | "sales_ai";

export type AgentTaskStatus = "queued" | "running" | "waiting" | "completed" | "failed" | "idle";

export type Room = "jobs" | "estimating" | "finance" | "director" | "leads" | "approvals" | "core";

/**
 * Thin wrapper around agent_tasks/agent_events. This is the single source
 * of truth the frontend HQ must poll to animate workers -- there is no
 * client-side fake movement. Every long-running AI/integration action
 * should create a task here, update its progress as it runs, and mark it
 * completed/failed/waiting so the UI reflects real backend state.
 */
export function createAgentTask(params: {
  agent: AgentName;
  taskType: string;
  room?: Room;
  entityType?: string;
  entityId?: string;
  message?: string;
}): string {
  const db = getDb();
  const id = newId("task");
  const now = nowIso();
  db.prepare(
    `INSERT INTO agent_tasks (id, agent, task_type, room, entity_type, entity_id, status, progress, message, started_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'running', 0, ?, ?, ?, ?)`
  ).run(
    id,
    params.agent,
    params.taskType,
    params.room ?? null,
    params.entityType ?? null,
    params.entityId ?? null,
    params.message ?? null,
    now,
    now,
    now
  );
  logAgentEvent({ taskId: id, agent: params.agent, eventType: "started", message: params.message });
  return id;
}

export function updateAgentTask(
  id: string,
  patch: Partial<{
    status: AgentTaskStatus;
    progress: number;
    message: string;
    error: string;
    room: Room;
  }>
): void {
  const db = getDb();
  const fields: string[] = [];
  const values: unknown[] = [];
  for (const [key, value] of Object.entries(patch)) {
    fields.push(`${key} = ?`);
    values.push(value);
  }
  if (patch.status === "completed" || patch.status === "failed") {
    fields.push("finished_at = ?");
    values.push(nowIso());
  }
  fields.push("updated_at = ?");
  values.push(nowIso());
  values.push(id);
  db.prepare(`UPDATE agent_tasks SET ${fields.join(", ")} WHERE id = ?`).run(...values);
}

export function logAgentEvent(params: {
  taskId?: string;
  agent: AgentName;
  eventType: string;
  message?: string;
  data?: unknown;
}): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO agent_events (id, task_id, agent, event_type, message, data, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    newId("evt"),
    params.taskId ?? null,
    params.agent,
    params.eventType,
    params.message ?? null,
    params.data !== undefined ? JSON.stringify(params.data) : null,
    nowIso()
  );
}
