const MAX_LEN = 300;

/**
 * Makes a stored agent error readable, whatever shape it is in.
 *
 * Errors are written to the database by whatever code was running at the
 * time, so historical rows keep their original format forever -- including
 * ones written before the writer learned to collapse repeats. A provider
 * payload repeated six times is unreadable, and it stays on screen until
 * that agent happens to run again, which may be never if the thing that
 * failed is the reason it can't run. Cleaning up at display time means no
 * row can flood the page, past or future.
 */
export function formatAgentError(raw: string | null | undefined): string {
  if (!raw) return "No reason was recorded.";

  const flat = raw.replace(/\s+/g, " ").trim();

  // Pull the meaningful pair out of a provider's JSON error payload. Google
  // in particular nests and repeats its own message several times over.
  const status = flat.match(/"status"\s*:\s*"([^"]+)"/)?.[1];
  const message = flat.match(/"message"\s*:\s*"([^"]{4,})"/)?.[1];
  if (status || message) {
    const httpCode = flat.match(/\b(\d{3})\b/)?.[1];
    const parts = [httpCode ? `HTTP ${httpCode}` : null, status, message].filter(Boolean);
    const summary = parts.join(" · ");
    return summary.length > MAX_LEN ? `${summary.slice(0, MAX_LEN)}…` : summary;
  }

  // Not a recognised payload: collapse literal repetition, then cap it. The
  // same sentence repeated N times carries no more information than once.
  const sentences = flat.split(/(?:\s*\|\s*|;\s+)/).map((s) => s.trim()).filter(Boolean);
  const unique: string[] = [];
  for (const s of sentences) if (!unique.includes(s)) unique.push(s);
  const joined = unique.join(" | ");
  return joined.length > MAX_LEN ? `${joined.slice(0, MAX_LEN)}…` : joined;
}
