import { getDb } from "../db/connection.js";
import { newId, nowIso } from "../lib/ids.js";
import { encryptJson, decryptJson, maskCredentials } from "../lib/crypto.js";

export type Provider = "fergus" | "xero" | "openai" | "openrouter" | "smtp" | "google_places";

export interface IntegrationRow {
  id: string;
  provider: Provider;
  status: "not_configured" | "connected" | "error";
  encrypted_credentials: string | null;
  credential_hint: string | null;
  last_sync_at: string | null;
  last_error: string | null;
  config: string | null;
  created_at: string;
  updated_at: string;
}

/** Public shape returned to the browser -- never includes decrypted credentials. */
export interface IntegrationSummary {
  provider: Provider;
  status: IntegrationRow["status"];
  credentialHint: string | null;
  lastSyncAt: string | null;
  lastError: string | null;
  config: Record<string, unknown> | null;
  configured: boolean;
}

function toSummary(row: IntegrationRow): IntegrationSummary {
  return {
    provider: row.provider,
    status: row.status,
    credentialHint: row.credential_hint,
    lastSyncAt: row.last_sync_at,
    lastError: row.last_error,
    config: row.config ? JSON.parse(row.config) : null,
    configured: row.encrypted_credentials !== null,
  };
}

export function listIntegrations(): IntegrationSummary[] {
  const db = getDb();
  const providers: Provider[] = ["fergus", "xero", "openai", "openrouter", "smtp", "google_places"];
  const existing = db.prepare("SELECT * FROM integrations").all() as IntegrationRow[];
  const byProvider = new Map(existing.map((r) => [r.provider, r]));
  return providers.map((p) => {
    const row = byProvider.get(p);
    if (row) return toSummary(row);
    return {
      provider: p,
      status: "not_configured",
      credentialHint: null,
      lastSyncAt: null,
      lastError: null,
      config: null,
      configured: false,
    };
  });
}

export function getIntegrationCredentials<T = Record<string, string>>(provider: Provider): T | null {
  const db = getDb();
  const row = db.prepare("SELECT * FROM integrations WHERE provider = ?").get(provider) as
    | IntegrationRow
    | undefined;
  if (!row?.encrypted_credentials) {
    // Dev fallback: allow env vars so the app is usable before the
    // Integrations UI has been used. Production should rely on the
    // encrypted store exclusively.
    return envFallback<T>(provider);
  }
  return decryptJson<T>(row.encrypted_credentials);
}

function envFallback<T>(provider: Provider): T | null {
  switch (provider) {
    case "openai":
      return process.env.OPENAI_API_KEY ? ({ apiKey: process.env.OPENAI_API_KEY } as unknown as T) : null;
    case "openrouter":
      return process.env.OPENROUTER_API_KEY ? ({ apiKey: process.env.OPENROUTER_API_KEY } as unknown as T) : null;
    case "fergus":
      return process.env.FERGUS_API_KEY
        ? ({
            apiKey: process.env.FERGUS_API_KEY,
            baseUrl: process.env.FERGUS_API_BASE_URL ?? "https://api.fergus.com",
          } as unknown as T)
        : null;
    case "xero":
      return process.env.XERO_CLIENT_ID && process.env.XERO_CLIENT_SECRET
        ? ({
            clientId: process.env.XERO_CLIENT_ID,
            clientSecret: process.env.XERO_CLIENT_SECRET,
          } as unknown as T)
        : null;
    default:
      return null;
  }
}

export function setIntegrationCredentials(
  provider: Provider,
  credentials: Record<string, string>,
  config?: Record<string, unknown>
): void {
  const db = getDb();
  const existing = db.prepare("SELECT id FROM integrations WHERE provider = ?").get(provider) as
    | { id: string }
    | undefined;
  const encrypted = encryptJson(credentials);
  const hint = maskCredentials(credentials);
  const now = nowIso();
  if (existing) {
    db.prepare(
      `UPDATE integrations SET status = 'connected', encrypted_credentials = ?, credential_hint = ?, config = ?, last_error = NULL, updated_at = ? WHERE id = ?`
    ).run(encrypted, hint, config ? JSON.stringify(config) : null, now, existing.id);
  } else {
    db.prepare(
      `INSERT INTO integrations (id, provider, status, encrypted_credentials, credential_hint, config, created_at, updated_at)
       VALUES (?, ?, 'connected', ?, ?, ?, ?, ?)`
    ).run(newId("intg"), provider, encrypted, hint, config ? JSON.stringify(config) : null, now, now);
  }
}

/** Merges `patch` into a provider's non-secret config JSON -- e.g. caching the last-synced cash position alongside its timestamp. */
export function setIntegrationConfig(provider: Provider, patch: Record<string, unknown>): void {
  const db = getDb();
  const existing = db.prepare("SELECT id, config FROM integrations WHERE provider = ?").get(provider) as
    | { id: string; config: string | null }
    | undefined;
  const now = nowIso();
  if (existing) {
    const merged = { ...(existing.config ? JSON.parse(existing.config) : {}), ...patch };
    db.prepare(`UPDATE integrations SET config = ?, updated_at = ? WHERE id = ?`).run(JSON.stringify(merged), now, existing.id);
  } else {
    db.prepare(
      `INSERT INTO integrations (id, provider, status, config, created_at, updated_at) VALUES (?, ?, 'not_configured', ?, ?, ?)`
    ).run(newId("intg"), provider, JSON.stringify(patch), now, now);
  }
}

export function getIntegrationConfig(provider: Provider): Record<string, unknown> | null {
  const db = getDb();
  const row = db.prepare("SELECT config FROM integrations WHERE provider = ?").get(provider) as
    | { config: string | null }
    | undefined;
  return row?.config ? JSON.parse(row.config) : null;
}

export function disconnectIntegration(provider: Provider): void {
  const db = getDb();
  db.prepare(
    `UPDATE integrations SET status = 'not_configured', encrypted_credentials = NULL, credential_hint = NULL, last_error = NULL, updated_at = ? WHERE provider = ?`
  ).run(nowIso(), provider);
}

export function recordIntegrationError(provider: Provider, error: string): void {
  const db = getDb();
  const existing = db.prepare("SELECT id FROM integrations WHERE provider = ?").get(provider) as
    | { id: string }
    | undefined;
  const now = nowIso();
  if (existing) {
    db.prepare(`UPDATE integrations SET status = 'error', last_error = ?, updated_at = ? WHERE id = ?`).run(
      error,
      now,
      existing.id
    );
  } else {
    db.prepare(
      `INSERT INTO integrations (id, provider, status, last_error, created_at, updated_at) VALUES (?, ?, 'error', ?, ?, ?)`
    ).run(newId("intg"), provider, error, now, now);
  }
}

export function recordIntegrationSuccess(provider: Provider): void {
  const db = getDb();
  const existing = db.prepare("SELECT id FROM integrations WHERE provider = ?").get(provider) as
    | { id: string }
    | undefined;
  const now = nowIso();
  if (existing) {
    db.prepare(
      `UPDATE integrations SET status = 'connected', last_sync_at = ?, last_error = NULL, updated_at = ? WHERE id = ?`
    ).run(now, now, existing.id);
  }
}
