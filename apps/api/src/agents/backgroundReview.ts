import { getDb } from "../db/connection.js";
import { newId, nowIso } from "../lib/ids.js";
import { createAgentTask, updateAgentTask, logAgentEvent, type AgentName } from "../lib/agentTasks.js";
import { createNotification } from "../lib/notifications.js";
import { getActiveChatClient, chatJson } from "../integrations/llm.js";
import { recordAudit } from "../lib/audit.js";
import { runAutonomousGrowthCycle, postGrowthCycleUpdate } from "./growthEngine.js";

// How stale an unanswered job question has to be before a check-in nudges
// the owner about it specifically, instead of just generic small talk.
const STALE_QUESTION_HOURS = 48;

const MAX_JOBS_PER_CYCLE = 5;
// A person wouldn't keep asking you new things while a dozen questions
// already sit unanswered -- back off once the owner is clearly behind, and
// let them catch up before piling on more.
const MAX_OPEN_JOB_QUESTIONS = 6;
// A real operations manager doesn't only speak up when something's wrong --
// they also just pop in every so often with "how's it going" style chatter.
// Floor + a coin flip each cycle (rather than a fixed timer) is what makes
// it feel like it's actually happening on its own instead of on a schedule
// the owner can set a watch to.
const MIN_CHECKIN_GAP_MS = 90 * 60 * 1000;
const CHECKIN_CHANCE = 0.4;

/** One thing the background pass found this cycle that's worth mentioning in the proactive briefing. */
interface RaisedItem {
  label: string; // e.g. "ELEC-3256", or "the business" for a general question
  question: string;
}

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
function checkBusinessProfileGap(): RaisedItem | null {
  const db = getDb();
  const services = db
    .prepare("SELECT COUNT(*) as c FROM business_memory WHERE active = 1 AND category = 'services'")
    .get() as { c: number };
  if (services.c > 0) return null;
  const question =
    "I don't know what services Goodall Electrical offers or what area you want to work in yet. Can you tell me? " +
    "It's blocking lead search and how I judge whether a job or lead is worth pursuing.";
  const created = ensureOpenQuestion("director", null, null, question);
  return created ? { label: "the business", question } : null;
}

const JOB_REVIEW_SCHEMA = {
  name: "job_review_questions",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      needsInput: { type: "boolean", description: "Whether this job is missing anything worth asking about right now." },
      question: {
        type: "string",
        description:
          "If needsInput is true: ONE natural message covering everything missing for this job, phrased the way " +
          "a person would actually ask it -- e.g. 'For ELEC-3376 I need a few things: crew size, whether access " +
          "is confirmed, and what inspection is needed.' Pick at most the 2-3 most important gaps, not an " +
          "exhaustive checklist. Only ask about things actually relevant to THIS job's title/description. If " +
          "needsInput is false, this must be an empty string.",
      },
    },
    required: ["needsInput", "question"],
  },
} as const;

/** Consolidates everything missing about a job into ONE question, the way a person would actually ask about it -- not one card per fact. */
async function reviewJob(taskId: string, job: any): Promise<RaisedItem | null> {
  const db = getDb();
  const chat = getActiveChatClient();
  if (!chat) return null; // no LLM available -- leave the job unreviewed rather than asking nothing intelligently

  const raw = await chatJson(chat, {
    schema: JOB_REVIEW_SCHEMA,
    messages: [
      {
        role: "system",
        content:
          "You are Operations AI for Goodall Electrical, an electrical contracting company, reviewing a job " +
          "just imported from Fergus. Decide whether there's anything worth asking the owner about right now -- " +
          "at most the 2-3 most important gaps, combined into one natural message, not a checklist of everything " +
          "that could theoretically be unknown. Never invent facts about the job -- if the title/description " +
          "gives no reason to think something like a shutdown or night work is involved, don't ask about it. A " +
          "busy owner is reading this among many other jobs, so be selective, not exhaustive.",
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

  const parsed = JSON.parse(raw) as {
    needsInput: boolean;
    question: string;
  };
  let raised: RaisedItem | null = null;
  if (parsed.needsInput && parsed.question.trim()) {
    const question = parsed.question.trim();
    if (ensureOpenQuestion("operations_ai", "job", job.id, question)) {
      raised = { label: job.job_number ?? job.id, question };
    }
  }

  // Mark reviewed regardless of outcome so this job isn't re-processed
  // (and re-billed against the OpenAI key) every single cycle.
  const now = nowIso();
  db.prepare(
    `INSERT INTO job_context (id, job_id, key, value, status, confidence, provenance, created_at, updated_at)
     VALUES (?, ?, '_ai_reviewed', 'true', 'known', 1, 'ai_inferred', ?, ?)
     ON CONFLICT(job_id, key) DO NOTHING`
  ).run(newId("ctx"), job.id, now, now);

  logAgentEvent({ taskId, agent: "operations_ai", eventType: "job_reviewed", data: { jobId: job.id, questionsRaised: raised ? 1 : 0 } });
  return raised;
}

const BRIEFING_SCHEMA = {
  name: "director_briefing",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      message: {
        type: "string",
        description:
          "One natural, first-person message from the Director to the owner summarizing what this background " +
          "review pass found, in the voice of a competent operations manager checking in -- not a bulleted report. " +
          "Mention the real numbers given (active jobs, overdue receivables) briefly for context, then walk through " +
          "the specific things that need the owner's input in plain sentences, the way a person would bring it up " +
          "in conversation. Do not invent anything not given to you.",
      },
    },
    required: ["message"],
  },
} as const;

/**
 * Turns what this cycle actually found into ONE natural chat message from
 * the Director, posted into director_messages unprompted -- so what the
 * owner sees when they open the Chat tab (the default tab) is the Director
 * having already spoken, the way a real operations manager would flag
 * things on their own rather than leaving a pile of silent form cards for
 * the owner to go decode. Only called when something genuinely new was
 * found this cycle (see runBackgroundReview) -- never fires on a quiet
 * cycle just to make noise.
 */
async function postProactiveBriefing(raised: RaisedItem[], jobsReviewed: number): Promise<void> {
  const db = getDb();
  const activeJobs = db
    .prepare("SELECT COUNT(*) as c FROM jobs WHERE status IS NULL OR status NOT IN ('completed', 'cancelled', 'Completed', 'Inactive')")
    .get() as { c: number };
  const overdueTotal = db
    .prepare("SELECT COALESCE(SUM(amount_due), 0) as total FROM invoices WHERE status = 'overdue'")
    .get() as { total: number };

  const chat = getActiveChatClient();
  let message: string;

  if (!chat) {
    // No LLM available -- still speak up, just without the natural-language polish.
    const lines = raised.map((r) => `- ${r.label}: ${r.question}`);
    message =
      `Background review: ${activeJobs.c} active job(s), ${jobsReviewed} reviewed this pass. ` +
      `${raised.length} thing${raised.length === 1 ? "" : "s"} need your input:\n${lines.join("\n")}`;
  } else {
    try {
      const raw = await chatJson(chat, {
        schema: BRIEFING_SCHEMA,
        messages: [
          {
            role: "system",
            content:
              "You are the AI Director for Goodall Electrical, an electrical contracting company. You just finished " +
              "an unprompted background review pass and are about to speak to the owner first, the way a real " +
              "operations manager would walk in and say what they found -- not a report, a conversation opener.",
          },
          {
            role: "user",
            content: JSON.stringify({
              activeJobs: activeJobs.c,
              overdueReceivables: overdueTotal.total,
              jobsReviewedThisPass: jobsReviewed,
              newQuestions: raised.map((r) => ({ about: r.label, question: r.question })),
            }),
          },
        ],
      });
      const parsed = JSON.parse(raw) as { message: string };
      message = parsed.message?.trim() || `I found ${raised.length} thing${raised.length === 1 ? "" : "s"} that need your input after reviewing the business.`;
    } catch (err: any) {
      logAgentEvent({ agent: "director", eventType: "briefing_compose_failed", message: err?.message ?? String(err) });
      const lines = raised.map((r) => `- ${r.label}: ${r.question}`);
      message = `Background review found ${raised.length} thing${raised.length === 1 ? "" : "s"} that need your input:\n${lines.join("\n")}`;
    }
  }

  db.prepare(`INSERT INTO director_messages (id, role, content, created_at) VALUES (?, 'director', ?, ?)`).run(
    newId("dmsg"),
    message,
    nowIso()
  );
}

const CHECKIN_SCHEMA = {
  name: "director_checkin",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      message: {
        type: "string",
        description:
          "One short, casual first-person message from the Director just checking in with the owner -- nothing is " +
          "wrong and nothing needs a reply. The kind of thing a good operations manager says walking past your desk: " +
          "a quick real number or two for context (only from what's given -- never invent one), maybe what you're " +
          "keeping an eye on. Not a report, not a list, not a greeting like 'Hi' on its own. Keep it to 1-3 sentences.",
      },
    },
    required: ["message"],
  },
} as const;

/**
 * Speaks up in the chat even when nothing needs the owner's input -- the
 * fix for "we want it to just start randomly talking to us". Without this,
 * the Director was only ever heard from when it had a problem or a question,
 * which isn't how a real operations manager behaves; they also just check in.
 * Gated by MIN_CHECKIN_GAP_MS since the last thing the Director said (of
 * any kind -- a briefing counts) plus a random roll each eligible cycle, so
 * it can't fire every 30-minute cycle and doesn't land on a predictable
 * schedule either. Only called on a cycle that already found nothing worth
 * raising (see runBackgroundReview) -- a real briefing always takes priority
 * over small talk.
 */
function getStaleQuestions(hours: number): { jobNumber: string | null; question: string }[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT q.question, j.job_number
       FROM ai_questions q LEFT JOIN jobs j ON j.id = q.entity_id AND q.entity_type = 'job'
       WHERE q.status = 'open' AND (julianday('now') - julianday(q.created_at)) * 24 >= ?
       ORDER BY q.created_at ASC LIMIT 5`
    )
    .all(hours) as { question: string; job_number: string | null }[];
  return rows.map((r) => ({ jobNumber: r.job_number, question: r.question }));
}

async function maybePostSpontaneousCheckin(): Promise<boolean> {
  const db = getDb();
  const last = db.prepare("SELECT created_at FROM director_messages WHERE role = 'director' ORDER BY created_at DESC LIMIT 1").get() as
    | { created_at: string }
    | undefined;
  if (last) {
    const elapsed = Date.now() - new Date(last.created_at).getTime();
    if (elapsed < MIN_CHECKIN_GAP_MS) return false;
  }
  if (Math.random() >= CHECKIN_CHANCE) return false;

  const activeJobs = db
    .prepare("SELECT COUNT(*) as c FROM jobs WHERE status IS NULL OR status NOT IN ('completed', 'cancelled', 'Completed', 'Inactive')")
    .get() as { c: number };
  const openQuotes = db
    .prepare("SELECT COUNT(*) as c FROM quotes WHERE status IN ('draft', 'pending_approval', 'approved', 'sent')")
    .get() as { c: number };
  const overdueTotal = db
    .prepare("SELECT COALESCE(SUM(amount_due), 0) as total FROM invoices WHERE status = 'overdue'")
    .get() as { total: number };
  const openQuestions = db.prepare("SELECT COUNT(*) as c FROM ai_questions WHERE status = 'open'").get() as { c: number };
  // Jobs are the "manage jobs" half of the check-in's job -- something the
  // owner hasn't answered in 48+ hours is exactly the kind of thing a
  // real ops manager would bring up unprompted rather than let sit forever
  // in a tab nobody's looking at.
  const staleQuestions = getStaleQuestions(STALE_QUESTION_HOURS);

  const stats = {
    activeJobs: activeJobs.c,
    openQuotes: openQuotes.c,
    overdueReceivables: overdueTotal.total,
    openQuestions: openQuestions.c,
    staleQuestions,
  };

  const chat = getActiveChatClient();
  let message: string;
  if (!chat) {
    const staleNote = staleQuestions.length > 0 ? ` Still waiting on: ${staleQuestions[0].question}` : "";
    message = `Just checking in -- ${stats.activeJobs} active job(s), ${stats.openQuotes} quote(s) in play.${staleNote}`;
  } else {
    try {
      const raw = await chatJson(chat, {
        schema: CHECKIN_SCHEMA,
        messages: [
          {
            role: "system",
            content:
              "You are the AI Director for Goodall Electrical, an electrical contracting company. Nothing is wrong " +
              "and there's no open question -- you're just checking in with the owner unprompted, the way a real " +
              "operations manager does sometimes, not because something needs them. If staleQuestions is non-empty, " +
              "gently mention the oldest one as a reminder (don't list them all) -- otherwise ignore that field.",
          },
          { role: "user", content: JSON.stringify(stats) },
        ],
      });
      const parsed = JSON.parse(raw) as { message: string };
      message = parsed.message?.trim() || `Just checking in -- ${stats.activeJobs} active job(s), nothing urgent right now.`;
    } catch (err: any) {
      logAgentEvent({ agent: "director", eventType: "checkin_compose_failed", message: err?.message ?? String(err) });
      return false; // a failed casual check-in isn't worth a fallback template -- just skip it, there's always next cycle
    }
  }

  db.prepare(`INSERT INTO director_messages (id, role, content, created_at) VALUES (?, 'director', ?, ?)`).run(newId("dmsg"), message, nowIso());
  createNotification({ type: "director_checkin", severity: "info", title: "Director checked in", message });
  return true;
}

/**
 * The Director's unprompted background pass -- runs on server startup and
 * on a recurring interval (see index.ts), not just when the owner sends a
 * chat message. Checks for structural gaps (no business profile) and
 * reviews recently-synced Fergus jobs that have never been looked at,
 * raising real ai_questions rather than requiring the owner to notice
 * something is missing and go looking for a settings page. When it finds
 * something new, it also speaks up in the chat itself (see
 * postProactiveBriefing) instead of only leaving silent question cards.
 * Also runs the autonomous growth cycle (see growthEngine.ts) -- bringing
 * in new leads and drafting outreach without being asked, gated to at most
 * once a day.
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
  const raisedItems: RaisedItem[] = [];

  try {
    const profileGap = checkBusinessProfileGap();
    if (profileGap) {
      questionsRaised++;
      raisedItems.push(profileGap);
    }

    const db = getDb();
    const openJobQuestions = db
      .prepare("SELECT COUNT(*) as c FROM ai_questions WHERE status = 'open' AND agent = 'operations_ai'")
      .get() as { c: number };

    if (openJobQuestions.c >= MAX_OPEN_JOB_QUESTIONS) {
      updateAgentTask(taskId, {
        status: "completed",
        progress: 100,
        message: `Holding off -- ${openJobQuestions.c} job question(s) already waiting on you`,
      });
      recordAudit({ actor: "director", action: "background_review_throttled", details: { openJobQuestions: openJobQuestions.c } });
      return { taskId, questionsRaised, jobsReviewed };
    }

    const roomToReview = MAX_OPEN_JOB_QUESTIONS - openJobQuestions.c;
    const unreviewed = db
      .prepare(
        `SELECT j.* FROM jobs j
         WHERE j.source = 'fergus' AND (j.status IS NULL OR j.status NOT IN ('Completed', 'Inactive'))
         AND NOT EXISTS (SELECT 1 FROM job_context jc WHERE jc.job_id = j.id AND jc.key = '_ai_reviewed')
         ORDER BY j.updated_at DESC LIMIT ?`
      )
      .all(Math.min(MAX_JOBS_PER_CYCLE, roomToReview)) as any[];

    for (const job of unreviewed) {
      updateAgentTask(taskId, {
        room: "jobs",
        message: `Reviewing ${job.job_number ?? job.id}`,
        progress: Math.round((jobsReviewed / Math.max(unreviewed.length, 1)) * 100),
      });
      try {
        const jobRaised = await reviewJob(taskId, job);
        if (jobRaised) {
          questionsRaised++;
          raisedItems.push(jobRaised);
        }
        jobsReviewed++;
      } catch (err: any) {
        logAgentEvent({ taskId, agent: "operations_ai", eventType: "job_review_failed", message: err?.message ?? String(err) });
      }
    }

    // Bring more work in without being asked -- independently gated (once a
    // day at most, since Google Places charges per call) so this is a no-op
    // on almost every 30-minute cycle and only actually sweeps when its own
    // floor has cleared.
    try {
      const growth = await runAutonomousGrowthCycle();
      if (growth.ran && (growth.newLeadsFound > 0 || growth.outreachDrafted > 0)) {
        await postGrowthCycleUpdate(growth);
      }
    } catch (err: any) {
      logAgentEvent({ taskId, agent: "lead_hunter", eventType: "growth_cycle_error", message: err?.message ?? String(err) });
    }

    let spokeUp = false;
    if (questionsRaised > 0) {
      createNotification({
        type: "director_needs_info",
        severity: "warning",
        title: "Director needs information",
        message: `${questionsRaised} new question${questionsRaised === 1 ? "" : "s"} waiting for you after a background review.`,
      });
      // Speak up in the chat itself, unprompted -- this is what makes the
      // Director feel like it's actually running the business in the
      // background rather than just reacting when the owner opens the app.
      try {
        await postProactiveBriefing(raisedItems, jobsReviewed);
        spokeUp = true;
      } catch (err: any) {
        logAgentEvent({ taskId, agent: "director", eventType: "briefing_post_failed", message: err?.message ?? String(err) });
      }
    } else {
      // Nothing needs the owner -- still worth speaking up sometimes, the
      // way a person would, rather than only ever being heard from when
      // there's a problem.
      try {
        spokeUp = await maybePostSpontaneousCheckin();
      } catch (err: any) {
        logAgentEvent({ taskId, agent: "director", eventType: "checkin_post_failed", message: err?.message ?? String(err) });
      }
    }

    updateAgentTask(taskId, {
      status: "completed",
      progress: 100,
      room: "director",
      message: questionsRaised > 0 ? `Raised ${questionsRaised} question(s)` : spokeUp ? "Checked in with you" : "Nothing new to ask",
    });
    recordAudit({ actor: "director", action: "background_review_completed", details: { questionsRaised, jobsReviewed } });
    return { taskId, questionsRaised, jobsReviewed };
  } catch (err: any) {
    updateAgentTask(taskId, { status: "failed", error: err?.message ?? String(err) });
    throw err;
  }
}
