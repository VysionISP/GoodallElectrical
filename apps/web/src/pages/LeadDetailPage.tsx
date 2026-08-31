import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { api } from "../lib/api.js";

interface Lead {
  id: string;
  business_name: string;
  location: string | null;
  website: string | null;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  lead_score: number | null;
  reason: string | null;
  status: string;
}
interface Research {
  id: string;
  summary: string;
  notes: string;
  created_at: string;
}
interface Outreach {
  id: string;
  draft_subject: string;
  draft_body: string;
  status: string;
  created_at: string;
}

export default function LeadDetailPage() {
  const { id } = useParams();
  const [lead, setLead] = useState<Lead | null>(null);
  const [research, setResearch] = useState<Research[]>([]);
  const [outreach, setOutreach] = useState<Outreach[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [emailDraft, setEmailDraft] = useState("");

  function load() {
    if (!id) return;
    api.get<{ lead: Lead; research: Research[]; outreach: Outreach[] }>(`/leads/${id}`).then((r) => {
      setLead(r.lead);
      setResearch(r.research);
      setOutreach(r.outreach);
      setEmailDraft(r.lead.contact_email ?? "");
    });
  }
  useEffect(load, [id]);

  async function saveEmail() {
    if (!id || !emailDraft.trim()) return;
    setBusy("email");
    setError(null);
    try {
      await api.patch(`/leads/${id}`, { contactEmail: emailDraft.trim() });
      load();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  }

  async function runResearch() {
    if (!id) return;
    setBusy("research");
    setError(null);
    try {
      await api.post(`/leads/${id}/research`);
      load();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  }

  async function draftOutreach() {
    if (!id) return;
    setBusy("draft");
    setError(null);
    try {
      await api.post(`/leads/${id}/draft-outreach`);
      load();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  }

  async function submitForApproval(outreachId: string) {
    setBusy(outreachId);
    setError(null);
    try {
      await api.post(`/leads/outreach/${outreachId}/submit-for-approval`);
      load();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  }

  async function send(outreachId: string) {
    setBusy(outreachId);
    setError(null);
    try {
      await api.post(`/leads/outreach/${outreachId}/send`);
      load();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  }

  if (!lead) return <div className="card">Loading…</div>;

  return (
    <div>
      <div className="page-title">{lead.business_name}</div>
      <div className="page-sub">
        <span className="pill pill-muted">{lead.status}</span>{" "}
        {lead.lead_score !== null ? `Score ${lead.lead_score}` : "Not yet researched"}
      </div>

      {error && <div className="field-error" style={{ marginBottom: 16 }}>{error}</div>}

      <div className="job-detail-grid">
        <div className="card">
          <h3>Details</h3>
          <div>{lead.location ?? <span className="na">Location not available</span>}</div>
          {lead.website && <div className="provenance-tag">{lead.website}</div>}
          {lead.contact_phone && <div className="provenance-tag">{lead.contact_phone}</div>}

          <div style={{ marginTop: 12 }}>
            <div className="hq-stat-label">Contact email</div>
            <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
              <input
                style={{ flex: 1 }}
                value={emailDraft}
                onChange={(e) => setEmailDraft(e.target.value)}
                placeholder="none on file -- add one to enable sending"
              />
              <button className="btn btn-secondary" disabled={busy === "email"} onClick={saveEmail}>
                Save
              </button>
            </div>
          </div>
        </div>

        <div className="card">
          <h3>Research</h3>
          {research.length === 0 && <div className="na">Not researched yet.</div>}
          {research.map((r) => (
            <div key={r.id} className="fact-row">
              <div>
                <div>{r.summary}</div>
                <div className="provenance-tag">{r.notes}</div>
              </div>
            </div>
          ))}
          <button className="btn" style={{ marginTop: 10 }} disabled={busy === "research"} onClick={runResearch}>
            {busy === "research" ? "Researching…" : research.length === 0 ? "Run Research" : "Re-research"}
          </button>
        </div>
      </div>

      <h3 className="section-heading">Outreach</h3>
      <div className="card" style={{ marginBottom: 12 }}>
        <button className="btn" disabled={busy === "draft"} onClick={draftOutreach}>
          {busy === "draft" ? "Drafting…" : "Draft outreach email"}
        </button>
      </div>

      {outreach.map((o) => (
        <div key={o.id} className="card" style={{ marginBottom: 12 }}>
          <div className="integration-header">
            <strong>{o.draft_subject}</strong>
            <span className="pill pill-muted">{o.status}</span>
          </div>
          <div style={{ whiteSpace: "pre-wrap", fontSize: 13, marginTop: 8 }}>{o.draft_body}</div>
          <div className="integration-actions" style={{ marginTop: 12 }}>
            {o.status === "drafted" && (
              <button className="btn btn-secondary" disabled={busy === o.id} onClick={() => submitForApproval(o.id)}>
                Submit for approval
              </button>
            )}
            {o.status === "approved" && (
              <button className="btn" disabled={busy === o.id} onClick={() => send(o.id)}>
                Send
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
