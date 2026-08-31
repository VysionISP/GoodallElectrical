import OpenAI from "openai";

export interface OpenRouterCredentials {
  apiKey: string;
}

/** OpenRouter exposes an OpenAI-compatible API, so this is the same shape as testOpenAiConnection but pointed at a different base URL. */
export async function testOpenRouterConnection(creds: OpenRouterCredentials): Promise<{ ok: true; detail?: string }> {
  const client = new OpenAI({ apiKey: creds.apiKey, baseURL: "https://openrouter.ai/api/v1" });
  const models = await client.models.list();
  const count = models.data?.length ?? 0;
  return { ok: true, detail: `Connected. ${count} model(s) visible to this key.` };
}
