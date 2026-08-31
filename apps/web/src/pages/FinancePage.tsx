import { useEffect, useState } from "react";
import { api } from "../lib/api.js";
import { money } from "../lib/format.js";

interface ForecastWindow {
  days: number;
  expectedReceipts: number;
  payables: number;
  recurringCosts: { wages: number; super: number; fixed: number; materials: number; other: number; total: number };
  forecastCash: number | null;
}
interface Forecast {
  currentCash: number | null;
  cashPositionAt: string | null;
  xeroConfigured: boolean;
  hasRecurringCosts: boolean;
  windows: ForecastWindow[];
}
interface RecurringCost {
  id: string;
  name: string;
  category: string;
  amount: number;
  frequency: string;
}

const CATEGORY_LABEL: Record<string, string> = {
  wages: "Wages",
  super: "Super",
  fixed: "Fixed overheads",
  materials: "Materials",
  other: "Other",
};

export default function FinancePage() {
  const [forecast, setForecast] = useState<Forecast | null>(null);
  const [costs, setCosts] = useState<RecurringCost[] | null>(null);
  const [name, setName] = useState("");
  const [category, setCategory] = useState("wages");
  const [amount, setAmount] = useState("");
  const [frequency, setFrequency] = useState("weekly");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function load() {
    api.get<Forecast>("/finance/forecast").then(setForecast);
    api.get<{ recurringCosts: RecurringCost[] }>("/finance/recurring-costs").then((r) => setCosts(r.recurringCosts));
  }
  useEffect(load, []);

  async function addCost() {
    const amt = Number(amount);
    if (!name.trim() || !amt || amt <= 0) return;
    setBusy(true);
    setError(null);
    try {
      await api.post("/finance/recurring-costs", { name: name.trim(), category, amount: amt, frequency });
      setName("");
      setAmount("");
      load();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function removeCost(id: string) {
    setBusy(true);
    try {
      await api.delete(`/finance/recurring-costs/${id}`);
      load();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="page-title">Finance</div>
      <div className="page-sub">
        Cashflow forecast built from real Xero data plus whatever recurring costs you've entered -- never a
        fabricated number. Missing pieces are labelled as missing, not filled in with a guess.
      </div>

      {forecast && !forecast.xeroConfigured && (
        <div className="card" style={{ marginBottom: 16 }}>
          Xero isn't connected, so current cash is unknown. Connect it under Integrations and run a sync to see a
          real forecast -- receivables/payables below still reflect whatever invoices/bills you do have.
        </div>
      )}

      {forecast && forecast.xeroConfigured && !forecast.hasRecurringCosts && (
        <div className="card" style={{ marginBottom: 16 }}>
          No recurring costs entered yet -- the forecast below doesn't account for wages, super, or fixed
          overheads. Add them below for a complete picture.
        </div>
      )}

      <div className="card" style={{ marginBottom: 20 }}>
        <div className="hq-stat-label">Current cash</div>
        <div className="hq-stat-value" style={{ fontSize: 28 }}>
          {forecast ? money(forecast.currentCash) : "…"}
        </div>
        {forecast?.cashPositionAt && (
          <div className="provenance-tag">As of {new Date(forecast.cashPositionAt).toLocaleString("en-AU")}</div>
        )}
      </div>

      {forecast && (
        <div className="card" style={{ padding: 0, overflowX: "auto", marginBottom: 20 }}>
          <table className="table">
            <thead>
              <tr>
                <th></th>
                {forecast.windows.map((w) => (
                  <th key={w.days}>{w.days} days</th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Expected receipts</td>
                {forecast.windows.map((w) => (
                  <td key={w.days}>{money(w.expectedReceipts)}</td>
                ))}
              </tr>
              <tr>
                <td>Payables</td>
                {forecast.windows.map((w) => (
                  <td key={w.days}>−{money(w.payables)}</td>
                ))}
              </tr>
              <tr>
                <td>Recurring costs</td>
                {forecast.windows.map((w) => (
                  <td key={w.days}>−{money(w.recurringCosts.total)}</td>
                ))}
              </tr>
              <tr>
                <td>
                  <strong>Forecast cash</strong>
                </td>
                {forecast.windows.map((w) => (
                  <td key={w.days}>
                    <strong>{money(w.forecastCash)}</strong>
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      )}

      <h3 className="section-heading" style={{ marginTop: 0 }}>
        Recurring costs
      </h3>
      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input placeholder="e.g. Wages" value={name} onChange={(e) => setName(e.target.value)} style={{ flex: 1, minWidth: 140 }} />
          <select value={category} onChange={(e) => setCategory(e.target.value)}>
            {Object.entries(CATEGORY_LABEL).map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
          <input placeholder="Amount" type="number" value={amount} onChange={(e) => setAmount(e.target.value)} style={{ width: 100 }} />
          <select value={frequency} onChange={(e) => setFrequency(e.target.value)}>
            <option value="weekly">Weekly</option>
            <option value="fortnightly">Fortnightly</option>
            <option value="monthly">Monthly</option>
          </select>
          <button className="btn" onClick={addCost} disabled={busy}>
            Add
          </button>
        </div>
        {error && <div className="field-error">{error}</div>}
      </div>

      {costs && costs.length > 0 && (
        <div className="card" style={{ padding: 0 }}>
          {costs.map((c) => (
            <div key={c.id} className="fact-row" style={{ padding: "10px 16px" }}>
              <div style={{ flex: 1 }}>
                {c.name} <span className="provenance-tag">{CATEGORY_LABEL[c.category]}</span>
              </div>
              <div style={{ marginRight: 12 }}>
                {money(c.amount)} / {c.frequency}
              </div>
              <button className="btn btn-danger" style={{ padding: "4px 10px", fontSize: 12 }} onClick={() => removeCost(c.id)}>
                Remove
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
