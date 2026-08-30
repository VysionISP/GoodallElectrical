/**
 * Xero OAuth 2.0 + API client.
 *
 * Like fergus.ts, this has not been exercised against a live Xero tenant in
 * this environment (no client ID/secret configured here). The OAuth
 * authorization-code flow itself follows Xero's publicly documented
 * standard (https://developer.xero.com/documentation/guides/oauth2/auth-flow/)
 * so the connect/callback mechanics should be correct, but the Accounting
 * API response field names in `mapXeroInvoice` are best-effort and must be
 * checked against a real response before being trusted for financial
 * decisions -- same rule as Fergus: never assume, inspect the real payload.
 */

export interface XeroCredentials {
  clientId: string;
  clientSecret: string;
  redirectUri?: string;
  // Populated after the OAuth callback exchanges a code for tokens.
  accessToken?: string;
  refreshToken?: string;
  tenantId?: string;
  expiresAt?: number;
}

const AUTHORIZE_URL = "https://login.xero.com/identity/connect/authorize";
const TOKEN_URL = "https://identity.xero.com/connect/token";
const CONNECTIONS_URL = "https://api.xero.com/connections";
const API_BASE = "https://api.xero.com/api.xro/2.0";

const SCOPES = [
  "openid",
  "profile",
  "email",
  "accounting.transactions.read",
  "accounting.contacts.read",
  "accounting.reports.read",
  "offline_access",
].join(" ");

export function buildAuthorizeUrl(creds: XeroCredentials, state: string): string {
  const redirectUri = creds.redirectUri ?? process.env.XERO_REDIRECT_URI;
  if (!redirectUri) throw new Error("Missing Xero redirect URI");
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", creds.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", SCOPES);
  url.searchParams.set("state", state);
  return url.toString();
}

export async function exchangeCodeForTokens(
  creds: XeroCredentials,
  code: string
): Promise<Pick<XeroCredentials, "accessToken" | "refreshToken" | "expiresAt">> {
  const redirectUri = creds.redirectUri ?? process.env.XERO_REDIRECT_URI;
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString("base64")}`,
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri ?? "",
    }),
  });
  if (!res.ok) throw new Error(`Xero token exchange failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { access_token: string; refresh_token: string; expires_in: number };
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
}

export async function fetchTenantId(accessToken: string): Promise<string> {
  const res = await fetch(CONNECTIONS_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Xero connections lookup failed: ${res.status}`);
  const connections = (await res.json()) as { tenantId: string }[];
  if (!connections.length) throw new Error("No Xero organisation is connected to this app yet.");
  return connections[0].tenantId;
}

export async function testXeroConnection(creds: XeroCredentials): Promise<{ ok: true; detail?: string }> {
  if (!creds.accessToken || !creds.tenantId) {
    throw new Error("Xero is not fully connected yet -- complete the OAuth flow first.");
  }
  const res = await fetch(`${API_BASE}/Organisation`, {
    headers: {
      Authorization: `Bearer ${creds.accessToken}`,
      "Xero-tenant-id": creds.tenantId,
      Accept: "application/json",
    },
  });
  if (!res.ok) throw new Error(`Xero API ${res.status}: ${await res.text()}`);
  return { ok: true, detail: "Connected to Xero." };
}

export interface NormalizedXeroInvoice {
  xeroInvoiceId: string;
  invoiceNumber: string | null;
  reference: string | null;
  contactName: string | null;
  issueDate: string | null;
  dueDate: string | null;
  subtotal: number | null;
  gst: number | null;
  total: number | null;
  amountPaid: number | null;
  amountDue: number | null;
  status: string | null;
}

export async function listInvoicesRaw(creds: XeroCredentials): Promise<any[]> {
  const res = await fetch(`${API_BASE}/Invoices?where=Type=="ACCREC"`, {
    headers: {
      Authorization: `Bearer ${creds.accessToken}`,
      "Xero-tenant-id": creds.tenantId ?? "",
      Accept: "application/json",
    },
  });
  if (!res.ok) throw new Error(`Xero API ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { Invoices?: any[] };
  return data.Invoices ?? [];
}

/** Best-effort mapping -- see file header re: unverified against a live tenant. */
export function mapXeroInvoice(raw: any): NormalizedXeroInvoice {
  return {
    xeroInvoiceId: String(raw.InvoiceID),
    invoiceNumber: raw.InvoiceNumber ?? null,
    reference: raw.Reference ?? null,
    contactName: raw.Contact?.Name ?? null,
    issueDate: raw.DateString ?? raw.Date ?? null,
    dueDate: raw.DueDateString ?? raw.DueDate ?? null,
    subtotal: numOrNull(raw.SubTotal),
    gst: numOrNull(raw.TotalTax),
    total: numOrNull(raw.Total),
    amountPaid: numOrNull(raw.AmountPaid),
    amountDue: numOrNull(raw.AmountDue),
    status: raw.Status ?? null,
  };
}

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
