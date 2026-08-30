-- Lead generation, sales outreach and HR/labour costing tables.

CREATE TABLE IF NOT EXISTS leads (
  id TEXT PRIMARY KEY,
  business_name TEXT NOT NULL,
  industry TEXT,
  location TEXT,
  website TEXT,
  contact_name TEXT,
  contact_email TEXT,
  contact_phone TEXT,
  estimated_opportunity REAL,
  reason TEXT,
  lead_score INTEGER,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'researching', 'qualified', 'contacted', 'responded', 'unqualified', 'converted')),
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('google_places', 'directory', 'referral', 'manual')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);

CREATE TABLE IF NOT EXISTS lead_research (
  id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  summary TEXT,
  notes TEXT,
  researched_by TEXT NOT NULL DEFAULT 'research_ai',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_lead_research_lead ON lead_research(lead_id);

CREATE TABLE IF NOT EXISTS sales_outreach (
  id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  channel TEXT NOT NULL DEFAULT 'email' CHECK (channel IN ('email', 'phone', 'other')),
  draft_subject TEXT,
  draft_body TEXT,
  status TEXT NOT NULL DEFAULT 'drafted' CHECK (status IN ('drafted', 'pending_approval', 'approved', 'sent', 'replied', 'declined')),
  approved_at TEXT,
  approved_by TEXT,
  sent_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_sales_outreach_lead ON sales_outreach(lead_id);
CREATE INDEX IF NOT EXISTS idx_sales_outreach_status ON sales_outreach(status);

CREATE TABLE IF NOT EXISTS employees (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT,
  hourly_rate REAL,
  loaded_hourly_cost REAL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS labour_costs (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  employee_id TEXT REFERENCES employees(id) ON DELETE SET NULL,
  hours REAL,
  rate REAL,
  cost REAL,
  date TEXT,
  source TEXT NOT NULL DEFAULT 'estimate' CHECK (source IN ('fergus', 'manual', 'estimate')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_labour_costs_job ON labour_costs(job_id);
