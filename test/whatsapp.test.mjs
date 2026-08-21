import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Store } from "../src/store.mjs";
import { WhatsAppBridge, verifyWhatsAppSignature } from "../src/whatsapp.mjs";

const secret = "synthetic-app-secret";
const sign = (body) => `sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`;

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cplug-whatsapp-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new Store(path.join(directory, "state.sqlite"));
  const sent = [];
  const calls = [];
  const agent = {
    async createTask(prompt, options) {
      calls.push({ prompt, options });
      return {
        tasks: [{ id: "task_1", summary: "Planned safely.", source: options.source, sourceRef: options.sourceRef }],
        actions: [{ id: "act_1", taskId: "task_1", status: "approval", title: "Send message", approvalCode: "123456" }]
      };
    },
    async decideByCode(code) {
      return { actions: [{ approvalCode: code, result: { message: "Approved action completed." } }] };
    }
  };
  const bridge = new WhatsAppBridge({
    store,
    agent,
    enabled: true,
    verifyToken: "synthetic-verify-token",
    appSecret: secret,
    accessToken: "synthetic-access-token",
    phoneNumberId: "1234567890",
    ownerNumber: "15551234567",
    apiVersion: "v99.0",
    fetchImpl: async (url, options) => {
      sent.push({ url, body: JSON.parse(options.body), authorization: options.headers.authorization });
      return { ok: true, status: 200 };
    }
  });
  return { bridge, store, sent, calls };
}

function payload({ from = "15551234567", id = "wamid.synthetic.1", text = "CPLUG create a test event" } = {}) {
  return Buffer.from(JSON.stringify({ entry: [{ changes: [{ value: { messages: [{ id, from, type: "text", text: { body: text } }] } }] }] }));
}

test("WhatsApp webhook signatures are verified against the raw body", () => {
  const body = payload();
  assert.equal(verifyWhatsAppSignature(body, sign(body), secret), true);
  assert.equal(verifyWhatsAppSignature(body, "sha256=" + "0".repeat(64), secret), false);
});

test("WhatsApp accepts only the configured owner and deduplicates message IDs", async (t) => {
  const f = fixture(t);
  const stranger = payload({ from: "15550000000" });
  assert.equal(f.bridge.acceptWebhook(stranger, sign(stranger)), 0);
  const owner = payload();
  assert.equal(f.bridge.acceptWebhook(owner, sign(owner)), 1);
  assert.equal(f.bridge.acceptWebhook(owner, sign(owner)), 0);
  await f.bridge.idle();
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].options, { source: "whatsapp", sourceRef: "wamid.synthetic.1" });
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0].body.text.body, /CPLUG APPROVE 123456/);
  assert.equal(f.store.getSetting("whatsapp_seen_ids")[0], "wamid.synthetic.1");
});

test("WhatsApp approval replies use the same six-digit action gate", async (t) => {
  const f = fixture(t);
  const body = payload({ id: "wamid.synthetic.2", text: "CPLUG APPROVE 654321" });
  assert.equal(f.bridge.acceptWebhook(body, sign(body)), 1);
  await f.bridge.idle();
  assert.equal(f.sent[0].body.text.body, "Approved action completed.");
});

test("WhatsApp relays namespaced WINCH approval codes", async (t) => {
  const f = fixture(t);
  const body = payload({ id: "wamid.synthetic.3", text: "CPLUG REJECT W654321" });
  assert.equal(f.bridge.acceptWebhook(body, sign(body)), 1);
  await f.bridge.idle();
  assert.equal(f.sent[0].body.text.body, "Approved action completed.");
});

test("WhatsApp rejects invalid signatures before processing JSON", (t) => {
  const f = fixture(t);
  assert.throws(() => f.bridge.acceptWebhook(Buffer.from("not-json"), "sha256=" + "0".repeat(64)), /signature/i);
});
