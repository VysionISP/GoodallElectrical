import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api.js";

interface Enquiry {
  id: string;
  job_number: string | null;
  title: string | null;
  description: string | null;
  status: string | null;
  site_address: string | null;
  customer_name: string | null;
  customer_email: string | null;
  updated_at: string;
}

/**
 * Work that has come in from Fergus and still needs pricing.
 *
 * These jobs were always being synced -- the /jobs call has no status
 * filter -- they just weren't distinguished from everything else, so
 * "bring in enquiries" looked like a missing integration when it was
 * really a missing view.
 */
export default function EnquiriesPage() {
  const [enquiries, setEnquiries] = useState<Enquiry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);

  function load() {
    api
      .get<{ enquiries: Enquiry[] }>("/jobs/enquiries")
      .then((r) => setEnquiries(r.enquiries))
      .catch((err) => setError(err.message));
  }
  useEffect(load, []);

  async function syncNow() {
    setSyncing(true);
    setError(null);
    try {
      await api.post("/integrations/fergus/sync");
      load();
    } catch (err: any) {
      setError(err.message ?? "Sync failed");
    } finally {
      setSyncing(false);
    }
  }

  return (
    <div>
      <div className="page-title">Enquiries</div>
      <div className="page-sub">
        Open jobs from Fergus with no quote and no quoted amount against them — work that has come in and still
        needs pricing. Pulled from your normal Fergus sync, not a separate feed.
      </div>

      <button className="btn btn-secondary" disabled={syncing} onClick={syncNow} style={{ marginBottom: 16 }}>
        {syncing ? "Syncing…" : "Sync Fergus now"}
      </button>

      {error && <div className="field-error">{error}</div>}
      {enquiries === null && !error && <div className="card">Loading…</div>}
      {enquiries && enquiries.length === 0 && (
        <div className="card">
          Nothing waiting to be priced. Every open job either has a quote or a quoted amount already.
        </div>
      )}

      {enquiries && enquiries.length > 0 && (
        <>
          <div className="page-sub" style={{ marginTop: 0 }}>
            <strong>{enquiries.length}</strong> waiting to be priced.
          </div>
          <div className="card" style={{ padding: 0, overflowX: "auto" }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Job</th>
                  <th>Title</th>
                  <th>Customer</th>
                  <th>Site</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {enquiries.map((e) => (
                  <tr key={e.id}>
                    <td className="mono">
                      <Link to={`/jobs/${e.id}`}>{e.job_number ?? e.id}</Link>
                    </td>
                    <td>{e.title ?? <span className="na">Untitled</span>}</td>
                    <td>{e.customer_name ?? <span className="na">Not available</span>}</td>
                    <td>{e.site_address ?? <span className="na">Not available</span>}</td>
                    <td>
                      <span className="pill pill-muted">{e.status ?? "unknown"}</span>
                    </td>
                    <td>
                      <Link className="btn" to={`/quotes/new?jobId=${e.id}`}>
                        Quote it
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
