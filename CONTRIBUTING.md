# Contributing

C-Plug is an early security-sensitive project. Small, auditable changes with tests are preferred.

1. Create an issue describing the user outcome and trust-boundary impact.
2. Never use real messages, addresses, credentials, calendars, SSH hosts, or task history in fixtures or screenshots.
3. Keep new connectors narrow: deterministic input validation, least privilege, preview, explicit approval for side effects, a receipt, and idempotency where possible.
4. Run `npm test` and `npm run check:public`.
5. Explain privacy, migration, and rollback implications in the pull request.

Security reports must follow [SECURITY.md](SECURITY.md), not public issues.
