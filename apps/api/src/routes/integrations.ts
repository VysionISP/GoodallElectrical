import { Router } from "express";
import { z } from "zod";
import {
  listIntegrations,
  setIntegrationCredentials,
  disconnectIntegration,
  getIntegrationCredentials,
  recordIntegrationSuccess,
  recordIntegrationError,
  type Provider,
} from "../integrations/store.js";
import { recordAudit } from "../lib/audit.js";
import { testFergusConnection } from "../integrations/fergus.js";
import { testXeroConnection, buildAuthorizeUrl, exchangeCodeForTokens, fetchTenantId } from "../integrations/xero.js";
import { testOpenAiConnection } from "../integrations/openai.js";
import { testOpenRouterConnection } from "../integrations/openrouter.js";
import { testGooglePlacesConnection } from "../integrations/googlePlaces.js";
import { testSmtpConnection } from "../integrations/smtp.js";
import { runFergusSync } from "../integrations/fergusSync.js";
import { runXeroSync } from "../integrations/xeroSync.js";
import { getActiveAiProvider, setActiveAiProvider } from "../integrations/llm.js";
import { randomUUID } from "node:crypto";

const router = Router();

const PROVIDERS: Provider[] = ["fergus", "xero", "openai", "openrouter", "smtp", "google_places"];

const providerParam = z.enum(["fergus", "xero", "openai", "openrouter", "smtp", "google_places"]);

router.get("/", (_req, res) => {
  res.json({ integrations: listIntegrations() });
});

/**
 * Which configured provider (openai vs openrouter/Hermes) actually powers
 * every agent's OpenAI-compatible calls right now. Registered before the
 * generic "/:provider" routes below -- Express matches routes in
 * registration order, and "/:provider" would otherwise swallow "/ai-provider"
 * as if "ai-provider" were itself a provider name and reject it with
 * UNKNOWN_PROVIDER (caught live while smoke-testing this route).
 */
router.get("/ai-provider", (_req, res) => {
  res.json({ provider: getActiveAiProvider() });
});

const aiProviderSchema = z.object({ provider: z.enum(["openai", "openrouter"]) });

router.put("/ai-provider", (req, res) => {
  const parsed = aiProviderSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "INVALID_BODY", details: parsed.error.flatten() });

  // Switching to a provider with no API key silently switches off every
  // agent in the app -- the Director, job review, estimating, leads, the
  // lot -- while a working key for the other provider sits right there
  // unused. Refuse the switch and say so, rather than letting one click
  // take the whole system dark.
  const target = parsed.data.provider;
  const creds = getIntegrationCredentials<{ apiKey: string }>(target);
  if (!creds?.apiKey) {
    const label = target === "openai" ? "OpenAI" : "OpenRouter";
    return res.status(400).json({
      error: "PROVIDER_NOT_CONFIGURED",
      message: `Can't switch to ${label} -- no ${label} API key is saved yet. Save the key on the ${label} card first, then switch. (Nothing has changed; your current provider is still active.)`,
    });
  }

  setActiveAiProvider(target);
  recordAudit({ actor: "owner", action: "ai_provider_changed", details: { provider: parsed.data.provider } });
  res.json({ ok: true, provider: parsed.data.provider });
});

const credentialsSchema = z.object({
  credentials: z.record(z.string(), z.string()),
  config: z.record(z.string(), z.unknown()).optional(),
});

router.put("/:provider", (req, res) => {
  const parseProvider = providerParam.safeParse(req.params.provider);
  if (!parseProvider.success) {
    return res.status(400).json({ error: "UNKNOWN_PROVIDER" });
  }
  const parsed = credentialsSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "INVALID_BODY", details: parsed.error.flatten() });
  }
  try {
    setIntegrationCredentials(parseProvider.data, parsed.data.credentials, parsed.data.config);
    recordAudit({
      actor: "owner",
      action: "integration_credentials_set",
      entityType: "integration",
      entityId: parseProvider.data,
    });
    res.json({ ok: true, integrations: listIntegrations() });
  } catch (err: any) {
    res.status(500).json({ error: "ENCRYPTION_FAILED", message: err.message });
  }
});

router.delete("/:provider", (req, res) => {
  const parseProvider = providerParam.safeParse(req.params.provider);
  if (!parseProvider.success) {
    return res.status(400).json({ error: "UNKNOWN_PROVIDER" });
  }
  disconnectIntegration(parseProvider.data);
  recordAudit({
    actor: "owner",
    action: "integration_disconnected",
    entityType: "integration",
    entityId: parseProvider.data,
  });
  res.json({ ok: true, integrations: listIntegrations() });
});

router.post("/:provider/test", async (req, res) => {
  const parseProvider = providerParam.safeParse(req.params.provider);
  if (!parseProvider.success) {
    return res.status(400).json({ error: "UNKNOWN_PROVIDER" });
  }
  const provider = parseProvider.data;
  const credentials = getIntegrationCredentials(provider);
  if (!credentials) {
    return res.status(400).json({ ok: false, error: "NOT_CONFIGURED" });
  }
  try {
    let result: { ok: true; detail?: string };
    if (provider === "fergus") result = await testFergusConnection(credentials as any);
    else if (provider === "xero") result = await testXeroConnection(credentials as any);
    else if (provider === "openai") result = await testOpenAiConnection(credentials as any);
    else if (provider === "openrouter") result = await testOpenRouterConnection(credentials as any);
    else if (provider === "google_places") result = await testGooglePlacesConnection(credentials as any);
    else if (provider === "smtp") result = await testSmtpConnection(credentials as any);
    else result = { ok: true, detail: "No live test available for this provider yet." };
    recordIntegrationSuccess(provider);
    res.json(result);
  } catch (err: any) {
    recordIntegrationError(provider, err.message ?? String(err));
    res.status(502).json({ ok: false, error: "CONNECTION_FAILED", message: err.message ?? String(err) });
  }
});

router.post("/fergus/sync", async (_req, res) => {
  try {
    const result = await runFergusSync();
    res.json({ ok: true, ...result });
  } catch (err: any) {
    const status = err?.code === "NOT_CONFIGURED" ? 400 : 502;
    res.status(status).json({ ok: false, error: err?.code ?? "SYNC_FAILED", message: err?.message ?? String(err) });
  }
});

router.post("/xero/sync", async (_req, res) => {
  try {
    const result = await runXeroSync();
    res.json({ ok: true, ...result });
  } catch (err: any) {
    const status = err?.code === "NOT_CONFIGURED" ? 400 : 502;
    res.status(status).json({ ok: false, error: err?.code ?? "SYNC_FAILED", message: err?.message ?? String(err) });
  }
});

const oauthStates = new Set<string>();

router.get("/xero/connect", (_req, res) => {
  const credentials = getIntegrationCredentials("xero") as any;
  if (!credentials?.clientId || !credentials?.clientSecret) {
    return res.status(400).json({ error: "NOT_CONFIGURED", message: "Set the Xero client ID/secret first." });
  }
  const state = randomUUID();
  oauthStates.add(state);
  const url = buildAuthorizeUrl(credentials, state);
  res.json({ authorizeUrl: url });
});

router.get("/xero/callback", async (req, res) => {
  const { code, state } = req.query;
  if (typeof code !== "string" || typeof state !== "string" || !oauthStates.has(state)) {
    return res.status(400).send("Invalid or expired Xero OAuth state.");
  }
  oauthStates.delete(state);
  try {
    const credentials = getIntegrationCredentials("xero") as any;
    if (!credentials) throw new Error("Xero credentials disappeared mid-flow.");
    const tokens = await exchangeCodeForTokens(credentials, code);
    const tenantId = await fetchTenantId(tokens.accessToken!);
    setIntegrationCredentials("xero", { ...credentials, ...tokens, tenantId } as any);
    recordAudit({ actor: "owner", action: "xero_connected", entityType: "integration", entityId: "xero" });
    res.send("Xero connected. You can close this tab and return to the app.");
  } catch (err: any) {
    res.status(502).send(`Xero connection failed: ${err.message ?? err}`);
  }
});

export default router;
export { PROVIDERS };
