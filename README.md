# LedgerLab

[![CI](https://github.com/floreabogdan/ledgerlab/actions/workflows/ci.yml/badge.svg)](https://github.com/floreabogdan/ledgerlab/actions/workflows/ci.yml)
[![License: AGPL v3](https://img.shields.io/badge/license-AGPL--3.0--only-2563eb.svg)](LICENSE)

LedgerLab is a self-hosted personal finance workspace for people who want detailed planning without handing their financial history to a third-party service.

It brings accounts, transactions, future obligations, budgets, forecasts, liabilities, statistics, imports, and backups into one focused application. LedgerLab keeps planned, pending, and actual money separate and stores monetary values as integers rather than floating-point numbers.

> [!IMPORTANT]
> LedgerLab contains sensitive financial and authentication data. Claim a new installation before exposing it publicly, use HTTPS, and keep verified backups. Review the [deployment notes](docs/deployment.md) and [security model](SECURITY.md).

## What it covers

- Current, savings, cash, investment, credit-card, loan, and custom accounts
- Income, expenses, refunds, adjustments, atomic transfers, split categories, tags, and merchants
- One-time and recurring planned payments with partial payment, skip, cancel, pay, and undo workflows
- Monthly budgets, scenarios, cash-flow forecasts, projected low points, and planned-versus-actual comparisons
- Credit limits, statements, repayments, and utilization for credit cards
- Fixed and indexed loan terms, rate histories, schedules, payment allocation, and liability tracking
- Date-range statistics, trends, runway estimates, recurring commitments, and calculation explanations
- CSV import with preview and duplicate handling, CSV/JSON export, and verified full backup/restore
- Native-currency accounts, cross-currency transfers, and a separate profile reporting currency, with dated BNR reference-rate snapshots and manual rate overrides
- Responsive desktop and mobile layouts, accessible controls, and keyboard-friendly entry

LedgerLab is a personal finance tool, not an accounting, tax, lending, or investment service. Its projections and suggestions are informational and are never guarantees or financial advice.

## Quick start

You need a current [Docker Engine](https://docs.docker.com/engine/install/). The named volume in this example keeps the database, uploaded receipts, and cached exchange rates when the container or image is replaced.

```bash
docker pull ghcr.io/floreabogdan/ledgerlab:latest
docker volume create ledgerlab-data
docker run --detach --name ledgerlab --restart unless-stopped --publish 3000:3000 --env REGISTRATION_MODE=first-user --mount source=ledgerlab-data,target=/app/data ghcr.io/floreabogdan/ledgerlab:latest
```

Open <http://localhost:3000>, create the installation owner, and add your first financial account. The database starts empty; demo records are never added automatically. Removing or rebuilding the container does not remove the `ledgerlab-data` volume. Do not run `docker volume rm ledgerlab-data` unless you intend to permanently delete the installation data.

Registration defaults to `first-user`: the first account becomes the installation owner and registration then closes automatically. Claim a new installation from a trusted device or network before exposing it publicly. See [configuration](docs/configuration.md#registration-policy) for intentionally open or fully closed modes.

To build the same image from a checkout instead of pulling it:

```bash
docker build --tag ledgerlab:local .
docker volume create ledgerlab-data
docker run --detach --name ledgerlab --restart unless-stopped --publish 3000:3000 --env REGISTRATION_MODE=first-user --mount source=ledgerlab-data,target=/app/data ledgerlab:local
```

Read [Getting started](docs/getting-started.md) for the first workspace and [Deployment](docs/deployment.md) before changing the port, using a reverse proxy, upgrading, or moving data.

## Documentation

- [Documentation index](docs/README.md)
- [Getting started](docs/getting-started.md)
- [Configuration](docs/configuration.md)
- [Deployment, Docker, and upgrades](docs/deployment.md)
- [Backups and recovery](docs/backups-and-recovery.md)
- [Data model and financial invariants](docs/data-model.md)
- [Architecture](docs/architecture.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Contributing](CONTRIBUTING.md)
- [Support](SUPPORT.md)
- [Security policy](SECURITY.md)

## Financial correctness

These rules are treated as product invariants and covered by focused tests:

- An account balance reconciles from its opening balance and cleared, non-void transactions.
- A transfer is an atomic pair of ledger rows and never inflates income or spending.
- Planned occurrences never affect actual balances. Paying one creates and links an actual transaction.
- Pending means an event already occurred but has not settled; future activity belongs in Planned Payments.
- Posted account amounts are the source of truth for balances. Original foreign amounts and applied rates are immutable context.
- Credit-card repayments and loan principal are transfers, while interest and fees are expenses.
- Historical statistics use actual transactions and never silently mix in plans or forecasts.
- Recurrence is deterministic across month and year boundaries and cannot create the same occurrence twice.

The complete model is documented in [docs/data-model.md](docs/data-model.md).

## International use

LedgerLab accepts three-letter ISO currency codes and observes each currency's minor-unit precision where the JavaScript runtime provides it. Each account has an immutable native ledger currency. A transaction posts in that account currency, while a purchase entered in another currency also preserves its original amount, applied rate, source, and effective date.

The profile currency is a mutable reporting preference, not a second ledger amount. Cross-account totals and reports convert native amounts when read: flows use the transaction date, historical balances use the snapshot date, and current balances use the current as-of date. Changing the profile currency therefore re-expresses reports without rewriting accounts or transaction history.

Cross-currency transfers store the exact source and destination native amounts as paired transfer legs. Their value never appears as income or spending.

The built-in reference feed is the National Bank of Romania (BNR). It is useful internationally when a requested pair can be resolved from BNR's published RON reference data; BNR does not publish every ISO currency. Unsupported or institution-specific transaction rates can be entered manually. A saved transaction always retains the applied rate and effective date, so a later feed update cannot rewrite history. Reporting fails transparently when a required historical rate is unavailable instead of adding unlike currencies.

Language translation is not yet available: the interface is currently English. Locale, time-zone, and currency preferences affect money and date behavior but do not translate interface copy.

## Data ownership and privacy

Your application data lives in the configured SQLite file and attachment directory. LedgerLab has no application telemetry or analytics integration. Its only application-level outbound requests retrieve BNR exchange-rate data when a supported conversion needs it. Database backups contain highly sensitive financial, authentication, and receipt data; protect them as carefully as the live database.

See [docs/backups-and-recovery.md](docs/backups-and-recovery.md) for safe backup and restore procedures.

## Development checks

Contributors need Node.js 24 or newer and npm 11 or newer. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full development workflow.

```bash
npm ci
npm run db:migrate
npm run lint
npm run typecheck
npm test
npx playwright install chromium
npm run test:e2e
npm run build
```

Playwright uses only the disposable `data/e2e.db` database unless `E2E_BASE_URL` points it at an existing deployment. It never recreates `data/ledgerlab.db`.

## Community

Bug reports and focused proposals are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request, use [SUPPORT.md](SUPPORT.md) to choose the right channel, and follow the [Code of Conduct](CODE_OF_CONDUCT.md).

Never attach a real database, bank export, receipt, access token, password, or unredacted financial screenshot to a public issue.

## License

LedgerLab is free and open-source software licensed under the [GNU Affero General Public License version 3.0 only](LICENSE) (`AGPL-3.0-only`). You may run, study, modify, and redistribute it, including commercially, under that license's terms. If you make a modified version available to users over a network, the AGPL requires you to offer those users its corresponding source code under the same license.

See [NOTICE](NOTICE) for project and third-party attribution information. The license text controls if this summary and the license differ.
