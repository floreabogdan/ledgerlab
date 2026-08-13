# LedgerLab documentation

This directory contains the operator and contributor documentation shipped with LedgerLab.

## Use and operate LedgerLab

- [Getting started](getting-started.md) — first local run and first workspace
- [Configuration](configuration.md) — environment variables and runtime behavior
- [Deployment](deployment.md) — Docker, persistent storage, reverse proxies, TLS, and upgrades
- [Backups and recovery](backups-and-recovery.md) — safe exports, database backups, restores, and disaster recovery
- [Troubleshooting](troubleshooting.md) — common startup, sign-in, proxy, database, and FX problems

## Understand and develop LedgerLab

- [Data model](data-model.md) — accounting semantics and invariants
- [Architecture](architecture.md) — application layers, persistence, and request flow
- [Internationalization](internationalization.md) — language packs, translation conventions, and structured API errors
- [Contributing](../CONTRIBUTING.md) — development workflow and pull-request expectations
- [Security policy](../SECURITY.md) — supported versions, deployment assumptions, and private reporting
- [Release process](release-checklist.md) — maintainer verification and publishing guidance

Documentation should describe behavior that exists in the same revision. If a code change alters setup, configuration, an invariant, or an operator workflow, update the relevant document in the same pull request.
