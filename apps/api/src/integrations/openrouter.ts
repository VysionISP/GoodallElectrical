import OpenAI from "openai";

export interface OpenRouterCredentials {
  apiKey: string;
}

export function openRouterClient(creds: OpenRouterCredentials): OpenAI {
  return new OpenAI({ apiKey: creds.apiKey, baseURL: "https://openrouter.ai/api/v1" });
}

/**
 * Tests the key AND answers the question that actually blocks people:
 * which Hermes model slug do I put in the model field?
 *
 * The exact slugs change over time and can't be hardcoded reliably, so
 * rather than making the owner guess (a wrong slug means every AI call
 * 404s with no obvious cause), this asks OpenRouter what this key can
 * actually see and names the Hermes/NousResearch models back.
 */
export async function testOpenRouterConnection(creds: OpenRouterCredentials): Promise<{ ok: true; detail?: string }> {
  const client = openRouterClient(creds);
  const models = await client.models.list();
  const all = models.data ?? [];

  const hermes = all
    .map((m) => m.id)
    .filter((id) => /hermes|nousresearch/i.test(id))
    .sort();

  if (hermes.length === 0) {
    return {
      ok: true,
      detail:
        `Key works (${all.length} models visible), but none of them are Hermes/NousResearch models. ` +
        `Check openrouter.ai/models -- you may need credit on the account before the model is available.`,
    };
  }

  return {
    ok: true,
    detail:
      `Key works. ${hermes.length} Hermes model(s) available to you -- paste one of these into the model field: ` +
      hermes.slice(0, 6).join("  |  "),
  };
}
