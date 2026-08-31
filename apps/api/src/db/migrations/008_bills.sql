-- Payables (supplier bills, Xero's ACCPAY invoices) are a fundamentally
-- different thing from sales invoices (money owed TO us vs money WE owe),
-- so they get their own table rather than overloading `invoices` (whose
-- job_id/customer_id columns only make sense for receivables).

CREATE TABLE IF NOT EXISTS bills (
  id TEXT PRIMARY KEY,
  xero_bill_id TEXT UNIQUE,
  supplier_name TEXT,
  bill_number TEXT,
  status TEXT,
  issue_date TEXT,
  due_date TEXT,
  subtotal REAL,
  gst REAL,
  total REAL,
  amount_paid REAL,
  amount_due REAL,
  source TEXT NOT NULL DEFAULT 'xero' CHECK (source IN ('xero', 'manual')),
  last_synced_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_bills_due_date ON bills(due_date);
CREATE INDEX IF NOT EXISTS idx_bills_status ON bills(status);
