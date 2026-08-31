/**
 * Google Places API (New) client -- Text Search.
 *
 * Same caveat as fergus.ts and xero.ts: this environment's network egress
 * policy blocked fetching Google's live API docs
 * (developers.google.com/maps/documentation/places/web-service/text-search),
 * so this is written from well-established, stable knowledge of the New
 * Places API rather than a freshly inspected payload. Before trusting a
 * real search: run one, log the raw response, and confirm `mapPlace`
 * matches what actually comes back.
 *
 * Also worth knowing before testing: unlike Fergus, Google Places is a
 * metered, billed API -- every search here costs real money against
 * whatever Google Cloud project the key belongs to. Keep result counts
 * small while testing.
 *
 * Auth: `X-Goog-Api-Key` header. The New API also requires an explicit
 * `X-Goog-FieldMask` header naming exactly which response fields you want
 * (there is no "give me everything" default -- omitting it, or naming a
 * field that doesn't exist, is a 400).
 */

export interface GooglePlacesCredentials {
  apiKey: string;
}

export interface NormalizedPlace {
  placeId: string;
  name: string;
  address: string | null;
  phone: string | null;
  website: string | null;
  types: string[];
  rating: number | null;
  userRatingCount: number | null;
}

const SEARCH_URL = "https://places.googleapis.com/v1/places:searchText";
const FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.nationalPhoneNumber",
  "places.websiteUri",
  "places.types",
  "places.rating",
  "places.userRatingCount",
].join(",");

const REQUEST_TIMEOUT_MS = 15_000;

export async function testGooglePlacesConnection(
  creds: GooglePlacesCredentials
): Promise<{ ok: true; detail?: string }> {
  // A minimal, cheap search just to confirm the key is valid and billing
  // is enabled -- this still counts as one billed request.
  const results = await searchTextRaw(creds, "hardware store", 1);
  return { ok: true, detail: `Connected. Test search returned ${results.length} result(s).` };
}

export async function searchTextRaw(
  creds: GooglePlacesCredentials,
  textQuery: string,
  maxResultCount = 20
): Promise<any[]> {
  let res: Response;
  try {
    res = await fetch(SEARCH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": creds.apiKey,
        "X-Goog-FieldMask": FIELD_MASK,
      },
      body: JSON.stringify({ textQuery, maxResultCount: Math.min(maxResultCount, 20) }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err: any) {
    if (err?.name === "TimeoutError" || err?.name === "AbortError") {
      throw new Error(`Google Places request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`);
    }
    throw err;
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Google Places API ${res.status} ${res.statusText}: ${body.slice(0, 500)}`);
  }
  const data = (await res.json()) as { places?: any[] };
  return data.places ?? [];
}

export function mapPlace(raw: any): NormalizedPlace {
  return {
    placeId: String(raw.id),
    name: raw.displayName?.text ?? "Unknown business",
    address: raw.formattedAddress ?? null,
    phone: raw.nationalPhoneNumber ?? null,
    website: raw.websiteUri ?? null,
    types: Array.isArray(raw.types) ? raw.types : [],
    rating: typeof raw.rating === "number" ? raw.rating : null,
    userRatingCount: typeof raw.userRatingCount === "number" ? raw.userRatingCount : null,
  };
}
