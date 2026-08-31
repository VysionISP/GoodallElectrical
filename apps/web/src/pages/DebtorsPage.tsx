import { useEffect, useState } from "react";
import { api } from "../lib/api.js";
import { money } from "../lib/format.js";

interface OverdueInvoice {
  id: string;
  invoice_number: string | null;
  customer_name: string | null;
  customer_email: string | null;
  amount_due: number | null;
  due_date: string | null;
  days_overdue: number;
}
interface Reminder {
  id: string;
  draft_subject: string;
  draft_body: string;
  status: string;
}

export default function DebtorsPage() {
  const [invoices, setInvoices] = useState<OverdueInvoice[] | null>(null);
  const [remindersByInvoice, setRemindersByInvoice] = useState<Record<string, Reminder[]>>({});
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function load() {
    api.get<{ invoices: OverdueInvoice[] }>("/debtors/overdue").then((r) => setInvoices(r.invoices));
  }
  useEffect(load, []);

  async function loadReminders(invoiceId: string) {
    const r = await api.get<{ reminders: Reminder[] }>(`/debtors/invoices/${invoiceId}/reminders`);
    setRemindersByInvoice((prev) => ({ ...prev, [invoiceId]: r.reminders }));
  }

  async function toggleExpand(invoiceId: string) {
    if (expanded === invoiceId) {
      setExpanded(null);
      return;
    }
    setExpanded(invoiceId);
    if (!remindersByInvoice[invoiceId]) await loadReminders(invoiceId);
  }

  async function draftReminder(invoiceId: string) {
    setBusy(invoiceId);
    setError(null);
    try {
      await api.post(`/debtors/invoices/${invoiceId}/draft-reminder`);
      await loadReminders(invoiceId);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  }

  async function submitForApproval(invoiceId: string, reminderId: string) {
    setBusy(reminderId);
    setError(null);
    try {
      await api.post(`/debtors/reminders/${reminderId}/submit-for-approval`);
      await loadReminders(invoiceId);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  }

  async function send(invoiceId: string, reminderId: string) {
    setBusy(reminderId);
    setError(null);
    try {
      await api.post(`/debtors/reminders/${reminderId}/send`);
      await loadReminders(invoiceId);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <div className="page-title">Debtors</div>
      <div className="page-sub">
        Overdue invoices, derived from real due dates and amounts owing -- Debtor AI can draft a reminder, but
        nothing sends without your approval.
      </div>

      {error && <div className="field-error" style={{ marginBottom: 16 }}>{error}</div>}

      {invoices === null && <div className="card">Loading…</div>}
      {invoices && invoices.length === 0 && <div className="card">Nothing overdue right now.</div>}
      {invoices &&
        invoices.map((inv) => (
          <div key={inv.id} className="card" style={{ marginBottom: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <strong>{inv.invoice_number ?? inv.id}</strong> — {inv.customer_name ?? <span className="na">Customer unavailable</span>}
                <div className="provenance-tag">
                  {money(inv.amount_due)} · {inv.days_overdue} day{inv.days_overdue === 1 ? "" : "s"} overdue
                  {!inv.customer_email && " · no email on file"}
                </div>
              </div>
              <button className="btn btn-secondary" onClick={() => toggleExpand(inv.id)}>
                {expanded === inv.id ? "Hide" : "Reminders"}
              </button>
            </div>

            {expanded === inv.id && (
              <div style={{ marginTop: 12 }}>
                <button className="btn" disabled={busy === inv.id} onClick={() => draftReminder(inv.id)}>
                  {busy === inv.id ? "Drafting…" : "Draft reminder"}
                </button>
                {(remindersByInvoice[inv.id] ?? []).map((r) => (
                  <div key={r.id} className="card" style={{ marginTop: 10, background: "var(--panel-2)" }}>
                    <div className="integration-header">
                      <strong>{r.draft_subject}</strong>
                      <span className="pill pill-muted">{r.status}</span>
                    </div>
                    <div style={{ whiteSpace: "pre-wrap", fontSize: 13, marginTop: 8 }}>{r.draft_body}</div>
                    <div className="integration-actions" style={{ marginTop: 10 }}>
                      {r.status === "drafted" && (
                        <button className="btn btn-secondary" disabled={busy === r.id} onClick={() => submitForApproval(inv.id, r.id)}>
                          Submit for approval
                        </button>
                      )}
                      {r.status === "approved" && (
                        <button className="btn" disabled={busy === r.id} onClick={() => send(inv.id, r.id)}>
                          Send
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
    </div>
  );
}
