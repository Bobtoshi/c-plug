# Community metrics collector contract

K-Stack clients do not send metrics unless an HTTPS endpoint is configured and the local user explicitly opts in. The collector is a separate service and is not included in this repository.

## Useful measurements

The allowlisted counters support:

- daily active installations, using a pseudonym that rotates each UTC day;
- request-channel share (`web` or `imessage`);
- planner-mode and fallback rates;
- bounded tool demand by tool identifier;
- approval/rejection rates;
- completion, blocking, and failure rates.

They cannot support prompt analysis, user profiling, contact graphs, longitudinal device tracking, content inspection, or connector-target analysis.

## Collector requirements

An official collector must:

1. accept HTTPS `POST` only and cap request bodies at 32 KB;
2. reject unknown top-level fields, events, dimensions, runtime fields, and counter names;
3. validate `schema`, `period`, version lengths, numeric counter ranges, and identifier formats;
4. deduplicate by `batchId` and expire that deduplication state;
5. aggregate reports promptly and delete raw payloads on a documented short schedule;
6. disable request-body, query-string, and source-IP logging at every proxy and application layer;
7. never enrich, sell, join, fingerprint, or repurpose the reports;
8. publish retention, deletion, incident-response, and operator contact information before accepting production data;
9. provide a public endpoint health page without exposing payloads;
10. treat client reports as untrusted data and never render counter keys as HTML.

The authoritative client allowlist is `telemetryContract` in `src/telemetry.mjs`. Changing it requires corresponding tests and updates to [PRIVACY.md](../PRIVACY.md).
