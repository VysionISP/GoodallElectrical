import { getDb } from "../db/connection.js";
import { newId, nowIso } from "../lib/ids.js";
import { createAgentTask, updateAgentTask, logAgentEvent } from "../lib/agentTasks.js";
import { createNotification } from "../lib/notifications.js";
import { recordAudit } from "../lib/audit.js";
import { getIntegrationCredentials, recordIntegrationSuccess, recordIntegrationError } from "./store.js";
import {
  listJobsRaw,
  mapFergusJob,
  mapFergusPhase,
  applyFinancialSummary,
  applyCustomerDetail,
  getCompanyPrefix,
  getJobFinancialSummaryRaw,
  getJobPhasesRaw,
  getJobPaidAmount,
  getCustomerRaw,
  type FergusCredentials,
  type NormalizedFergusJob,
} from "./fergus.js";

/**
 * Upserts one normalized Fergus job (+ its customer, financials, phases)
 * into the local schema. Financial fields that Fergus did not supply are
 * stored as NULL, never 0 -- the UI is responsible for rendering NULL as
 * "Not available" (section 30 of the brief).
 */
function upsertJob(job: NormalizedFergusJob): string {
  const db = getDb();
  const now = nowIso();

  let customerId: string | null = null;
  if (job.customer) {
    const existing = db
      .prepare("SELECT id FROM customers WHERE fergus_customer_id = ?")
      .get(job.customer.fergusCustomerId) as { id: string } | undefined;
    if (existing) {
      customerId = existing.id;
      db.prepare(
        `UPDATE customers SET name = ?, email = ?, phone = ?, billing_address = ?, updated_at = ? WHERE id = ?`
      ).run(job.customer.name, job.customer.email, job.customer.phone, job.customer.billingAddress, now, customerId);
    } else {
      customerId = newId("cust");
      db.prepare(
        `INSERT INTO customers (id, fergus_customer_id, name, email, phone, billing_address, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'fergus', ?, ?)`
      ).run(
        customerId,
        job.customer.fergusCustomerId,
        job.customer.name,
        job.customer.email,
        job.customer.phone,
        job.customer.billingAddress,
        now,
        now
      );
    }
  }

  const existingJob = db.prepare("SELECT id FROM jobs WHERE fergus_job_id = ?").get(job.fergusJobId) as
    | { id: string }
    | undefined;
  let jobId: string;
  if (existingJob) {
    jobId = existingJob.id;
    db.prepare(
      `UPDATE jobs SET job_number = ?, title = ?, description = ?, customer_id = ?, site_address = ?, status = ?, fergus_status_raw = ?, last_synced_at = ?, updated_at = ? WHERE id = ?`
    ).run(job.jobNumber, job.title, job.description, customerId, job.siteAddress, job.status, job.status, now, now, jobId);
  } else {
    jobId = newId("job");
    db.prepare(
      `INSERT INTO jobs (id, fergus_job_id, job_number, title, description, customer_id, site_address, status, fergus_status_raw, source, last_synced_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'fergus', ?, ?, ?)`
    ).run(
      jobId,
      job.fergusJobId,
      job.jobNumber,
      job.title,
      job.description,
      customerId,
      job.siteAddress,
      job.status,
      job.status,
      now,
      now,
      now
    );
  }

  // Financials: only mark a field as fergus-sourced provenance if Fergus
  // actually returned it. Fields that stay null keep whatever provenance
  // (or absence of one) they already had -- we never overwrite an
  // owner-provided or previously-known figure with a fabricated blank.
  const f = job.financials;
  const provenance: Record<string, string> = {};
  if (f.quotedAmount !== null) provenance.quotedAmount = "fergus";
  if (f.actualCost !== null) provenance.actualCost = "fergus";
  if (f.invoicedAmount !== null) provenance.invoicedAmount = "fergus";
  if (f.paidAmount !== null) provenance.paidAmount = "fergus";

  const existingFin = db.prepare("SELECT id, provenance FROM job_financials WHERE job_id = ?").get(jobId) as
    | { id: string; provenance: string }
    | undefined;

  if (existingFin) {
    const mergedProvenance = { ...JSON.parse(existingFin.provenance || "{}"), ...provenance };
    db.prepare(
      `UPDATE job_financials SET quoted_amount = ?, actual_cost = ?, invoiced_amount = ?, paid_amount = ?, provenance = ?, last_synced_at = ?, updated_at = ? WHERE id = ?`
    ).run(
      f.quotedAmount,
      f.actualCost,
      f.invoicedAmount,
      f.paidAmount,
      JSON.stringify(mergedProvenance),
      now,
      now,
      existingFin.id
    );
  } else {
    db.prepare(
      `INSERT INTO job_financials (id, job_id, quoted_amount, actual_cost, invoiced_amount, paid_amount, provenance, last_synced_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      newId("fin"),
      jobId,
      f.quotedAmount,
      f.actualCost,
      f.invoicedAmount,
      f.paidAmount,
      JSON.stringify(provenance),
      now,
      now,
      now
    );
  }

  for (const phase of job.phases) {
    const existingPhase = db
      .prepare("SELECT id FROM job_phases WHERE job_id = ? AND fergus_phase_id = ?")
      .get(jobId, phase.fergusPhaseId) as { id: string } | undefined;
    if (existingPhase) {
      db.prepare(`UPDATE job_phases SET name = ?, status = ?, updated_at = ? WHERE id = ?`).run(
        phase.name,
        phase.status,
        now,
        existingPhase.id
      );
    } else {
      db.prepare(
        `INSERT INTO job_phases (id, job_id, fergus_phase_id, name, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(newId("phase"), jobId, phase.fergusPhaseId, phase.name, phase.status, now, now);
    }
  }

  return jobId;
}

type FetchOutcome<T> = { ok: true; value: T } | { ok: false; error: string };

/** Captures why a per-job fetch failed instead of discarding it. */
async function attempt<T>(p: Promise<T>): Promise<FetchOutcome<T>> {
  try {
    return { ok: true, value: await p };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}

export async function runFergusSync(): Promise<{ taskId: string; jobsSynced: number }> {
  const creds = getIntegrationCredentials<FergusCredentials>("fergus");
  const taskId = createAgentTask({
    agent: "operations_ai",
    taskType: "fergus_sync",
    room: "jobs",
    message: "Syncing Fergus jobs",
  });

  const db = getDb();
  const syncId = newId("sync");
  db.prepare(
    `INSERT INTO integration_syncs (id, provider, status, records_synced, started_at, agent_task_id) VALUES (?, 'fergus', 'running', 0, ?, ?)`
  ).run(syncId, nowIso(), taskId);

  if (!creds) {
    const message = "Fergus is not configured. Add an API key in Integrations before syncing.";
    updateAgentTask(taskId, { status: "failed", error: message, progress: 0 });
    db.prepare(`UPDATE integration_syncs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?`).run(
      message,
      nowIso(),
      syncId
    );
    createNotification({ type: "fergus_sync_failed", severity: "warning", title: "Fergus sync failed", message });
    throw Object.assign(new Error(message), { code: "NOT_CONFIGURED" });
  }

  try {
    const companyPrefix = await getCompanyPrefix(creds);
    const rawJobs = await listJobsRaw(creds);
    const customerCache = new Map<string, any>();
    let synced = 0;

    // Financials used to be fetched with `.catch(() => null)`, so a job's
    // money silently became null whether the request failed or the payload
    // shape simply didn't match what this client expects -- and the sync
    // still reported "Synced 102 jobs" as a clean success. That is exactly
    // how an owner ends up staring at an empty finance view with nothing
    // anywhere telling them why. Both outcomes are now counted and
    // reported.
    let finOk = 0;
    let finFailed = 0;
    let finEmpty = 0;
    let firstFinError: string | null = null;
    let observedFinancialKeys: string | null = null;

    for (const raw of rawJobs) {
      const normalized = mapFergusJob(raw, companyPrefix);
      updateAgentTask(taskId, {
        progress: rawJobs.length ? Math.round((synced / rawJobs.length) * 100) : 100,
        message: `Reviewing ${normalized.jobNumber ?? normalized.fergusJobId}`,
      });

      // financials/phases/paid-amount are separate endpoints in the real
      // API -- a Job object never embeds them (see fergus.ts header).
      const [finRes, phaseRes, paidRes] = await Promise.all([
        attempt(getJobFinancialSummaryRaw(creds, raw.id)),
        attempt(getJobPhasesRaw(creds, raw.id)),
        attempt(getJobPaidAmount(creds, raw.id)),
      ]);

      if (finRes.ok) {
        applyFinancialSummary(normalized, finRes.value);
        const got =
          normalized.financials.quotedAmount !== null ||
          normalized.financials.actualCost !== null ||
          normalized.financials.invoicedAmount !== null;
        if (got) {
          finOk++;
        } else {
          finEmpty++;
          // Record the field names Fergus actually returned (names only,
          // never the figures) the first time nothing maps -- without this
          // a shape mismatch is indistinguishable from a job that
          // genuinely has no money against it yet.
          if (observedFinancialKeys === null && finRes.value && typeof finRes.value === "object") {
            observedFinancialKeys = Object.keys(finRes.value).join(", ") || "(empty object)";
          }
        }
      } else {
        finFailed++;
        if (!firstFinError) firstFinError = finRes.error;
      }

      normalized.financials.paidAmount = paidRes.ok ? paidRes.value : null;
      if (!paidRes.ok && !firstFinError) firstFinError = paidRes.error;
      normalized.phases = (phaseRes.ok ? phaseRes.value : []).map(mapFergusPhase);

      if (normalized.customer) {
        const custId = normalized.customer.fergusCustomerId;
        if (!customerCache.has(custId)) {
          const detail = await getCustomerRaw(creds, custId).catch(() => null);
          customerCache.set(custId, detail);
        }
        applyCustomerDetail(normalized.customer, customerCache.get(custId));
      }

      upsertJob(normalized);
      synced++;
    }

    // Jobs arriving without their money is a half-broken sync, not a
    // success -- say so plainly rather than reporting a clean tick over an
    // empty finance view.
    const financialsMissing = finFailed + finEmpty;
    let financialsNote: string | null = null;
    if (synced > 0 && finOk === 0 && financialsMissing > 0) {
      financialsNote =
        `No financial figures came back for any of the ${synced} jobs. ` +
        (finFailed > 0
          ? `${finFailed} request(s) to Fergus failed -- first error: ${firstFinError}`
          : `Fergus answered, but none of the expected amounts were present. Fields it actually returned: ${observedFinancialKeys ?? "(none)"}`);
    } else if (financialsMissing > 0) {
      financialsNote = `${finOk} job(s) have financials; ${financialsMissing} do not` + (firstFinError ? ` (first error: ${firstFinError})` : "");
    }

    updateAgentTask(taskId, {
      status: "completed",
      progress: 100,
      message: `Synced ${synced} jobs` + (financialsNote ? " -- but no financials" : ""),
      error: financialsNote ?? undefined,
    });
    logAgentEvent({
      taskId,
      agent: "operations_ai",
      eventType: "fergus_sync_completed",
      data: { synced, financialsOk: finOk, financialsFailed: finFailed, financialsEmpty: finEmpty, observedFinancialKeys },
    });
    db.prepare(
      `UPDATE integration_syncs SET status = 'success', records_synced = ?, error = ?, finished_at = ? WHERE id = ?`
    ).run(synced, financialsNote, nowIso(), syncId);
    recordIntegrationSuccess("fergus");
    recordAudit({
      actor: "operations_ai",
      action: "fergus_sync_completed",
      details: { synced, financialsOk: finOk, financialsFailed: finFailed, financialsEmpty: finEmpty },
    });
    createNotification({
      type: financialsNote && finOk === 0 ? "fergus_financials_missing" : "fergus_sync_completed",
      severity: financialsNote && finOk === 0 ? "warning" : "info",
      title: financialsNote && finOk === 0 ? "Fergus synced, but with no financials" : "Fergus sync completed",
      message: financialsNote ?? `${synced} job${synced === 1 ? "" : "s"} synced.`,
    });
    return { taskId, jobsSynced: synced };
  } catch (err: any) {
    const message = err?.message ?? String(err);
    updateAgentTask(taskId, { status: "failed", error: message });
    db.prepare(`UPDATE integration_syncs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?`).run(
      message,
      nowIso(),
      syncId
    );
    recordIntegrationError("fergus", message);
    createNotification({ type: "fergus_sync_failed", severity: "critical", title: "Fergus sync failed", message });
    recordAudit({ actor: "operations_ai", action: "fergus_sync_failed", details: { error: message } });
    throw err;
  }
}
