import { getDb } from "../db/connection.js";
import { newId, nowIso } from "../lib/ids.js";
import { getActiveChatClient, chatJson } from "../integrations/llm.js";
import { createAgentTask, updateAgentTask } from "../lib/agentTasks.js";
import { recordAudit } from "../lib/audit.js";

const RESPONSE_SCHEMA = {
  name: "lead_research",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      suitable: { type: "boolean", description: "Whether this business is a plausible customer for an electrical contractor." },
      leadScore: { type: "number", description: "0-100 opportunity score. Only score what the given information actually supports." },
      reason: { type: "string", description: "Why this business may need electrical work -- grounded in the info given, not invented." },
      summary: { type: "string", description: "1-2 sentence research summary." },
    },
    required: ["suitable", "leadScore", "reason", "summary"],
  },
} as const;

const SYSTEM_PROMPT = `You are Research AI for Goodall Electrical, an electrical contracting company.
Given a business found by Lead Hunter, assess whether it's a plausible customer and why.

Rules:
- Only use the information you're actually given (name, address, Google Places category types, and
  website text if provided). Never invent details about the business you weren't told.
- If the available information is thin, say so in the summary and give a lower leadScore rather than
  guessing confidently.
- Respect any business rules provided in "business memory" (e.g. minimum job size, categories to avoid).`;

/** Best-effort: fetches a business's homepage and strips it down to plain text for extra context. Never fatal. */
async function fetchWebsiteText(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const html = await res.text();
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return text.slice(0, 3000) || null;
  } catch {
    return null;
  }
}

export async function runLeadResearch(leadId: string): Promise<{ taskId: string; suitable: boolean; leadScore: number }> {
  const db = getDb();
  const lead = db.prepare("SELECT * FROM leads WHERE id = ?").get(leadId) as any;
  if (!lead) throw Object.assign(new Error("Lead not found"), { code: "NOT_FOUND" });

  const chat = getActiveChatClient();
  if (!chat) {
    throw Object.assign(new Error("No AI provider is configured. Add an OpenAI or OpenRouter API key in Integrations first."), {
      code: "NOT_CONFIGURED",
    });
  }

  const taskId = createAgentTask({
    agent: "research_ai",
    taskType: "lead_research",
    room: "leads",
    entityType: "lead",
    entityId: leadId,
    message: `Researching ${lead.business_name}`,
  });

  try {
    const websiteText = lead.website ? await fetchWebsiteText(lead.website) : null;
    const businessMemory = db
      .prepare("SELECT content FROM business_memory WHERE active = 1 ORDER BY created_at DESC LIMIT 15")
      .all() as { content: string }[];

    const raw = await chatJson(chat, {
      schema: RESPONSE_SCHEMA,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: JSON.stringify({
            businessName: lead.business_name,
            location: lead.location,
            website: lead.website,
            websiteText,
            businessMemory: businessMemory.map((m) => m.content),
          }),
        },
      ],
    });

    const parsed = JSON.parse(raw) as {
      suitable: boolean;
      leadScore: number;
      reason: string;
      summary: string;
    };

    const now = nowIso();
    db.prepare(
      `INSERT INTO lead_research (id, lead_id, summary, notes, researched_by, created_at) VALUES (?, ?, ?, ?, 'research_ai', ?)`
    ).run(newId("research"), leadId, parsed.summary, parsed.reason, now);

    db.prepare(
      `UPDATE leads SET lead_score = ?, reason = ?, status = ?, updated_at = ? WHERE id = ?`
    ).run(parsed.leadScore, parsed.reason, parsed.suitable ? "qualified" : "unqualified", now, leadId);

    updateAgentTask(taskId, { status: "completed", progress: 100, message: `Score ${parsed.leadScore}` });
    recordAudit({
      actor: "research_ai",
      action: "lead_researched",
      entityType: "lead",
      entityId: leadId,
      details: { suitable: parsed.suitable, leadScore: parsed.leadScore },
    });

    return { taskId, suitable: parsed.suitable, leadScore: parsed.leadScore };
  } catch (err: any) {
    const message = err?.message ?? String(err);
    updateAgentTask(taskId, { status: "failed", error: message });
    throw err;
  }
}
