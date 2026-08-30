-- Quotes and invoices. Both carry an approval gate (approved_at/approved_by)
-- that server-side middleware enforces before /send is allowed to run --
-- see the approvals table (005) and the approval firewall middleware.

CREATE TABLE IF NOT EXISTS quotes (
  id TEXT PRIMARY KEY,
  job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
  customer_id TEXT REFERENCES customers(id) ON DELETE SET NULL,
  fergus_quote_id TEXT,
  quote_number TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'pending_approval', 'approved', 'sent', 'accepted', 'declined', 'expired')),
  subtotal REAL,
  gst REAL,
  total REAL,
  internal_material_cost REAL,
  internal_labour_cost REAL,
  internal_other_cost REAL,
  internal_total_cost REAL,
  forecast_gross_profit REAL,
  forecast_margin REAL,
  notes TEXT,
  created_by TEXT NOT NULL DEFAULT 'estimator_ai',
  approved_at TEXT,
  approved_by TEXT,
  sent_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_quotes_job ON quotes(job_id);
CREATE INDEX IF NOT EXISTS idx_quotes_customer ON quotes(customer_id);
CREATE INDEX IF NOT EXISTS idx_quotes_status ON quotes(status);

CREATE TABLE IF NOT EXISTS quote_items (
  id TEXT PRIMARY KEY,
  quote_id TEXT NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  quantity REAL NOT NULL DEFAULT 1,
  unit TEXT,
  unit_cost REAL,
  unit_price REAL,
  category TEXT NOT NULL DEFAULT 'other' CHECK (category IN ('materials', 'labour', 'testing', 'other')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_quote_items_quote ON quote_items(quote_id);

CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY,
  job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
  customer_id TEXT REFERENCES customers(id) ON DELETE SET NULL,
  xero_invoice_id TEXT UNIQUE,
  invoice_number TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'pending_approval', 'approved', 'sent', 'paid', 'part_paid', 'overdue', 'void')),
  issue_date TEXT,
  due_date TEXT,
  subtotal REAL,
  gst REAL,
  total REAL,
  amount_paid REAL,
  amount_due REAL,
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('xero', 'manual')),
  approved_at TEXT,
  approved_by TEXT,
  sent_at TEXT,
  last_synced_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_invoices_job ON invoices(job_id);
CREATE INDEX IF NOT EXISTS idx_invoices_customer ON invoices(customer_id);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);

CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  xero_payment_id TEXT UNIQUE,
  amount REAL NOT NULL,
  paid_at TEXT,
  method TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_payments_invoice ON payments(invoice_id);

CREATE TABLE IF NOT EXISTS bank_transactions (
  id TEXT PRIMARY KEY,
  xero_transaction_id TEXT UNIQUE,
  account_name TEXT,
  type TEXT CHECK (type IN ('receive', 'spend')),
  amount REAL,
  description TEXT,
  contact_name TEXT,
  date TEXT,
  reconciled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_bank_transactions_date ON bank_transactions(date);
