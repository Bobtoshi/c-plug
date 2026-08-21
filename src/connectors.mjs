import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const macScripts = path.join(root, "scripts", "macos");
const now = () => new Date().toISOString();

export class ConnectorError extends Error {
  constructor(message, code = "connector_error") {
    super(message);
    this.code = code;
  }
}

function required(value, name, max = 20_000) {
  if (typeof value !== "string" || !value.trim()) throw new ConnectorError(`${name} is required.`, "invalid_payload");
  if (value.length > max) throw new ConnectorError(`${name} is too long.`, "invalid_payload");
  return value.trim();
}

function email(value) {
  const clean = required(value, "Email recipient", 320);
  if (!/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(clean)) throw new ConnectorError("A single valid email recipient is required.", "invalid_payload");
  return clean;
}

function isoDate(value, name) {
  const clean = required(value, name, 64);
  const date = new Date(clean);
  if (Number.isNaN(date.getTime())) throw new ConnectorError(`${name} must be an ISO 8601 date.`, "invalid_payload");
  return date;
}

function exactAliases(filename) {
  if (!fs.existsSync(filename)) return [];
  const aliases = [];
  for (const line of fs.readFileSync(filename, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*Host\s+(.+)$/i);
    if (!match) continue;
    for (const alias of match[1].trim().split(/\s+/)) {
      if (!/[*?!]/.test(alias) && /^[A-Za-z0-9._-]+$/.test(alias)) aliases.push(alias);
    }
  }
  return [...new Set(aliases)];
}

async function runFile(command, args, timeout = 25_000) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, { timeout, maxBuffer: 1_000_000 });
    return { stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (error) {
    if (error.killed || error.signal === "SIGTERM") throw new ConnectorError("macOS permission prompt timed out. Grant access and try again.", "permission_required");
    const detail = String(error.stderr || error.message).replace(/\s+/g, " ").slice(0, 260);
    if (/not authorized|not permitted|denied|-1743/i.test(detail)) throw new ConnectorError("macOS permission is required for this connector.", "permission_required");
    throw new ConnectorError(detail || "Connector command failed.");
  }
}

function receipt(connector, message, extra = {}) {
  return { message, connector, external: true, completedAt: now(), ...extra };
}

export class ConnectorRegistry {
  constructor({ homeDir = process.env.HOME, shortcutNames = process.env.CPLUG_SHORTCUTS || "", liveEnabled = false } = {}) {
    this.liveEnabled = liveEnabled;
    this.shortcutNames = shortcutNames.split(",").map((item) => item.trim()).filter(Boolean);
    this.sshAliases = exactAliases(path.join(homeDir, ".ssh", "config"));
  }

  status(plannerStatus, imessageStatus, whatsappStatus = { status: "disabled", detail: "Disabled by configuration" }) {
    const liveStatus = this.liveEnabled ? "available" : "disabled";
    const liveDetail = this.liveEnabled ? null : "Enable live connectors after reviewing permissions";
    return [
      { id: "local", name: "Local ledger", status: "connected", detail: "SQLite / local only" },
      { id: "planner", name: "AI planner", status: plannerStatus.mode === "fallback" ? "limited" : "connected", detail: plannerStatus.label },
      { id: "imessage", name: "iMessage", status: imessageStatus.status, detail: imessageStatus.detail },
      { id: "whatsapp", name: "WhatsApp", status: whatsappStatus.status, detail: whatsappStatus.detail },
      { id: "calendar", name: "Calendar", status: liveStatus, detail: liveDetail || "Approval required to create" },
      { id: "email", name: "Mail", status: liveStatus, detail: liveDetail || "Drafts local; send requires approval" },
      { id: "shortcuts", name: "Apple Shortcuts", status: this.liveEnabled ? (this.shortcutNames.length ? "connected" : "setup_required") : "disabled", detail: liveDetail || (this.shortcutNames.length ? `${this.shortcutNames.length} allowlisted` : "Set CPLUG_SHORTCUTS") },
      { id: "ssh", name: "SSH status", status: this.liveEnabled ? (this.sshAliases.length ? "connected" : "setup_required") : "disabled", detail: liveDetail || `${this.sshAliases.length} configured target${this.sshAliases.length === 1 ? "" : "s"}` }
    ];
  }

  async execute(action) {
    const payload = action.payload || {};
    const liveTools = new Set(["calendar.list", "calendar.create", "email.draft", "email.send", "home.run_shortcut", "ssh.status"]);
    if (liveTools.has(action.tool) && !this.liveEnabled) {
      throw new ConnectorError("Live macOS connectors are disabled. Review the permissions and set CPLUG_LIVE_CONNECTORS=1 to enable them.", "live_connectors_disabled");
    }
    switch (action.tool) {
      case "system.none":
        return { message: payload.message || action.title, connector: "planner", external: false, completedAt: now() };
      case "note.save":
        return { message: "Note saved to the private local ledger.", connector: "local", external: false, completedAt: now(), text: required(payload.text, "Note") };
      case "research.collect":
        return { message: "Research request saved. Live web collection is not enabled in this connector yet.", connector: "local", external: false, completedAt: now(), query: required(payload.query, "Research query") };
      case "calendar.list":
        return this.#calendarList(payload);
      case "calendar.create":
        return this.#calendarCreate(payload);
      case "email.draft":
        return this.#mail(payload, false);
      case "email.send":
        return this.#mail(payload, true);
      case "home.run_shortcut":
        return this.#shortcut(payload);
      case "ssh.status":
        return this.#sshStatus(payload);
      default:
        throw new ConnectorError(`No connector is registered for ${action.tool}.`, "unknown_tool");
    }
  }

  async #calendarCreate(payload) {
    const start = isoDate(payload.start, "Start time");
    const end = isoDate(payload.end, "End time");
    if (end <= start) throw new ConnectorError("End time must be after start time.", "invalid_payload");
    const clean = { title: required(payload.title, "Event title", 300), start: start.toISOString(), end: end.toISOString(), notes: String(payload.notes || "").slice(0, 10_000), calendar: String(payload.calendar || "").slice(0, 300) };
    const { stdout } = await runFile("osascript", ["-l", "JavaScript", path.join(macScripts, "calendar-create.js"), JSON.stringify(clean)]);
    const result = JSON.parse(stdout || "{}");
    return receipt("calendar", `Created “${clean.title}” in ${result.calendar || "Calendar"}.`, { providerId: result.id || null, calendar: result.calendar || null });
  }

  async #calendarList(payload) {
    const days = Math.min(Math.max(Number(payload.days) || 7, 1), 31);
    const { stdout } = await runFile("osascript", ["-l", "JavaScript", path.join(macScripts, "calendar-list.js"), String(days)]);
    const result = JSON.parse(stdout || "[]");
    return { message: result.length ? `${result.length} upcoming event${result.length === 1 ? "" : "s"} found.` : "No upcoming events found.", connector: "calendar", external: false, completedAt: now(), events: result.slice(0, 25) };
  }

  async #mail(payload, send) {
    const clean = { to: email(payload.to), subject: required(payload.subject, "Email subject", 500), body: required(payload.body, "Email body"), send };
    const { stdout } = await runFile("osascript", ["-l", "JavaScript", path.join(macScripts, "mail-message.js"), JSON.stringify(clean)]);
    const result = JSON.parse(stdout || "{}");
    return receipt("mail", send ? `Sent email to ${clean.to}.` : `Created a Mail draft to ${clean.to}; nothing was sent.`, { providerId: result.id || null, recipient: clean.to, sent: send });
  }

  async #shortcut(payload) {
    const name = required(payload.shortcut, "Shortcut name", 300);
    if (!this.shortcutNames.includes(name)) throw new ConnectorError(`Shortcut “${name}” is not allowlisted.`, "not_allowlisted");
    await runFile("shortcuts", ["run", name], 60_000);
    return receipt("shortcuts", `Ran allowlisted Shortcut “${name}”.`, { shortcut: name });
  }

  async #sshStatus(payload) {
    const host = required(payload.host, "SSH host", 255);
    if (!this.sshAliases.includes(host)) throw new ConnectorError(`SSH host “${host}” is not configured and allowlisted.`, "not_allowlisted");
    const { stdout } = await runFile("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", host, "printf 'connected\\n'; uname -srm; uptime"], 20_000);
    return receipt("ssh", `Read-only status check completed for ${host}.`, { host, output: stdout.slice(0, 2_000) });
  }
}

export async function sendIMessage(handle, message) {
  const cleanHandle = required(handle, "iMessage handle", 320);
  const cleanMessage = required(message, "iMessage body", 4_000);
  await runFile("osascript", [path.join(macScripts, "messages-send.applescript"), cleanHandle, cleanMessage]);
  return receipt("imessage", "iMessage reply sent.", { recipient: cleanHandle });
}
