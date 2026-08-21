import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.mjs";

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "kstack-store-test-"));
  const dataDirectory = path.join(directory, "private-data");
  const filename = path.join(dataDirectory, "test.sqlite");
  const store = new Store(filename);
  return { directory, dataDirectory, filename, store };
}

test("local ledger files are restricted to the current user", (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.directory, { recursive: true, force: true }));
  assert.equal(fs.statSync(f.dataDirectory).mode & 0o777, 0o700);
  assert.equal(fs.statSync(f.filename).mode & 0o777, 0o600);
});

test("retention pruning removes expired tasks and their action trail", (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.directory, { recursive: true, force: true }));
  f.store.createTask({ id: "task_old", prompt: "Synthetic", summary: "Synthetic", status: "completed", source: "web", sourceRef: null, createdAt: "2020-01-01T00:00:00.000Z" });
  f.store.createAction({ id: "act_old", taskId: "task_old", tool: "system.none", title: "Synthetic", payload: {}, status: "completed", createdAt: "2020-01-01T00:00:00.000Z" });
  f.store.addEvent({ taskId: "task_old", actionId: "act_old", kind: "completed", message: "Synthetic" });
  assert.equal(f.store.prune(30), 1);
  assert.deepEqual(f.store.state(), { tasks: [], actions: [], events: [] });
});
