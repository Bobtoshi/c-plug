import crypto from "node:crypto";

const SCHEMA_VERSION = 1;
const MAX_COUNTERS = 200;
const MAX_BATCHES = 30;

const EVENTS = new Set([
  "task_created",
  "task_blocked",
  "plan_created",
  "planner_fallback",
  "action_proposed",
  "action_finished",
  "approval_decided"
]);

const DIMENSIONS = Object.freeze({
  source: new Set(["web", "imessage", "whatsapp", "unknown"]),
  planner: new Set(["api", "codex", "fallback", "unknown"]),
  gate: new Set(["auto", "approval", "blocked", "unknown"]),
  outcome: new Set(["completed", "failed", "blocked", "rejected", "approved", "waiting", "unknown"]),
  tool: new Set([
    "research.collect", "note.save", "email.draft", "calendar.list", "calendar.create",
    "email.send", "home.run_shortcut", "ssh.status", "system.none", "unknown"
  ])
});

function day() {
  return new Date().toISOString().slice(0, 10);
}

function safeEndpoint(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return null;
    url.username = "";
    url.password = "";
    url.hash = "";
    return url;
  } catch {
    return null;
  }
}

function cleanDimensions(values = {}) {
  const clean = [];
  for (const key of Object.keys(DIMENSIONS).sort()) {
    if (values[key] === undefined) continue;
    const value = DIMENSIONS[key].has(values[key]) ? values[key] : "unknown";
    clean.push(`${key}.${value}`);
  }
  return clean;
}

function countEvents(counters = {}) {
  return Object.values(counters).reduce((total, value) => total + Number(value || 0), 0);
}

export class Telemetry {
  constructor({ store, endpoint = "", version = "0.0.0", fetchImpl = globalThis.fetch, platform = process.platform, arch = process.arch, nodeVersion = process.versions.node } = {}) {
    this.store = store;
    this.endpoint = safeEndpoint(endpoint);
    this.version = String(version).slice(0, 40);
    this.fetchImpl = fetchImpl;
    this.runtime = { platform, arch, nodeMajor: String(nodeVersion).split(".")[0] };
    this.timer = null;
    this.busy = false;
    this.lastDelivery = this.store.getSetting("telemetry_last_delivery");
  }

  available() {
    return Boolean(this.endpoint);
  }

  enabled() {
    return this.available() && this.store.getSetting("telemetry_consent", false) === true;
  }

  status() {
    const active = this.store.getSetting("telemetry_active", null);
    const outbox = this.store.getSetting("telemetry_outbox", []);
    return {
      available: this.available(),
      enabled: this.enabled(),
      endpointOrigin: this.endpoint?.origin || null,
      pendingEvents: countEvents(active?.counters),
      queuedReports: Array.isArray(outbox) ? outbox.length : 0,
      lastDelivery: this.lastDelivery || null
    };
  }

  setConsent(enabled) {
    if (typeof enabled !== "boolean") throw Object.assign(new Error("Telemetry consent must be true or false."), { statusCode: 400 });
    if (enabled && !this.available()) throw Object.assign(new Error("No telemetry endpoint is configured."), { statusCode: 409 });
    this.store.setSetting("telemetry_consent", enabled);
    if (!enabled) {
      this.stop();
      this.store.deleteSetting("telemetry_active");
      this.store.deleteSetting("telemetry_outbox");
      this.store.deleteSetting("telemetry_seed");
    } else {
      this.schedule(1_000);
    }
    return this.status();
  }

  record(event, dimensions = {}) {
    if (!this.enabled() || !EVENTS.has(event)) return false;
    const suffix = cleanDimensions(dimensions);
    const key = [event, ...suffix].join("|");
    let active = this.store.getSetting("telemetry_active", null);
    if (!active || active.period !== day()) {
      if (active) this.#enqueue(active);
      active = { period: day(), counters: {} };
    }
    if (!(key in active.counters) && Object.keys(active.counters).length >= MAX_COUNTERS) return false;
    active.counters[key] = Math.min(Number(active.counters[key] || 0) + 1, 1_000_000);
    this.store.setSetting("telemetry_active", active);
    this.schedule();
    return true;
  }

  schedule(delay = 30_000) {
    if (!this.enabled() || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush().catch(() => {});
    }, delay);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  async flush() {
    if (!this.enabled() || this.busy) return false;
    this.busy = true;
    try {
      const active = this.store.getSetting("telemetry_active", null);
      if (active && countEvents(active.counters) > 0) {
        this.#enqueue(active);
        this.store.deleteSetting("telemetry_active");
      }

      const outbox = this.store.getSetting("telemetry_outbox", []);
      if (!Array.isArray(outbox) || !outbox.length) return false;
      const batch = outbox[0];
      const response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        redirect: "error",
        credentials: "omit",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(batch),
        signal: AbortSignal.timeout(10_000)
      });
      if (!response.ok) return false;
      this.store.setSetting("telemetry_outbox", outbox.slice(1));
      this.lastDelivery = new Date().toISOString();
      this.store.setSetting("telemetry_last_delivery", this.lastDelivery);
      if (outbox.length > 1) this.schedule(1_000);
      return true;
    } finally {
      this.busy = false;
    }
  }

  #enqueue(active) {
    const outbox = this.store.getSetting("telemetry_outbox", []);
    const safeOutbox = Array.isArray(outbox) ? outbox.slice(-(MAX_BATCHES - 1)) : [];
    safeOutbox.push({
      schema: SCHEMA_VERSION,
      batchId: crypto.randomUUID(),
      dailyInstanceId: this.#dailyInstanceId(active.period),
      period: active.period,
      appVersion: this.version,
      runtime: this.runtime,
      counters: active.counters
    });
    this.store.setSetting("telemetry_outbox", safeOutbox);
  }

  #dailyInstanceId(period) {
    let seed = this.store.getSetting("telemetry_seed", null);
    if (typeof seed !== "string" || seed.length < 32) {
      seed = crypto.randomBytes(32).toString("base64url");
      this.store.setSetting("telemetry_seed", seed);
    }
    return crypto.createHmac("sha256", seed).update(String(period)).digest("base64url").slice(0, 22);
  }
}

export const telemetryContract = Object.freeze({
  schema: SCHEMA_VERSION,
  events: [...EVENTS],
  dimensions: Object.fromEntries(Object.entries(DIMENSIONS).map(([key, values]) => [key, [...values]]))
});
