import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { IMessageBridge } from "../src/imessage.mjs";
import { Store } from "../src/store.mjs";

class FakeSource {
  constructor() { this.rows = []; }
  status() { return { status: "available", detail: "test" }; }
  maxRowId() { return 0; }
  messagesAfter(cursor) { return this.rows.filter((row) => row.rowId > cursor); }
}

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cplug-imessage-test-"));
  const store = new Store(path.join(directory, "test.sqlite"));
  const source = new FakeSource();
  const sent = [];
  const agent = {
    decisions: [],
    async decideByCode(code, decision) {
      this.decisions.push({ code, decision });
      return { actions: [{ approvalCode: code, result: { message: "Action completed." } }] };
    },
    async createTask(_prompt, options) {
      return { tasks: [{ id: "task_1", summary: "Planned.", source: "imessage", sourceRef: options.sourceRef }], actions: [] };
    }
  };
  const bridge = new IMessageBridge({ store, source, agent, sender: async (handle, message) => sent.push({ handle, message }), pollMs: 999_999 });
  return { directory, store, source, sent, agent, bridge };
}

test("iMessage pairing binds one handle and chat", async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.directory, { recursive: true, force: true }));
  await f.bridge.processOnce();
  const code = f.store.getSetting("imessage_pairing").code;
  f.source.rows.push({ rowId: 1, text: `CPLUG PAIR ${code}`, handle: "owner@example.test", chatId: "7", participantCount: 1, fromMe: false });
  await f.bridge.processOnce();
  assert.equal(f.store.getSetting("imessage_pair").handle, "owner@example.test");
  assert.match(f.sent[0].message, /paired/i);
});

test("unpaired or unrelated chats cannot issue commands", async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.directory, { recursive: true, force: true }));
  f.store.setSetting("imessage_cursor", 0);
  f.store.setSetting("imessage_pair", { handle: "owner@example.test", chatId: "7" });
  f.source.rows.push({ rowId: 1, text: "CPLUG STATUS", handle: "other@example.test", chatId: "8", participantCount: 1, fromMe: false });
  await f.bridge.processOnce();
  assert.equal(f.sent.length, 0);
});

test("approval commands are routed by six-digit code", async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.directory, { recursive: true, force: true }));
  f.store.setSetting("imessage_cursor", 0);
  f.store.setSetting("imessage_pair", { handle: "owner@example.test", chatId: "7" });
  f.source.rows.push({ rowId: 1, text: "CPLUG APPROVE 482193", handle: "owner@example.test", chatId: "7", participantCount: 1, fromMe: true });
  await f.bridge.processOnce();
  assert.deepEqual(f.agent.decisions, [{ code: "482193", decision: "approve" }]);
  assert.match(f.sent[0].message, /completed/i);
});

test("WINCH action approvals keep their W namespace", async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.directory, { recursive: true, force: true }));
  f.store.setSetting("imessage_cursor", 0);
  f.store.setSetting("imessage_pair", { handle: "owner@example.test", chatId: "7" });
  f.source.rows.push({ rowId: 1, text: "CPLUG APPROVE W482193", handle: "owner@example.test", chatId: "7", participantCount: 1, fromMe: true });
  await f.bridge.processOnce();
  assert.deepEqual(f.agent.decisions, [{ code: "W482193", decision: "approve" }]);
});
