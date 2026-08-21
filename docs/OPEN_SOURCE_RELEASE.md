# Open-source release checklist

- [ ] Build from a fresh checkout, never from a live runtime directory.
- [ ] Confirm `data/`, `.env*`, logs, screenshots, test traces, archives, and editor files are untracked.
- [ ] Run `npm test` and `npm run check:public`.
- [ ] Run GitHub secret scanning and review the entire Git history, not only the current tree.
- [ ] Review every new connector against `SECURITY.md` and `PRIVACY.md`.
- [ ] Use synthetic data for screenshots and demonstrations.
- [ ] Confirm telemetry is off by default and its payload still matches `PRIVACY.md`.
- [ ] Enable private vulnerability reporting, Dependabot, secret scanning, push protection, and code scanning in repository settings.
- [ ] Tag the exact tested commit and attach checksums to release artifacts.

Do not publish the local `outputs/` archives as releases. Generate a fresh archive from tracked files after the repository is initialized.
