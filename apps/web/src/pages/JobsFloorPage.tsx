import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api.js";
import type { JobListItem } from "../lib/types.js";
import { money, percent, provenanceLabel } from "../lib/format.js";

export default function JobsFloorPage() {
  const [jobs, setJobs] = useState<JobListItem[] | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);

  function load() {
    api.get<{ jobs: JobListItem[] }>("/jobs").then((r) => setJobs(r.jobs));
  }

  useEffect(load, []);

  async function triggerSync() {
    setSyncing(true);
    setSyncError(null);
    try {
      await api.post("/integrations/fergus/sync");
      load();
    } catch (err: any) {
      setSyncError(err.message);
    } finally {
      setSyncing(false);
    }
  }

  return (
    <div>
      <div className="page-title">Jobs Floor</div>
      <div className="page-sub">Live Fergus jobs. Missing figures show as "Not available", never as $0.</div>

      <div style={{ marginBottom: 16 }}>
        <button className="btn" onClick={triggerSync} disabled={syncing}>
          {syncing ? "Syncing…" : "Sync Fergus now"}
        </button>
        {syncError && (
          <div className="pill pill-danger" style={{ marginLeft: 10 }}>
            {syncError}
          </div>
        )}
      </div>

      {jobs === null && <div className="card">Loading…</div>}
      {jobs && jobs.length === 0 && (
        <div className="card">
          No jobs yet. Connect Fergus under Integrations and run a sync to import real jobs -- nothing here is
          fabricated.
        </div>
      )}
      {jobs && jobs.length > 0 && (
        <div className="card" style={{ padding: 0, overflowX: "auto" }}>
          <table className="table">
            <thead>
              <tr>
                <th>Job</th>
                <th>Customer</th>
                <th>Status</th>
                <th>Quoted</th>
                <th>Cost</th>
                <th>Invoiced</th>
                <th>Paid</th>
                <th>Margin</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((j) => (
                <tr key={j.id}>
                  <td>
                    <Link to={`/jobs/${j.id}`}>{j.job_number ?? j.id}</Link>
                    <div className="provenance-tag">{j.title}</div>
                  </td>
                  <td>{j.customer_name ?? <span className="na">Customer unavailable</span>}</td>
                  <td>{j.status ?? <span className="na">Unknown</span>}</td>
                  <FinancialCell value={j.quoted_amount} provenance={j.financial_provenance?.quotedAmount} />
                  <FinancialCell value={j.actual_cost} provenance={j.financial_provenance?.actualCost} />
                  <FinancialCell value={j.invoiced_amount} provenance={j.financial_provenance?.invoicedAmount} />
                  <FinancialCell value={j.paid_amount} provenance={j.financial_provenance?.paidAmount} />
                  <td>{percent(j.forecast_margin)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function FinancialCell({ value, provenance }: { value: number | null; provenance?: string }) {
  return (
    <td>
      {value === null ? <span className="na">Not available</span> : money(value)}
      {provenance && <span className="provenance-tag">{provenanceLabel(provenance)}</span>}
    </td>
  );
}
