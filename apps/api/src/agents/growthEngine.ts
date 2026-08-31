import { getDb } from "../db/connection.js";
import { newId, nowIso } from "../lib/ids.js";
import { createAgentTask, updateAgentTask, logAgentEvent } from "../lib/agentTasks.js";
import { createNotification } from "../lib/notifications.js";
import { recordAudit } from "../lib/audit.js";
import { getSetting, setSetting } from "../lib/settings.js";
import { getIntegrationCredentials } from "../integrations/store.js";
import { getActiveChatClient, chatJson } from "../integrations/llm.js";
import { runAreaSweep } from "./leadHunter.js";
import { runLeadResearch } from "./researchAI.js";
import { draftOutreach } from "./salesAI.js";

// Google Places charges per request, so this can't run on the same 30-minute
// cadence as the rest of the background review -- once a day is the floor.
const GROWTH_CYCLE_MIN_GAP_MS = 24 * 60 * 60 * 1000;
const MAX_LEADS_TO_RESEARCH_PER_CYCLE = 10;
const MAX_OUTREACH_DRAFTS_PER_CYCLE = 5;
const QUALIFIED_SCORE_THRESHOLD = 60;

/** Identical to the manual "submit for approval" step in routes/leads.ts -- a draft still lands in Approvals, it just doesn't wait for the owner to click the button that puts it there. */
function submitOutreachForApproval(outreachId: string): void {
  const db = getDb();
  const now = nowIso();
  db.prepare(`UPDATE sales_outreach SET status = 'pending_approval', updated_at = ? WHERE id = ?`).run(now, outreachId);
  db.prepare(
    `INSERT INTO approvals (id, entity_type, entity_id, action, status, requested_by, created_at, updated_at)
     VALUES (?, 'sales_outreach', ?, 'send', 'pending', 'sales_ai', ?, ?)`
  ).run(newId("appr"), outreachId, now, now);
}

export interface GrowthCycleResult {
  ran: boolean;
  reason?: string;
  newLeadsFound: number;
  leadsResearched: number;
  qualifiedLeads: number;
  outreachDrafted: number;
}

/**
 * The "bring more work in without being asked" half of removing the owner
 * from day-to-day running of the business. Runs the exact same sweep ->
 * research -> draft pipeline the owner could already trigger by hand from
 * the Leads page, just without waiting to be told to -- qualified leads land
 * with a draft already sitting in Approvals, so the only thing left for the
 * owner to do is the one thing the approval firewall never skips: actually
 * saying yes before anything goes out to a real business.
 */
export async function runAutonomousGrowthCycle(): Promise<GrowthCycleResult> {
  const empty = { newLeadsFound: 0, leadsResearched: 0, qualifiedLeads: 0, outreachDrafted: 0 };

  const placesCreds = getIntegrationCredentials("google_places");
  if (!placesCreds) {
    return { ran: false, reason: "google_places_not_configured", ...empty };
  }

  const lastRun = getSetting("last_growth_sweep_at");
  if (lastRun && Date.now() - new Date(lastRun).getTime() < GROWTH_CYCLE_MIN_GAP_MS) {
    return { ran: false, reason: "too_soon", ...empty };
  }

  const taskId = createAgentTask({
    agent: "lead_hunter",
    taskType: "autonomous_growth_cycle",
    room: "leads",
    message: "Running unprompted lead sweep",
  });
  setSetting("last_growth_sweep_at", nowIso());

  let newLeadsFound = 0;
  let leadsResearched = 0;
  let qualifiedLeads = 0;
  let outreachDrafted = 0;

  try {
    // Throws NOT_CONFIGURED / NO_SERVICES / NO_QUERIES if the business
    // profile isn't filled in yet -- caught below as an expected, quiet
    // no-op rather than a failure, same as the manual sweep button would.
    const sweep = await runAreaSweep();
    newLeadsFound = sweep.totalCreated;

    const db = getDb();
    const toResearch = db
      .prepare(
        `SELECT l.id FROM leads l
         WHERE l.status = 'new' AND NOT EXISTS (SELECT 1 FROM lead_research r WHERE r.lead_id = l.id)
         ORDER BY l.created_at DESC LIMIT ?`
      )
      .all(MAX_LEADS_TO_RESEARCH_PER_CYCLE) as { id: string }[];

    for (const { id } of toResearch) {
      try {
        const result = await runLeadResearch(id);
        leadsResearched++;
        if (result.suitable && result.leadScore >= QUALIFIED_SCORE_THRESHOLD) qualifiedLeads++;
      } catch (err: any) {
        logAgentEvent({ taskId, agent: "research_ai", eventType: "auto_research_failed", message: err?.message ?? String(err) });
        if (err?.code === "NOT_CONFIGURED") break; // every remaining lead will fail identically -- stop wasting the loop
      }
    }

    const toOutreach = db
      .prepare(
        `SELECT l.id FROM leads l
         WHERE l.status = 'qualified' AND l.lead_score >= ? AND l.contact_email IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM sales_outreach o WHERE o.lead_id = l.id)
         ORDER BY l.lead_score DESC LIMIT ?`
      )
      .all(QUALIFIED_SCORE_THRESHOLD, MAX_OUTREACH_DRAFTS_PER_CYCLE) as { id: string }[];

    for (const { id } of toOutreach) {
      try {
        const drafted = await draftOutreach(id);
        submitOutreachForApproval(drafted.outreachId);
        outreachDrafted++;
      } catch (err: any) {
        logAgentEvent({ taskId, agent: "sales_ai", eventType: "auto_outreach_failed", message: err?.message ?? String(err) });
        if (err?.code === "NOT_CONFIGURED") break;
      }
    }

    if (outreachDrafted > 0) {
      createNotification({
        type: "outreach_requires_approval",
        severity: "warning",
        title: "Outreach ready for your approval",
        message: `${outreachDrafted} outreach draft${outreachDrafted === 1 ? "" : "s"} from today's automatic lead sweep are waiting for your approval.`,
      });
    }

    updateAgentTask(taskId, {
      status: "completed",
      progress: 100,
      message: `${newLeadsFound} new lead(s), ${qualifiedLeads} qualified, ${outreachDrafted} outreach draft(s) ready for approval`,
    });
    recordAudit({
      actor: "lead_hunter",
      action: "autonomous_growth_cycle_completed",
      details: { newLeadsFound, leadsResearched, qualifiedLeads, outreachDrafted },
    });

    return { ran: true, newLeadsFound, leadsResearched, qualifiedLeads, outreachDrafted };
  } catch (err: any) {
    const expected = ["NOT_CONFIGURED", "NO_SERVICES", "NO_QUERIES"].includes(err?.code);
    if (expected) {
      updateAgentTask(taskId, { status: "completed", progress: 100, message: `Skipped: ${err.message}` });
    } else {
      updateAgentTask(taskId, { status: "failed", error: err?.message ?? String(err) });
      logAgentEvent({ taskId, agent: "lead_hunter", eventType: "autonomous_growth_cycle_failed", message: err?.message ?? String(err) });
    }
    return { ran: false, reason: err?.code ?? "error", newLeadsFound, leadsResearched, qualifiedLeads, outreachDrafted };
  }
}

const GROWTH_UPDATE_SCHEMA = {
  name: "growth_cycle_update",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      message: {
        type: "string",
        description:
          "One short, natural first-person message from the Director reporting what an unprompted lead-generation " +
          "sweep just did, in plain business language -- not a data dump. Only state the real numbers given.",
      },
    },
    required: ["message"],
  },
} as const;

/** Only called when the cycle actually found or drafted something -- a sweep that found nothing new doesn't need to interrupt the owner every day. */
export async function postGrowthCycleUpdate(result: GrowthCycleResult): Promise<void> {
  const db = getDb();
  const chat = getActiveChatClient();
  let message: string;

  if (!chat) {
    message =
      `Ran an unprompted lead sweep: ${result.newLeadsFound} new lead(s) found, ${result.leadsResearched} researched, ` +
      `${result.qualifiedLeads} qualified, ${result.outreachDrafted} outreach draft(s) waiting in Approvals.`;
  } else {
    try {
      const raw = await chatJson(chat, {
        schema: GROWTH_UPDATE_SCHEMA,
        messages: [
          {
            role: "system",
            content:
              "You are the AI Director for Goodall Electrical, an electrical contracting company. You just ran an " +
              "unprompted lead-generation sweep of the owner's service area and are reporting back, the way a " +
              "salesperson would mention what they found in passing -- not a spreadsheet readout.",
          },
          { role: "user", content: JSON.stringify(result) },
        ],
      });
      const parsed = JSON.parse(raw) as { message: string };
      message =
        parsed.message?.trim() ||
        `Found ${result.newLeadsFound} new lead(s) today, ${result.outreachDrafted} outreach draft(s) waiting for your approval.`;
    } catch (err: any) {
      logAgentEvent({ agent: "director", eventType: "growth_update_compose_failed", message: err?.message ?? String(err) });
      message =
        `Ran an unprompted lead sweep: ${result.newLeadsFound} new lead(s) found, ${result.qualifiedLeads} qualified, ` +
        `${result.outreachDrafted} outreach draft(s) waiting in Approvals.`;
    }
  }

  db.prepare(`INSERT INTO director_messages (id, role, content, created_at) VALUES (?, 'director', ?, ?)`).run(newId("dmsg"), message, nowIso());
}
