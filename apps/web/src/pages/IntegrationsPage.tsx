import { useEffect, useState } from "react";
import { api } from "../lib/api.js";
import type { IntegrationSummary } from "../lib/types.js";

const FIELD_MAP: Record<string, { key: string; label: string; secret?: boolean; config?: boolean }[]> = {
  fergus: [
    { key: "apiKey", label: "Personal Access Token", secret: true },
    { key: "baseUrl", label: "Base URL (leave blank -- defaults to https://api.fergus.com)" },
  ],
  xero: [
    { key: "clientId", label: "Client ID" },
    { key: "clientSecret", label: "Client secret", secret: true },
  ],
  openai: [{ key: "apiKey", label: "API key", secret: true }],
  openrouter: [
    { key: "apiKey", label: "OpenRouter API key", secret: true },
    {
      key: "model",
      label: "Hermes model slug (e.g. nousresearch/hermes-3-llama-3.1-405b) -- leave blank for the default. See openrouter.ai/models.",
      config: true,
    },
  ],
  smtp: [
    { key: "host", label: "SMTP host" },
    { key: "port", label: "Port (e.g. 587)" },
    { key: "secure", label: "Secure -- type true or false" },
    { key: "user", label: "Username" },
    { key: "pass", label: "Password", secret: true },
    { key: "fromEmail", label: "From email address" },
    { key: "fromName", label: "From name (optional)" },
  ],
  google_places: [{ key: "apiKey", label: "API key", secret: true }],
};

const PROVIDER_LABEL: Record<string, string> = {
  fergus: "Fergus",
  xero: "Xero",
  openai: "OpenAI",
  openrouter: "OpenRouter (Hermes)",
  smtp: "Email (SMTP)",
  google_places: "Google Places",
};

export default function IntegrationsPage() {
  const [integrations, setIntegrations] = useState<IntegrationSummary[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Record<string, string>>>({});
  const [testResult, setTestResult] = useState<Record<string, string>>({});
  const [saveError, setSaveError] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [aiProvider, setAiProvider] = useState<"openai" | "openrouter" | null>(null);
  const [aiProviderBusy, setAiProviderBusy] = useState(false);

  function load() {
    api.get<{ integrations: IntegrationSummary[] }>("/integrations").then((r) => setIntegrations(r.integrations));
    api.get<{ provider: "openai" | "openrouter" }>("/integrations/ai-provider").then((r) => setAiProvider(r.provider));
  }
  useEffect(load, []);

  async function save(provider: string) {
    setBusy(provider);
    setSaveError((prev) => ({ ...prev, [provider]: "" }));
    try {
      const fields = FIELD_MAP[provider] ?? [];
      const values = drafts[provider] ?? {};
      const credentials: Record<string, string> = {};
      const config: Record<string, string> = {};
      for (const f of fields) {
        const v = values[f.key];
        if (v === undefined) continue;
        if (f.config) config[f.key] = v;
        else credentials[f.key] = v;
      }
      await api.put(`/integrations/${provider}`, { credentials, config: Object.keys(config).length ? config : undefined });
      load();
    } catch (err: any) {
      setSaveError((prev) => ({ ...prev, [provider]: err.message ?? "Save failed" }));
    } finally {
      setBusy(null);
    }
  }

  async function switchAiProvider(provider: "openai" | "openrouter") {
    setAiProviderBusy(true);
    try {
      await api.put("/integrations/ai-provider", { provider });
      setAiProvider(provider);
    } catch (err: any) {
      alert(`Couldn't switch AI provider: ${err.message}`);
    } finally {
      setAiProviderBusy(false);
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
    setSaveError((prev) => ({ ...prev, xero: "" }));
    try {
      const { authorizeUrl } = await api.get<{ authorizeUrl: string }>("/integrations/xero/connect");
      window.open(authorizeUrl, "_blank", "noopener");
    } catch (err: any) {
      setSaveError((prev) => ({ ...prev, xero: err.message ?? "Could not start Xero connect" }));
    }
  }

  if (!integrations) return <div className="card">Loading…</div>;

  return (
    <div>
      <div className="page-title">Integrations</div>
      <div className="page-sub">
        Credentials are encrypted server-side (AES-256-GCM) and never returned to the browser -- only a masked hint.
      </div>

      <div className="card" style={{ marginBottom: 20 }}>
        <h3 style={{ marginTop: 0 }}>AI provider</h3>
        <div className="page-sub" style={{ marginTop: -4 }}>
          Every agent (Director, Operations, Estimator, Finance, Debtor, Lead Hunter, Research, Sales) makes its
          calls through whichever provider is active here. Switching doesn't touch the other provider's saved key --
          you can flip back any time.
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
          <button
            className={aiProvider === "openai" ? "btn" : "btn btn-secondary"}
            disabled={aiProviderBusy || aiProvider === "openai"}
            onClick={() => switchAiProvider("openai")}
          >
            OpenAI
          </button>
          <button
            className={aiProvider === "openrouter" ? "btn" : "btn btn-secondary"}
            disabled={aiProviderBusy || aiProvider === "openrouter"}
            onClick={() => switchAiProvider("openrouter")}
          >
            OpenRouter (Hermes)
          </button>
        </div>
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
            {saveError[intg.provider] && <div className="field-error">{saveError[intg.provider]}</div>}
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
