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

async function xeroGet(creds: XeroCredentials, path: string): Promise<any> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${creds.accessToken}`,
      "Xero-tenant-id": creds.tenantId ?? "",
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`Xero API ${res.status} on ${path}: ${await res.text()}`);
  return res.json();
}

/** type "ACCREC" = sales invoices (what customers owe us). "ACCPAY" = bills (what we owe suppliers). Xero models both as the same Invoices resource. */
export async function listInvoicesRaw(creds: XeroCredentials, type: "ACCREC" | "ACCPAY" = "ACCREC"): Promise<any[]> {
  const data = await xeroGet(creds, `/Invoices?where=Type=="${type}"`);
  return data.Invoices ?? [];
}

export interface NormalizedBankTransaction {
  xeroTransactionId: string;
  accountName: string | null;
  type: "receive" | "spend" | null;
  amount: number | null;
  description: string | null;
  contactName: string | null;
  date: string | null;
}

export async function listBankTransactionsRaw(creds: XeroCredentials): Promise<any[]> {
  const data = await xeroGet(creds, `/BankTransactions?order=Date DESC`);
  return data.BankTransactions ?? [];
}

export function mapBankTransaction(raw: any): NormalizedBankTransaction {
  return {
    xeroTransactionId: String(raw.BankTransactionID),
    accountName: raw.BankAccount?.Name ?? null,
    type: raw.Type === "RECEIVE" ? "receive" : raw.Type === "SPEND" ? "spend" : null,
    amount: numOrNull(raw.Total),
    description: raw.Reference ?? raw.LineItems?.[0]?.Description ?? null,
    contactName: raw.Contact?.Name ?? null,
    date: raw.DateString ?? raw.Date ?? null,
  };
}

/**
 * Current cash position, read from Xero's BankSummary report (all bank
 * accounts' closing balances). Xero reports share a generic
 * {Reports: [{ Rows: [{ RowType, Cells: [{ Value }] }] }]} shape; this
 * has NOT been verified against a live tenant (same caveat as the rest of
 * this file), so parsing is defensive -- if the expected "Closing Balance"
 * row isn't found in the shape we expect, this returns null rather than
 * guessing a cash figure. A null cash position must be surfaced honestly
 * ("I don't know your current cash position") rather than treated as $0.
 */
export async function getCashPosition(creds: XeroCredentials): Promise<number | null> {
  try {
    const data = await xeroGet(creds, `/Reports/BankSummary`);
    const rows: any[] = data.Reports?.[0]?.Rows ?? [];
    let total = 0;
    let found = false;
    for (const section of rows) {
      for (const row of section.Rows ?? []) {
        const label = row.Cells?.[0]?.Value;
        if (typeof label === "string" && label.toLowerCase().includes("closing balance")) {
          const lastCell = row.Cells?.[row.Cells.length - 1];
          const value = numOrNull(lastCell?.Value);
          if (value !== null) {
            total += value;
            found = true;
          }
        }
      }
    }
    return found ? total : null;
  } catch {
    return null;
  }
}

/** Best-effort mapping -- see file header re: unverified against a live tenant. */
/** Status here is Xero's own raw value (DRAFT/SUBMITTED/AUTHORISED/PAID/VOIDED/DELETED) -- fine as-is for `bills` (no CHECK constraint), but must be translated before writing to `invoices.status`, which has a strict enum. See mapXeroStatusToInvoiceStatus below. */
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

/**
 * Our `invoices.status` column has a strict CHECK constraint
 * (draft/pending_approval/approved/sent/paid/part_paid/overdue/void)
 * built for our own send-approval lifecycle. A Xero-synced invoice is
 * already a real, finalized invoice Xero considers AUTHORISED (it went
 * through Xero's own workflow, not ours), so "pending_approval"/
 * "approved" don't apply to it -- AUTHORISED maps to 'sent' and then
 * 'overdue'/'part_paid' are derived from due date and amounts, the same
 * way section 30 of the brief insists on: derive, don't guess.
 */
export function mapXeroStatusToInvoiceStatus(inv: NormalizedXeroInvoice): string {
  const raw = (inv.status ?? "").toUpperCase();
  if (raw === "PAID") return "paid";
  if (raw === "VOIDED" || raw === "DELETED") return "void";
  if (raw === "DRAFT" || raw === "SUBMITTED") return "draft";

  // AUTHORISED (or an unrecognized value on an invoice that reached us at
  // all, which in practice means it's live) -- derive from amounts/dates.
  const amountDue = inv.amountDue ?? 0;
  const amountPaid = inv.amountPaid ?? 0;
  if (inv.dueDate) {
    const due = new Date(inv.dueDate);
    if (!Number.isNaN(due.getTime()) && due.getTime() < Date.now() && amountDue > 0) return "overdue";
  }
  if (amountPaid > 0 && amountDue > 0) return "part_paid";
  return "sent";
}

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
