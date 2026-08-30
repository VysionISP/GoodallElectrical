import { useEffect, useState } from "react";
import { api } from "../lib/api.js";
import type { IntegrationSummary } from "../lib/types.js";

const FIELD_MAP: Record<string, { key: string; label: string; secret?: boolean }[]> = {
  fergus: [
    { key: "apiKey", label: "API key", secret: true },
    { key: "baseUrl", label: "Base URL (optional)" },
  ],
  xero: [
    { key: "clientId", label: "Client ID" },
    { key: "clientSecret", label: "Client secret", secret: true },
  ],
  openai: [{ key: "apiKey", label: "API key", secret: true }],
  smtp: [
    { key: "host", label: "SMTP host" },
    { key: "user", label: "Username" },
    { key: "pass", label: "Password", secret: true },
  ],
  google_places: [{ key: "apiKey", label: "API key", secret: true }],
};

const PROVIDER_LABEL: Record<string, string> = {
  fergus: "Fergus",
  xero: "Xero",
  openai: "OpenAI",
  smtp: "Email (SMTP)",
  google_places: "Google Places",
};

export default function IntegrationsPage() {
  const [integrations, setIntegrations] = useState<IntegrationSummary[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Record<string, string>>>({});
  const [testResult, setTestResult] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  function load() {
    api.get<{ integrations: IntegrationSummary[] }>("/integrations").then((r) => setIntegrations(r.integrations));
  }
  useEffect(load, []);

  async function save(provider: string) {
    setBusy(provider);
    try {
      await api.put(`/integrations/${provider}`, { credentials: drafts[provider] ?? {} });
      load();
    } finally {
      setBusy(null);
    }
  }

  async function test(provider: string) {
    setBusy(provider);
    try {
      const result = await api.post<{ ok: boolean; detail?: string; message?: string }>(`/integrations/${provider}/test`);
      setTestResult((prev) => ({ ...prev, [provider]: result.detail ?? "OK" }));
    } catch (err: any) {
      setTestResult((prev) => ({ ...prev, [provider]: `Failed: ${err.message}` }));
    } finally {
      setBusy(null);
    }
  }

  async function disconnect(provider: string) {
    setBusy(provider);
    try {
      await api.delete(`/integrations/${provider}`);
      load();
    } finally {
      setBusy(null);
    }
  }

  async function connectXero() {
    const { authorizeUrl } = await api.get<{ authorizeUrl: string }>("/integrations/xero/connect");
    window.open(authorizeUrl, "_blank", "noopener");
  }

  if (!integrations) return <div className="card">Loading…</div>;

  return (
    <div>
      <div className="page-title">Integrations</div>
      <div className="page-sub">
        Credentials are encrypted server-side (AES-256-GCM) and never returned to the browser -- only a masked hint.
      </div>

      <div className="integrations-grid">
        {integrations.map((intg) => (
          <div key={intg.provider} className="card">
            <div className="integration-header">
              <strong>{PROVIDER_LABEL[intg.provider]}</strong>
              <span className={`pill ${statusPill(intg.status)}`}>{intg.status.replace("_", " ")}</span>
            </div>
            {intg.credentialHint && <div className="provenance-tag">{intg.credentialHint}</div>}
            {intg.lastSyncAt && <div className="provenance-tag">Last sync: {new Date(intg.lastSyncAt).toLocaleString()}</div>}
            {intg.lastError && <div className="pill pill-danger" style={{ marginTop: 6 }}>{intg.lastError}</div>}

            <div className="integration-fields">
              {FIELD_MAP[intg.provider].map((f) => (
                <input
                  key={f.key}
                  type={f.secret ? "password" : "text"}
                  placeholder={f.label}
                  value={drafts[intg.provider]?.[f.key] ?? ""}
                  onChange={(e) =>
                    setDrafts((prev) => ({
                      ...prev,
                      [intg.provider]: { ...prev[intg.provider], [f.key]: e.target.value },
                    }))
                  }
                />
              ))}
            </div>

            <div className="integration-actions">
              <button className="btn" disabled={busy === intg.provider} onClick={() => save(intg.provider)}>
                Save
              </button>
              {intg.provider === "xero" && (
                <button className="btn btn-secondary" onClick={connectXero}>
                  Connect via OAuth
                </button>
              )}
              <button className="btn btn-secondary" disabled={!intg.configured || busy === intg.provider} onClick={() => test(intg.provider)}>
                Test connection
              </button>
              <button className="btn btn-danger" disabled={!intg.configured || busy === intg.provider} onClick={() => disconnect(intg.provider)}>
                Disconnect
              </button>
            </div>
            {testResult[intg.provider] && <div className="provenance-tag" style={{ marginTop: 6 }}>{testResult[intg.provider]}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}

function statusPill(status: string) {
  if (status === "connected") return "pill-ok";
  if (status === "error") return "pill-danger";
  return "pill-muted";
}
