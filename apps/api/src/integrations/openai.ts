import OpenAI from "openai";
import { getIntegrationCredentials } from "./store.js";

export interface OpenAiCredentials {
  apiKey: string;
}

export function getOpenAiClient(): OpenAI | null {
  const creds = getIntegrationCredentials<OpenAiCredentials>("openai");
  if (!creds?.apiKey) return null;
  return new OpenAI({ apiKey: creds.apiKey });
}

export async function testOpenAiConnection(creds: OpenAiCredentials): Promise<{ ok: true; detail?: string }> {
  const client = new OpenAI({ apiKey: creds.apiKey });
  const models = await client.models.list();
  const count = models.data?.length ?? 0;
  return { ok: true, detail: `Connected. ${count} models visible to this key.` };
}
