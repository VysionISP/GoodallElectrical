import { getDb } from "../db/connection.js";
import { newId, nowIso } from "../lib/ids.js";
import { getOpenAiClient } from "../integrations/openai.js";
import { createAgentTask, updateAgentTask } from "../lib/agentTasks.js";
import { recordAudit } from "../lib/audit.js";

const MODEL = process.env.OPENAI_MODEL ?? "gpt-4o-mini";

const RESPONSE_SCHEMA = {
  name: "outreach_draft",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      subject: { type: "string" },
      body: { type: "string", description: "Plain-text email body. Personalized, not generic spam. No placeholders like [Name]." },
    },
    required: ["subject", "body"],
  },
} as const;

const SYSTEM_PROMPT = `You are Sales AI for Goodall Electrical, an electrical contracting company.
Draft a short, personalized outreach email to a business Research AI has already assessed as a plausible
customer. Reference the specific reason this business might need electrical work -- never generic
"we do electrical work, contact us" spam. Keep it under 150 words. Sign off as "The team at Goodall Electrical".
This is a DRAFT ONLY -- it will never be sent without the owner's explicit approval, so do not claim in the
copy that anything has already happened (no "as discussed", no fabricated prior contact).`;

export async function draftOutreach(leadId: string): Promise<{ taskId: string; outreachId: string }> {
  const db = getDb();
  const lead = db.prepare("SELECT * FROM leads WHERE id = ?").get(leadId) as any;
  if (!lead) throw Object.assign(new Error("Lead not found"), { code: "NOT_FOUND" });

  const client = getOpenAiClient();
  if (!client) {
    throw Object.assign(new Error("OpenAI is not configured. Add an API key in Integrations first."), {
      code: "NOT_CONFIGURED",
    });
  }

  const taskId = createAgentTask({
    agent: "sales_ai",
    taskType: "draft_outreach",
    room: "leads",
    entityType: "lead",
    entityId: leadId,
    message: `Drafting outreach for ${lead.business_name}`,
  });

  try {
    const research = db
      .prepare("SELECT summary, notes FROM lead_research WHERE lead_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(leadId) as { summary: string; notes: string } | undefined;

    const completion = await client.chat.completions.create({
      model: MODEL,
      response_format: { type: "json_schema", json_schema: RESPONSE_SCHEMA },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: JSON.stringify({
            businessName: lead.business_name,
            location: lead.location,
            researchSummary: research?.summary ?? null,
            researchReason: research?.notes ?? lead.reason ?? null,
          }),
        },
      ],
    });

    const parsed = JSON.parse(completion.choices[0]?.message?.content ?? "{}") as { subject: string; body: string };

    const now = nowIso();
    const outreachId = newId("outreach");
    db.prepare(
      `INSERT INTO sales_outreach (id, lead_id, channel, draft_subject, draft_body, status, created_at, updated_at)
       VALUES (?, ?, 'email', ?, ?, 'drafted', ?, ?)`
    ).run(outreachId, leadId, parsed.subject, parsed.body, now, now);

    updateAgentTask(taskId, { status: "completed", progress: 100, message: "Draft ready" });
    recordAudit({ actor: "sales_ai", action: "outreach_drafted", entityType: "lead", entityId: leadId, details: { outreachId } });

    return { taskId, outreachId };
  } catch (err: any) {
    const message = err?.message ?? String(err);
    updateAgentTask(taskId, { status: "failed", error: message });
    throw err;
  }
}
