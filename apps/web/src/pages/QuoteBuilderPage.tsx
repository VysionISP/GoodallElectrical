import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../lib/api.js";
import { money, percent } from "../lib/format.js";
import type { JobListItem } from "../lib/types.js";

type Category = "materials" | "labour" | "testing" | "other";

interface DraftItem {
  key: string;
  description: string;
  category: Category;
  quantity: string;
  unit: string;
  unitCost: string;
  unitPrice: string;
}

const CATEGORIES: Category[] = ["materials", "labour", "testing", "other"];
const GST_RATE = 0.1;

function blankItem(): DraftItem {
  return {
    key: `item-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    description: "",
    category: "materials",
    quantity: "1",
    unit: "",
    unitCost: "",
    unitPrice: "",
  };
}

/** Empty string means "not entered", which is different from zero -- an unpriced line must not silently count as $0 revenue. */
function num(value: string): number | null {
  if (value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export default function QuoteBuilderPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [jobs, setJobs] = useState<JobListItem[] | null>(null);
  const [jobId, setJobId] = useState<string>(searchParams.get("jobId") ?? "");
  const [notes, setNotes] = useState("");
  const [items, setItems] = useState<DraftItem[]>([blankItem()]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get<{ jobs: JobListItem[] }>("/jobs").then((r) => setJobs(r.jobs));
  }, []);

  function updateItem(key: string, patch: Partial<DraftItem>) {
    setItems((prev) => prev.map((i) => (i.key === key ? { ...i, ...patch } : i)));
  }

  function removeItem(key: string) {
    setItems((prev) => (prev.length === 1 ? prev : prev.filter((i) => i.key !== key)));
  }

  // Mirrors the server's math in routes/quotes.ts exactly (GST 10%, cost by
  // category, GP = subtotal - cost, margin = GP/subtotal). If these ever
  // disagree the owner would approve one number and send another, so they
  // are deliberately kept identical rather than "close enough".
  const totals = useMemo(() => {
    let subtotal = 0;
    let materialCost = 0;
    let labourCost = 0;
    let otherCost = 0;

    for (const item of items) {
      const qty = num(item.quantity) ?? 0;
      const price = num(item.unitPrice) ?? 0;
      const cost = num(item.unitCost) ?? 0;
      subtotal += qty * price;
      const lineCost = qty * cost;
      if (item.category === "materials") materialCost += lineCost;
      else if (item.category === "labour") labourCost += lineCost;
      else otherCost += lineCost;
    }

    const totalCost = materialCost + labourCost + otherCost;
    const gst = round2(subtotal * GST_RATE);
    const grossProfit = round2(subtotal - totalCost);
    return {
      subtotal: round2(subtotal),
      gst,
      total: round2(subtotal + gst),
      totalCost: round2(totalCost),
      grossProfit,
      margin: subtotal > 0 ? round2((grossProfit / subtotal) * 100) : null,
    };
  }, [items]);

  const priced = items.filter((i) => i.description.trim() !== "");
  const canSave = priced.length > 0 && !saving;

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const payload = {
        jobId: jobId || undefined,
        notes: notes.trim() || undefined,
        createdBy: "owner",
        items: priced.map((i) => ({
          description: i.description.trim(),
          category: i.category,
          quantity: num(i.quantity) ?? 1,
          unit: i.unit.trim() || undefined,
          unitCost: num(i.unitCost) ?? undefined,
          unitPrice: num(i.unitPrice) ?? undefined,
        })),
      };
      await api.post("/quotes", payload);
      navigate("/quotes");
    } catch (err: any) {
      setError(err.message ?? "Could not save this quote");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <div className="page-title">New quote</div>
      <div className="page-sub">
        Saves as a draft. Nothing reaches the customer until you submit it for approval and approve it -- the API
        refuses /send with 403 at any earlier stage.
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <h3 style={{ marginTop: 0 }}>Job</h3>
        {jobs === null ? (
          <div className="na">Loading jobs…</div>
        ) : (
          <select value={jobId} onChange={(e) => setJobId(e.target.value)} style={{ minWidth: 340, maxWidth: "100%" }}>
            <option value="">No job — standalone quote</option>
            {jobs.map((j) => (
              <option key={j.id} value={j.id}>
                {j.job_number ?? j.id} — {j.title ?? "Untitled"}
                {j.customer_name ? ` (${j.customer_name})` : ""}
              </option>
            ))}
          </select>
        )}
        <div className="provenance-tag" style={{ marginTop: 8 }}>
          Picking a job attaches this quote to that job's customer automatically.
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16, padding: 0, overflowX: "auto" }}>
        <table className="table">
          <thead>
            <tr>
              <th style={{ minWidth: 220 }}>Description</th>
              <th>Category</th>
              <th style={{ width: 80 }}>Qty</th>
              <th style={{ width: 90 }}>Unit</th>
              <th style={{ width: 120 }}>Cost/unit</th>
              <th style={{ width: 120 }}>Price/unit</th>
              <th style={{ width: 110 }}>Line total</th>
              <th style={{ width: 40 }}></th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => {
              const lineTotal = (num(item.quantity) ?? 0) * (num(item.unitPrice) ?? 0);
              return (
                <tr key={item.key}>
                  <td>
                    <input
                      value={item.description}
                      placeholder="e.g. Supply and install switchboard"
                      onChange={(e) => updateItem(item.key, { description: e.target.value })}
                      style={{ width: "100%" }}
                    />
                  </td>
                  <td>
                    <select
                      value={item.category}
                      onChange={(e) => updateItem(item.key, { category: e.target.value as Category })}
                    >
                      {CATEGORIES.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <input
                      value={item.quantity}
                      inputMode="decimal"
                      onChange={(e) => updateItem(item.key, { quantity: e.target.value })}
                      style={{ width: "100%" }}
                    />
                  </td>
                  <td>
                    <input
                      value={item.unit}
                      placeholder="ea"
                      onChange={(e) => updateItem(item.key, { unit: e.target.value })}
                      style={{ width: "100%" }}
                    />
                  </td>
                  <td>
                    <input
                      value={item.unitCost}
                      inputMode="decimal"
                      placeholder="—"
                      onChange={(e) => updateItem(item.key, { unitCost: e.target.value })}
                      style={{ width: "100%" }}
                    />
                  </td>
                  <td>
                    <input
                      value={item.unitPrice}
                      inputMode="decimal"
                      placeholder="—"
                      onChange={(e) => updateItem(item.key, { unitPrice: e.target.value })}
                      style={{ width: "100%" }}
                    />
                  </td>
                  <td className="mono">{money(round2(lineTotal))}</td>
                  <td>
                    <button
                      className="btn btn-secondary"
                      disabled={items.length === 1}
                      onClick={() => removeItem(item.key)}
                      aria-label="Remove line"
                    >
                      ×
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <button className="btn btn-secondary" onClick={() => setItems((prev) => [...prev, blankItem()])}>
        + Add line
      </button>

      <h3 className="section-heading">Totals</h3>
      <div className="fin-cards">
        <TotalCard label="Subtotal (ex GST)" value={totals.subtotal} />
        <TotalCard label="GST (10%)" value={totals.gst} />
        <TotalCard label="Total (inc GST)" value={totals.total} />
        <TotalCard label="Your cost" value={totals.totalCost} internal />
        <TotalCard label="Gross profit" value={totals.grossProfit} internal />
        <TotalCard label="Margin" value={totals.margin} internal isPercent />
      </div>
      <div className="provenance-tag" style={{ marginTop: 6 }}>
        Cost, gross profit and margin are internal only -- they appear on the owner PDF, never the customer one.
      </div>

      <h3 className="section-heading">Notes</h3>
      <textarea
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder="Anything the customer should see on the quote..."
        rows={3}
        style={{ width: "100%", maxWidth: 700 }}
      />

      {error && <div className="field-error">{error}</div>}

      <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
        <button className="btn" disabled={!canSave} onClick={save}>
          {saving ? "Saving…" : "Save as draft"}
        </button>
        <button className="btn btn-secondary" onClick={() => navigate("/quotes")}>
          Cancel
        </button>
      </div>
      {priced.length === 0 && (
        <div className="provenance-tag" style={{ marginTop: 8 }}>
          Add at least one line with a description to save.
        </div>
      )}
    </div>
  );
}

function TotalCard({
  label,
  value,
  isPercent,
  internal,
}: {
  label: string;
  value: number | null;
  isPercent?: boolean;
  internal?: boolean;
}) {
  return (
    <div className="card fin-card">
      <div className="hq-stat-label">{label}</div>
      <div className={`hq-stat-value ${value === null ? "na" : ""}`}>
        {isPercent ? percent(value) : money(value)}
      </div>
      {internal && <div className="provenance-tag">Internal only</div>}
    </div>
  );
}
