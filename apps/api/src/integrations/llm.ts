import OpenAI from "openai";
import { getIntegrationCredentials, getIntegrationConfig } from "./store.js";
import { getSetting, setSetting } from "../lib/settings.js";

export type AiProvider = "openai" | "openrouter";

export interface ChatClient {
  client: OpenAI;
  model: string;
  provider: AiProvider;
}

const DEFAULT_OPENAI_MODEL = process.env.OPENAI_MODEL ?? "gpt-4o-mini";
// NousResearch's largest current Hermes chat model on OpenRouter as of this
// build. Overridable per-deployment via OPENROUTER_MODEL, or per-owner via
// the "model" field saved on the openrouter integration (Integrations page)
// -- exact available slugs change over time, see openrouter.ai/models.
const DEFAULT_OPENROUTER_MODEL = process.env.OPENROUTER_MODEL ?? "nousresearch/hermes-3-llama-3.1-405b";

/** Which provider (openai vs openrouter/Hermes) currently powers every AI agent in the app. Defaults to openai. */
export function getActiveAiProvider(): AiProvider {
  return getSetting("ai_provider") === "openrouter" ? "openrouter" : "openai";
}

export function setActiveAiProvider(provider: AiProvider): void {
  setSetting("ai_provider", provider);
}

/**
 * Resolves the OpenAI-SDK-compatible client + model for whichever provider
 * is currently active. Returns null if that provider isn't configured yet
 * (no API key saved) -- callers already handle "OpenAI not configured" as a
 * plain, honest state, and this preserves exactly that behavior for
 * whichever provider is actually selected.
 */
/**
 * Explains, in the owner's terms, why there is no usable AI client right
 * now. The old message blamed both providers ("neither is configured"),
 * which is actively wrong in the most common case: a perfectly good
 * OpenAI key is saved, but the provider switch was flipped to OpenRouter
 * before a key was added there, so every agent went dark for a reason the
 * message never mentioned.
 */
export function describeMissingChatClient(): string {
  const provider = getActiveAiProvider();
  const other = provider === "openrouter" ? "openai" : "openrouter";
  const otherConfigured = !!getIntegrationCredentials<{ apiKey: string }>(other as any)?.apiKey;
  const otherLabel = other === "openai" ? "OpenAI" : "OpenRouter";
  const activeLabel = provider === "openai" ? "OpenAI" : "OpenRouter";

  if (otherConfigured) {
    return (
      `The AI provider is set to ${activeLabel}, but no ${activeLabel} API key is saved -- so every agent is switched off, ` +
      `even though your ${otherLabel} key is still there. Either add an ${activeLabel} key under Integrations, ` +
      `or switch the AI provider back to ${otherLabel}.`
    );
  }
  return `No ${activeLabel} API key is saved, so I can't think this through. Add one under Integrations and I'll be able to respond.`;
}

export function getActiveChatClient(): ChatClient | null {
  const provider = getActiveAiProvider();
  if (provider === "openrouter") {
    const creds = getIntegrationCredentials<{ apiKey: string }>("openrouter");
    if (!creds?.apiKey) return null;
    const config = getIntegrationConfig("openrouter") as { model?: string } | null;
    return {
      client: new OpenAI({
        apiKey: creds.apiKey,
        baseURL: "https://openrouter.ai/api/v1",
        defaultHeaders: {
          "HTTP-Referer": "https://github.com/VysionISP/GoodallElectrical",
          "X-Title": "Goodall Electrical AI OS",
        },
      }),
      model: config?.model || DEFAULT_OPENROUTER_MODEL,
      provider: "openrouter",
    };
  }
  const creds = getIntegrationCredentials<{ apiKey: string }>("openai");
  if (!creds?.apiKey) return null;
  return { client: new OpenAI({ apiKey: creds.apiKey }), model: DEFAULT_OPENAI_MODEL, provider: "openai" };
}

interface JsonSchemaDef {
  name: string;
  strict: true;
  schema: { required?: readonly string[]; [key: string]: unknown };
}

/** Some models wrap JSON in a ```json fence despite being told not to -- strip it before parsing rather than failing on it. */
function extractJsonText(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return (fenced ? fenced[1] : raw).trim();
}

/**
 * Every agent's structured-output call goes through here instead of calling
 * chat.completions.create directly. OpenAI's strict json_schema mode is
 * requested first; if the active provider doesn't honour it the same way
 * (a real, open concern for non-OpenAI models routed through OpenRouter --
 * see README) this retries once in plain JSON-object mode with the schema
 * spelled out in the prompt, then checks every field the schema marks
 * required actually came back before trusting the result. If it didn't,
 * this throws rather than letting a caller JSON.parse something that looks
 * valid but is silently missing fields -- never fabricate by accident.
 * OpenAI itself is expected to always support strict mode, so a failure
 * there is treated as a real error, not something to paper over.
 */
export async function chatJson(
  chat: ChatClient,
  params: { schema: JsonSchemaDef; messages: OpenAI.Chat.ChatCompletionMessageParam[] }
): Promise<string> {
  try {
    const completion = await chat.client.chat.completions.create({
      model: chat.model,
      response_format: { type: "json_schema", json_schema: params.schema },
      messages: params.messages,
    });
    const raw = extractJsonText(completion.choices[0]?.message?.content ?? "{}");
    JSON.parse(raw); // throws if strict mode wasn't actually honoured and this isn't valid JSON
    return raw;
  } catch (err: any) {
    if (chat.provider === "openai") throw err;

    // A missing/misspelled model slug is the most common way an OpenRouter
    // setup fails, and retrying in json_object mode would just 404 again --
    // twice the latency to reach the same dead end, with the real cause
    // buried. Fail fast and say exactly what to change.
    const msg = String(err?.message ?? "");
    if (err?.status === 404 || (/model/i.test(msg) && /not.*(found|exist)/i.test(msg))) {
      throw new Error(
        `OpenRouter rejected the model "${chat.model}". Open Integrations, hit "Test connection" on the ` +
          `OpenRouter card -- it lists the exact Hermes model slugs your key can use -- then paste one into the model field. ` +
          `(original error: ${err?.message ?? err})`
      );
    }

    const completion = await chat.client.chat.completions.create({
      model: chat.model,
      response_format: { type: "json_object" },
      messages: [
        ...params.messages,
        {
          role: "system",
          content:
            "Your previous response format wasn't accepted or wasn't valid JSON. Respond with ONLY a JSON object " +
            `matching this exact schema, no markdown fences, no other text:\n${JSON.stringify(params.schema.schema)}`,
        },
      ],
    });
    const raw = extractJsonText(completion.choices[0]?.message?.content ?? "{}");
    const parsed = JSON.parse(raw);
    const required = params.schema.schema.required ?? [];
    const missing = required.filter((k) => !(k in parsed));
    if (missing.length > 0) {
      throw new Error(`${chat.provider} model "${chat.model}" response missing required field(s): ${missing.join(", ")}`);
    }
    return raw;
  }
}
