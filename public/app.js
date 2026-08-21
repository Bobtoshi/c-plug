const $ = (selector) => document.querySelector(selector);
const state = { tasks: [], actions: [], events: [], meta: { connectors: [] } };
const labels = { request: "Request", plan: "Plan", approval: "Approval required", completed: "Completed", rejected: "Rejected", blocked: "Blocked", warning: "Fallback" };
const mutationHeaders = Object.freeze({ "content-type": "application/json", "x-kstack-request": "1" });

function node(tag, { className, text, dataset } = {}) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = String(text);
  for (const [key, value] of Object.entries(dataset || {})) element.dataset[key] = String(value);
  return element;
}

function append(parent, ...children) {
  parent.append(...children.filter(Boolean));
  return parent;
}

function time(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(date);
}

function renderApprovals(pending) {
  const list = $("#approval-list");
  list.replaceChildren();
  if (!pending.length) {
    list.append(node("div", { className: "empty", text: "Nothing is waiting. Consequential actions will appear here before they run." }));
    return;
  }
  pending.forEach((action, index) => {
    const details = node("div");
    append(details,
      node("h3", { text: action.title }),
      node("p", { text: action.policyReason }),
      node("code", { text: `${action.tool} · ${JSON.stringify(action.payload)}` })
    );
    const decisions = node("div", { className: "decision" });
    append(decisions,
      node("button", { text: "Reject", dataset: { decision: "reject", id: action.id } }),
      node("button", { className: "approve", text: "Approve", dataset: { decision: "approve", id: action.id } })
    );
    decisions.querySelectorAll("button").forEach((button) => { button.type = "button"; });
    append(list, append(node("article", { className: "approval" }),
      node("span", { className: "approval-index", text: String(index + 1).padStart(2, "0") }),
      details,
      decisions
    ));
  });
}

function renderEvents() {
  const list = $("#event-list");
  list.replaceChildren();
  const events = state.events.slice(0, 16);
  if (!events.length) {
    const detail = append(node("div"), node("b", { text: "Ready" }), document.createTextNode("Your first request will create a visible action trail here."));
    append(list, append(node("li"), node("time", { text: "NOW" }), node("span", { className: "dot" }), detail));
    return;
  }
  events.forEach((event) => {
    const detail = append(node("div"), node("b", { text: labels[event.kind] || event.kind }), document.createTextNode(event.message || ""));
    append(list, append(node("li"), node("time", { text: time(event.created_at) }), node("span", { className: "dot" }), detail));
  });
}

function renderConnectors() {
  const list = $("#connector-list");
  list.replaceChildren();
  for (const item of state.meta.connectors || []) {
    append(list, append(node("li"),
      node("span", { text: item.name }),
      node("small", { className: item.status, text: String(item.status || "unknown").replaceAll("_", " ") }),
      node("em", { text: item.detail || "" })
    ));
  }
}

function renderTelemetry() {
  const telemetry = state.meta.telemetry || {};
  const toggle = $("#telemetry-toggle");
  toggle.checked = Boolean(telemetry.enabled);
  toggle.disabled = !telemetry.available;
  if (!telemetry.available) {
    $("#telemetry-detail").textContent = "Unavailable in this build. No metrics leave this Mac.";
  } else if (telemetry.enabled) {
    $("#telemetry-detail").textContent = `Sharing aggregate counters with ${telemetry.endpointOrigin}. ${telemetry.pendingEvents || 0} local events are waiting.`;
  } else {
    $("#telemetry-detail").textContent = "Off. Enabling this shares aggregate workflow and reliability counters only.";
  }
}

function render() {
  const pending = state.actions.filter((action) => action.status === "approval");
  const badge = $("#approval-badge");
  badge.textContent = pending.length;
  badge.hidden = pending.length === 0;
  badge.style.display = pending.length ? "grid" : "none";
  $("#approval-count").textContent = `${pending.length} waiting`;
  renderApprovals(pending);
  renderEvents();
  renderConnectors();
  renderTelemetry();

  const plannerLabels = { openai: `${state.meta.model} planner`, codex: "Codex planner · read-only", fallback: "Deterministic fallback" };
  $("#mode-label").textContent = plannerLabels[state.meta.mode] || state.meta.model || "Planner ready";
  $("#rail-mode").textContent = state.meta.mode === "fallback" ? "Limited planner" : "Planner online";

  const message = state.meta.imessage || {};
  const setup = $("#imessage-setup");
  setup.hidden = false;
  $("#pairing-command").hidden = !message.pairingCode;
  $("#copy-pairing").hidden = !message.pairingCode;
  $("#reset-pairing").hidden = !message.paired;
  if (message.pairingCode) $("#pairing-command").textContent = `KSTACK PAIR ${message.pairingCode}`;
  else $("#pairing-command").textContent = "";
  if (message.status === "permission_required") {
    $("#imessage-title").textContent = "Allow message access";
    $("#imessage-detail").textContent = "Open System Settings → Privacy & Security → Full Disk Access, enable K-Stack and the Node executable that runs it, then restart K-Stack. After that, send the pairing command from the one iMessage chat you want to authorize.";
  } else if (message.paired) {
    $("#imessage-title").textContent = "Private chat paired";
    $("#imessage-detail").textContent = "Only the paired one-to-one chat and messages beginning with KSTACK are accepted.";
  } else {
    $("#imessage-title").textContent = "Pair your phone";
    $("#imessage-detail").textContent = "Send this exact command from the one-to-one iMessage conversation you want K-Stack to trust.";
  }
}

async function refresh() {
  const response = await fetch("/api/state");
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Could not load K-Stack state.");
  Object.assign(state, data);
  render();
}

function toast(message) {
  const target = $("#toast");
  target.textContent = message;
  target.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => target.classList.remove("show"), 3000);
}

$("#composer").addEventListener("submit", async (event) => {
  event.preventDefault();
  const prompt = $("#prompt").value.trim();
  if (!prompt) return;
  const button = $(".submit");
  button.disabled = true;
  button.querySelector("span").textContent = "Planning…";
  try {
    const response = await fetch("/api/tasks", { method: "POST", headers: mutationHeaders, body: JSON.stringify({ prompt }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Request failed");
    Object.assign(state, data);
    $("#prompt").value = "";
    render();
    toast(state.tasks[0]?.summary || "Request planned.");
  } catch (error) { toast(error.message); }
  finally { button.disabled = false; button.querySelector("span").textContent = "Run request"; }
});

$("#approval-list").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-decision]");
  if (!button) return;
  button.disabled = true;
  try {
    const response = await fetch(`/api/actions/${encodeURIComponent(button.dataset.id)}/${button.dataset.decision}`, { method: "POST", headers: mutationHeaders, body: "{}" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Decision failed");
    Object.assign(state, data);
    render();
    const decided = state.actions.find((action) => action.id === button.dataset.id);
    toast(decided?.result?.message || (button.dataset.decision === "approve" ? "Approved and completed." : "Rejected. Nothing was changed."));
  } catch (error) { toast(error.message); button.disabled = false; }
});

document.querySelectorAll("[data-prompt]").forEach((button) => button.addEventListener("click", () => {
  $("#prompt").value = button.dataset.prompt;
  $("#prompt").focus();
}));

$("#copy-pairing").addEventListener("click", async () => {
  await navigator.clipboard.writeText($("#pairing-command").textContent);
  toast("Pairing command copied.");
});

$("#reset-pairing").addEventListener("click", async () => {
  const response = await fetch("/api/imessage/reset", { method: "POST", headers: mutationHeaders, body: "{}" });
  const data = await response.json();
  if (!response.ok) return toast(data.error || "Could not reset pairing.");
  Object.assign(state, data);
  render();
  toast("iMessage pairing reset.");
});

$("#telemetry-toggle").addEventListener("change", async (event) => {
  const enabled = event.target.checked;
  event.target.disabled = true;
  try {
    const response = await fetch("/api/telemetry/consent", { method: "POST", headers: mutationHeaders, body: JSON.stringify({ enabled }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not change metrics consent.");
    Object.assign(state, data);
    render();
    toast(enabled ? "Anonymous aggregate metrics enabled." : "Metrics disabled and unsent counters deleted.");
  } catch (error) {
    event.target.checked = !enabled;
    toast(error.message);
  } finally {
    event.target.disabled = !(state.meta.telemetry || {}).available;
  }
});

$("#date-label").textContent = new Intl.DateTimeFormat(undefined, { month: "short", day: "2-digit" }).format(new Date()).toUpperCase();

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
if (Recognition) {
  const recognition = new Recognition();
  recognition.interimResults = true;
  recognition.continuous = false;
  recognition.onstart = () => { $("#voice").classList.add("listening"); $("#voice").lastChild.textContent = " Listening"; };
  recognition.onend = () => { $("#voice").classList.remove("listening"); $("#voice").lastChild.textContent = " Talk"; };
  recognition.onresult = (event) => { $("#prompt").value = [...event.results].map((result) => result[0].transcript).join(""); };
  $("#voice").addEventListener("click", () => recognition.start());
} else {
  $("#voice").addEventListener("click", () => toast("Voice dictation is not available in this browser."));
}

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
refresh().catch((error) => toast(error.message));
