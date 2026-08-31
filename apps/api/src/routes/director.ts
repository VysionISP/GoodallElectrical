import { Router } from "express";
import { z } from "zod";
import { getDb } from "../db/connection.js";
import { runDirectorTurn } from "../agents/director.js";
import { newId, nowIso } from "../lib/ids.js";
import { recordAudit } from "../lib/audit.js";

const router = Router();

router.get("/messages", (_req, res) => {
  const db = getDb();
  const messages = db.prepare("SELECT * FROM director_messages ORDER BY created_at ASC LIMIT 200").all();
  res.json({ messages });
});

const chatSchema = z.object({ message: z.string().min(1) });

router.post("/chat", async (req, res) => {
  const parsed = chatSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "INVALID_BODY", details: parsed.error.flatten() });
  try {
    const result = await runDirectorTurn(parsed.data.message);
    res.json(result);
  } catch (err: any) {
    res.status(502).json({ error: "DIRECTOR_FAILED", message: err?.message ?? String(err) });
  }
});

/** "Needs You" tab: open AI questions waiting on the owner + pending approvals. */
router.get("/needs-you", (_req, res) => {
  const db = getDb();
  const questions = db
    .prepare(
      `SELECT q.*, j.job_number FROM ai_questions q LEFT JOIN jobs j ON j.id = q.entity_id AND q.entity_type = 'job'
       WHERE q.status = 'open' ORDER BY q.created_at DESC`
    )
    .all();
  const approvals = db.prepare("SELECT * FROM approvals WHERE status = 'pending' ORDER BY created_at DESC").all();
  res.json({ questions, approvals });
});

/** "Activity" tab: recent agent task + notification activity. */
router.get("/activity", (_req, res) => {
  const db = getDb();
  const tasks = db.prepare("SELECT * FROM agent_tasks ORDER BY updated_at DESC LIMIT 50").all();
  const notifications = db.prepare("SELECT * FROM notifications ORDER BY created_at DESC LIMIT 50").all();
  res.json({ tasks, notifications });
});

const answerSchema = z.object({ answer: z.string().min(1), answeredBy: z.string().default("owner") });

router.post("/questions/:id/answer", (req, res) => {
  const parsed = answerSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "INVALID_BODY", details: parsed.error.flatten() });
  const db = getDb();
  const question = db.prepare("SELECT * FROM ai_questions WHERE id = ?").get(req.params.id) as
    | { id: string }
    | undefined;
  if (!question) return res.status(404).json({ error: "NOT_FOUND" });
  const now = nowIso();
  db.prepare(`INSERT INTO ai_answers (id, question_id, answer, answered_by, created_at) VALUES (?, ?, ?, ?, ?)`).run(
    newId("ans"),
    question.id,
    parsed.data.answer,
    parsed.data.answeredBy,
    now
  );
  db.prepare(`UPDATE ai_questions SET status = 'answered', updated_at = ? WHERE id = ?`).run(now, question.id);
  res.json({ ok: true });
});

/**
 * One-time cleanup for jobs that got flooded with multiple separate
 * questions under the old per-fact review logic (fixed to ask one
 * consolidated question per job instead). Dismisses those open questions
 * and clears the affected jobs' _ai_reviewed marker so the next
 * background review cycle re-reviews them under the new, consolidated
 * behavior rather than leaving them permanently unreviewed.
 */
/**
 * Dismisses every open question in one go.
 *
 * The background review stops raising anything once MAX_OPEN_JOB_QUESTIONS
 * is reached, so a backlog the owner never worked through ("Holding off --
 * 42 job question(s) already waiting on you") silently halts the Director's
 * own reviewing. Clearing is a legitimate answer to a pile of questions
 * that were never worth asking, and without it the only route out was
 * answering 42 of them by hand.
 */
router.post("/questions/dismiss-all", (_req, res) => {
  const db = getDb();
  const result = db
    .prepare("UPDATE ai_questions SET status = 'dismissed', updated_at = ? WHERE status = 'open'")
    .run(nowIso());
  recordAudit({ actor: "owner", action: "questions_dismissed_all", details: { dismissed: result.changes } });
  res.json({ ok: true, dismissed: result.changes });
});

router.post("/reset-job-reviews", (_req, res) => {
  const db = getDb();
  const now = nowIso();

  const affectedJobs = db
    .prepare("SELECT DISTINCT entity_id as job_id FROM ai_questions WHERE status = 'open' AND agent = 'operations_ai' AND entity_type = 'job'")
    .all() as { job_id: string }[];

  const dismissed = db
    .prepare("UPDATE ai_questions SET status = 'dismissed', updated_at = ? WHERE status = 'open' AND agent = 'operations_ai' AND entity_type = 'job'")
    .run(now);

  const clearReviewed = db.prepare("DELETE FROM job_context WHERE job_id = ? AND key = '_ai_reviewed'");
  for (const { job_id } of affectedJobs) {
    clearReviewed.run(job_id);
  }

  res.json({ ok: true, questionsDismissed: dismissed.changes, jobsQueuedForReReview: affectedJobs.length });
});

export default router;
