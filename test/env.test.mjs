import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadEnv } from "../src/env.mjs";

test("private environment files must be owner-only regular files", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cplug-env-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, ".env");
  fs.writeFileSync(filename, "CPLUG_SYNTHETIC_TEST=loaded\n", { mode: 0o600 });
  loadEnv(filename);
  assert.equal(process.env.CPLUG_SYNTHETIC_TEST, "loaded");
  delete process.env.CPLUG_SYNTHETIC_TEST;

  fs.chmodSync(filename, 0o644);
  assert.throws(() => loadEnv(filename), /owner-only/);

  const link = path.join(directory, ".env-link");
  fs.symlinkSync(filename, link);
  assert.throws(() => loadEnv(link), /regular file/);
});
