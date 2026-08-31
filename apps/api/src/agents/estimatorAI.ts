import { getDb } from "../db/connection.js";
import { getOpenAiClient } from "../integrations/openai.js";

const MODEL = process.env.OPENAI_MODEL ?? "gpt-4o-mini";

/**
 * The facts that actually drive a labour estimate, matching the
 * Operations AI question list from section 7 of the brief. Confidence is
 * simply knownCount/relevantCount -- deliberately not an LLM's own
 * self-rated confidence (which tends to be overconfident), but a
 * mechanical measure of how much of the picture is actually known.
 */
const LABOUR_DRIVING_FACTS = [
  "crew_size",
  "night_work",
  "expected_shifts",
  "shutdown_required",
  "access_confirmed",
  "materials_ordered",
  "inspection_required",
] as const;

export interface LabourForecast {
  jobId: string;
  confidence: number; // 0-100
  known: { key: string; value: string }[];
  missing: string[];
  expectedHoursLow: number | null;
  expectedHoursHigh: number | null;
  reasoning: string | null;
}

const HOURS_SCHEMA = {
  name: "labour_hours_estimate",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      expectedHoursLow: { type: "number" },
      expectedHoursHigh: { type: "number" },
      reasoning: {
        type: "string",
        description: "One sentence on how you got this range, referencing which facts were known vs assumed.",
      },
    },
    required: ["expectedHoursLow", "expectedHoursHigh", "reasoning"],
  },
} as const;

/**
 * Confidence is always computed here (no OpenAI needed for that part --
 * it's a mechanical count). The hour RANGE requires OpenAI; without it,
 * expectedHoursLow/High are null rather than a fabricated number -- a
 * missing estimate must read as missing, not as zero or a guess.
 */
export async function computeLabourForecast(jobId: string): Promise<LabourForecast> {
  const db = getDb();
  const job = db.prepare("SELECT job_number, title, description FROM jobs WHERE id = ?").get(jobId) as
    | { job_number: string | null; title: string | null; description: string | null }
    | undefined;
  if (!job) throw Object.assign(new Error("Job not found"), { code: "NOT_FOUND" });

  const context = db
    .prepare("SELECT key, value, status FROM job_context WHERE job_id = ?")
    .all(jobId) as { key: string; value: string; status: string }[];
  const byKey = new Map(context.map((c) => [c.key, c]));

  const known: { key: string; value: string }[] = [];
  const missing: string[] = [];
  for (const factKey of LABOUR_DRIVING_FACTS) {
    const row = byKey.get(factKey);
    if (row && (row.status === "known" || row.status === "inferred")) {
      known.push({ key: factKey, value: row.value });
    } else {
      missing.push(factKey);
    }
  }

  const confidence = Math.round((known.length / LABOUR_DRIVING_FACTS.length) * 100);

  const client = getOpenAiClient();
  if (!client) {
    return { jobId, confidence, known, missing, expectedHoursLow: null, expectedHoursHigh: null, reasoning: null };
  }

  const completion = await client.chat.completions.create({
    model: MODEL,
    response_format: { type: "json_schema", json_schema: HOURS_SCHEMA },
    messages: [
      {
        role: "system",
        content:
          "You are Estimator AI for an electrical contracting company. Estimate a labour hours range for this " +
          "job using ONLY the known facts given -- for anything missing, widen the range to reflect the " +
          "uncertainty rather than assuming a typical value. Never present a narrow, confident range when key " +
          "facts (crew size, shifts, etc) are unknown.",
      },
      {
        role: "user",
        content: JSON.stringify({
          jobNumber: job.job_number,
          title: job.title,
          description: job.description,
          knownFacts: Object.fromEntries(known.map((k) => [k.key, k.value])),
          missingFacts: missing,
        }),
      },
    ],
  });

  const parsed = JSON.parse(completion.choices[0]?.message?.content ?? "{}") as {
    expectedHoursLow: number;
    expectedHoursHigh: number;
    reasoning: string;
  };

  return {
    jobId,
    confidence,
    known,
    missing,
    expectedHoursLow: parsed.expectedHoursLow,
    expectedHoursHigh: parsed.expectedHoursHigh,
    reasoning: parsed.reasoning,
  };
}
