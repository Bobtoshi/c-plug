import test from "node:test";
import assert from "node:assert/strict";
import { WinchClient, summarizeWinchRun } from "../src/winch-client.mjs";

const token = "synthetic-bridge-secret-0123456789abcdef";

test("WINCH client only accepts an uncredentialed loopback HTTP origin", () => {
  assert.throws(() => new WinchClient({ enabled: true, baseUrl: "https://example.test", token }), /loopback/i);
  assert.throws(() => new WinchClient({ enabled: true, baseUrl: "http://user:pass@127.0.0.1:4321", token }), /loopback/i);
});

test("WINCH client authenticates dispatch and relays namespaced action approvals", async () => {
  const calls = [];
  const client = new WinchClient({
    enabled: true,
    token,
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return { ok: true, status: 201, async text() { return JSON.stringify({
        run: { id: "run_1", status: "completed", result: { selectedHarness: "forge", primary: { result: "Primary answer" }, verification: { result: "Verified" } } },
        actions: [{ title: "Write file", type: "files.write", status: "awaiting_approval", approvalCode: "W123456" }]
      }); } };
    }
  });
  const result = await client.dispatch("Implement the parser", "forge");
  assert.match(result.message, /Primary answer/);
  assert.match(result.message, /CPLUG APPROVE W123456/);
  assert.equal(result.selectedHarness, "forge");
  assert.equal(calls[0].options.headers.authorization, `Bearer ${token}`);
  assert.equal(calls[0].options.redirect, "error");
  assert.equal(JSON.parse(calls[0].options.body).operatorApproved, true);
});

test("WINCH summaries omit unrelated state and preserve the verification result", () => {
  const result = summarizeWinchRun({ run: { result: { primary: { result: "Answer" }, verification: { result: "Checked" } } }, actions: [] });
  assert.match(result.message, /Answer/);
  assert.match(result.message, /Checked/);
});

test("WINCH client rejects an oversized response before parsing it", async () => {
  const client = new WinchClient({
    enabled: true,
    token,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: { get(name) { return name === "content-length" ? "999999" : null; } },
      async text() { throw new Error("body should not be read"); }
    })
  });
  await assert.rejects(client.dispatch("Review this"), (error) => error.code === "winch_invalid_response");
});
