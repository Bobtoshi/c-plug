import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.mjs";
import { Telemetry } from "../src/telemetry.mjs";

function fixture(fetchImpl = async () => ({ ok: true })) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "kstack-telemetry-test-"));
  const store = new Store(path.join(directory, "test.sqlite"));
  const telemetry = new Telemetry({ store, endpoint: "https://metrics.example.test/v1/events", version: "0.1.0", fetchImpl, platform: "darwin", arch: "arm64", nodeVersion: "26.1.0" });
  return { directory, store, telemetry };
}

test("telemetry is disabled until explicit consent", async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.directory, { recursive: true, force: true }));
  assert.equal(f.telemetry.record("task_created", { source: "web" }), false);
  assert.equal(f.store.getSetting("telemetry_active"), null);
});

test("telemetry emits aggregate counters without user content or a stable install id", async (t) => {
  let sent;
  const f = fixture(async (_url, options) => {
    sent = JSON.parse(options.body);
    return { ok: true };
  });
  t.after(() => fs.rmSync(f.directory, { recursive: true, force: true }));
  f.telemetry.setConsent(true);
  f.telemetry.record("action_proposed", { tool: "email.send", gate: "approval", prompt: "private words", recipient: "owner@example.com" });
  assert.equal(await f.telemetry.flush(), true);
  assert.deepEqual(sent.runtime, { platform: "darwin", arch: "arm64", nodeMajor: "26" });
  assert.equal(sent.counters["action_proposed|gate.approval|tool.email.send"], 1);
  assert.equal(JSON.stringify(sent).includes("private words"), false);
  assert.equal(JSON.stringify(sent).includes("owner@example.com"), false);
  assert.equal("installId" in sent, false);
  assert.match(sent.dailyInstanceId, /^[A-Za-z0-9_-]{22}$/);
});

test("disabling telemetry purges unsent aggregates", (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.directory, { recursive: true, force: true }));
  f.telemetry.setConsent(true);
  f.telemetry.record("task_created", { source: "imessage" });
  f.telemetry.setConsent(false);
  assert.equal(f.store.getSetting("telemetry_active"), null);
  assert.deepEqual(f.store.getSetting("telemetry_outbox", []), []);
  assert.equal(f.store.getSetting("telemetry_seed"), null);
});

test("telemetry requires an HTTPS endpoint", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "kstack-telemetry-test-"));
  try {
    const store = new Store(path.join(directory, "test.sqlite"));
    const telemetry = new Telemetry({ store, endpoint: "http://metrics.example.test/events" });
    assert.equal(telemetry.available(), false);
    assert.throws(() => telemetry.setConsent(true), /No telemetry endpoint/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
