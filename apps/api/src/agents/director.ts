import { getDb } from "../db/connection.js";
import { newId, nowIso } from "../lib/ids.js";
import { getActiveChatClient, chatJson, describeMissingChatClient } from "../integrations/llm.js";
import { buildDirectorContext, findJobByNumber } from "./directorContext.js";
import { recordAudit } from "../lib/audit.js";
import { createNotification } from "../lib/notifications.js";
import { createAgentTask, updateAgentTask } from "../lib/agentTasks.js";

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
      action: {
        type: "string",
        description:
          "A real job to actually start right now, if the owner just asked for one. 'none' unless they clearly " +
          "asked for that specific thing. These are the ONLY things you can make happen -- anything else, you " +
          "must tell the owner you can't do it rather than implying you will.",
        enum: ["none", "run_lead_sweep", "run_fergus_sync", "run_xero_sync"],
      },
    },
    required: ["reply", "jobUpdates", "newQuestions", "businessFacts", "action"],
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
- Keep replies concise and business-like, the way a competent operations manager would talk to the owner.

EVERY SUGGESTION MUST COME FROM THIS BUSINESS'S OWN NUMBERS.
You are not a business-advice generator. Generic advice an outsider could give without ever seeing this
company -- upgrade the vehicles, invest in marketing, improve efficiency, consider hiring, diversify -- is
worthless here and destroys trust. Do not produce it under any circumstances.
- A suggestion is only allowed if you can point at the specific job, invoice, quote, lead or figure in the
  context that prompted it. Name that thing in the suggestion itself ("ELEC-3376 has been open 5 weeks with
  no quote against it"). If you cannot name it, do not make the suggestion.
- The context includes a "dataGaps" list of things you genuinely do not know. When the owner asks what they
  should do and the numbers needed to answer are in dataGaps, the honest and useful answer is to say exactly
  what is missing and what would fix it -- not to fall back on general advice. "I can't tell you which jobs
  are making money: none of your 102 jobs have cost or invoiced figures, because the Fergus sync isn't
  returning them" is a genuinely useful answer. "Consider reviewing your pricing strategy" is not.
- Never imply you can see something you cannot. If a number is null, it is unknown, not zero.

NEVER PROMISE WORK YOU ARE NOT ACTUALLY STARTING. This is the most important rule here.
You cannot do anything in the background between messages. You have no ability to "keep an eye on"
something, "get started on it", "keep you updated", "work on it in the background", or come back later with
results. Nothing happens after this reply unless you set the "action" field, which really does start that job.
- If the owner asks for one of the actions you have (find leads / sweep for customers -> run_lead_sweep,
  refresh jobs from Fergus -> run_fergus_sync, refresh invoices and cash from Xero -> run_xero_sync), set it.
  Do not describe what you are about to do -- it is already running, so say what was started, briefly.
- If they ask for anything else -- assigning a worker in Fergus, phoning a customer, ordering materials,
  booking anything, or any "look into it and get back to me" -- say plainly that you can't do that, name what
  you CAN do or what they need to click, and stop. Do not soften it into a promise.
- Banned phrasings, because they are false: "I'll start...", "I'll begin...", "I'm working on...",
  "I'll keep you updated", "I'll let you know", "leave it with me", "I'll monitor", "in the background".

FERGUS IS READ-ONLY. You can SEE Fergus jobs, customers and financials because they are synced into the
database you are reading. You CANNOT write anything back to Fergus. You cannot mark a job complete, change a
job status, assign a worker, create or send an invoice or quote in Fergus, or check whether Fergus emailed
something. Saying "I'll update the status accordingly", "I'll proceed with preparing the invoice", or "I'll
check the system to confirm it was sent" is a lie, and the owner will believe the job was handled when it was
not. Say what you can see, then say plainly that the change has to be made in Fergus by a person.
- What you CAN do about Fergus: start a fresh sync (run_fergus_sync) to pull in the latest jobs and figures.
- Quotes are different: quotes live in THIS app, not Fergus. If asked for a quote, say it can be built on the
  Quotes page ("+ New quote") and offer to work out the line items and pricing with them there. Never claim to
  have created one.

NEVER STATE A DETAIL YOU WERE NOT GIVEN. If the owner asks where a job is, who the customer is, or what a
figure is, and that field is absent or null in the context, say you do not have it -- do not supply a
plausible value from another job. Guessing a real customer's name or site onto the wrong job is the single
most damaging thing you can do here. The same applies to counts: only ever quote numbers you can see.`;

type DirectorAction = "none" | "run_lead_sweep" | "run_fergus_sync" | "run_xero_sync";

/**
 * Actually starts the job the Director just said it started.
 *
 * The Director used to reply "I'll start the lead generation process and
 * keep you updated" with no code path anywhere that could make that true --
 * it invented having done something. Now the only future work it can refer
 * to is work this function really kicks off, and the sentence appended to
 * its reply describes a real agent_task the owner can watch on the HQ map.
 *
 * These runs take far longer than an HTTP request should, so they're
 * started and left running rather than awaited. Nothing here can send
 * anything to a customer -- a sweep creates leads and drafts, and the
 * approval firewall still stands between a draft and an actual send.
 */
async function startDirectorAction(action: DirectorAction): Promise<string | null> {
  if (action === "none") return null;

  const [{ runAreaSweep }, { runFergusSync }, { runXeroSync }] = await Promise.all([
    import("./leadHunter.js"),
    import("../integrations/fergusSync.js"),
    import("../integrations/xeroSync.js"),
  ]);

  /**
   * Claiming "started" the instant a promise is created is its own lie:
   * these jobs reject almost immediately when an integration isn't
   * configured, so the Director would announce a sweep that never existed.
   * Give it a moment to fail first -- if it's still going after that, it
   * really is running and there's a task row to point at.
   */
  const started = async (label: string, run: () => Promise<unknown>, room: string) => {
    let settled: { ok: true } | { ok: false; error: string } | null = null;
    const promise = run().then(
      () => {
        settled = { ok: true };
      },
      (err: any) => {
        settled = { ok: false, error: err?.message ?? String(err) };
        console.error(`[director] ${label} failed:`, err?.message ?? err);
      }
    );

    await Promise.race([promise, new Promise((r) => setTimeout(r, 1500))]);

    if (settled && !(settled as { ok: boolean }).ok) {
      return `\n\nI couldn't start ${label}: ${(settled as { ok: false; error: string }).error}`;
    }
    if (settled) return `\n\nRan ${label} just now -- results are in already.`;
    return `\n\nStarted now: ${label}. You can watch it on the HQ map (${room}), and I'll have the results next time you ask.`;
  };

  if (action === "run_lead_sweep") return started("a lead sweep of your service area", runAreaSweep, "Lead Radar");
  if (action === "run_fergus_sync") return started("a Fergus sync", runFergusSync, "Jobs Floor");
  if (action === "run_xero_sync") return started("a Xero sync", runXeroSync, "Finance Vault");
  return null;
}

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

  const chat = getActiveChatClient();
  if (!chat) {
    const reply = describeMissingChatClient();
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

    const raw = await chatJson(chat, {
      schema: RESPONSE_SCHEMA,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "system", content: `Current business context (from our own database):\n${JSON.stringify(context, null, 2)}` },
        ...history.reverse().map((m) => ({
          role: (m.role === "owner" ? "user" : "assistant") as "user" | "assistant",
          content: m.content,
        })),
      ],
    });

    const parsed = JSON.parse(raw) as {
      reply: string;
      jobUpdates: { jobNumber: string; key: string; value: string; confidence: number }[];
      newQuestions: { jobNumber: string | null; question: string }[];
      businessFacts: { category: string; content: string }[];
      action?: DirectorAction;
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

    // Run whatever the Director said it was doing, and append what really
    // started -- so the message the owner reads describes an actual
    // agent_task, never an intention.
    const action = parsed.action ?? "none";
    const actionNote = await startDirectorAction(action);
    const reply = actionNote ? `${parsed.reply}${actionNote}` : parsed.reply;

    const directorMessageId = newId("dmsg");
    db.prepare(
      `INSERT INTO director_messages (id, role, content, extracted_data, created_at) VALUES (?, 'director', ?, ?, ?)`
    ).run(
      directorMessageId,
      reply,
      JSON.stringify({
        jobUpdates: parsed.jobUpdates,
        newQuestions: parsed.newQuestions,
        businessFacts: parsed.businessFacts,
        action,
      }),
      nowIso()
    );

    updateAgentTask(taskId, { status: "completed", progress: 100 });
    recordAudit({
      actor: "director",
      action: "director_chat_turn",
      details: { jobUpdatesApplied: applied, questionsRaised, businessFactsSaved: factsSaved, actionStarted: action },
    });

    return {
      ownerMessageId,
      directorMessageId,
      reply,
      jobUpdatesApplied: applied,
      questionsRaised,
      businessFactsSaved: factsSaved,
    };
  } catch (err: any) {
    updateAgentTask(taskId, { status: "failed", error: err?.message ?? String(err) });
    throw err;
  }
}
