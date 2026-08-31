import { getDb } from "../db/connection.js";
import { computeCashflowForecast } from "./financeAI.js";

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
  // site_address was missing here, so asked "where was this job for" the
  // Director had nothing and invented a site -- naming a real customer
  // that the job had nothing to do with. A field it isn't given is a field
  // it will guess, so anything it might be asked about belongs in here.
  const jobsSummary = db
    .prepare(
      `SELECT j.job_number, j.title, j.description, j.status, j.site_address,
              c.name as customer_name,
              f.quoted_amount, f.actual_cost, f.invoiced_amount, f.paid_amount
       FROM jobs j LEFT JOIN customers c ON c.id = j.customer_id
       LEFT JOIN job_financials f ON f.job_id = j.id
       ORDER BY j.updated_at DESC LIMIT 30`
    )
    .all();

  // Enquiries -- work in from Fergus that nobody has priced yet. Asked to
  // "fetch enquiries from Fergus", the Director said it couldn't and told
  // the owner to go do it themselves, when these rows were already synced;
  // they simply weren't distinguished from any other job.
  const enquiries = db
    .prepare(
      `SELECT j.job_number, j.title, j.status, j.site_address, c.name as customer_name, j.updated_at
       FROM jobs j LEFT JOIN customers c ON c.id = j.customer_id
       WHERE (j.status IS NULL OR j.status NOT IN ('Completed', 'Inactive', 'completed', 'cancelled'))
         AND NOT EXISTS (SELECT 1 FROM quotes q WHERE q.job_id = j.id)
         AND NOT EXISTS (SELECT 1 FROM job_financials f WHERE f.job_id = j.id AND f.quoted_amount IS NOT NULL)
       ORDER BY j.updated_at DESC LIMIT 20`
    )
    .all();
  const enquiryCount = db
    .prepare(
      `SELECT COUNT(*) as c FROM jobs j
       WHERE (j.status IS NULL OR j.status NOT IN ('Completed', 'Inactive', 'completed', 'cancelled'))
         AND NOT EXISTS (SELECT 1 FROM quotes q WHERE q.job_id = j.id)
         AND NOT EXISTS (SELECT 1 FROM job_financials f WHERE f.job_id = j.id AND f.quoted_amount IS NOT NULL)`
    )
    .get() as { c: number };

  // Leads were absent entirely, so "give me a list of the leads you found"
  // got "I can't provide that" while the rows sat in the database.
  const leads = db
    .prepare(
      `SELECT business_name, location, website, contact_email, contact_phone, lead_score, status, reason
       FROM leads ORDER BY (lead_score IS NULL), lead_score DESC, created_at DESC LIMIT 25`
    )
    .all();
  const leadCounts = db
    .prepare("SELECT status, COUNT(*) as c FROM leads GROUP BY status")
    .all() as { status: string; c: number }[];

  // Real cashflow data so the Director can actually answer scenario
  // questions ("can we afford another electrician?") with numbers instead
  // of guessing -- section 21 of the brief. If Xero isn't connected or
  // cash position couldn't be read, currentCash is null and the Director
  // is instructed (see director.ts system prompt) to say so rather than
  // pretend it knows.
  const cashflowForecast = computeCashflowForecast();

  // Scattered nulls inside the data are easy for a model to skate past,
  // and the silence gets filled with generic business advice ("consider
  // upgrading your vehicles") that has nothing to do with this business.
  // Stating the gaps outright, in plain terms, gives the Director
  // something concrete to say instead of inventing filler.
  const totalJobs = db.prepare("SELECT COUNT(*) as c FROM jobs").get() as { c: number };
  const jobsWithFinancials = db
    .prepare(
      `SELECT COUNT(*) as c FROM job_financials
       WHERE quoted_amount IS NOT NULL OR actual_cost IS NOT NULL OR invoiced_amount IS NOT NULL`
    )
    .get() as { c: number };
  const invoiceCount = db.prepare("SELECT COUNT(*) as c FROM invoices").get() as { c: number };

  const dataGaps: string[] = [];
  if (totalJobs.c > 0 && jobsWithFinancials.c === 0) {
    dataGaps.push(
      `NONE of the ${totalJobs.c} jobs have any financial figures (quoted/cost/invoiced). You cannot say anything ` +
        `about job profitability, margins, or which work is worth doing. The Fergus sync is not returning money data.`
    );
  } else if (totalJobs.c > 0 && jobsWithFinancials.c < totalJobs.c) {
    dataGaps.push(`Only ${jobsWithFinancials.c} of ${totalJobs.c} jobs have financial figures; the rest are unknown.`);
  }
  if (invoiceCount.c === 0) dataGaps.push("There are no invoices at all, so receivables and debtors are unknown.");
  if (cashflowForecast?.currentCash === null || cashflowForecast?.currentCash === undefined) {
    dataGaps.push("Current cash position is unknown -- Xero's bank balance has not been read.");
  }
  if (businessMemory.length === 0) dataGaps.push("Nothing is recorded about what this business does or where it works.");

  return {
    activeJobs: activeJobs.c,
    openQuotes: openQuotesCount.c,
    overdueReceivables: overdueTotal.total,
    openQuestions,
    businessMemory,
    recentNotifications,
    jobs: jobsSummary,
    enquiries,
    enquiryCount: enquiryCount.c,
    leads,
    leadCounts,
    cashflowForecast,
    dataGaps,
  };
}

export function findJobByNumber(jobNumber: string): { id: string; job_number: string } | undefined {
  const db = getDb();
  return db.prepare("SELECT id, job_number FROM jobs WHERE job_number = ?").get(jobNumber) as
    | { id: string; job_number: string }
    | undefined;
}
