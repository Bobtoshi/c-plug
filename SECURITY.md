# Security policy

K-Stack can operate Mail, Calendar, Messages, Shortcuts, and allowlisted SSH targets using the permissions of the local macOS account. Treat every connector as security-sensitive.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability or include credentials, message content, task prompts, database files, pairing codes, or screenshots containing personal data.

Use GitHub's private vulnerability reporting feature for this repository. Include the affected version, reproduction steps using synthetic data, impact, and any proposed mitigation. Maintainers should acknowledge a complete report within seven days.

## Supported versions

Only the latest release on the default branch receives security fixes during the pre-1.0 period.

## Security boundaries

- The HTTP service is loopback-only and rejects non-loopback Host and cross-site mutation requests.
- Unknown tools fail closed. External changes require an explicit approval immediately before execution.
- Email bodies, email links, and email attachments are outside the supported trust boundary.
- The iMessage connector is macOS-only, reads Apple's local Messages database with user-granted Full Disk Access, accepts one paired one-to-one chat, and requires the `KSTACK` prefix.
- The WhatsApp connector uses Meta's official Cloud API, verifies every webhook with the configured app secret, accepts one exact owner number, deduplicates message IDs, and requires the `KSTACK` prefix. A reverse proxy should expose only `/api/whatsapp/webhook` over HTTPS and rewrite the upstream Host header.
- Credentials remain in the operating system, local configuration, or environment. They must never be copied into issues, telemetry, fixtures, or the SQLite ledger.
- SSH is limited to exact non-wildcard aliases already present in the user's SSH configuration and executes one fixed read-only status command.
- Community telemetry is optional, aggregate-only, and disabled until explicit consent. See [PRIVACY.md](PRIVACY.md).

## Maintainer release requirements

Before publishing a release, run `npm test` and `npm run check:public`, review the complete Git diff, scan the entire Git history for secrets, and build the release archive from tracked files only.
