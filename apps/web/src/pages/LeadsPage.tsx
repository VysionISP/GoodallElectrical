import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api.js";

interface Lead {
  id: string;
  business_name: string;
  location: string | null;
  website: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  lead_score: number | null;
  status: string;
  source: string;
  created_at: string;
}

export default function LeadsPage() {
  const [leads, setLeads] = useState<Lead[] | null>(null);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchResult, setSearchResult] = useState<string | null>(null);

  function load() {
    api.get<{ leads: Lead[] }>("/leads").then((r) => setLeads(r.leads));
  }
  useEffect(load, []);

  async function runSearch() {
    if (!query.trim()) return;
    setSearching(true);
    setSearchError(null);
    setSearchResult(null);
    try {
      const result = await api.post<{ found: number; created: number }>("/leads/search", { query });
      setSearchResult(`Found ${result.found}, ${result.created} new.`);
      load();
    } catch (err: any) {
      setSearchError(err.message);
    } finally {
      setSearching(false);
    }
  }

  return (
    <div>
      <div className="page-title">Lead Radar</div>
      <div className="page-sub">
        Lead Hunter searches Google Places for potential customers. Research AI scores them; nothing gets
        contacted without your approval.
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            style={{ flex: 1 }}
            placeholder='e.g. "property managers near Sale VIC"'
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && runSearch()}
            disabled={searching}
          />
          <button className="btn" onClick={runSearch} disabled={searching || !query.trim()}>
            {searching ? "Searching…" : "Search"}
          </button>
        </div>
        {searchError && <div className="field-error">{searchError}</div>}
        {searchResult && <div className="provenance-tag" style={{ marginTop: 6 }}>{searchResult}</div>}
      </div>

      {leads === null && <div className="card">Loading…</div>}
      {leads && leads.length === 0 && <div className="card">No leads yet -- run a search above.</div>}
      {leads && leads.length > 0 && (
        <div className="card" style={{ padding: 0, overflowX: "auto" }}>
          <table className="table">
            <thead>
              <tr>
                <th>Business</th>
                <th>Location</th>
                <th>Score</th>
                <th>Status</th>
                <th>Source</th>
              </tr>
            </thead>
            <tbody>
              {leads.map((l) => (
                <tr key={l.id}>
                  <td>
                    <Link to={`/leads/${l.id}`}>{l.business_name}</Link>
                    {l.website && <div className="provenance-tag">{l.website}</div>}
                  </td>
                  <td>{l.location ?? <span className="na">Not available</span>}</td>
                  <td>{l.lead_score ?? <span className="na">Not scored</span>}</td>
                  <td>
                    <span className={`pill ${statusPill(l.status)}`}>{l.status}</span>
                  </td>
                  <td>{l.source}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function statusPill(status: string) {
  if (status === "qualified") return "pill-ok";
  if (status === "unqualified") return "pill-muted";
  if (status === "contacted") return "pill-info";
  return "pill-warn";
}
