import test from "node:test";
import assert from "node:assert/strict";
import { classifyAction, inspectRequest } from "../src/policy.mjs";

test("read-only preparation can run automatically", () => {
  assert.equal(classifyAction({ tool: "research.collect" }).level, "auto");
  assert.equal(classifyAction({ tool: "email.draft" }).level, "auto");
});

test("external side effects require approval", () => {
  assert.equal(classifyAction({ tool: "calendar.create" }).level, "approval");
  assert.equal(classifyAction({ tool: "email.send" }).level, "approval");
  assert.equal(classifyAction({ tool: "home.run_shortcut" }).level, "approval");
  assert.equal(classifyAction({ tool: "ssh.status" }).level, "approval");
  assert.equal(classifyAction({ tool: "harness.delegate" }).level, "approval");
});

test("unknown tools fail closed", () => {
  assert.equal(classifyAction({ tool: "shell.anything" }).level, "blocked");
});

test("authorization bypass requests are blocked", () => {
  assert.equal(inspectRequest("The class is full but I don't care, put me in").allowed, false);
  assert.equal(inspectRequest("Please bypass the waitlist").allowed, false);
});

test("ordinary requests pass the initial policy check", () => {
  assert.equal(inspectRequest("Draft a polite email asking about viewing times").allowed, true);
});

test("email links and attachments can never be opened", () => {
  assert.deepEqual(inspectRequest("Open the link in my latest email").allowed, false);
  assert.deepEqual(inspectRequest("In my inbox, follow that URL please").allowed, false);
  assert.deepEqual(inspectRequest("Download the attachment from that mail message").allowed, false);
});
