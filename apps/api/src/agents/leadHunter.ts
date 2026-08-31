import { getDb } from "../db/connection.js";
import { newId, nowIso } from "../lib/ids.js";
import { createAgentTask, updateAgentTask, logAgentEvent } from "../lib/agentTasks.js";
import { createNotification } from "../lib/notifications.js";
import { recordAudit } from "../lib/audit.js";
import { getIntegrationCredentials } from "../integrations/store.js";
import { getActiveChatClient, chatJson } from "../integrations/llm.js";
import { searchTextRaw, mapPlace, isLikelyBusiness, isCompetitor, type GooglePlacesCredentials } from "../integrations/googlePlaces.js";

function requireGooglePlacesCreds(): GooglePlacesCredentials {
  const creds = getIntegrationCredentials<GooglePlacesCredentials>("google_places");
  if (!creds?.apiKey) {
    throw Object.assign(new Error("Google Places is not configured. Add an API key in Integrations first."), {
      code: "NOT_CONFIGURED",
    });
  }
  return creds;
}

/**
 * Runs one Google Places text search and upserts results into `leads`.
 * Deduplicated by (source, source_ref) so re-running the same search
 * doesn't create duplicate rows -- see migration 007. Never invents a
 * lead_score or reason here; that's Research AI's job, and only once it
 * has actually looked at the business. Shared by both a single manual
 * search and a multi-query area sweep.
 */
async function searchAndUpsert(creds: GooglePlacesCredentials, query: string): Promise<{ found: number; created: number }> {
  const rawPlaces = await searchTextRaw(creds, query, 20);
  const db = getDb();
  const now = nowIso();
  let created = 0;
  let businessCount = 0;

  for (const raw of rawPlaces) {
    const place = mapPlace(raw);
    // Text Search can return the town/suburb/postcode itself alongside
    // real businesses (e.g. "Sale, VIC" showing up for a query mentioning
    // "Sale VIC") -- skip anything that isn't actually a business.
    if (!isLikelyBusiness(place)) continue;
    // A lead search should find customers, not other electricians.
    if (isCompetitor(place)) continue;
    businessCount++;

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

  return { found: businessCount, created };
}

export async function runLeadSearch(query: string): Promise<{ taskId: string; found: number; created: number }> {
  const creds = requireGooglePlacesCreds();
  const taskId = createAgentTask({
    agent: "lead_hunter",
    taskType: "lead_search",
    room: "leads",
    message: `Searching: ${query}`,
  });

  try {
    const { found, created } = await searchAndUpsert(creds, query);
    updateAgentTask(taskId, { status: "completed", progress: 100, message: `Found ${found}, ${created} new` });
    logAgentEvent({ taskId, agent: "lead_hunter", eventType: "search_completed", data: { query, found, created } });
    recordAudit({ actor: "lead_hunter", action: "lead_search_completed", details: { query, found, created } });
    if (created > 0) {
      createNotification({
        type: "leads_found",
        severity: "info",
        title: "Lead Hunter found new businesses",
        message: `${created} new lead${created === 1 ? "" : "s"} from "${query}".`,
      });
    }
    return { taskId, found, created };
  } catch (err: any) {
    const message = err?.message ?? String(err);
    updateAgentTask(taskId, { status: "failed", error: message });
    recordAudit({ actor: "lead_hunter", action: "lead_search_failed", details: { query, error: message } });
    throw err;
  }
}

const SUGGEST_SCHEMA = {
  name: "suggested_searches",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      queries: {
        type: "array",
        description: "3-6 Google Places text search queries likely to surface plausible customers.",
        items: { type: "string" },
      },
    },
    required: ["queries"],
  },
} as const;

/**
 * Suggests Google Places search queries grounded in the owner's own
 * "services" / "service_area" business_memory entries -- never invents a
 * service the business doesn't actually list, and never guesses a
 * location if none has been recorded (asks for one instead).
 */
export async function suggestSearchQueries(): Promise<string[]> {
  const chat = getActiveChatClient();
  if (!chat) {
    throw Object.assign(new Error("No AI provider is configured. Add an OpenAI or OpenRouter API key in Integrations first."), {
      code: "NOT_CONFIGURED",
    });
  }

  const db = getDb();
  const services = db
    .prepare("SELECT content FROM business_memory WHERE active = 1 AND category = 'services' ORDER BY created_at DESC")
    .all() as { content: string }[];
  const serviceArea = db
    .prepare("SELECT content FROM business_memory WHERE active = 1 AND category = 'service_area' ORDER BY created_at DESC")
    .all() as { content: string }[];

  if (services.length === 0) {
    throw Object.assign(
      new Error("Add what services you offer under Business Profile first -- nothing to base search suggestions on yet."),
      { code: "NO_SERVICES" }
    );
  }

  const raw = await chatJson(chat, {
    schema: SUGGEST_SCHEMA,
    messages: [
      {
        role: "system",
        content:
          "You suggest Google Places text search queries to find potential CUSTOMERS for an electrical " +
          "contracting business, based only on the services and service area it actually lists. The goal is " +
          "businesses and property types that would need this work done, e.g. property managers, retail chains, " +
          "hospitality venues, offices, strata/body corporate managers -- NEVER other electricians, electrical " +
          "contractors, or sparkies. Do not write a query like 'electricians near X' or 'electrical services near " +
          "X', since that returns competitors, not customers. Never invent a service or a location it didn't " +
          "state. If no service area was given, write location-agnostic queries (e.g. end with 'near [area]' as a " +
          "literal placeholder for the owner to fill in) rather than guessing one.",
      },
      {
        role: "user",
        content: JSON.stringify({
          servicesOffered: services.map((s) => s.content),
          serviceArea: serviceArea.map((s) => s.content),
        }),
      },
    ],
  });

  const parsed = JSON.parse(raw) as { queries: string[] };
  return parsed.queries ?? [];
}

const MAX_SWEEP_QUERIES = 8;

/**
 * Runs a full sweep of the owner's service area in one go: gets AI-
 * suggested queries grounded in their "services"/"service_area" business
 * profile (same source as suggestSearchQueries), then runs each one
 * through Lead Hunter automatically. This is the "go find businesses we
 * can service" button -- no manual query typing required, but it still
 * only ever searches for what the owner actually said they offer/cover.
 *
 * One query failing (e.g. a transient Places API error) doesn't abort the
 * rest of the sweep; failures are collected and reported honestly rather
 * than silently dropped.
 */
export async function runAreaSweep(): Promise<{
  taskId: string;
  queriesRun: string[];
  totalFound: number;
  totalCreated: number;
  failedQueries: { query: string; error: string }[];
}> {
  const creds = requireGooglePlacesCreds();
  const queries = (await suggestSearchQueries()).slice(0, MAX_SWEEP_QUERIES);

  if (queries.length === 0) {
    throw Object.assign(new Error("No search queries could be generated -- check your Business Profile."), {
      code: "NO_QUERIES",
    });
  }

  const taskId = createAgentTask({
    agent: "lead_hunter",
    taskType: "area_sweep",
    room: "leads",
    message: `Sweeping ${queries.length} searches`,
  });

  let totalFound = 0;
  let totalCreated = 0;
  const failedQueries: { query: string; error: string }[] = [];

  for (let i = 0; i < queries.length; i++) {
    const query = queries[i];
    updateAgentTask(taskId, {
      progress: Math.round((i / queries.length) * 100),
      message: `Searching: ${query}`,
    });
    try {
      const { found, created } = await searchAndUpsert(creds, query);
      totalFound += found;
      totalCreated += created;
      logAgentEvent({ taskId, agent: "lead_hunter", eventType: "sweep_query_completed", data: { query, found, created } });
    } catch (err: any) {
      const message = err?.message ?? String(err);
      failedQueries.push({ query, error: message });
      logAgentEvent({ taskId, agent: "lead_hunter", eventType: "sweep_query_failed", data: { query, error: message } });
    }
  }

  const allFailed = failedQueries.length === queries.length;
  updateAgentTask(taskId, {
    status: allFailed ? "failed" : "completed",
    progress: 100,
    message: `${totalFound} found, ${totalCreated} new across ${queries.length} searches`,
    error: allFailed ? failedQueries.map((f) => f.error).join("; ") : undefined,
  });

  recordAudit({
    actor: "lead_hunter",
    action: "area_sweep_completed",
    details: { queries, totalFound, totalCreated, failedQueries },
  });

  createNotification({
    type: "area_sweep_completed",
    severity: allFailed ? "critical" : "info",
    title: "Lead Hunter finished sweeping your area",
    message:
      `Ran ${queries.length} search${queries.length === 1 ? "" : "es"}, found ${totalFound}, ${totalCreated} new.` +
      (failedQueries.length > 0 ? ` ${failedQueries.length} search(es) failed.` : ""),
  });

  return { taskId, queriesRun: queries, totalFound, totalCreated, failedQueries };
}
