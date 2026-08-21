import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { sendIMessage } from "./connectors.mjs";

const normalize = (value) => String(value || "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffc]/g, "").trim();

function decodeAttributedBody(value) {
  if (!Buffer.isBuffer(value)) return "";
  const candidates = [value.toString("utf8"), value.toString("utf16le")]
    .flatMap((text) => text.split(/[\u0000-\u001f]+/))
    .map(normalize)
    .filter((text) => text.length >= 4 && !/^(NSString|NSDictionary|NSAttributedString|NSMutableAttributedString|streamtyped)$/i.test(text));
  return candidates.sort((a, b) => b.length - a.length)[0] || "";
}

export class MacMessagesSource {
  constructor(filename = path.join(process.env.HOME || "", "Library", "Messages", "chat.db")) {
    this.filename = filename;
  }

  status() {
    try {
      fs.accessSync(this.filename, fs.constants.R_OK);
      return { status: "available", detail: "Ready to pair" };
    } catch {
      return { status: "permission_required", detail: "Grant Full Disk Access to C-Plug/Codex" };
    }
  }

  #database() {
    return new DatabaseSync(this.filename, { readOnly: true });
  }

  maxRowId() {
    const db = this.#database();
    try { return Number(db.prepare("SELECT COALESCE(MAX(ROWID),0) AS id FROM message").get().id); }
    finally { db.close(); }
  }

  messagesAfter(rowId, pairedChatId = null) {
    const db = this.#database();
    try {
      const chatFilter = pairedChatId === null ? "" : "AND cmj.chat_id = ?";
      const statement = db.prepare(`
        SELECT m.ROWID AS row_id, m.text, m.attributedBody AS attributed_body,
               m.is_from_me, h.id AS handle, cmj.chat_id,
               (SELECT COUNT(*) FROM chat_handle_join chj WHERE chj.chat_id = cmj.chat_id) AS participant_count
        FROM message m
        JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
        LEFT JOIN handle h ON h.ROWID = m.handle_id
        WHERE m.ROWID > ?
        ${chatFilter}
        ORDER BY m.ROWID ASC
        LIMIT 100
      `);
      const rows = pairedChatId === null ? statement.all(Number(rowId) || 0) : statement.all(Number(rowId) || 0, Number(pairedChatId));
      return rows.map((row) => ({
        rowId: Number(row.row_id),
        text: normalize(row.text) || decodeAttributedBody(row.attributed_body),
        handle: normalize(row.handle),
        chatId: String(row.chat_id),
        participantCount: Number(row.participant_count),
        fromMe: Boolean(row.is_from_me)
      }));
    } finally { db.close(); }
  }
}

export class IMessageBridge {
  constructor({ store, agent, source = new MacMessagesSource(), sender = sendIMessage, enabled = true, pollMs = 3_000 } = {}) {
    this.store = store;
    this.agent = agent;
    this.source = source;
    this.sender = sender;
    this.enabled = enabled;
    this.pollMs = pollMs;
    this.timer = null;
    this.busy = false;
    this.lastError = null;
    if (this.enabled) this.#ensurePairingCode();
  }

  #ensurePairingCode() {
    if (this.store.getSetting("imessage_pair")) return;
    const existing = this.store.getSetting("imessage_pairing");
    if (existing && new Date(existing.expiresAt) > new Date()) return;
    this.store.setSetting("imessage_pairing", {
      code: String(crypto.randomInt(100000, 1_000_000)),
      expiresAt: new Date(Date.now() + 30 * 60_000).toISOString()
    });
  }

  status() {
    if (!this.enabled) return { status: "disabled", detail: "Disabled by configuration", paired: false };
    const sourceStatus = this.source.status();
    const pair = this.store.getSetting("imessage_pair");
    this.#ensurePairingCode();
    const pairing = this.store.getSetting("imessage_pairing");
    if (sourceStatus.status !== "available") return { ...sourceStatus, paired: Boolean(pair), pairingCode: pairing?.code || null, pairingExpiresAt: pairing?.expiresAt || null };
    if (pair) return { status: "connected", detail: "Paired sender only", paired: true };
    return { status: "pairing", detail: "Send the pairing command from your phone", paired: false, pairingCode: pairing.code, pairingExpiresAt: pairing.expiresAt };
  }

  start() {
    if (!this.enabled || this.timer) return;
    this.processOnce().catch((error) => { this.lastError = error.message; });
    this.timer = setInterval(() => this.processOnce().catch((error) => { this.lastError = error.message; }), this.pollMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  resetPairing() {
    this.store.deleteSetting("imessage_pair");
    this.store.deleteSetting("imessage_pairing");
    if (this.enabled) this.#ensurePairingCode();
    return this.status();
  }

  async processOnce() {
    if (this.busy || this.source.status().status !== "available") return;
    this.busy = true;
    try {
      let cursor = this.store.getSetting("imessage_cursor");
      if (cursor === null) {
        cursor = this.source.maxRowId();
        this.store.setSetting("imessage_cursor", cursor);
        return;
      }
      const pair = this.store.getSetting("imessage_pair");
      const messages = this.source.messagesAfter(cursor, pair?.chatId ?? null);
      for (const message of messages) {
        this.store.setSetting("imessage_cursor", message.rowId);
        if (!message.text || !message.handle || message.participantCount > 1) continue;
        await this.#handle(message);
      }
      this.lastError = null;
    } finally {
      this.busy = false;
    }
  }

  async #handle(message) {
    const pair = this.store.getSetting("imessage_pair");
    if (!pair) {
      const pairing = this.store.getSetting("imessage_pairing");
      if (!pairing || new Date(pairing.expiresAt) <= new Date()) return;
      if (message.text.toUpperCase() !== `CPLUG PAIR ${pairing.code}`) return;
      this.store.setSetting("imessage_pair", { handle: message.handle, chatId: message.chatId, pairedAt: new Date().toISOString() });
      this.store.deleteSetting("imessage_pairing");
      this.store.addEvent({ kind: "completed", message: "iMessage command channel paired to one private conversation." });
      await this.sender(message.handle, "C-Plug: paired. Send CPLUG followed by a request. Consequential actions will return a six-digit approval code.");
      return;
    }

    if (message.handle !== pair.handle || message.chatId !== String(pair.chatId)) return;
    const match = message.text.match(/^CPLUG\s+(.+)$/is);
    if (!match) return;
    const command = match[1].trim();

    const decision = command.match(/^(APPROVE|REJECT)\s+(W?\d{6})$/i);
    if (decision) {
      try {
        const code = decision[2].toUpperCase();
        const state = await this.agent.decideByCode(code, decision[1].toLowerCase() === "approve" ? "approve" : "reject");
        const action = state.actions.find((item) => item.approvalCode === code);
        await this.sender(pair.handle, `C-Plug: ${action?.result?.message || "Decision recorded."}`);
      } catch (error) {
        await this.sender(pair.handle, `C-Plug: ${error.message}`);
      }
      return;
    }

    if (/^STATUS$/i.test(command)) {
      const pending = this.store.state().actions.filter((item) => item.status === "approval");
      await this.sender(pair.handle, pending.length ? `C-Plug: ${pending.length} action${pending.length === 1 ? "" : "s"} waiting for approval.` : "C-Plug: online. Nothing is waiting for approval.");
      return;
    }

    const state = await this.agent.createTask(command, { source: "imessage", sourceRef: message.chatId });
    const task = state.tasks.find((item) => item.source === "imessage" && item.sourceRef === message.chatId);
    const actions = task ? state.actions.filter((item) => item.taskId === task.id) : [];
    const pending = actions.filter((item) => item.status === "approval");
    const results = actions.filter((item) => item.result?.message).map((item) => item.result.message);
    let reply = `C-Plug: ${task?.summary || "Request recorded."}`;
    if (pending.length) reply += "\n" + pending.map((item) => `${item.title}\nReply CPLUG APPROVE ${item.approvalCode} or CPLUG REJECT ${item.approvalCode}`).join("\n\n");
    else if (results.length) reply += `\n${results.join("\n")}`;
    await this.sender(pair.handle, reply.slice(0, 3_800));
  }
}
