import crypto from "node:crypto";

const digits = (value) => String(value || "").replace(/[^0-9]/g, "");
const cleanText = (value, max = 4_000) => String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);

function equalSecret(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

export function verifyWhatsAppSignature(rawBody, signatureHeader, appSecret) {
  const match = String(signatureHeader || "").match(/^sha256=([a-f0-9]{64})$/i);
  if (!match || !appSecret) return false;
  const expected = crypto.createHmac("sha256", appSecret).update(rawBody).digest("hex");
  return equalSecret(match[1].toLowerCase(), expected);
}

function incomingMessages(payload) {
  const messages = [];
  for (const entry of Array.isArray(payload?.entry) ? payload.entry : []) {
    for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
      const value = change?.value;
      for (const message of Array.isArray(value?.messages) ? value.messages : []) {
        if (message?.type !== "text") continue;
        const id = cleanText(message.id, 200);
        const from = digits(message.from);
        const text = cleanText(message.text?.body);
        if (id && from && text) messages.push({ id, from, text });
      }
    }
  }
  return messages;
}

export class WhatsAppBridge {
  constructor({
    store,
    agent,
    enabled = false,
    verifyToken = "",
    appSecret = "",
    accessToken = "",
    phoneNumberId = "",
    ownerNumber = "",
    apiVersion = "",
    fetchImpl = globalThis.fetch
  } = {}) {
    this.store = store;
    this.agent = agent;
    this.enabled = enabled;
    this.verifyToken = String(verifyToken);
    this.appSecret = String(appSecret);
    this.accessToken = String(accessToken);
    this.phoneNumberId = digits(phoneNumberId);
    this.ownerNumber = digits(ownerNumber);
    this.apiVersion = String(apiVersion);
    this.fetchImpl = fetchImpl;
    this.queue = Promise.resolve();
    this.lastError = null;
  }

  configured() {
    return Boolean(
      this.verifyToken && this.appSecret && this.accessToken &&
      /^\d{6,30}$/.test(this.phoneNumberId) && /^\d{6,20}$/.test(this.ownerNumber) &&
      /^v\d+\.\d+$/.test(this.apiVersion)
    );
  }

  status() {
    if (!this.enabled) return { status: "disabled", detail: "Disabled by configuration" };
    if (!this.configured()) return { status: "setup_required", detail: "Complete the WhatsApp Cloud API settings" };
    return { status: this.lastError ? "degraded" : "connected", detail: this.lastError ? "Last delivery failed" : "Signed webhook; owner number only" };
  }

  verifyChallenge(params) {
    if (!this.enabled || !this.configured()) throw Object.assign(new Error("WhatsApp is not configured."), { statusCode: 404 });
    if (params.get("hub.mode") !== "subscribe" || !equalSecret(params.get("hub.verify_token"), this.verifyToken)) {
      throw Object.assign(new Error("Webhook verification failed."), { statusCode: 403 });
    }
    const challenge = String(params.get("hub.challenge") || "");
    if (!/^\d{1,100}$/.test(challenge)) throw Object.assign(new Error("Invalid webhook challenge."), { statusCode: 400 });
    return challenge;
  }

  acceptWebhook(rawBody, signatureHeader) {
    if (!this.enabled || !this.configured()) throw Object.assign(new Error("WhatsApp is not configured."), { statusCode: 404 });
    if (!verifyWhatsAppSignature(rawBody, signatureHeader, this.appSecret)) {
      throw Object.assign(new Error("Invalid WhatsApp webhook signature."), { statusCode: 403 });
    }

    let payload;
    try { payload = JSON.parse(rawBody.toString("utf8")); }
    catch { throw Object.assign(new Error("Invalid WhatsApp webhook payload."), { statusCode: 400 }); }

    const seen = new Set(this.store.getSetting("whatsapp_seen_ids", []));
    const accepted = [];
    for (const message of incomingMessages(payload)) {
      if (message.from !== this.ownerNumber || seen.has(message.id)) continue;
      seen.add(message.id);
      accepted.push(message);
    }
    this.store.setSetting("whatsapp_seen_ids", [...seen].slice(-200));

    for (const message of accepted) {
      this.queue = this.queue.then(() => this.#handle(message)).catch((error) => {
        this.lastError = String(error?.message || "WhatsApp delivery failed.").slice(0, 200);
      });
    }
    return accepted.length;
  }

  async idle() {
    await this.queue;
  }

  async #handle(message) {
    const match = message.text.match(/^CPLUG\s+(.+)$/is);
    if (!match) return;
    const command = match[1].trim();
    const decision = command.match(/^(APPROVE|REJECT)\s+(W?\d{6})$/i);

    if (decision) {
      try {
        const code = decision[2].toUpperCase();
        const state = await this.agent.decideByCode(code, decision[1].toLowerCase() === "approve" ? "approve" : "reject");
        const action = state.actions.find((item) => item.approvalCode === code);
        await this.#send(action?.result?.message || "Decision recorded.");
      } catch (error) {
        await this.#send(cleanText(error.message, 500) || "The approval could not be applied.");
      }
      return;
    }

    if (/^STATUS$/i.test(command)) {
      const pending = this.store.state().actions.filter((item) => item.status === "approval");
      await this.#send(pending.length ? `${pending.length} action${pending.length === 1 ? "" : "s"} waiting for approval.` : "Online. Nothing is waiting for approval.");
      return;
    }

    const state = await this.agent.createTask(command, { source: "whatsapp", sourceRef: message.id });
    const task = state.tasks.find((item) => item.source === "whatsapp" && item.sourceRef === message.id);
    const actions = task ? state.actions.filter((item) => item.taskId === task.id) : [];
    const pending = actions.filter((item) => item.status === "approval");
    const results = actions.filter((item) => item.result?.message).map((item) => item.result.message);
    let reply = task?.summary || "Request recorded.";
    if (pending.length) reply += "\n" + pending.map((item) => `${item.title}\nReply CPLUG APPROVE ${item.approvalCode} or CPLUG REJECT ${item.approvalCode}`).join("\n\n");
    else if (results.length) reply += `\n${results.join("\n")}`;
    await this.#send(reply);
  }

  async #send(message) {
    const endpoint = `https://graph.facebook.com/${this.apiVersion}/${this.phoneNumberId}/messages`;
    const response = await this.fetchImpl(endpoint, {
      method: "POST",
      redirect: "error",
      headers: {
        authorization: `Bearer ${this.accessToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ messaging_product: "whatsapp", to: this.ownerNumber, type: "text", text: { body: cleanText(message, 3_800) } }),
      signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) throw new Error(`WhatsApp delivery failed with HTTP ${response.status}.`);
    this.lastError = null;
  }
}
