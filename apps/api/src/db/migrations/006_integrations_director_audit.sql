-- Integration credential storage (section 22-23), the global Director chat
-- log (section 5) and the audit log (section 24). Credentials are stored
-- as an AES-256-GCM ciphertext blob (see src/lib/crypto.ts); the raw
-- secret is never written to this table and never returned to the browser
-- -- only credential_hint (a masked display value) is exposed via the API.

CREATE TABLE IF NOT EXISTS integrations (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL UNIQUE CHECK (provider IN ('fergus', 'xero', 'openai', 'smtp', 'google_places')),
  status TEXT NOT NULL DEFAULT 'not_configured' CHECK (status IN ('not_configured', 'connected', 'error')),
  encrypted_credentials TEXT,
  credential_hint TEXT,
  last_sync_at TEXT,
  last_error TEXT,
  config TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS integration_syncs (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'success', 'failed')),
  records_synced INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  finished_at TEXT,
  agent_task_id TEXT REFERENCES agent_tasks(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_integration_syncs_provider ON integration_syncs(provider);

CREATE TABLE IF NOT EXISTS director_messages (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('owner', 'director')),
  content TEXT NOT NULL,
  extracted_data TEXT,
  job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_director_messages_created ON director_messages(created_at);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  details TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_log_entity ON audit_log(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at);
