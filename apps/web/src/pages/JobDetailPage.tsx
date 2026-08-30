import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { api } from "../lib/api.js";
import { money, percent, provenanceLabel } from "../lib/format.js";

interface JobDetailResponse {
  job: any;
  financials: any;
  phases: any[];
  known: any[];
  missing: any[];
  memory: any[];
  quotes: any[];
  invoices: any[];
  openQuestions: any[];
}

export default function JobDetailPage() {
  const { id } = useParams();
  const [data, setData] = useState<JobDetailResponse | null>(null);

  useEffect(() => {
    if (id) api.get<JobDetailResponse>(`/jobs/${id}`).then(setData);
  }, [id]);

  if (!data) return <div className="card">Loading…</div>;

  const { job, financials, known, missing } = data;

  return (
    <div>
      <div className="page-title">
        {job.job_number ?? job.id} — {job.title ?? "Untitled job"}
      </div>
      <div className="page-sub">
        <span className="pill pill-info">{job.source === "fergus" ? "LIVE FROM FERGUS" : "MANUAL"}</span>{" "}
        {job.status ?? "Unknown status"}
      </div>

      <div className="job-detail-grid">
        <div className="card">
          <h3>Customer</h3>
          <div>{job.customer_name ?? <span className="na">Customer unavailable</span>}</div>
          <div className="provenance-tag">{job.customer_email ?? ""}</div>
        </div>
        <div className="card">
          <h3>Site</h3>
          <div>{job.site_address ?? <span className="na">Not available</span>}</div>
        </div>
      </div>

      <h3 className="section-heading">Financials</h3>
      <div className="fin-cards">
        <FinCard label="Quoted" value={financials?.quoted_amount} provenance={financials?.provenance?.quotedAmount} />
        <FinCard label="Actual cost" value={financials?.actual_cost} provenance={financials?.provenance?.actualCost} />
        <FinCard label="Invoiced" value={financials?.invoiced_amount} provenance={financials?.provenance?.invoicedAmount} />
        <FinCard label="Paid" value={financials?.paid_amount} provenance={financials?.provenance?.paidAmount} />
        <FinCard label="Outstanding" value={financials?.outstanding_amount} provenance={financials?.provenance?.outstandingAmount} />
        <FinCard label="Forecast margin" value={financials?.forecast_margin} isPercent />
      </div>

      <div className="job-detail-grid">
        <div className="card">
          <h3>What AI knows</h3>
          {known.length === 0 && <div className="na">Nothing confirmed yet.</div>}
          {known.map((c) => (
            <div key={c.id} className="fact-row">
              <span className={`pill ${c.status === "known" ? "pill-ok" : "pill-info"}`}>{c.status}</span>
              <div>
                <strong>{c.key.replace(/_/g, " ")}</strong>: {c.value}
                <div className="provenance-tag">
                  {provenanceLabel(c.provenance)} · {Math.round((c.confidence ?? 1) * 100)}% confidence
                </div>
              </div>
            </div>
          ))}
        </div>
        <div className="card">
          <h3>Missing information</h3>
          {missing.length === 0 && data.openQuestions.length === 0 && (
            <div className="na">Nothing outstanding.</div>
          )}
          {missing.map((c) => (
            <div key={c.id} className="fact-row">
              <span className="pill pill-warn">needs input</span>
              <div>{c.key.replace(/_/g, " ")}</div>
            </div>
          ))}
          {data.openQuestions.map((q) => (
            <div key={q.id} className="fact-row">
              <span className="pill pill-danger">question</span>
              <div>{q.question}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function FinCard({
  label,
  value,
  provenance,
  isPercent,
}: {
  label: string;
  value: number | null | undefined;
  provenance?: string;
  isPercent?: boolean;
}) {
  return (
    <div className="card fin-card">
      <div className="hq-stat-label">{label}</div>
      <div className={`hq-stat-value ${value === null || value === undefined ? "na" : ""}`}>
        {isPercent ? percent(value) : money(value)}
      </div>
      {provenance && <div className="provenance-tag">{provenanceLabel(provenance)}</div>}
    </div>
  );
}
