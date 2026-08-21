const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function cleanIntent(value) {
  const intent = String(value || "").trim();
  if (!intent || intent.length > 4_000) throw Object.assign(new Error("Harness intent must contain 1 to 4,000 characters."), { code: "invalid_payload" });
  return intent;
}

function endpoint(value) {
  let url;
  try { url = new URL(String(value || "http://127.0.0.1:4321")); }
  catch { throw new Error("CPLUG_WINCH_URL must be a valid loopback HTTP origin."); }
  if (url.protocol !== "http:" || !LOOPBACK.has(url.hostname.toLowerCase()) || url.username || url.password || (url.pathname !== "/" && url.pathname !== "")) {
    throw new Error("CPLUG_WINCH_URL must be an uncredentialed loopback HTTP origin.");
  }
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url;
}

async function boundedResponseText(response, limit = 256_000) {
  const declared = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > limit) throw Object.assign(new Error("WINCH returned an oversized response."), { code: "winch_invalid_response" });
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text) > limit) throw Object.assign(new Error("WINCH returned an oversized response."), { code: "winch_invalid_response" });
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw Object.assign(new Error("WINCH returned an oversized response."), { code: "winch_invalid_response" });
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(joined);
}

function summarize(payload) {
  const run = payload?.run || {};
  const primary = run.result?.primary;
  const verification = run.result?.verification;
  const lines = [];
  if (primary?.result) lines.push(String(primary.result).slice(0, 12_000));
  else if (run.result?.summary) lines.push(String(run.result.summary).slice(0, 2_000));
  else lines.push(`WINCH run ${run.status || "recorded"}.`);
  for (const opinion of Array.isArray(run.result?.advisory) ? run.result.advisory.slice(0, 2) : []) {
    if (opinion?.result?.result) lines.push(`${opinion.harness || "Advisor"}: ${String(opinion.result.result).slice(0, 3_000)}`);
  }
  if (verification?.result) lines.push(`Independent verification: ${String(verification.result).slice(0, 4_000)}`);
  const pending = (Array.isArray(payload?.actions) ? payload.actions : []).filter((item) => item.status === "awaiting_approval" && /^W\d{6}$/.test(item.approvalCode || ""));
  if (pending.length) {
    lines.push(pending.map((item) => `${item.title} (${item.type})\nReply CPLUG APPROVE ${item.approvalCode} or CPLUG REJECT ${item.approvalCode}`).join("\n\n"));
  }
  return { message: lines.join("\n\n").slice(0, 20_000), pending };
}

export class WinchClient {
  constructor({ enabled = false, baseUrl = "http://127.0.0.1:4321", token = "", fetchImpl = globalThis.fetch } = {}) {
    this.enabled = enabled;
    this.baseUrl = endpoint(baseUrl);
    this.token = String(token);
    this.fetchImpl = fetchImpl;
  }

  configured() {
    return this.enabled && this.token.length >= 32 && this.token.length <= 512;
  }

  status() {
    if (!this.enabled) return { status: "disabled", detail: "Disabled by configuration" };
    if (!this.configured()) return { status: "setup_required", detail: "Set matching C-Plug and WINCH bridge tokens" };
    return { status: "available", detail: "Authenticated loopback cross-harness delegation" };
  }

  async #request(pathname, body) {
    if (!this.configured()) throw Object.assign(new Error("WINCH delegation is not configured."), { code: "winch_disabled" });
    const url = new URL(pathname, this.baseUrl);
    let response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        redirect: "error",
        headers: {
          authorization: `Bearer ${this.token}`,
          "content-type": "application/json",
          "x-winch-request": "1"
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(150_000)
      });
    } catch {
      throw Object.assign(new Error("WINCH is unavailable on the configured loopback address."), { code: "winch_unavailable" });
    }
    const raw = await boundedResponseText(response);
    let payload;
    try { payload = JSON.parse(raw || "{}"); }
    catch { throw Object.assign(new Error("WINCH returned invalid JSON."), { code: "winch_invalid_response" }); }
    if (!response.ok) throw Object.assign(new Error(String(payload.error || `WINCH returned HTTP ${response.status}.`).slice(0, 500)), { code: "winch_request_failed" });
    return payload;
  }

  async dispatch(intent, preferredHarness = null) {
    const clean = cleanIntent(intent);
    const preferred = preferredHarness == null || preferredHarness === "" ? null : String(preferredHarness);
    if (preferred && !/^[a-z][a-z0-9_-]{1,39}$/.test(preferred)) throw Object.assign(new Error("Preferred harness id is invalid."), { code: "invalid_payload" });
    const payload = await this.#request("/api/bridge/runs", { intent: clean, preferredHarness: preferred, operatorApproved: true });
    const summary = summarize(payload);
    return {
      message: summary.message,
      connector: "winch",
      external: true,
      completedAt: new Date().toISOString(),
      runId: payload.run?.id || null,
      selectedHarness: payload.run?.result?.selectedHarness || payload.run?.route?.primary || null,
      pendingApprovalCodes: summary.pending.map((item) => item.approvalCode)
    };
  }

  async decide(code, decision) {
    const match = String(code || "").toUpperCase().match(/^W(\d{6})$/);
    if (!match || !["approve", "reject"].includes(decision)) throw Object.assign(new Error("Invalid WINCH approval decision."), { code: "invalid_payload" });
    const payload = await this.#request(`/api/bridge/approvals/${match[1]}`, { decision });
    const action = (payload.actions || [])
      .filter((item) => item.approvalCode === null && ["completed", "rejected", "failed"].includes(item.status))
      .sort((a, b) => String(b.decidedAt || "").localeCompare(String(a.decidedAt || "")))[0];
    const message = action?.result?.summary || (action?.status === "completed" ? `${action.title} completed and WINCH recorded its receipt.` : action?.status === "rejected" ? `${action.title} was rejected; no action was taken.` : action?.status === "failed" ? `${action.title} failed safely.` : "WINCH decision recorded.");
    return { message, connector: "winch", external: action?.status === "completed", completedAt: new Date().toISOString(), runId: payload.run?.id || null };
  }
}

export const summarizeWinchRun = summarize;
