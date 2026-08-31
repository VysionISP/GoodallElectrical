-- Adds 'openrouter' as a valid integrations provider (the route to
-- NousResearch Hermes models, which OpenAI itself doesn't host) and a small
-- general-purpose app_settings table for app-wide toggles like which AI
-- provider currently powers the agents.
--
-- SQLite can't ALTER a CHECK constraint directly, so the provider check is
-- widened by rebuilding the table. Verified before writing this migration
-- that no other table has a foreign key referencing integrations(id) --
-- unlike the documented near-miss with approvals/approval_events, there is
-- no cascade-delete risk here; this is a straight copy-and-swap that
-- preserves every existing row (credentials, hints, config) untouched.
CREATE TABLE integrations_new (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL UNIQUE CHECK (provider IN ('fergus', 'xero', 'openai', 'openrouter', 'smtp', 'google_places')),
  status TEXT NOT NULL DEFAULT 'not_configured' CHECK (status IN ('not_configured', 'connected', 'error')),
  encrypted_credentials TEXT,
  credential_hint TEXT,
  last_sync_at TEXT,
  last_error TEXT,
  config TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT INTO integrations_new (id, provider, status, encrypted_credentials, credential_hint, last_sync_at, last_error, config, created_at, updated_at)
SELECT id, provider, status, encrypted_credentials, credential_hint, last_sync_at, last_error, config, created_at, updated_at
FROM integrations;

DROP TABLE integrations;
ALTER TABLE integrations_new RENAME TO integrations;

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
