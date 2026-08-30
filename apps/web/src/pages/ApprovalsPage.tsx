import { useEffect, useState } from "react";
import { api } from "../lib/api.js";
import type { Approval } from "../lib/types.js";

export default function ApprovalsPage() {
  const [approvals, setApprovals] = useState<Approval[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  function load() {
    api.get<{ approvals: Approval[] }>("/approvals?status=pending").then((r) => setApprovals(r.approvals));
  }
  useEffect(load, []);

  async function decide(id: string, decision: "approved" | "rejected") {
    setBusy(id);
    try {
      await api.post(`/approvals/${id}/decide`, { decision, decidedBy: "owner" });
      load();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <div className="page-title">Approvals</div>
      <div className="page-sub">
        Nothing gets sent without a decision here -- enforced server-side, not just hidden buttons. This queue is the
        only path to an "approved" status.
      </div>

      {approvals === null && <div className="card">Loading…</div>}
      {approvals && approvals.length === 0 && <div className="card">Nothing waiting on you right now.</div>}
      {approvals && approvals.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {approvals.map((a) => (
            <div key={a.id} className="card" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <span className="pill pill-warn">{a.entity_type}</span> <strong>{a.action}</strong>
                <div className="provenance-tag">
                  {a.entity_id} · requested by {a.requested_by ?? "system"}
                </div>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button className="btn" disabled={busy === a.id} onClick={() => decide(a.id, "approved")}>
                  Approve
                </button>
                <button className="btn btn-danger" disabled={busy === a.id} onClick={() => decide(a.id, "rejected")}>
                  Reject
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
