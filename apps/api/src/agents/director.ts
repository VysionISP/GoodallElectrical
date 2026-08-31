import { getDb } from "../db/connection.js";
import { newId, nowIso } from "../lib/ids.js";
import { getOpenAiClient } from "../integrations/openai.js";
import { buildDirectorContext, findJobByNumber } from "./directorContext.js";
import { recordAudit } from "../lib/audit.js";
import { createNotification } from "../lib/notifications.js";
import { createAgentTask, updateAgentTask } from "../lib/agentTasks.js";

const MODEL = process.env.OPENAI_MODEL ?? "gpt-4o-mini";

const RESPONSE_SCHEMA = {
  name: "director_response",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      reply: { type: "string", description: "Conversational reply to show the owner." },
      jobUpdates: {
        type: "array",
        description:
          "Structured facts extracted from the owner's message that should be stored against a specific job. Only include a fact if the owner's message actually states it -- never invent one.",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            jobNumber: { type: "string", description: "The job number this fact applies to, e.g. ELEC-3256." },
            key: { type: "string", description: "snake_case fact name, e.g. night_work, crew_size, shutdown_time." },
            value: { type: "string", description: "The value as a string (numbers/booleans stringified)." },
            confidence: { type: "number", description: "0-1 confidence that this extraction is correct." },
          },
          required: ["jobNumber", "key", "value", "confidence"],
        },
      },
      newQuestions: {
        type: "array",
        description: "Questions the Director still needs answered before it can finish an assessment.",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            jobNumber: {
              type: ["string", "null"],
              description: "The job number this question relates to, e.g. ELEC-3256, or null if it's not job-specific.",
            },
            question: { type: "string" },
          },
          required: ["jobNumber", "question"],
        },
      },
      businessFacts: {
        type: "array",
        description:
          "General business knowledge the owner just told you that ISN'T tied to one job -- what services the " +
          "business offers, its service area, pricing rules, or job types it won't take. Only include a fact if " +
          "the owner's message actually states it.",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            category: {
              type: "string",
              enum: ["services", "service_area", "pricing", "exclusions", "other"],
            },
            content: { type: "string", description: "The fact itself, written as a standalone statement." },
          },
          required: ["category", "content"],
        },
      },
    },
    required: ["reply", "jobUpdates", "newQuestions", "businessFacts"],
  },
} as const;

const SYSTEM_PROMPT = `You are the AI Director for Goodall Electrical, an electrical contracting company.
You are the virtual general manager: you understand jobs, customers, quotes, profitability, receivables,
payables, cashflow and business memory, and you speak to the owner directly and plainly.

Absolute rules:
- Never invent a fact you were not given. If you don't know something, say so and ask.
- When the owner's message gives you a concrete fact about a specific job (crew size, night work,
  shutdown timing, materials status, access, etc.), extract it into jobUpdates against that job's number.
- When the owner tells you something general about the BUSINESS rather than one job -- what services you offer,
  where you're willing to work, pricing rules, job types you don't take -- extract it into businessFacts, not
  jobUpdates. This is important: don't make the owner fill out a settings form for this, just listen for it in
  conversation and save it yourself.
- If the business context shows no "services" business memory yet, and the owner hasn't just told you in this
  message, ask what services the business offers and what area it wants to work in -- this blocks lead generation
  and job profitability judgement, so it's worth asking about early rather than waiting to be asked.
- The business context includes a real cashflowForecast (current cash from Xero, expected receipts, payables, and
  recurring costs across 7/14/30/60/90-day windows) -- use it for scenario questions like "can we afford another
  electrician". If currentCash is null, Xero's bank position hasn't been read yet -- say that plainly instead of
  guessing a number. If hasRecurringCosts is false, say the forecast doesn't yet account for wages/super/fixed
  costs because none have been entered under Recurring Costs, rather than presenting the forecast as complete.
  When reasoning about a new hire or purchase, use the real loaded_hourly_cost from employees if relevant, and be
  explicit about which numbers are real (from the forecast) versus your own estimate.
- If you still need information to finish an assessment, add it to newQuestions rather than guessing.
- Keep replies concise and business-like, the way a competent operations manager would talk to the owner.`;

export interface DirectorTurnResult {
  ownerMessageId: string;
  directorMessageId: string;
  reply: string;
  jobUpdatesApplied: number;
  questionsRaised: number;
  businessFactsSaved: number;
}

export async function runDirectorTurn(ownerMessage: string): Promise<DirectorTurnResult> {
  const db = getDb();
  const now = nowIso();
  const ownerMessageId = newId("dmsg");
  db.prepare(
    `INSERT INTO director_messages (id, role, content, created_at) VALUES (?, 'owner', ?, ?)`
  ).run(ownerMessageId, ownerMessage, now);

  const client = getOpenAiClient();
  if (!client) {
    const reply =
      "OpenAI isn't configured yet, so I can't think this through. Add an API key under Integrations and I'll be able to respond.";
    const directorMessageId = newId("dmsg");
    db.prepare(
      `INSERT INTO director_messages (id, role, content, created_at) VALUES (?, 'director', ?, ?)`
    ).run(directorMessageId, reply, nowIso());
    return { ownerMessageId, directorMessageId, reply, jobUpdatesApplied: 0, questionsRaised: 0, businessFactsSaved: 0 };
  }

  const taskId = createAgentTask({ agent: "director", taskType: "director_chat", room: "director" });

  try {
    const context = buildDirectorContext();
    const history = db
      .prepare("SELECT role, content FROM director_messages ORDER BY created_at DESC LIMIT 20")
      .all() as { role: string; content: string }[];

    const completion = await client.chat.completions.create({
      model: MODEL,
      response_format: { type: "json_schema", json_schema: RESPONSE_SCHEMA },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "system", content: `Current business context (from our own database):\n${JSON.stringify(context, null, 2)}` },
        ...history.reverse().map((m) => ({
          role: (m.role === "owner" ? "user" : "assistant") as "user" | "assistant",
          content: m.content,
        })),
      ],
    });

    const raw = completion.choices[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(raw) as {
      reply: string;
      jobUpdates: { jobNumber: string; key: string; value: string; confidence: number }[];
      newQuestions: { jobNumber: string | null; question: string }[];
      businessFacts: { category: string; content: string }[];
    };

    let applied = 0;
    for (const update of parsed.jobUpdates) {
      const job = findJobByNumber(update.jobNumber);
      if (!job) continue; // never fabricate a job that doesn't exist locally
      const status = update.confidence >= 0.7 ? "known" : "inferred";
      const nowTs = nowIso();
      db.prepare(
        `INSERT INTO job_context (id, job_id, key, value, status, confidence, provenance, source_message_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'owner_provided', ?, ?, ?)
         ON CONFLICT(job_id, key) DO UPDATE SET value = excluded.value, status = excluded.status,
           confidence = excluded.confidence, provenance = 'owner_provided',
           source_message_id = excluded.source_message_id, updated_at = excluded.updated_at`
      ).run(newId("ctx"), job.id, update.key, update.value, status, update.confidence, ownerMessageId, nowTs, nowTs);
      applied++;

      // Auto-resolve any open question this answer covers.
      db.prepare(
        `UPDATE ai_questions SET status = 'answered', updated_at = ? WHERE entity_type = 'job' AND entity_id = ? AND status = 'open' AND question LIKE '%' || ? || '%'`
      ).run(nowTs, job.id, update.key.replace(/_/g, " "));
    }

    let factsSaved = 0;
    for (const fact of parsed.businessFacts) {
      const nowTs = nowIso();
      db.prepare(
        `INSERT INTO business_memory (id, content, category, created_by, active, created_at, updated_at)
         VALUES (?, ?, ?, 'owner', 1, ?, ?)`
      ).run(newId("bmem"), fact.content, fact.category, nowTs, nowTs);
      factsSaved++;
    }
    // A "what services do you offer" style open question is satisfied the
    // moment the owner states any business fact in chat -- close it rather
    // than leaving it open now that the information actually exists.
    if (factsSaved > 0) {
      db.prepare(
        `UPDATE ai_questions SET status = 'answered', updated_at = ? WHERE status = 'open' AND entity_type IS NULL AND (question LIKE '%services%' OR question LIKE '%area%')`
      ).run(nowIso());
    }

    let questionsRaised = 0;
    for (const q of parsed.newQuestions) {
      const job = q.jobNumber ? findJobByNumber(q.jobNumber) : undefined;
      const nowTs = nowIso();
      db.prepare(
        `INSERT INTO ai_questions (id, agent, entity_type, entity_id, question, status, created_at, updated_at)
         VALUES (?, 'director', ?, ?, ?, 'open', ?, ?)`
      ).run(newId("q"), job ? "job" : null, job?.id ?? null, q.question, nowTs, nowTs);
      questionsRaised++;
    }

    if (questionsRaised > 0) {
      createNotification({
        type: "director_needs_info",
        severity: "warning",
        title: "Director needs information",
        message: `${questionsRaised} question${questionsRaised === 1 ? "" : "s"} waiting for your input.`,
      });
    }

    const directorMessageId = newId("dmsg");
    db.prepare(
      `INSERT INTO director_messages (id, role, content, extracted_data, created_at) VALUES (?, 'director', ?, ?, ?)`
    ).run(
      directorMessageId,
      parsed.reply,
      JSON.stringify({ jobUpdates: parsed.jobUpdates, newQuestions: parsed.newQuestions, businessFacts: parsed.businessFacts }),
      nowIso()
    );

    updateAgentTask(taskId, { status: "completed", progress: 100 });
    recordAudit({
      actor: "director",
      action: "director_chat_turn",
      details: { jobUpdatesApplied: applied, questionsRaised, businessFactsSaved: factsSaved },
    });

    return {
      ownerMessageId,
      directorMessageId,
      reply: parsed.reply,
      jobUpdatesApplied: applied,
      questionsRaised,
      businessFactsSaved: factsSaved,
    };
  } catch (err: any) {
    updateAgentTask(taskId, { status: "failed", error: err?.message ?? String(err) });
    throw err;
  }
}
