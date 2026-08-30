-- Customers, contacts, jobs, job phases, job context and job financials.
-- job_context stores individual structured facts with a KNOWN/INFERRED/
-- UNKNOWN/NEEDS_OWNER_INPUT status per section 7-8 of the product brief.
-- job_financials stores a per-field provenance map (JSON) so the UI can
-- distinguish LIVE FROM FERGUS / LIVE FROM XERO / OWNER PROVIDED / AI
-- INFERRED per section 30 -- never fabricate a $0 for a missing value.

CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY,
  fergus_customer_id TEXT UNIQUE,
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  billing_address TEXT,
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('fergus', 'xero', 'manual')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  fergus_contact_id TEXT,
  name TEXT,
  email TEXT,
  phone TEXT,
  role TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_contacts_customer ON contacts(customer_id);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  fergus_job_id TEXT UNIQUE,
  job_number TEXT,
  title TEXT,
  description TEXT,
  customer_id TEXT REFERENCES customers(id) ON DELETE SET NULL,
  site_address TEXT,
  status TEXT,
  fergus_status_raw TEXT,
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('fergus', 'manual')),
  last_synced_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_jobs_customer ON jobs(customer_id);
CREATE INDEX IF NOT EXISTS idx_jobs_job_number ON jobs(job_number);

CREATE TABLE IF NOT EXISTS job_phases (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  fergus_phase_id TEXT,
  name TEXT,
  status TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_job_phases_job ON job_phases(job_id);

-- One row per structured fact the AI holds about a job (night_work,
-- crew_size, shutdown_required, shutdown_time, materials_ordered, ...).
CREATE TABLE IF NOT EXISTS job_context (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT,
  status TEXT NOT NULL DEFAULT 'unknown' CHECK (status IN ('known', 'inferred', 'unknown', 'needs_owner_input')),
  confidence REAL,
  provenance TEXT NOT NULL DEFAULT 'ai_inferred' CHECK (provenance IN ('fergus', 'xero', 'owner_provided', 'ai_inferred')),
  source_message_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (job_id, key)
);
CREATE INDEX IF NOT EXISTS idx_job_context_job ON job_context(job_id);
CREATE INDEX IF NOT EXISTS idx_job_context_status ON job_context(status);

CREATE TABLE IF NOT EXISTS job_financials (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id) ON DELETE CASCADE,
  quoted_amount REAL,
  actual_cost REAL,
  invoiced_amount REAL,
  paid_amount REAL,
  outstanding_amount REAL,
  forecast_gross_profit REAL,
  forecast_margin REAL,
  -- JSON object mapping each field above to its provenance
  -- ('fergus' | 'xero' | 'owner_provided' | 'ai_inferred').
  provenance TEXT NOT NULL DEFAULT '{}',
  last_synced_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
