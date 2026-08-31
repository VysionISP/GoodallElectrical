import { getDb } from "../db/connection.js";
import { newId, nowIso } from "../lib/ids.js";
import { createAgentTask, updateAgentTask, logAgentEvent } from "../lib/agentTasks.js";
import { createNotification } from "../lib/notifications.js";
import { recordAudit } from "../lib/audit.js";
import { getIntegrationCredentials, recordIntegrationSuccess, recordIntegrationError, setIntegrationConfig } from "./store.js";
import {
  listInvoicesRaw,
  mapXeroInvoice,
  mapXeroStatusToInvoiceStatus,
  listBankTransactionsRaw,
  mapBankTransaction,
  getCashPosition,
  type XeroCredentials,
  type NormalizedXeroInvoice,
  type NormalizedBankTransaction,
} from "./xero.js";

/**
 * Upserts one Xero invoice and, where its Reference matches a known Fergus
 * job_number, correlates it against that job's financials (section 3 of
 * the brief -- Fergus + Xero reconciliation). No correlation is invented
 * when the reference doesn't match an existing job.
 */
function upsertInvoice(inv: NormalizedXeroInvoice): void {
  const db = getDb();
  const now = nowIso();

  let jobId: string | null = null;
  if (inv.reference) {
    const job = db.prepare("SELECT id FROM jobs WHERE job_number = ?").get(inv.reference) as
      | { id: string }
      | undefined;
    jobId = job?.id ?? null;
  }

  let customerId: string | null = null;
  if (inv.contactName) {
    const existingCustomer = db.prepare("SELECT id FROM customers WHERE name = ?").get(inv.contactName) as
      | { id: string }
      | undefined;
    if (existingCustomer) {
      customerId = existingCustomer.id;
    } else {
      customerId = newId("cust");
      db.prepare(
        `INSERT INTO customers (id, name, source, created_at, updated_at) VALUES (?, ?, 'xero', ?, ?)`
      ).run(customerId, inv.contactName, now, now);
    }
  }

  const existing = db.prepare("SELECT id FROM invoices WHERE xero_invoice_id = ?").get(inv.xeroInvoiceId) as
    | { id: string }
    | undefined;

  // Xero's raw status (DRAFT/SUBMITTED/AUTHORISED/PAID/VOIDED) doesn't
  // fit our invoices.status CHECK constraint, which is built for our own
  // send-approval lifecycle -- translate it, deriving overdue/part_paid
  // from real amounts and dates rather than guessing.
  const mappedStatus = mapXeroStatusToInvoiceStatus(inv);

  if (existing) {
    db.prepare(
      `UPDATE invoices SET job_id = ?, customer_id = ?, invoice_number = ?, status = ?, issue_date = ?, due_date = ?, subtotal = ?, gst = ?, total = ?, amount_paid = ?, amount_due = ?, last_synced_at = ?, updated_at = ? WHERE id = ?`
    ).run(
      jobId,
      customerId,
      inv.invoiceNumber,
      mappedStatus,
      inv.issueDate,
      inv.dueDate,
      inv.subtotal,
      inv.gst,
      inv.total,
      inv.amountPaid,
      inv.amountDue,
      now,
      now,
      existing.id
    );
  } else {
    db.prepare(
      `INSERT INTO invoices (id, job_id, customer_id, xero_invoice_id, invoice_number, status, issue_date, due_date, subtotal, gst, total, amount_paid, amount_due, source, last_synced_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'xero', ?, ?, ?)`
    ).run(
      newId("inv"),
      jobId,
      customerId,
      inv.xeroInvoiceId,
      inv.invoiceNumber,
      mappedStatus,
      inv.issueDate,
      inv.dueDate,
      inv.subtotal,
      inv.gst,
      inv.total,
      inv.amountPaid,
      inv.amountDue,
      now,
      now,
      now
    );
  }

  if (jobId && (inv.total !== null || inv.amountPaid !== null)) {
    const existingFin = db.prepare("SELECT id, provenance FROM job_financials WHERE job_id = ?").get(jobId) as
      | { id: string; provenance: string }
      | undefined;
    const provenanceUpdate: Record<string, string> = {};
    if (inv.total !== null) provenanceUpdate.invoicedAmount = "xero";
    if (inv.amountPaid !== null) provenanceUpdate.paidAmount = "xero";
    if (existingFin) {
      const merged = { ...JSON.parse(existingFin.provenance || "{}"), ...provenanceUpdate };
      db.prepare(
        `UPDATE job_financials SET invoiced_amount = COALESCE(?, invoiced_amount), paid_amount = COALESCE(?, paid_amount), provenance = ?, updated_at = ? WHERE id = ?`
      ).run(inv.total, inv.amountPaid, JSON.stringify(merged), now, existingFin.id);
    } else {
      db.prepare(
        `INSERT INTO job_financials (id, job_id, invoiced_amount, paid_amount, provenance, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(newId("fin"), jobId, inv.total, inv.amountPaid, JSON.stringify(provenanceUpdate), now, now);
    }
  }
}

/** Bills (ACCPAY) reuse the same Invoice mapping as sales invoices -- Xero models both as the same resource. */
function upsertBill(bill: NormalizedXeroInvoice): void {
  const db = getDb();
  const now = nowIso();
  const existing = db.prepare("SELECT id FROM bills WHERE xero_bill_id = ?").get(bill.xeroInvoiceId) as
    | { id: string }
    | undefined;

  if (existing) {
    db.prepare(
      `UPDATE bills SET supplier_name = ?, bill_number = ?, status = ?, issue_date = ?, due_date = ?, subtotal = ?, gst = ?, total = ?, amount_paid = ?, amount_due = ?, last_synced_at = ?, updated_at = ? WHERE id = ?`
    ).run(
      bill.contactName,
      bill.invoiceNumber,
      bill.status,
      bill.issueDate,
      bill.dueDate,
      bill.subtotal,
      bill.gst,
      bill.total,
      bill.amountPaid,
      bill.amountDue,
      now,
      now,
      existing.id
    );
  } else {
    db.prepare(
      `INSERT INTO bills (id, xero_bill_id, supplier_name, bill_number, status, issue_date, due_date, subtotal, gst, total, amount_paid, amount_due, source, last_synced_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'xero', ?, ?, ?)`
    ).run(
      newId("bill"),
      bill.xeroInvoiceId,
      bill.contactName,
      bill.invoiceNumber,
      bill.status,
      bill.issueDate,
      bill.dueDate,
      bill.subtotal,
      bill.gst,
      bill.total,
      bill.amountPaid,
      bill.amountDue,
      now,
      now,
      now
    );
  }
}

function upsertBankTransaction(tx: NormalizedBankTransaction): void {
  const db = getDb();
  const now = nowIso();
  const existing = db.prepare("SELECT id FROM bank_transactions WHERE xero_transaction_id = ?").get(tx.xeroTransactionId) as
    | { id: string }
    | undefined;
  if (existing) {
    db.prepare(
      `UPDATE bank_transactions SET account_name = ?, type = ?, amount = ?, description = ?, contact_name = ?, date = ? WHERE id = ?`
    ).run(tx.accountName, tx.type, tx.amount, tx.description, tx.contactName, tx.date, existing.id);
  } else {
    db.prepare(
      `INSERT INTO bank_transactions (id, xero_transaction_id, account_name, type, amount, description, contact_name, date, reconciled, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`
    ).run(newId("txn"), tx.xeroTransactionId, tx.accountName, tx.type, tx.amount, tx.description, tx.contactName, tx.date, now);
  }
}

export async function runXeroSync(): Promise<{
  taskId: string;
  invoicesSynced: number;
  billsSynced: number;
  transactionsSynced: number;
  cashPosition: number | null;
}> {
  const creds = getIntegrationCredentials<XeroCredentials>("xero");
  const taskId = createAgentTask({
    agent: "finance_ai",
    taskType: "xero_sync",
    room: "finance",
    message: "Syncing Xero invoices",
  });

  const db = getDb();
  const syncId = newId("sync");
  db.prepare(
    `INSERT INTO integration_syncs (id, provider, status, records_synced, started_at, agent_task_id) VALUES (?, 'xero', 'running', 0, ?, ?)`
  ).run(syncId, nowIso(), taskId);

  if (!creds?.accessToken) {
    const message = "Xero is not connected. Complete the OAuth flow in Integrations before syncing.";
    updateAgentTask(taskId, { status: "failed", error: message });
    db.prepare(`UPDATE integration_syncs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?`).run(
      message,
      nowIso(),
      syncId
    );
    createNotification({ type: "xero_sync_failed", severity: "warning", title: "Xero sync failed", message });
    throw Object.assign(new Error(message), { code: "NOT_CONFIGURED" });
  }

  try {
    const rawInvoices = await listInvoicesRaw(creds, "ACCREC");
    let synced = 0;
    for (const raw of rawInvoices) {
      upsertInvoice(mapXeroInvoice(raw));
      synced++;
      updateAgentTask(taskId, {
        message: "Syncing sales invoices",
        progress: rawInvoices.length ? Math.round((synced / rawInvoices.length) * 33) : 33,
      });
    }

    updateAgentTask(taskId, { message: "Syncing bills (payables)", progress: 40 });
    const rawBills = await listInvoicesRaw(creds, "ACCPAY");
    let billsSynced = 0;
    for (const raw of rawBills) {
      upsertBill(mapXeroInvoice(raw));
      billsSynced++;
    }

    updateAgentTask(taskId, { message: "Syncing bank transactions", progress: 65 });
    const rawTxns = await listBankTransactionsRaw(creds);
    let transactionsSynced = 0;
    for (const raw of rawTxns) {
      upsertBankTransaction(mapBankTransaction(raw));
      transactionsSynced++;
    }

    updateAgentTask(taskId, { message: "Reading bank summary", progress: 90 });
    const cashPosition = await getCashPosition(creds);
    setIntegrationConfig("xero", { cashPosition, cashPositionAt: nowIso() });

    const totalSynced = synced + billsSynced + transactionsSynced;
    updateAgentTask(taskId, {
      status: "completed",
      progress: 100,
      message: `Synced ${synced} invoices, ${billsSynced} bills, ${transactionsSynced} transactions`,
    });
    logAgentEvent({
      taskId,
      agent: "finance_ai",
      eventType: "xero_sync_completed",
      data: { synced, billsSynced, transactionsSynced, cashPosition },
    });
    db.prepare(
      `UPDATE integration_syncs SET status = 'success', records_synced = ?, finished_at = ? WHERE id = ?`
    ).run(totalSynced, nowIso(), syncId);
    recordIntegrationSuccess("xero");
    recordAudit({
      actor: "finance_ai",
      action: "xero_sync_completed",
      details: { synced, billsSynced, transactionsSynced, cashPosition },
    });
    createNotification({
      type: "xero_sync_completed",
      severity: "info",
      title: "Xero sync completed",
      message: `${synced} invoice${synced === 1 ? "" : "s"}, ${billsSynced} bill${billsSynced === 1 ? "" : "s"}, ${transactionsSynced} transaction${transactionsSynced === 1 ? "" : "s"} synced.`,
    });
    return { taskId, invoicesSynced: synced, billsSynced, transactionsSynced, cashPosition };
  } catch (err: any) {
    const message = err?.message ?? String(err);
    updateAgentTask(taskId, { status: "failed", error: message });
    db.prepare(`UPDATE integration_syncs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?`).run(
      message,
      nowIso(),
      syncId
    );
    recordIntegrationError("xero", message);
    createNotification({ type: "xero_sync_failed", severity: "critical", title: "Xero sync failed", message });
    throw err;
  }
}
