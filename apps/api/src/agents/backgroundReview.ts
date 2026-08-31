import { getDb } from "../db/connection.js";
import { newId, nowIso } from "../lib/ids.js";
import { createAgentTask, updateAgentTask, logAgentEvent, type AgentName } from "../lib/agentTasks.js";
import { createNotification } from "../lib/notifications.js";
import { getOpenAiClient } from "../integrations/openai.js";
import { recordAudit } from "../lib/audit.js";

const MODEL = process.env.OPENAI_MODEL ?? "gpt-4o-mini";
const MAX_JOBS_PER_CYCLE = 5;

/** Inserts an open question only if an identical open one doesn't already exist -- keeps repeated review cycles from spamming duplicates. */
function ensureOpenQuestion(agent: AgentName, entityType: string | null, entityId: string | null, question: string): boolean {
  const db = getDb();
  const existing = entityId
    ? db.prepare("SELECT id FROM ai_questions WHERE status = 'open' AND question = ? AND entity_id = ?").get(question, entityId)
    : db.prepare("SELECT id FROM ai_questions WHERE status = 'open' AND question = ? AND entity_id IS NULL").get(question);
  if (existing) return false;
  const now = nowIso();
  db.prepare(
    `INSERT INTO ai_questions (id, agent, entity_type, entity_id, question, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'open', ?, ?)`
  ).run(newId("q"), agent, entityType, entityId, question, now, now);
  return true;
}

/** No OpenAI required -- a straight DB check. This is the fix for "I shouldn't have to go fill out a form": if nothing has told the Director what services the business offers, it asks, unprompted. */
function checkBusinessProfileGap(): number {
  const db = getDb();
  const services = db
    .prepare("SELECT COUNT(*) as c FROM business_memory WHERE active = 1 AND category = 'services'")
    .get() as { c: number };
  if (services.c > 0) return 0;
  const created = ensureOpenQuestion(
    "director",
    null,
    null,
    "I don't know what services Goodall Electrical offers or what area you want to work in yet. Can you tell me? " +
      "It's blocking lead search and how I judge whether a job or lead is worth pursuing."
  );
  return created ? 1 : 0;
}

const JOB_REVIEW_SCHEMA = {
  name: "job_review_questions",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      questions: {
        type: "array",
        description:
          "Specific operational questions needed to forecast labour/profitability for this job -- crew size, " +
          "night work, shutdown timing, materials ordered, access, inspection, temporary power, etc. Only ask " +
          "what's actually relevant to THIS job given its title/description; skip anything the job clearly " +
          "doesn't involve. Return an empty list if there's nothing worth asking yet.",
        items: { type: "string" },
      },
    },
    required: ["questions"],
  },
} as const;

async function reviewJob(taskId: string, job: any): Promise<number> {
  const db = getDb();
  const client = getOpenAiClient();
  if (!client) return 0; // no LLM available -- leave the job unreviewed rather than asking nothing intelligently

  const completion = await client.chat.completions.create({
    model: MODEL,
    response_format: { type: "json_schema", json_schema: JOB_REVIEW_SCHEMA },
    messages: [
      {
        role: "system",
        content:
          "You are Operations AI for Goodall Electrical, an electrical contracting company, reviewing a job " +
          "just imported from Fergus. Decide what operational information is still missing and worth asking the " +
          "owner about. Never invent facts about the job -- if the title/description gives no reason to think " +
          "something like a shutdown or night work is involved, don't ask about it.",
      },
      {
        role: "user",
        content: JSON.stringify({
          jobNumber: job.job_number,
          title: job.title,
          description: job.description,
          status: job.status,
        }),
      },
    ],
  });

  const parsed = JSON.parse(completion.choices[0]?.message?.content ?? "{}") as { questions: string[] };
  let raised = 0;
  for (const q of parsed.questions) {
    if (ensureOpenQuestion("operations_ai", "job", job.id, q)) raised++;
  }

  // Mark reviewed regardless of outcome so this job isn't re-processed
  // (and re-billed against the OpenAI key) every single cycle.
  const now = nowIso();
  db.prepare(
    `INSERT INTO job_context (id, job_id, key, value, status, confidence, provenance, created_at, updated_at)
     VALUES (?, ?, '_ai_reviewed', 'true', 'known', 1, 'ai_inferred', ?, ?)
     ON CONFLICT(job_id, key) DO NOTHING`
  ).run(newId("ctx"), job.id, now, now);

  logAgentEvent({ taskId, agent: "operations_ai", eventType: "job_reviewed", data: { jobId: job.id, questionsRaised: raised } });
  return raised;
}

/**
 * The Director's unprompted background pass -- runs on server startup and
 * on a recurring interval (see index.ts), not just when the owner sends a
 * chat message. Checks for structural gaps (no business profile) and
 * reviews recently-synced Fergus jobs that have never been looked at,
 * raising real ai_questions rather than requiring the owner to notice
 * something is missing and go looking for a settings page.
 */
export async function runBackgroundReview(): Promise<{ taskId: string; questionsRaised: number; jobsReviewed: number }> {
  const taskId = createAgentTask({
    agent: "director",
    taskType: "background_review",
    room: "director",
    message: "Reviewing the business",
  });

  let questionsRaised = 0;
  let jobsReviewed = 0;

  try {
    questionsRaised += checkBusinessProfileGap();

    const db = getDb();
    const unreviewed = db
      .prepare(
        `SELECT j.* FROM jobs j
         WHERE j.source = 'fergus' AND (j.status IS NULL OR j.status NOT IN ('Completed', 'Inactive'))
         AND NOT EXISTS (SELECT 1 FROM job_context jc WHERE jc.job_id = j.id AND jc.key = '_ai_reviewed')
         ORDER BY j.updated_at DESC LIMIT ?`
      )
      .all(MAX_JOBS_PER_CYCLE) as any[];

    for (const job of unreviewed) {
      updateAgentTask(taskId, {
        room: "jobs",
        message: `Reviewing ${job.job_number ?? job.id}`,
        progress: Math.round((jobsReviewed / Math.max(unreviewed.length, 1)) * 100),
      });
      try {
        questionsRaised += await reviewJob(taskId, job);
        jobsReviewed++;
      } catch (err: any) {
        logAgentEvent({ taskId, agent: "operations_ai", eventType: "job_review_failed", message: err?.message ?? String(err) });
      }
    }

    if (questionsRaised > 0) {
      createNotification({
        type: "director_needs_info",
        severity: "warning",
        title: "Director needs information",
        message: `${questionsRaised} new question${questionsRaised === 1 ? "" : "s"} waiting for you after a background review.`,
      });
    }

    updateAgentTask(taskId, {
      status: "completed",
      progress: 100,
      room: "director",
      message: questionsRaised > 0 ? `Raised ${questionsRaised} question(s)` : "Nothing new to ask",
    });
    recordAudit({ actor: "director", action: "background_review_completed", details: { questionsRaised, jobsReviewed } });
    return { taskId, questionsRaised, jobsReviewed };
  } catch (err: any) {
    updateAgentTask(taskId, { status: "failed", error: err?.message ?? String(err) });
    throw err;
  }
}
