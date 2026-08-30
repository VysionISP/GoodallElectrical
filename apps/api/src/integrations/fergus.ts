/**
 * Fergus API client.
 *
 * IMPORTANT -- read before wiring this up against a real Fergus account:
 * This session has no Fergus credentials or account access, so the request
 * shapes below (base URL, endpoint paths, auth header, response field
 * names) are best-effort scaffolding, NOT verified against a real payload.
 * Per the product brief's non-negotiable rule #4 ("never assume API
 * response structures, inspect them"), the first thing to do with real
 * credentials is: call GET /jobs (or whatever `listJobs` below actually
 * hits), log the raw JSON for one real job (e.g. ELEC-3256), and correct
 * `mapFergusJob` / the endpoint paths to match what actually comes back.
 * Nothing here should be trusted as ground truth until that happens.
 *
 * The rest of the app depends only on the normalized `NormalizedJob` shape
 * returned by `mapFergusJob`, not on Fergus's raw response shape, so fixing
 * this file is the only place that needs to change once real payloads are
 * inspected.
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
  return creds.baseUrl?.replace(/\/$/, "") ?? "https://api.fergus.com";
}

async function fergusFetch(creds: FergusCredentials, path: string): Promise<any> {
  const url = `${baseUrl(creds)}${path}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${creds.apiKey}`,
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Fergus API ${res.status} ${res.statusText} on ${path}: ${body.slice(0, 500)}`);
  }
  return res.json();
}

export async function testFergusConnection(creds: FergusCredentials): Promise<{ ok: true; detail?: string }> {
  await fergusFetch(creds, "/v1/jobs?limit=1");
  return { ok: true, detail: "Connected to Fergus." };
}

/** Fetches the raw job list. Shape is UNVERIFIED -- see file header. */
export async function listJobsRaw(creds: FergusCredentials): Promise<any[]> {
  const data = await fergusFetch(creds, "/v1/jobs?limit=200");
  return Array.isArray(data) ? data : (data.jobs ?? data.data ?? []);
}

/** Fetches one job's detail including financials/phases. Shape is UNVERIFIED -- see file header. */
export async function getJobDetailRaw(creds: FergusCredentials, fergusJobId: string): Promise<any> {
  return fergusFetch(creds, `/v1/jobs/${encodeURIComponent(fergusJobId)}`);
}

/**
 * Best-effort mapping from a raw Fergus job payload to our normalized
 * shape. Every field is read defensively (multiple possible key names,
 * falling back to null rather than guessing a value) so that once the real
 * schema is confirmed, this function can be tightened rather than rewritten.
 * NEVER fabricate a numeric 0 for a missing financial figure -- null means
 * "not available" and must render as such in the UI, not as $0.
 */
export function mapFergusJob(raw: any): NormalizedFergusJob {
  const customerRaw = raw.customer ?? raw.client ?? null;
  const financialsRaw = raw.financial_summary ?? raw.financials ?? {};

  return {
    fergusJobId: String(raw.id ?? raw.job_id ?? raw.uuid),
    jobNumber: raw.job_number ?? raw.number ?? raw.reference ?? null,
    title: raw.title ?? raw.name ?? null,
    description: raw.description ?? null,
    siteAddress: raw.site_address ?? raw.address ?? raw.location?.address ?? null,
    status: raw.status ?? raw.job_status ?? null,
    customer: customerRaw
      ? {
          fergusCustomerId: String(customerRaw.id ?? customerRaw.customer_id),
          name: customerRaw.name ?? customerRaw.company_name ?? "Unknown",
          email: customerRaw.email ?? null,
          phone: customerRaw.phone ?? null,
          billingAddress: customerRaw.billing_address ?? customerRaw.address ?? null,
        }
      : null,
    financials: {
      quotedAmount: numOrNull(financialsRaw.quoted ?? financialsRaw.quoted_amount),
      actualCost: numOrNull(financialsRaw.actual_cost ?? financialsRaw.cost),
      invoicedAmount: numOrNull(financialsRaw.invoiced ?? financialsRaw.invoiced_amount),
      paidAmount: numOrNull(financialsRaw.paid ?? financialsRaw.paid_amount),
    },
    phases: Array.isArray(raw.phases)
      ? raw.phases.map((p: any) => ({
          fergusPhaseId: String(p.id ?? p.phase_id),
          name: p.name ?? "Untitled phase",
          status: p.status ?? null,
        }))
      : [],
  };
}

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
