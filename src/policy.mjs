const TOOL_POLICY = Object.freeze({
  "research.collect": { level: "auto", label: "Research sources" },
  "note.save": { level: "auto", label: "Save a private note" },
  "email.draft": { level: "auto", label: "Prepare an email draft" },
  "calendar.list": { level: "auto", label: "Read upcoming calendar events" },
  "calendar.create": { level: "approval", label: "Create a calendar event" },
  "email.send": { level: "approval", label: "Send an email" },
  "home.run_shortcut": { level: "approval", label: "Run an allowlisted Apple Shortcut" },
  "ssh.status": { level: "approval", label: "Check an allowlisted SSH target" },
  "harness.delegate": { level: "approval", label: "Delegate to the WINCH harness control plane" },
  "system.none": { level: "auto", label: "Answer without an action" }
});

const BLOCKED_PATTERNS = [
  { pattern: /\b(bypass|circumvent|break into|hack)\b/i, reason: "This request asks C-Plug to bypass an access or authorization boundary." },
  { pattern: /\b(steal|phish|credential stuffing|malware|ransomware)\b/i, reason: "This request would facilitate harmful or unauthorized activity." },
  { pattern: /\bspam\b|email\s+(everyone|thousands|a list)/i, reason: "Bulk unsolicited outreach is not an allowed action." },
  { pattern: /\b(full|sold out)\b.{0,80}\b(don'?t care|figure it out|put me in|get me in)\b/i, reason: "C-Plug will not override a full booking or displace another person." }
];

export function inspectRequest(text) {
  const normalized = String(text ?? "").trim();
  if (!normalized) return { allowed: false, reason: "Enter a request first." };
  if (normalized.length > 4_000) return { allowed: false, reason: "Requests are limited to 4,000 characters." };
  const emailContext = /\b(email|mail|message|inbox)\b/i.test(normalized);
  const emailObject = /\b(link|url|attachment)\b/i.test(normalized);
  const openAction = /\b(click|open|visit|follow|preview|fetch|download)\b/i.test(normalized);
  if (emailContext && emailObject && openAction) return { allowed: false, reason: "C-Plug never opens links or attachments from email." };
  const match = BLOCKED_PATTERNS.find(({ pattern }) => pattern.test(normalized));
  return match ? { allowed: false, reason: match.reason } : { allowed: true };
}

export function classifyAction(action) {
  const policy = TOOL_POLICY[action?.tool];
  if (!policy) {
    return { level: "blocked", label: "Unknown action", reason: `Tool ${action?.tool || "(missing)"} is not registered.` };
  }
  return { ...policy, reason: policy.level === "approval" ? "This action changes an external system or contacts another person." : null };
}

export function toolCatalog() {
  return Object.entries(TOOL_POLICY).map(([tool, policy]) => ({ tool, ...policy }));
}

export function securityInvariants() {
  return Object.freeze({
    emailReadsEnabled: false,
    emailLinkOpeningEnabled: false,
    emailAttachmentOpeningEnabled: false
  });
}
