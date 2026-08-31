/**
 * Fergus API client.
 *
 * Written against the real Fergus OpenAPI spec (fetched from
 * https://api.fergus.com/docs on 2026-08-30), not guessed. Key facts from
 * that spec that shaped this file:
 *
 * - Base URL is exactly `https://api.fergus.com` -- no `/v1`, no
 *   `/api/partner`. (The original guess appended `/v1/jobs` to whatever
 *   Base URL was configured; if that field ever contains a path prefix,
 *   every request breaks -- leave it blank unless Fergus support says
 *   otherwise.)
 * - Auth is a Bearer token (Personal Access Token) via `Authorization:
 *   Bearer <token>` -- this part of the original guess was correct.
 * - `GET /jobs` returns full Job objects, but a Job does NOT embed
 *   financials or phases. Those are separate calls:
 *     - `GET /jobs/{jobId}/financialSummary` -- quoted/cost/invoiced
 *     - `GET /jobs/{jobId}/phases` -- phases
 *     - `GET /customerInvoices?jobId={jobId}` -- invoices, whose
 *       `totalPaid` fields have to be summed for a "paid" figure; there is
 *       no single "amount paid" field on the job or its financial summary.
 * - A Job has no `title` field. The closest fields are `description`
 *   (short, e.g. "Main Switch Board Replacement") and `longDescription`
 *   (detail) -- mapped here to our `title`/`description` respectively.
 * - The embedded `job.customer` is just `{ id, customerFullName }` -- no
 *   email/phone/address. Those live on `GET /customers/{id}`.
 * - `Company.prefix` (from `GET /company`) combined with a job's `jobNo`
 *   is how a human-facing number like "ELEC-3256" is likely reconstructed
 *   when the job's own `jobNumber` field is null; both `jobNo` and
 *   `jobNumber` exist on Job and are used defensively here.
 * - Rate limit is 100 requests/minute per company; 429 responses carry a
 *   `retry-after` header, honoured below with a single retry.
 *
 * Pagination is cursor-based (`pageCursor` in, `paging.links.next` out as
 * a full URL), not offset-based.
 */

export interface FergusCredentials {
  apiKey: string;
  baseUrl?: string;
}

export interface NormalizedFergusCustomer {
  fergusCustomerId: string;
  name: string;
  email: string | null;
  phone: string | null;
  billingAddress: string | null;
}

export interface NormalizedFergusJob {
  fergusJobId: string;
  jobNumber: string | null;
  title: string | null;
  description: string | null;
  siteAddress: string | null;
  status: string | null;
  customer: NormalizedFergusCustomer | null;
  financials: {
    quotedAmount: number | null;
    actualCost: number | null;
    invoicedAmount: number | null;
    paidAmount: number | null;
  };
  phases: { fergusPhaseId: string; name: string; status: string | null }[];
}

function baseUrl(creds: FergusCredentials): string {
  return creds.baseUrl?.replace(/\/$/, "") || "https://api.fergus.com";
}

const REQUEST_TIMEOUT_MS = 20_000;

async function fergusFetch(creds: FergusCredentials, path: string, retrying = false): Promise<any> {
  const url = `${baseUrl(creds)}${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${creds.apiKey}`,
        Accept: "application/json",
      },
      // Without this, a hung connection to Fergus leaves the whole sync
      // loop frozen on one job forever -- the caller never gets a
      // rejection to catch, so the agent_task's "Reviewing X" message
      // never advances. Every per-job call site already tolerates a
      // thrown error (see fergusSync.ts), so timing out here lets the
      // sync continue past a bad request instead of hanging indefinitely.
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err: any) {
    if (err?.name === "TimeoutError" || err?.name === "AbortError") {
      throw new Error(`Fergus API request to ${path} timed out after ${REQUEST_TIMEOUT_MS / 1000}s`);
    }
    throw err;
  }

  if (res.status === 429 && !retrying) {
    const retryAfterSeconds = Math.min(Number(res.headers.get("retry-after")) || 2, 10);
    await new Promise((resolve) => setTimeout(resolve, retryAfterSeconds * 1000));
    return fergusFetch(creds, path, true);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Fergus API ${res.status} ${res.statusText} on ${path}: ${body.slice(0, 500)}`);
  }
  return res.json();
}

export async function testFergusConnection(creds: FergusCredentials): Promise<{ ok: true; detail?: string }> {
  const data = await fergusFetch(creds, "/company");
  return { ok: true, detail: `Connected to Fergus as ${data.data?.name ?? "unknown company"}.` };
}

export async function getCompanyPrefix(creds: FergusCredentials): Promise<string | null> {
  const data = await fergusFetch(creds, "/company");
  return data.data?.prefix ?? null;
}

/** Follows cursor pagination (paging.links.next) up to a safety cap. */
export async function listJobsRaw(creds: FergusCredentials, maxPages = 20): Promise<any[]> {
  const jobs: any[] = [];
  let path: string | null = "/jobs?pageSize=100";
  let pages = 0;
  while (path && pages < maxPages) {
    const data: any = await fergusFetch(creds, path);
    jobs.push(...(data.data ?? []));
    const next = data.paging?.links?.next ?? null;
    path = next ? next.replace(baseUrl(creds), "") : null;
    pages++;
  }
  return jobs;
}

export async function getJobFinancialSummaryRaw(creds: FergusCredentials, jobId: number | string): Promise<any> {
  const data = await fergusFetch(creds, `/jobs/${jobId}/financialSummary`);
  return data.data ?? null;
}

export async function getJobPhasesRaw(creds: FergusCredentials, jobId: number | string): Promise<any[]> {
  const data = await fergusFetch(creds, `/jobs/${jobId}/phases`);
  return data.data ?? [];
}

/** Sums CustomerInvoice.totalPaid across every invoice for a job -- there is no single "paid" field anywhere else. */
export async function getJobPaidAmount(creds: FergusCredentials, jobId: number | string): Promise<number | null> {
  const data = await fergusFetch(creds, `/customerInvoices?jobId=${jobId}&pageSize=100`);
  const invoices: any[] = data.data ?? [];
  if (invoices.length === 0) return null;
  const total = invoices.reduce((sum, inv) => sum + (Number(inv.totalPaid) || 0), 0);
  return total;
}

export async function getCustomerRaw(creds: FergusCredentials, customerId: number | string): Promise<any> {
  const data = await fergusFetch(creds, `/customers/${customerId}`);
  return data.data ?? null;
}

/**
 * Maps a raw Job (from GET /jobs or GET /jobs/{id}) to our normalized
 * shape, EXCLUDING financials/phases (fetched and merged separately --
 * see fergusSync.ts). Never fabricates a numeric 0 for a missing figure.
 */
export function mapFergusJob(raw: any, companyPrefix: string | null): NormalizedFergusJob {
  const jobNo: string | null = raw.jobNo != null ? String(raw.jobNo) : null;
  const jobNumber = raw.jobNumber ?? (companyPrefix && jobNo ? `${companyPrefix}${jobNo}` : jobNo);

  const site = raw.siteAddress;
  const siteAddress = site
    ? [site.address1, site.address2, site.addressSuburb, site.addressCity, site.addressRegion, site.addressPostcode]
        .filter(Boolean)
        .join(", ") || null
    : null;

  return {
    fergusJobId: String(raw.id),
    jobNumber,
    title: raw.description ?? null,
    description: raw.longDescription ?? null,
    siteAddress,
    status: raw.status ?? null,
    customer: raw.customer
      ? {
          fergusCustomerId: String(raw.customer.id),
          name: raw.customer.customerFullName ?? "Unknown",
          email: null,
          phone: null,
          billingAddress: null,
        }
      : null,
    financials: { quotedAmount: null, actualCost: null, invoicedAmount: null, paidAmount: null },
    phases: [],
  };
}

/** Merges a /financialSummary response into a normalized job's financials, in place. */
export function applyFinancialSummary(job: NormalizedFergusJob, summary: any): void {
  if (!summary) return;
  job.financials.quotedAmount = numOrNull(summary.quoteSummary?.quotedAmount);
  job.financials.actualCost = numOrNull(summary.costsIncurred?.total);
  job.financials.invoicedAmount = numOrNull(summary.totalBilled?.total);
}

export function mapFergusPhase(raw: any): { fergusPhaseId: string; name: string; status: string | null } {
  return {
    fergusPhaseId: String(raw.id),
    name: raw.title ?? "Untitled phase",
    status: raw.status ?? null,
  };
}

/** Enriches a normalized customer with contact/address details from GET /customers/{id}. */
export function applyCustomerDetail(customer: NormalizedFergusCustomer, raw: any): void {
  if (!raw) return;
  const contactItems: { contactType: string; contactValue: string }[] = raw.mainContact?.contactItems ?? [];
  customer.email = contactItems.find((c) => c.contactType === "email")?.contactValue ?? null;
  customer.phone = contactItems.find((c) => c.contactType === "phone" || c.contactType === "mobile")?.contactValue ?? null;
  const addr = raw.physicalAddress;
  customer.billingAddress = addr
    ? [addr.address1, addr.address2, addr.addressSuburb, addr.addressCity, addr.addressRegion, addr.addressPostcode]
        .filter(Boolean)
        .join(", ") || null
    : null;
}

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
