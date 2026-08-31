-- Proposed changes to the LIVE Fergus account, held until the owner
-- approves them.
--
-- Fergus writes are not like the rest of this app: marking the wrong job
-- complete, or invoicing the wrong customer, changes the real business and
-- cannot be undone from here. So a write is never performed at the moment
-- an agent decides to; it is recorded as a request, gated by the same
-- approval firewall as sending a quote, and only executed once the owner
-- says yes.
--
-- method/path/body are stored on the row rather than being implied by the
-- action name. That keeps exactly what will be sent visible for review
-- before it happens, and recorded afterwards for audit.
CREATE TABLE IF NOT EXISTS fergus_write_requests (
  id TEXT PRIMARY KEY,
  -- Human-readable summary, e.g. "Mark ELEC-3341 complete".
  summary TEXT NOT NULL,
  action TEXT NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('POST', 'PATCH', 'PUT', 'DELETE')),
  path TEXT NOT NULL,
  body TEXT,
  job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
  requested_by TEXT NOT NULL DEFAULT 'director',
  status TEXT NOT NULL DEFAULT 'pending_approval'
    CHECK (status IN ('pending_approval', 'approved', 'rejected', 'executed', 'failed')),
  response TEXT,
  error TEXT,
  executed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_fergus_write_requests_status ON fergus_write_requests(status);
CREATE INDEX IF NOT EXISTS idx_fergus_write_requests_job ON fergus_write_requests(job_id);
