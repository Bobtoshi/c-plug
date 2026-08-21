const PROVIDERS = new Set(["openai-responses", "openai-compatible", "anthropic", "gemini"]);
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const DEFAULT_ENDPOINTS = Object.freeze({
  "openai-responses": "https://api.openai.com/v1/responses",
  "openai-compatible": "https://api.openai.com/v1/chat/completions",
  anthropic: "https://api.anthropic.com/v1/messages"
});

function clean(value, max = 300) {
  return String(value || "").trim().slice(0, max);
}

function endpointFor(kind, model, configured) {
  const candidate = clean(configured, 2_000) || (kind === "gemini"
    ? `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`
    : DEFAULT_ENDPOINTS[kind]);
  let url;
  try { url = new URL(candidate); }
  catch { throw new Error("The AI provider endpoint is not a valid URL."); }
  if (url.username || url.password || url.hash) throw new Error("The AI provider endpoint cannot contain credentials or a fragment.");
  if ([...url.searchParams.keys()].some((key) => /key|token|secret|auth/i.test(key))) throw new Error("Put provider credentials in the API key setting, not the endpoint URL.");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname.toLowerCase()))) {
    throw new Error("AI provider endpoints must use HTTPS, except loopback local-model endpoints.");
  }
  return url;
}

function keyFromEnvironment(env, keyName, required) {
  const name = clean(keyName, 64);
  if (!name) {
    if (required) throw new Error("Set CPLUG_AI_API_KEY or CPLUG_AI_API_KEY_ENV for the selected provider.");
    return { name: null, value: "" };
  }
  if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(name)) throw new Error("CPLUG_AI_API_KEY_ENV must be an uppercase environment variable name.");
  const value = String(env[name] || "").trim();
  if (required && !value) throw new Error(`The configured AI key environment variable ${name} is empty.`);
  return { name, value };
}

function responseText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((item) => typeof item === "string" ? item : item?.text || "").join("\n");
  return "";
}

async function limitedResponseText(response, limit = 1_000_000) {
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text) > limit) throw new Error("The AI provider response exceeded the 1 MB safety limit.");
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new Error("The AI provider response exceeded the 1 MB safety limit.");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function parseResponse(response) {
  const text = await limitedResponseText(response);
  if (!response.ok) throw new Error(`The AI provider request failed with HTTP ${response.status}.`);
  try { return JSON.parse(text); }
  catch { throw new Error("The AI provider returned invalid JSON."); }
}

function extractOpenAIResponse(body) {
  return (body.output || [])
    .filter((item) => item?.type === "message")
    .flatMap((item) => item.content || [])
    .filter((item) => item?.type === "output_text")
    .map((item) => item.text || "")
    .join("\n");
}

function extractPlanText(kind, body) {
  if (kind === "openai-responses") return extractOpenAIResponse(body);
  if (kind === "openai-compatible") return responseText(body?.choices?.[0]?.message?.content);
  if (kind === "anthropic") return (body?.content || []).filter((item) => item?.type === "text").map((item) => item.text || "").join("\n");
  if (kind === "gemini") return (body?.candidates?.[0]?.content?.parts || []).map((item) => item?.text || "").join("\n");
  return "";
}

function requestFor(kind, { model, key, instructions, prompt, schema }) {
  if (kind === "openai-responses") return {
    headers: { authorization: `Bearer ${key}` },
    body: { model, store: false, instructions, input: prompt, text: { format: { type: "json_schema", name: "cplug_plan", strict: true, schema } } }
  };
  if (kind === "openai-compatible") return {
    headers: key ? { authorization: `Bearer ${key}` } : {},
    body: { model, messages: [{ role: "system", content: instructions }, { role: "user", content: prompt }], response_format: { type: "json_object" }, temperature: 0 }
  };
  if (kind === "anthropic") return {
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: { model, max_tokens: 2_000, system: instructions, messages: [{ role: "user", content: prompt }], temperature: 0 }
  };
  return {
    headers: { "x-goog-api-key": key },
    body: {
      system_instruction: { parts: [{ text: instructions }] },
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: "application/json", temperature: 0 }
    }
  };
}

export class UniversalProvider {
  constructor({ kind, model, apiKey, endpoint, fetchImpl = globalThis.fetch } = {}) {
    this.kind = clean(kind, 40);
    this.model = clean(model, 200);
    if (!PROVIDERS.has(this.kind)) throw new Error(`Unsupported AI provider: ${this.kind || "(missing)"}.`);
    if (!this.model) throw new Error("CPLUG_AI_MODEL is required when an API provider is enabled.");
    this.endpoint = endpointFor(this.kind, this.model, endpoint);
    this.apiKey = String(apiKey || "");
    this.fetchImpl = fetchImpl;
  }

  label() {
    return `${this.model} via ${this.kind}`;
  }

  async plan({ prompt, instructions, schema }) {
    const request = requestFor(this.kind, { model: this.model, key: this.apiKey, instructions, prompt, schema });
    const response = await this.fetchImpl(this.endpoint, {
      method: "POST",
      redirect: "error",
      credentials: "omit",
      headers: { "content-type": "application/json", ...request.headers },
      body: JSON.stringify(request.body),
      signal: AbortSignal.timeout(45_000)
    });
    const body = await parseResponse(response);
    const text = extractPlanText(this.kind, body).trim();
    if (!text) throw new Error("The AI provider returned no plan text.");
    return text;
  }
}

export function providerFromEnv(env = process.env) {
  const kind = clean(env.CPLUG_AI_PROVIDER, 40);
  if (!kind) return null;
  if (!PROVIDERS.has(kind)) throw new Error(`CPLUG_AI_PROVIDER must be one of: ${[...PROVIDERS].join(", ")}.`);
  const requiresKey = !(kind === "openai-compatible" && clean(env.CPLUG_AI_BASE_URL).startsWith("http://"));
  const directKey = String(env.CPLUG_AI_API_KEY || "").trim();
  const key = directKey ? { name: null, value: directKey } : keyFromEnvironment(env, env.CPLUG_AI_API_KEY_ENV, requiresKey);
  return new UniversalProvider({ kind, model: env.CPLUG_AI_MODEL, apiKey: key.value, endpoint: env.CPLUG_AI_BASE_URL });
}

export const supportedProviders = Object.freeze([...PROVIDERS]);
