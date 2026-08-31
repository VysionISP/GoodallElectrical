import { Router } from "express";
import { getDb } from "../db/connection.js";
import { computeLabourForecast } from "../agents/estimatorAI.js";

const router = Router();

/**
 * List jobs for the Jobs Floor. Financial fields are returned as-is
 * (including null) plus a provenance map -- the frontend must render null
 * as "Not available", never as $0 (section 30 of the brief).
 */
router.get("/", (_req, res) => {
  const db = getDb();
  const jobs = db
    .prepare(
      `SELECT j.*, c.name as customer_name, c.id as customer_row_id,
              f.quoted_amount, f.actual_cost, f.invoiced_amount, f.paid_amount,
              f.outstanding_amount, f.forecast_gross_profit, f.forecast_margin, f.provenance as financial_provenance
       FROM jobs j
       LEFT JOIN customers c ON c.id = j.customer_id
       LEFT JOIN job_financials f ON f.job_id = j.id
       ORDER BY j.updated_at DESC`
    )
    .all();
  res.json({
    jobs: jobs.map((j: any) => ({
      ...j,
      customer_name: j.customer_name ?? (j.customer_row_id ? j.customer_name : null),
      financial_provenance: j.financial_provenance ? JSON.parse(j.financial_provenance) : {},
    })),
  });
});

/**
 * Enquiries: work that has come in from Fergus and still needs pricing.
 *
 * Defined by what is true in the data -- an open job with no quote against
 * it and no quoted amount -- rather than by matching Fergus status strings.
 * The exact status wording varies ("To Price", "Pending", "Quoting"), and
 * guessing those strings is how features here have broken before; a job
 * nobody has priced is unambiguous whatever it is labelled.
 *
 * Registered before "/:id" because Express matches in order and "/:id"
 * would otherwise swallow "/enquiries" as a job id.
 */
router.get("/enquiries", (_req, res) => {
  const db = getDb();
  const enquiries = db
    .prepare(
      `SELECT j.id, j.job_number, j.title, j.description, j.status, j.site_address, j.created_at, j.updated_at,
              c.name as customer_name, c.email as customer_email
       FROM jobs j
       LEFT JOIN customers c ON c.id = j.customer_id
       WHERE (j.status IS NULL OR j.status NOT IN ('Completed', 'Inactive', 'completed', 'cancelled'))
         AND NOT EXISTS (SELECT 1 FROM quotes q WHERE q.job_id = j.id)
         AND NOT EXISTS (SELECT 1 FROM job_financials f WHERE f.job_id = j.id AND f.quoted_amount IS NOT NULL)
       ORDER BY j.updated_at DESC`
    )
    .all();
  res.json({ enquiries });
});

router.get("/:id", (req, res) => {
  const db = getDb();
  const job = db
    .prepare(
      `SELECT j.*, c.name as customer_name, c.email as customer_email, c.phone as customer_phone
       FROM jobs j LEFT JOIN customers c ON c.id = j.customer_id WHERE j.id = ?`
    )
    .get(req.params.id) as any;
  if (!job) return res.status(404).json({ error: "NOT_FOUND" });

  const financials = db.prepare("SELECT * FROM job_financials WHERE job_id = ?").get(req.params.id) as any;
  const phases = db.prepare("SELECT * FROM job_phases WHERE job_id = ? ORDER BY sort_order").all(req.params.id);
  const context = db.prepare("SELECT * FROM job_context WHERE job_id = ? ORDER BY key").all(req.params.id) as any[];
  const memory = db.prepare("SELECT * FROM job_memory WHERE job_id = ? AND active = 1 ORDER BY created_at DESC").all(req.params.id);
  const quotes = db.prepare("SELECT * FROM quotes WHERE job_id = ? ORDER BY created_at DESC").all(req.params.id);
  const invoices = db.prepare("SELECT * FROM invoices WHERE job_id = ? ORDER BY created_at DESC").all(req.params.id);
  const openQuestions = db
    .prepare("SELECT * FROM ai_questions WHERE entity_type = 'job' AND entity_id = ? AND status = 'open'")
    .all(req.params.id);

  res.json({
    job,
    financials: financials
      ? { ...financials, provenance: financials.provenance ? JSON.parse(financials.provenance) : {} }
      : null,
    phases,
    // Split job_context into what the AI knows vs. what's still missing,
    // matching the "What AI knows" / "Missing information" split in the brief.
    known: context.filter((c) => c.status === "known" || c.status === "inferred"),
    missing: context.filter((c) => c.status === "unknown" || c.status === "needs_owner_input"),
    memory,
    quotes,
    invoices,
    openQuestions,
  });
});

/** Section 8 of the brief: "Expected labour: 31 hours, Confidence: 42%, Missing: ...". */
router.get("/:id/labour-forecast", async (req, res) => {
  try {
    const forecast = await computeLabourForecast(req.params.id);
    res.json(forecast);
  } catch (err: any) {
    const status = err?.code === "NOT_FOUND" ? 404 : 502;
    res.status(status).json({ error: err?.code ?? "FORECAST_FAILED", message: err?.message ?? String(err) });
  }
});

export default router;
