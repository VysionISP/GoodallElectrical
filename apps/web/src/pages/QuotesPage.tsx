import { useEffect, useState } from "react";
import { api } from "../lib/api.js";
import { money, percent } from "../lib/format.js";

interface Quote {
  id: string;
  status: string;
  total: number | null;
  forecast_gross_profit: number | null;
  forecast_margin: number | null;
  created_at: string;
}

export default function QuotesPage() {
  const [quotes, setQuotes] = useState<Quote[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  function load() {
    api.get<{ quotes: Quote[] }>("/quotes").then((r) => setQuotes(r.quotes));
  }
  useEffect(load, []);

  async function submitForApproval(id: string) {
    setBusy(id);
    try {
      await api.post(`/quotes/${id}/submit-for-approval`);
      load();
    } finally {
      setBusy(null);
    }
  }

  async function send(id: string) {
    setBusy(id);
    try {
      await api.post(`/quotes/${id}/send`);
      load();
    } catch (err: any) {
      alert(err.message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <div className="page-title">Quotes</div>
      <div className="page-sub">
        Draft → submitted for approval → approved → sent. The API refuses /send with 403 QUOTE_NOT_APPROVED at any
        earlier stage, regardless of what this UI shows.
      </div>

      {quotes === null && <div className="card">Loading…</div>}
      {quotes && quotes.length === 0 && <div className="card">No quotes yet.</div>}
      {quotes && quotes.length > 0 && (
        <div className="card" style={{ padding: 0, overflowX: "auto" }}>
          <table className="table">
            <thead>
              <tr>
                <th>Quote</th>
                <th>Status</th>
                <th>Total</th>
                <th>Forecast GP</th>
                <th>Margin</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {quotes.map((q) => (
                <tr key={q.id}>
                  <td className="mono">{q.id}</td>
                  <td>
                    <span className="pill pill-muted">{q.status}</span>
                  </td>
                  <td>{money(q.total)}</td>
                  <td>{money(q.forecast_gross_profit)}</td>
                  <td>{percent(q.forecast_margin)}</td>
                  <td style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    {q.status === "draft" && (
                      <button className="btn btn-secondary" disabled={busy === q.id} onClick={() => submitForApproval(q.id)}>
                        Submit for approval
                      </button>
                    )}
                    {q.status === "approved" && (
                      <button className="btn" disabled={busy === q.id} onClick={() => send(q.id)}>
                        Send
                      </button>
                    )}
                    <a className="btn btn-secondary" href={`/api/quotes/${q.id}/pdf?variant=customer`} target="_blank" rel="noreferrer">
                      PDF (customer)
                    </a>
                    <a className="btn btn-secondary" href={`/api/quotes/${q.id}/pdf?variant=owner`} target="_blank" rel="noreferrer">
                      PDF (owner)
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
