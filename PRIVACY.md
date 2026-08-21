# Privacy

C-Plug is local-first. Task prompts, action payloads, approval codes, connector results, messages, email addresses, calendar details, hostnames, shortcut names, and credentials are not community telemetry.

## Local data

The local SQLite ledger contains task prompts and action details. Its directory is restricted to the local user, and task history is pruned after 30 days by default. Set `CPLUG_RETENTION_DAYS` to another value from 1 to 3650, or to 0 to disable automatic pruning.

The iMessage bridge needs Full Disk Access to read Apple's local Messages database. Before pairing, it searches new one-to-one messages for the exact pairing command. After pairing, reads are restricted to the paired chat. Unrelated message bodies are not written to C-Plug's ledger or telemetry.

The optional WhatsApp channel uses Meta's official Cloud API. Meta processes the messages under the operator's Meta account terms. C-Plug accepts signed webhooks only, ignores senders other than the configured owner number, stores only a bounded set of processed message IDs for deduplication, and sends accepted command text into the same local task ledger as web and iMessage requests.

## Optional community metrics

Metrics are unavailable unless the operator configures `CPLUG_TELEMETRY_ENDPOINT` with an HTTPS URL. Even then, collection is off until the local user explicitly enables it in the control room. Disabling it deletes unsent counters and queued reports.

Each report contains only:

- telemetry schema and application version;
- a one-use random batch identifier for retry deduplication;
- a pseudonymous identifier that rotates every UTC day, allowing daily active-install estimates without cross-day linkage;
- UTC calendar day;
- operating-system family, CPU architecture, and Node.js major version;
- aggregate counters for request channel, planner mode, tool type, approval gate, decision, and completion outcome.

The daily identifier is derived locally from a random seed, changes each UTC day, and the seed is deleted when metrics are disabled. Reports contain no stable installation or user identifier. The receiving service can still observe transport metadata such as the source IP address; an official collector must avoid retaining or enriching that metadata.

The complete allowlist is exported as `telemetryContract` from `src/telemetry.mjs`. Unknown events and dimension values are discarded or mapped to `unknown`; arbitrary fields cannot enter a report.

## Never collected

- prompts, summaries, titles, notes, email content, recipients, or addresses;
- iMessage handles, WhatsApp numbers, chat identifiers, message text, or pairing and approval codes;
- calendar event content;
- URLs, attachments, hostnames, IP targets, SSH output, or shortcut names;
- credentials, API keys, cookies, private keys, or environment variables;
- precise event timestamps or stable device fingerprints.
