import { getDb } from "../db/connection.js";

/**
 * Builds the structured business context fed to the Director's system
 * prompt. Pulled from our own database, not from Fergus/Xero directly, per
 * section 4 of the brief ("receives structured business context from the
 * application's own database"). Every number here traces back to a real
 * row -- nothing is invented for the prompt.
 */
export function buildDirectorContext() {
  const db = getDb();

  const activeJobs = db.prepare("SELECT COUNT(*) as c FROM jobs WHERE status IS NULL OR status NOT IN ('completed', 'cancelled')").get() as { c: number };
  const openQuotesCount = db.prepare("SELECT COUNT(*) as c FROM quotes WHERE status IN ('draft', 'pending_approval', 'approved', 'sent')").get() as { c: number };
  const overdueTotal = db
    .prepare("SELECT COALESCE(SUM(amount_due), 0) as total FROM invoices WHERE status = 'overdue'")
    .get() as { total: number };
  const openQuestions = db
    .prepare(
      `SELECT q.id, q.agent, q.entity_type, q.entity_id, q.question, j.job_number
       FROM ai_questions q LEFT JOIN jobs j ON j.id = q.entity_id AND q.entity_type = 'job'
       WHERE q.status = 'open' ORDER BY q.created_at DESC LIMIT 20`
    )
    .all();
  const businessMemory = db
    .prepare("SELECT content, category FROM business_memory WHERE active = 1 ORDER BY created_at DESC LIMIT 25")
    .all();
  const recentNotifications = db
    .prepare("SELECT type, severity, title, message FROM notifications ORDER BY created_at DESC LIMIT 10")
    .all();
  const jobsSummary = db
    .prepare(
      `SELECT j.job_number, j.title, j.status, c.name as customer_name,
              f.quoted_amount, f.actual_cost, f.invoiced_amount, f.paid_amount
       FROM jobs j LEFT JOIN customers c ON c.id = j.customer_id
       LEFT JOIN job_financials f ON f.job_id = j.id
       ORDER BY j.updated_at DESC LIMIT 30`
    )
    .all();

  return {
    activeJobs: activeJobs.c,
    openQuotes: openQuotesCount.c,
    overdueReceivables: overdueTotal.total,
    openQuestions,
    businessMemory,
    recentNotifications,
    jobs: jobsSummary,
  };
}

export function findJobByNumber(jobNumber: string): { id: string; job_number: string } | undefined {
  const db = getDb();
  return db.prepare("SELECT id, job_number FROM jobs WHERE job_number = ?").get(jobNumber) as
    | { id: string; job_number: string }
    | undefined;
}
