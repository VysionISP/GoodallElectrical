import { getDb } from "../db/connection.js";
import { newId, nowIso } from "../lib/ids.js";
import { createAgentTask, updateAgentTask, logAgentEvent } from "../lib/agentTasks.js";
import { createNotification } from "../lib/notifications.js";
import { recordAudit } from "../lib/audit.js";
import { getIntegrationCredentials } from "../integrations/store.js";
import { searchTextRaw, mapPlace, type GooglePlacesCredentials } from "../integrations/googlePlaces.js";

/**
 * Lead Hunter: runs a Google Places text search and upserts results into
 * `leads`. Deduplicated by (source, source_ref) so re-running the same
 * search doesn't create duplicate rows -- see migration 007. Never
 * invents a lead_score or reason here; that's Research AI's job, and only
 * once it has actually looked at the business.
 */
export async function runLeadSearch(query: string): Promise<{ taskId: string; found: number; created: number }> {
  const creds = getIntegrationCredentials<GooglePlacesCredentials>("google_places");
  if (!creds?.apiKey) {
    throw Object.assign(new Error("Google Places is not configured. Add an API key in Integrations first."), {
      code: "NOT_CONFIGURED",
    });
  }

  const taskId = createAgentTask({
    agent: "lead_hunter",
    taskType: "lead_search",
    room: "leads",
    message: `Searching: ${query}`,
  });

  try {
    const rawPlaces = await searchTextRaw(creds, query, 20);
    const db = getDb();
    const now = nowIso();
    let created = 0;

    for (const raw of rawPlaces) {
      const place = mapPlace(raw);
      const existing = db
        .prepare("SELECT id FROM leads WHERE source = 'google_places' AND source_ref = ?")
        .get(place.placeId) as { id: string } | undefined;

      if (existing) {
        db.prepare(
          `UPDATE leads SET business_name = ?, location = ?, website = ?, contact_phone = ?, updated_at = ? WHERE id = ?`
        ).run(place.name, place.address, place.website, place.phone, now, existing.id);
      } else {
        db.prepare(
          `INSERT INTO leads (id, business_name, location, website, contact_phone, status, source, source_ref, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'new', 'google_places', ?, ?, ?)`
        ).run(newId("lead"), place.name, place.address, place.website, place.phone, place.placeId, now, now);
        created++;
      }
    }

    updateAgentTask(taskId, {
      status: "completed",
      progress: 100,
      message: `Found ${rawPlaces.length}, ${created} new`,
    });
    logAgentEvent({ taskId, agent: "lead_hunter", eventType: "search_completed", data: { query, found: rawPlaces.length, created } });
    recordAudit({ actor: "lead_hunter", action: "lead_search_completed", details: { query, found: rawPlaces.length, created } });
    if (created > 0) {
      createNotification({
        type: "leads_found",
        severity: "info",
        title: "Lead Hunter found new businesses",
        message: `${created} new lead${created === 1 ? "" : "s"} from "${query}".`,
      });
    }
    return { taskId, found: rawPlaces.length, created };
  } catch (err: any) {
    const message = err?.message ?? String(err);
    updateAgentTask(taskId, { status: "failed", error: message });
    recordAudit({ actor: "lead_hunter", action: "lead_search_failed", details: { query, error: message } });
    throw err;
  }
}
