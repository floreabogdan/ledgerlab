# Contributing to LedgerLab

Thank you for helping improve LedgerLab. Personal finance software has an unusually high cost of subtle mistakes, so small, well-tested changes are easier to review and safer to ship than broad rewrites.

By participating, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md). For support, bugs, and security reports, first choose the right channel in [SUPPORT.md](SUPPORT.md).

## Before opening a pull request

- Search existing issues and pull requests.
- Open an issue before a large feature, schema change, authentication change, or change to a financial invariant.
- Describe the user problem and correctness rules before proposing a UI.
- Use invented test data. Never include a real database, bank export, receipt, access token, password, or unredacted financial screenshot.

Tiny documentation fixes and narrowly scoped bug fixes do not need a design issue.

## Development setup

You need Node.js 24+ and npm 11+.

```bash
npm ci
npm run db:migrate
npm run dev
```

The default database is `data/ledgerlab.db`. Use a separate disposable path for development when you need isolation; never point tests or scripts at another person's data.

### Optional demo workspace

Demo data is never added automatically. For UI development, `npm run db:seed` creates an isolated `demo@ledgerlab.local` workspace in the configured development database. If that user already exists, the command leaves it unchanged. Seeding requires an explicit password of at least 10 characters.

macOS or Linux:

```bash
DEMO_PASSWORD='choose-a-local-demo-password' npm run db:seed
```

PowerShell:

```powershell
$env:DEMO_PASSWORD = 'choose-a-local-demo-password'
npm run db:seed
Remove-Item Env:DEMO_PASSWORD
```

Do not run the seed command against a production database or an internet-accessible installation.

## Project shape

Read [docs/architecture.md](docs/architecture.md) before making a cross-cutting change. In short:

- Keep reusable financial calculations pure in `src/lib/domain`.
- Keep authenticated, user-scoped orchestration in `src/server`.
- Validate input at the API boundary with Zod.
- Keep page and component code focused on interaction and presentation.
- Change the Drizzle schema and checked-in migration together.

## Non-negotiable financial rules

- Store money as safe integer minor units, never binary floating-point ledger values.
- Respect each currency's minor-unit precision.
- Treat the posted account amount as authoritative; preserve foreign source amounts and rate snapshots as context.
- Make transfers atomic, paired, and excluded from income and spending.
- Never let planned occurrences affect actual balances or historical statistics.
- Treat pending as already occurred but unsettled; future activity stays planned.
- Preserve archive, void, undo, and audit history where an existing workflow depends on it.
- Make recurrence deterministic and idempotent across month/year boundaries.
- Label estimates and projections and keep them out of actual transaction history.

Update [docs/data-model.md](docs/data-model.md) when behavior changes.

## Database changes

1. Update `src/db/schema.ts`.
2. Run `npm run db:generate`.
3. Inspect the generated SQL; never blindly commit destructive SQL.
4. Test migration from a representative previous schema and from an empty database.
5. Add regression tests for constraints, ownership, migration compatibility, and any affected calculation.

Do not edit a migration that has shipped in a release. Add a new forward migration.

## Tests and release checks

Run the full local gate before requesting review:

```bash
npm run lint
npm run typecheck
npm test
npx playwright install chromium
npm run test:e2e
npm run build
```

Run `npm run i18n:check` when changing interface copy, validation, API errors, or a language pack. Run `npm run i18n:copy` when changing application UI code. See [Internationalization](docs/internationalization.md) for the YAML-only language workflow, message conventions, copy guard, and structured-error contract.

Add the smallest test that would have caught the bug or protects the new invariant. Prefer pure unit coverage for calculation edges, migrated in-memory service tests for database behavior, and Playwright for critical user workflows.

Playwright recreates only `data/e2e.db` in the normal local workflow. Do not set `E2E_BASE_URL` to a real workspace.

## Pull requests

A reviewable pull request:

- Has one clear objective and explains the user impact
- Links its issue when one exists
- Lists correctness and security implications
- Includes tests and documentation
- Calls out migrations, backup compatibility, and UI screenshots when relevant
- Avoids drive-by formatting and unrelated dependency changes
- Contains no generated databases, reports, logs, `.env` files, or personal data

Maintainers may ask to split a change when its correctness cannot be reviewed safely as one unit.

## Dependencies

Explain why a new production dependency is necessary, its maintenance posture, its license, and why existing platform capabilities are insufficient. Commit the updated lockfile. Do not silence an audit finding without documenting its runtime reachability and mitigation.

## Licensing contributions

Only submit work you have the right to contribute. Unless a separate written agreement says otherwise, a submitted contribution is offered under the repository's `AGPL-3.0-only` license, and contributors retain copyright in their work.

LedgerLab does not currently require copyright assignment or a contributor license agreement. Maintainers cannot relicense a contributor's work under different terms without the necessary permission from that contributor.
