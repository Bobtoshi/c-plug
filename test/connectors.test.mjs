import test from "node:test";
import assert from "node:assert/strict";
import { ConnectorRegistry } from "../src/connectors.mjs";

test("local notes complete without an external side effect", async () => {
  const connectors = new ConnectorRegistry({ homeDir: "/path/that/does/not/exist" });
  const result = await connectors.execute({ tool: "note.save", title: "Save", payload: { text: "Private note" } });
  assert.equal(result.external, false);
  assert.equal(result.connector, "local");
});

test("live connectors fail closed by default", async () => {
  const connectors = new ConnectorRegistry({ homeDir: "/path/that/does/not/exist" });
  await assert.rejects(
    connectors.execute({ tool: "calendar.list", title: "Read", payload: { days: 7 } }),
    (error) => error.code === "live_connectors_disabled"
  );
});

test("shortcuts fail closed unless exact name is allowlisted", async () => {
  const connectors = new ConnectorRegistry({ homeDir: "/path/that/does/not/exist", shortcutNames: "Prepare Office", liveEnabled: true });
  await assert.rejects(
    connectors.execute({ tool: "home.run_shortcut", title: "Run", payload: { shortcut: "Prepare Gaming" } }),
    (error) => error.code === "not_allowlisted"
  );
});

test("mail validates a single recipient before touching Mail", async () => {
  const connectors = new ConnectorRegistry({ homeDir: "/path/that/does/not/exist", liveEnabled: true });
  await assert.rejects(
    connectors.execute({ tool: "email.send", title: "Send", payload: { to: "one@example.com,two@example.com", subject: "Hi", body: "Test" } }),
    (error) => error.code === "invalid_payload"
  );
});

test("SSH only accepts aliases found in the configured allowlist", async () => {
  const connectors = new ConnectorRegistry({ homeDir: "/path/that/does/not/exist", liveEnabled: true });
  await assert.rejects(
    connectors.execute({ tool: "ssh.status", title: "Status", payload: { host: "unknown.example" } }),
    (error) => error.code === "not_allowlisted"
  );
});
