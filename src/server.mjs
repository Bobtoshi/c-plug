import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Agent } from "./agent.mjs";
import { ConnectorRegistry } from "./connectors.mjs";
import { loadEnv } from "./env.mjs";
import { IMessageBridge } from "./imessage.mjs";
import { Planner } from "./planner.mjs";
import { providerFromEnv } from "./providers.mjs";
import { Store } from "./store.mjs";
import { Telemetry } from "./telemetry.mjs";
import { WhatsAppBridge } from "./whatsapp.mjs";
import { WinchClient } from "./winch-client.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
loadEnv(path.join(root, ".env"));

const publicDir = path.join(root, "public");
const port = Number(process.env.CPLUG_PORT || 4317);
const host = process.env.CPLUG_HOST || "127.0.0.1";
const loopbackHosts = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("CPLUG_PORT must be a valid TCP port.");
if (!loopbackHosts.has(host.toLowerCase())) throw new Error("C-Plug only binds to loopback. Remote access requires a separately authenticated proxy.");
const store = new Store(path.join(root, "data", "cplug.sqlite"));
store.prune(Number(process.env.CPLUG_RETENTION_DAYS || 30));
const packageInfo = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const planner = new Planner({ provider: providerFromEnv(process.env), codexEnabled: process.env.CPLUG_CODEX_PLANNER === "1", codexModel: process.env.CPLUG_CODEX_MODEL || "gpt-5.6-luna" });
const winchClient = new WinchClient({
  enabled: process.env.CPLUG_WINCH_ENABLED === "1",
  baseUrl: process.env.CPLUG_WINCH_URL || "http://127.0.0.1:4321",
  token: process.env.CPLUG_WINCH_TOKEN || ""
});
const connectors = new ConnectorRegistry({ liveEnabled: process.env.CPLUG_LIVE_CONNECTORS === "1", winchClient });
const telemetry = new Telemetry({ store, endpoint: process.env.CPLUG_TELEMETRY_ENDPOINT || "", version: packageInfo.version });
const agent = new Agent({ store, planner, connectors, telemetry });
const imessage = new IMessageBridge({ store, agent, enabled: process.env.CPLUG_IMESSAGE_ENABLED === "1" });
const whatsapp = new WhatsAppBridge({
  store,
  agent,
  enabled: process.env.CPLUG_WHATSAPP_ENABLED === "1",
  verifyToken: process.env.CPLUG_WHATSAPP_VERIFY_TOKEN,
  appSecret: process.env.CPLUG_WHATSAPP_APP_SECRET,
  accessToken: process.env.CPLUG_WHATSAPP_ACCESS_TOKEN,
  phoneNumberId: process.env.CPLUG_WHATSAPP_PHONE_NUMBER_ID,
  ownerNumber: process.env.CPLUG_WHATSAPP_OWNER_NUMBER,
  apiVersion: process.env.CPLUG_WHATSAPP_API_VERSION
});

const mime = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml" };

const securityHeaders = Object.freeze({
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "cross-origin-resource-policy": "same-origin",
  "cross-origin-opener-policy": "same-origin",
  "permissions-policy": "camera=(), geolocation=(), microphone=(self)",
  "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; require-trusted-types-for 'script'; trusted-types cplug"
});

function json(res, status, responseBody) {
  res.writeHead(status, { ...securityHeaders, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(responseBody));
}

function assertLocalRequest(req) {
  let authority;
  try { authority = new URL(`http://${req.headers.host || ""}`); }
  catch { throw Object.assign(new Error("Invalid Host header."), { statusCode: 400 }); }
  const hostname = authority.hostname.toLowerCase();
  const requestPort = Number(authority.port || 80);
  if (!loopbackHosts.has(hostname) || requestPort !== port) throw Object.assign(new Error("Host is not allowed."), { statusCode: 403 });

  if (req.method === "POST") {
    if (req.headers["x-cplug-request"] !== "1") throw Object.assign(new Error("Missing local request header."), { statusCode: 403 });
    if (!String(req.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
      throw Object.assign(new Error("JSON content type required."), { statusCode: 415 });
    }
    if (req.headers["sec-fetch-site"] === "cross-site") throw Object.assign(new Error("Cross-site requests are not allowed."), { statusCode: 403 });
    if (req.headers.origin) {
      let origin;
      try { origin = new URL(req.headers.origin); }
      catch { throw Object.assign(new Error("Invalid Origin header."), { statusCode: 403 }); }
      if (!loopbackHosts.has(origin.hostname.toLowerCase()) || Number(origin.port || 80) !== port) {
        throw Object.assign(new Error("Origin is not allowed."), { statusCode: 403 });
      }
    }
  }
}

async function readRawBody(req, limit = 32_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error("Request body too large."), { statusCode: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readBody(req) {
  const raw = await readRawBody(req);
  try { return JSON.parse(raw.toString("utf8") || "{}"); }
  catch { throw Object.assign(new Error("Invalid JSON body."), { statusCode: 400 }); }
}

function stateResponse() {
  const plannerStatus = planner.status();
  const imessageStatus = imessage.status();
  const whatsappStatus = whatsapp.status();
  return {
    ...store.state(),
    meta: {
      mode: plannerStatus.mode,
      model: plannerStatus.label,
      connectors: connectors.status(plannerStatus, imessageStatus, whatsappStatus),
      imessage: imessageStatus,
      whatsapp: whatsappStatus,
      telemetry: telemetry.status()
    }
  };
}

async function handleWhatsApp(req, res, url) {
  if (req.method === "GET") {
    const challenge = whatsapp.verifyChallenge(url.searchParams);
    res.writeHead(200, { ...securityHeaders, "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
    res.end(challenge);
    return;
  }
  if (req.method === "POST") {
    if (!String(req.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
      throw Object.assign(new Error("JSON content type required."), { statusCode: 415 });
    }
    const raw = await readRawBody(req, 256_000);
    const accepted = whatsapp.acceptWebhook(raw, req.headers["x-hub-signature-256"]);
    return json(res, 200, { accepted: true, commands: accepted });
  }
  res.writeHead(405, { ...securityHeaders, allow: "GET, POST", "cache-control": "no-store" });
  res.end();
}

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/state") return json(res, 200, stateResponse());
  if (req.method === "POST" && url.pathname === "/api/tasks") {
    const data = await readBody(req);
    await agent.createTask(data.prompt, { source: "web" });
    return json(res, 201, stateResponse());
  }
  if (req.method === "POST" && url.pathname === "/api/imessage/reset") {
    imessage.resetPairing();
    return json(res, 200, stateResponse());
  }
  if (req.method === "POST" && url.pathname === "/api/telemetry/consent") {
    const data = await readBody(req);
    telemetry.setConsent(data.enabled);
    return json(res, 200, stateResponse());
  }
  const decision = url.pathname.match(/^\/api\/actions\/([^/]+)\/(approve|reject)$/);
  if (req.method === "POST" && decision) {
    await agent.decide(decision[1], decision[2]);
    return json(res, 200, stateResponse());
  }
  return json(res, 404, { error: "API route not found." });
}

function serveStatic(req, res, pathname) {
  if (req.method !== "GET") {
    res.writeHead(405, { ...securityHeaders, allow: "GET", "cache-control": "no-store" });
    res.end();
    return;
  }
  const requested = pathname === "/" ? "/index.html" : pathname;
  const resolved = path.resolve(publicDir, `.${requested}`);
  if (!resolved.startsWith(`${publicDir}${path.sep}`) || !fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) return json(res, 404, { error: "Not found." });
  res.writeHead(200, {
    ...securityHeaders,
    "content-type": mime[path.extname(resolved)] || "application/octet-stream",
    "cache-control": requested === "/index.html" ? "no-cache" : "public, max-age=3600"
  });
  fs.createReadStream(resolved).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    if (!req.url?.startsWith("/")) throw Object.assign(new Error("Invalid request target."), { statusCode: 400 });
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if (url.pathname === "/api/whatsapp/webhook") return await handleWhatsApp(req, res, url);
    assertLocalRequest(req);
    if (url.pathname.startsWith("/api/")) await handleApi(req, res, url);
    else serveStatic(req, res, url.pathname);
  } catch (error) {
    if (!error.statusCode) console.error("C-Plug request failed with an internal error.");
    json(res, error.statusCode || 500, { error: error.statusCode ? error.message : "Internal server error." });
  }
});

server.requestTimeout = 15_000;
server.headersTimeout = 10_000;
server.keepAliveTimeout = 5_000;
server.on("clientError", (_error, socket) => {
  if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
});

server.listen(port, host, () => {
  const plannerStatus = planner.status();
  const messageStatus = imessage.status();
  console.log(`C-Plug is running at http://${host}:${port}`);
  console.log(`Planner: ${plannerStatus.label}`);
  console.log(`iMessage: ${messageStatus.status}`);
  console.log(`WhatsApp: ${whatsapp.status().status}`);
  imessage.start();
  telemetry.schedule(10_000);
});

function shutdown() {
  imessage.stop();
  telemetry.stop();
  server.close(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
