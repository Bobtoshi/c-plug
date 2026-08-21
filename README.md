# C-Plug

C-Plug is a universal, local-first personal AI operator for macOS. It connects the user's chosen AI provider to typed, bounded actions; accepts requests from its local control room, iMessage, or WhatsApp; prepares low-risk work locally; and pauses consequential actions for explicit approval.

When paired with [WINCH](https://github.com/Bobtoshi/winch), C-Plug can also delegate work across multiple AI harnesses, preserve fallbacks, request an independent verification pass, and return separately namespaced action approvals to the same message conversation.

This is early community software, not a hosted service. Start in safe local mode, inspect the proposed actions, and enable only the connectors you understand.

## Safety model

The default checkout has no live connectors, iMessage bridge, WhatsApp bridge, external AI planner, or telemetry enabled. It binds only to loopback and uses a deterministic fallback planner.

- Unknown tools fail closed.
- Calendar creation, email sending, Shortcuts, and SSH status checks require approval.
- Mail bodies cannot be read. Mail links and attachments cannot be opened, fetched, previewed, followed, or downloaded.
- SSH accepts only exact non-wildcard aliases already present in `~/.ssh/config` and runs one fixed read-only status command.
- Messages commands require one paired one-to-one chat and the `CPLUG` prefix.
- WhatsApp commands require Meta's signed Cloud API webhook, one exact owner number, and the `CPLUG` prefix.
- Local task history is pruned after 30 days by default.
- Optional community metrics are aggregate-only, off by default, and exclude user content and stable installation IDs.

Read [SECURITY.md](SECURITY.md) and [PRIVACY.md](PRIVACY.md) before enabling integrations.

## Run the safe local mode

Requires macOS and Node.js 22.5 or newer.

```bash
npm run setup
npm start
```

Open `http://127.0.0.1:4317`. Safe mode can save private local notes and demonstrate planning and approval behavior without operating macOS applications.

Run the checks with:

```bash
npm test
npm run check:public
```

## Enable selected capabilities

`npm run setup` creates an owner-only `.env` file. Review every setting and opt in deliberately:

```dotenv
CPLUG_AI_PROVIDER=anthropic
CPLUG_AI_MODEL=claude-your-model
CPLUG_AI_API_KEY=your-local-key
CPLUG_LIVE_CONNECTORS=1
CPLUG_IMESSAGE_ENABLED=1
CPLUG_SHORTCUTS=Prepare Office,Prepare Gaming
```

Paste any supported service key into `CPLUG_AI_API_KEY`. Alternatively, `CPLUG_AI_API_KEY_ENV` can name any uppercase environment variable such as `ANTHROPIC_API_KEY` or `OPENROUTER_API_KEY`. The key remains server-side and is never returned to the browser, message channels, ledger, or telemetry.

Supported provider shapes:

| `CPLUG_AI_PROVIDER` | Typical services | Endpoint behavior |
| --- | --- | --- |
| `openai-responses` | OpenAI Responses API | Defaults to OpenAI's Responses endpoint and requests strict JSON schema output. |
| `openai-compatible` | OpenAI Chat Completions, OpenRouter, Groq, Together, Ollama and compatible servers | Set `CPLUG_AI_BASE_URL` to the exact chat-completions endpoint. Loopback HTTP is allowed for local models; every other endpoint requires HTTPS. |
| `anthropic` | Anthropic Messages API | Defaults to Anthropic's Messages endpoint and uses the configured key as `x-api-key`. |
| `gemini` | Google Gemini generateContent | Builds the official model endpoint and uses the configured key as `x-goog-api-key`. |

Set `CPLUG_CODEX_PLANNER=1` instead to use an already-authenticated Codex CLI as an ephemeral, schema-constrained planner in an empty temporary directory with a read-only sandbox. If neither mode is configured, C-Plug uses its deterministic fallback.

`CPLUG_LIVE_CONNECTORS=1` enables the Calendar, Mail, Shortcuts, and SSH adapters as a group. Action-level approval rules still apply. Review `src/policy.mjs` and `src/connectors.mjs` first.

## Connect the WINCH harness plane

This optional bridge combines C-Plug's iMessage, WhatsApp, voice, and personal-operator surface with WINCH's cross-harness routing and provider-independent action broker.

1. Run WINCH on its default loopback address.
2. Generate a shared secret with `openssl rand -hex 32`.
3. Put that value in WINCH's private `.env` as `WINCH_BRIDGE_TOKEN`.
4. Put the same value in C-Plug's private `.env` as `CPLUG_WINCH_TOKEN`, then set `CPLUG_WINCH_ENABLED=1`.
5. Restart both services.

The secret never enters either SQLite ledger or the UI. C-Plug accepts only an uncredentialed loopback HTTP origin and WINCH accepts only authenticated loopback bridge requests. Delegating an intent always requires a C-Plug approval because it can disclose that intent to an external AI provider. That approval authorizes only the harness dispatch. Every file write, API request, message, device action, or other WINCH proposal receives a separate `W123456` approval code.

Example:

```text
CPLUG ask my best coding harness to review the parser and independently verify the answer
CPLUG APPROVE 123456
CPLUG APPROVE W654321
```

Use language such as “ask all my AIs,” “form a council,” or “reach consensus” to make WINCH run independent adviser harnesses in parallel before its verifier synthesizes the result. Adviser outputs cannot create additional actions; only the primary proposal enters the typed action gate.

## Pair iMessage

1. Set `CPLUG_IMESSAGE_ENABLED=1` and restart C-Plug.
2. Open the control room. If access is required, grant Full Disk Access to C-Plug and the exact Node executable running it.
3. Send the displayed `CPLUG PAIR 123456` command from the one-to-one conversation you want to authorize.
4. Send `CPLUG` followed by a request.
5. For a consequential action, reply with the exact `CPLUG APPROVE 123456` or `CPLUG REJECT 123456` command.

Before pairing, C-Plug searches only new one-to-one Messages rows for the pairing command. After pairing, database reads are restricted to that chat. Unrelated message bodies are not stored in C-Plug or included in telemetry.

The Messages database is an Apple implementation detail and may change between macOS releases. This connector is distributed directly and is not represented as a public Apple messaging API.

## Connect WhatsApp

C-Plug supports the official WhatsApp Cloud API. It does not automate WhatsApp Web or scrape private chats.

1. Create a Meta app with WhatsApp Cloud API access and configure a dedicated business phone number.
2. Set all `CPLUG_WHATSAPP_*` values from `.env.example`, including one exact owner number and a currently supported Graph API version.
3. Expose only `/api/whatsapp/webhook` through an HTTPS reverse proxy or tunnel. Keep every other C-Plug route loopback-only and rewrite the upstream Host header to `127.0.0.1:4317`.
4. Register the HTTPS webhook URL and verify token with Meta, subscribe to message events, and restart C-Plug.
5. Send `CPLUG STATUS` or `CPLUG` followed by a request from the configured owner number.

Every POST webhook is authenticated with `X-Hub-Signature-256` before its JSON is parsed. Other senders and duplicate message IDs are ignored. Consequential actions return the same six-digit approval flow as iMessage.

## Keep it running after login

After configuring `.env`:

```bash
chmod +x scripts/install-launch-agent.sh
./scripts/install-launch-agent.sh
```

The installer copies a private runtime to `~/Library/Application Support/CPlug`, preserves local data across updates, restricts the runtime and database directories to the current user, and registers `com.cplug.agent` as a LaunchAgent.

## Optional community insights

Maintainers can configure an HTTPS collector with `CPLUG_TELEMETRY_ENDPOINT`. That only makes the consent control available; nothing is collected until the local user enables it in the control room.

Useful aggregate counters include:

- which bounded tool types are proposed;
- daily active-install estimates using a daily rotating pseudonym;
- web, iMessage, or WhatsApp request channel;
- planner mode and fallback frequency;
- approval versus rejection rates;
- connector completion and failure rates.

No prompts, messages, recipients, calendar content, URLs, hostnames, credentials, results, precise timestamps, or stable installation identifiers are accepted by the telemetry schema. Disabling metrics deletes unsent counters. See [PRIVACY.md](PRIVACY.md) for the exact payload and transport caveat.

## What works

- Phone-first local control room and browser voice dictation
- Deterministic fallback, authenticated Codex CLI, or universal API-provider planning
- Server-enforced approval gates and SQLite action receipts
- Paired iMessage and owner-allowlisted WhatsApp commands with six-digit approvals
- Calendar reads and approved event creation
- Mail drafts and approved sending
- Exact allowlisted Apple Shortcuts
- Fixed read-only SSH status checks
- Authenticated cross-harness delegation through WINCH, with independent verification and separately approved actions
- Installable PWA shell and LaunchAgent installer

Live research collection is intentionally not connected yet.

C-Plug is not an unrestricted shell and cannot literally do everything. It can perform any operation implemented as a typed connector that satisfies the connector contract below. Apple Shortcuts provide a practical extension path for personal workflows without granting incoming messages arbitrary command execution.

## Connector contract

Every new connector must provide:

1. least-privilege credentials stored outside SQLite;
2. deterministic input validation and a preview;
3. explicit approval immediately before an external side effect;
4. a receipt written to the local ledger;
5. idempotency and rollback where the provider supports them;
6. no expansion of community telemetry beyond the documented aggregate allowlist.

## Open-source releases

C-Plug is licensed under the GNU Affero General Public License v3.0 only. See [LICENSE](LICENSE).

Never publish a live runtime folder. Build releases from a fresh checkout and follow [the release checklist](docs/OPEN_SOURCE_RELEASE.md). Security reports belong in GitHub private vulnerability reporting, not public issues.
