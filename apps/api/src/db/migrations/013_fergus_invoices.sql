-- Allow invoices to come from Fergus, not only Xero.
--
-- Invoices were only ever imported from Xero, so an owner whose invoicing
-- lives in Fergus saw "Nothing overdue right now" while real overdue
-- invoices sat in Fergus. The sync already fetched them per job
-- (/customerInvoices?jobId=) and threw them away after summing totalPaid.
--
-- SQLite cannot ALTER a CHECK constraint, so the table is rebuilt. TWO
-- tables reference invoices with ON DELETE CASCADE -- payments and
-- debtor_reminders -- and dropping the parent deletes their rows even
-- though the child tables survive (measured directly in this project when
-- the approvals table was nearly rebuilt the same way). Both are copied
-- out and restored, and the invoice ids are preserved so the references
-- still resolve.
CREATE TABLE _payments_backup AS SELECT * FROM payments;
CREATE TABLE _debtor_reminders_backup AS SELECT * FROM debtor_reminders;

CREATE TABLE invoices_new (
  id TEXT PRIMARY KEY,
  job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
  customer_id TEXT REFERENCES customers(id) ON DELETE SET NULL,
  xero_invoice_id TEXT UNIQUE,
  fergus_invoice_id TEXT UNIQUE,
  invoice_number TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'pending_approval', 'approved', 'sent', 'paid', 'part_paid', 'overdue', 'void')),
  issue_date TEXT,
  due_date TEXT,
  subtotal REAL,
  gst REAL,
  total REAL,
  amount_paid REAL,
  amount_due REAL,
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('xero', 'fergus', 'manual')),
  approved_at TEXT,
  approved_by TEXT,
  sent_at TEXT,
  last_synced_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT INTO invoices_new (id, job_id, customer_id, xero_invoice_id, invoice_number, status, issue_date, due_date,
                          subtotal, gst, total, amount_paid, amount_due, source, approved_at, approved_by,
                          sent_at, last_synced_at, created_at, updated_at)
SELECT id, job_id, customer_id, xero_invoice_id, invoice_number, status, issue_date, due_date,
       subtotal, gst, total, amount_paid, amount_due, source, approved_at, approved_by,
       sent_at, last_synced_at, created_at, updated_at
FROM invoices;

DROP TABLE invoices;
ALTER TABLE invoices_new RENAME TO invoices;

CREATE INDEX IF NOT EXISTS idx_invoices_job ON invoices(job_id);
CREATE INDEX IF NOT EXISTS idx_invoices_customer ON invoices(customer_id);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);
CREATE INDEX IF NOT EXISTS idx_invoices_fergus ON invoices(fergus_invoice_id);

INSERT INTO payments SELECT * FROM _payments_backup;
INSERT INTO debtor_reminders SELECT * FROM _debtor_reminders_backup;
DROP TABLE _payments_backup;
DROP TABLE _debtor_reminders_backup;
