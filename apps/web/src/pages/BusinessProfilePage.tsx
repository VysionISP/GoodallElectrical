import { useEffect, useState } from "react";
import { api } from "../lib/api.js";

interface MemoryItem {
  id: string;
  content: string;
  category: string;
  created_at: string;
}

type Category = "services" | "service_area" | "pricing" | "exclusions" | "other";

const CATEGORY_LABEL: Record<Category, string> = {
  services: "Services we offer",
  service_area: "Service area",
  pricing: "Pricing rules",
  exclusions: "Jobs we don't take",
  other: "Other",
};

const CATEGORY_HINT: Record<Category, string> = {
  services: 'e.g. "Switchboard upgrades and replacements", "EV charger installation", "Commercial and residential wiring"',
  service_area: 'e.g. "We work within 80km of Sale VIC"',
  pricing: 'e.g. "Standard callout fee is $120"',
  exclusions: 'e.g. "We don\'t pursue domestic jobs below $5,000"',
  other: "Any other business rule the AI should know",
};

export default function BusinessProfilePage() {
  const [memory, setMemory] = useState<MemoryItem[] | null>(null);
  const [category, setCategory] = useState<Category>("services");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function load() {
    api.get<{ memory: MemoryItem[] }>("/business-memory").then((r) => setMemory(r.memory));
  }
  useEffect(load, []);

  async function add() {
    if (!draft.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.post("/business-memory", { content: draft.trim(), category });
      setDraft("");
      load();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setBusy(true);
    try {
      await api.delete(`/business-memory/${id}`);
      load();
    } finally {
      setBusy(false);
    }
  }

  const categories = Object.keys(CATEGORY_LABEL) as Category[];

  return (
    <div>
      <div className="page-title">Business Profile</div>
      <div className="page-sub">
        What the AI knows about your business -- services offered, service area, pricing rules, and jobs you don't
        take. Research AI uses this to judge whether a lead is a fit; Lead Hunter uses "services" and "service area"
        to suggest search queries.
      </div>

      <div className="card" style={{ marginBottom: 20 }}>
        <div className="hq-stat-label">Add an entry</div>
        <div style={{ display: "flex", gap: 8, margin: "8px 0" }}>
          <select value={category} onChange={(e) => setCategory(e.target.value as Category)}>
            {categories.map((c) => (
              <option key={c} value={c}>
                {CATEGORY_LABEL[c]}
              </option>
            ))}
          </select>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            style={{ flex: 1 }}
            placeholder={CATEGORY_HINT[category]}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && add()}
            disabled={busy}
          />
          <button className="btn" onClick={add} disabled={busy || !draft.trim()}>
            Add
          </button>
        </div>
        {error && <div className="field-error">{error}</div>}
      </div>

      {memory === null && <div className="card">Loading…</div>}
      {memory && memory.length === 0 && (
        <div className="card">
          Nothing yet. Start with "Services we offer" -- Lead Hunter and Research AI can't do much without it.
        </div>
      )}

      {categories.map((cat) => {
        const items = (memory ?? []).filter((m) => m.category === cat);
        if (items.length === 0) return null;
        return (
          <div key={cat} style={{ marginBottom: 16 }}>
            <h3 className="section-heading" style={{ marginTop: 0 }}>
              {CATEGORY_LABEL[cat]}
            </h3>
            <div className="card" style={{ padding: 0 }}>
              {items.map((m) => (
                <div key={m.id} className="fact-row" style={{ padding: "10px 16px" }}>
                  <div style={{ flex: 1 }}>{m.content}</div>
                  <button className="btn btn-danger" style={{ padding: "4px 10px", fontSize: 12 }} onClick={() => remove(m.id)}>
                    Remove
                  </button>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
