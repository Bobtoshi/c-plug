import assert from "node:assert/strict";
import test from "node:test";
import { Planner } from "../src/planner.mjs";
import { providerFromEnv, UniversalProvider } from "../src/providers.mjs";

const planText = JSON.stringify({ summary: "Synthetic plan.", actions: [{ tool: "note.save", title: "Save note", payload_json: "{\"text\":\"synthetic\"}" }] });

function fakeResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, async text() { return JSON.stringify(body); } };
}

const providerCases = [
  ["openai-responses", { output: [{ type: "message", content: [{ type: "output_text", text: planText }] }] }, "authorization"],
  ["openai-compatible", { choices: [{ message: { content: planText } }] }, "authorization"],
  ["anthropic", { content: [{ type: "text", text: planText }] }, "x-api-key"],
  ["gemini", { candidates: [{ content: { parts: [{ text: planText }] } }] }, "x-goog-api-key"]
];

for (const [kind, responseBody, authHeader] of providerCases) {
  test(`${kind} uses its provider contract without exposing the key`, async () => {
    const calls = [];
    const provider = new UniversalProvider({
      kind,
      model: "synthetic-model",
      apiKey: "synthetic-secret-value",
      endpoint: "https://provider.example/v1/plan",
      fetchImpl: async (url, options) => {
        calls.push({ url: String(url), options });
        return fakeResponse(responseBody);
      }
    });
    assert.equal(await provider.plan({ prompt: "synthetic request", instructions: "return JSON", schema: { type: "object" } }), planText);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.redirect, "error");
    assert.ok(calls[0].options.headers[authHeader]);
    assert.doesNotMatch(provider.label(), /synthetic-secret-value/);
  });
}

test("provider configuration accepts any valid API-key environment variable name", () => {
  const provider = providerFromEnv({
    CPLUG_AI_PROVIDER: "anthropic",
    CPLUG_AI_MODEL: "synthetic-model",
    CPLUG_AI_API_KEY_ENV: "MY_PRIVATE_AI_KEY",
    MY_PRIVATE_AI_KEY: "synthetic-secret-value"
  });
  assert.equal(provider.kind, "anthropic");
  assert.doesNotMatch(provider.label(), /MY_PRIVATE_AI_KEY|synthetic-secret-value/);
});

test("provider configuration accepts one generic direct API key", () => {
  const provider = providerFromEnv({
    CPLUG_AI_PROVIDER: "gemini",
    CPLUG_AI_MODEL: "synthetic-model",
    CPLUG_AI_API_KEY: "synthetic-direct-key"
  });
  assert.equal(provider.kind, "gemini");
  assert.doesNotMatch(provider.label(), /synthetic-direct-key/);
});

test("loopback compatible providers may run without a key, but remote HTTP is rejected", () => {
  const local = providerFromEnv({
    CPLUG_AI_PROVIDER: "openai-compatible",
    CPLUG_AI_MODEL: "local-model",
    CPLUG_AI_BASE_URL: "http://127.0.0.1:11434/v1/chat/completions"
  });
  assert.equal(local.endpoint.hostname, "127.0.0.1");
  assert.throws(() => providerFromEnv({
    CPLUG_AI_PROVIDER: "openai-compatible",
    CPLUG_AI_MODEL: "remote-model",
    CPLUG_AI_BASE_URL: "http://provider.example/v1/chat/completions"
  }), /HTTPS/);
});

test("invalid key variable names and credential-bearing endpoints fail closed", () => {
  assert.throws(() => providerFromEnv({ CPLUG_AI_PROVIDER: "anthropic", CPLUG_AI_MODEL: "x", CPLUG_AI_API_KEY_ENV: "bad-name" }), /uppercase/);
  assert.throws(() => new UniversalProvider({ kind: "openai-compatible", model: "x", endpoint: "https://user:pass@provider.example/v1/chat/completions" }), /credentials/);
  assert.throws(() => new UniversalProvider({ kind: "gemini", model: "x", endpoint: "https://provider.example/generate?api_key=secret" }), /credentials/);
});

test("Planner normalizes a universal provider plan before routing", async () => {
  const provider = { label: () => "synthetic via test", async plan() { return `\`\`\`json\n${planText}\n\`\`\``; } };
  const planner = new Planner({ provider, codexEnabled: false });
  const result = await planner.plan("save this synthetic note");
  assert.equal(result.plan.summary, "Synthetic plan.");
  assert.deepEqual(result.plan.actions[0], { tool: "note.save", title: "Save note", payload: { text: "synthetic" } });
  assert.equal(planner.status().mode, "api");
});
