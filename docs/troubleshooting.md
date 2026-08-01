# Troubleshooting

## The container exits during startup

Inspect the application log first:

```bash
docker logs ledgerlab
docker volume inspect ledgerlab-data
```

Confirm that the container mounts `ledgerlab-data` at `/app/data`, that the host has free space, and that no second LedgerLab container is using the same database. A custom bind mount must be writable by the container's unprivileged user (UID 1001, GID 1001).

## Installation fails at `better-sqlite3`

Use a supported Node.js 24 release and run `npm ci` from a clean checkout. On platforms without a prebuilt native binary, install the platform's C/C++ compiler toolchain and Python required by `node-gyp`, then retry.

Do not replace `npm ci` with an unlocked dependency update as a troubleshooting step; that changes the build you are diagnosing.

## “Cross-origin changes are not allowed”

LedgerLab expects the page and API to share one origin. If a reverse proxy terminates TLS, make it overwrite and forward the original `Host`, `X-Forwarded-Host`, and `X-Forwarded-Proto`. The browser's public origin must match the origin LedgerLab reconstructs from those values.

Common causes are:

- Browsing with `https://` while the proxy reports `http`
- Switching between an IP address, `localhost`, and a hostname
- Forwarding the proxy's internal host instead of the public host
- Hosting `/api` on a different domain
- Trusting or appending malformed client-supplied forwarding headers

Do not disable the check. Correct the proxy and clear only LedgerLab's site cookies before trying again.

## Sign-in works over HTTP but loops behind HTTPS

Forward `X-Forwarded-Proto: https`. LedgerLab uses the effective request protocol to set secure authentication cookies. Also confirm that the browser is always redirected to one canonical HTTPS host.

## Database cannot be opened

Confirm that:

- `DATABASE_URL` is present in the process that runs the command
- A relative path resolves from the expected working directory
- The process can create and write the parent directory
- The filesystem is local and has free space
- No read-only container mount hides `/app/data`

SQLite needs permission to create `-wal` and `-shm` files next to the database.

## The app starts with an unexpected empty database

A relative `DATABASE_URL` is relative to the current working directory. A service manager may use a different directory than your shell. Switch to an absolute path, stop the process, and start it again.

With Docker, confirm that the expected named volume is mounted at `/app/data` and that the run command did not create a similarly named new volume. Compare `docker inspect ledgerlab` with `docker volume inspect ledgerlab-data` before changing anything.

Do not merge two SQLite files. Identify and back up both before choosing the intended database.

## Receipt upload fails

The default attachment directory is beside the database at `/app/data/attachments` in Docker. Check the container log, free space, mount permissions, and the attachment size, per-user quota, and per-transaction file-count settings documented in [Configuration](configuration.md).

Do not point `ATTACHMENTS_DIR` at an ephemeral or separately unmounted container path. If database metadata exists but a receipt file is missing, a full backup will fail rather than silently producing an incomplete artifact.

## Exchange-rate lookup fails

Check outbound HTTPS connectivity and whether BNR publishes both requested currencies for the relevant date. Weekends and holidays use the latest common observation on or before the transaction date.

BNR does not cover every currency or a bank/card provider's retail spread. Enter the institution's actual rate manually when necessary; LedgerLab retains both the manual rate and available reference context.

## Account totals look wrong

Check these in order:

1. Opening balance and opening date
2. Date-range filter
3. Pending versus cleared status
4. Voided rows
5. Both legs of transfers
6. Posted account amount for foreign transactions
7. Archived accounts included in historical totals

Planned payments never affect the actual balance. A credit-card repayment is a transfer, and loan principal is not a new expense.

Each account balance remains in that account's ledger currency. Cross-account totals are converted into the profile's reporting currency at read time, using the persisted BNR observation on or before the relevant date. Changing the reporting currency therefore re-expresses totals without rewriting accounts or transactions. If BNR does not publish one of the currencies, LedgerLab reports the missing rate instead of adding unlike currency units.

If the mismatch persists, create a minimal reproduction with invented amounts. Never publish a real database or bank export.

## End-to-end tests affect the wrong server

Unset `E2E_BASE_URL` for the normal local test workflow. When it is set, Playwright sends destructive test traffic to that URL and does not start its disposable server.

The default workflow recreates only `data/e2e.db` and its sidecars.

## Getting more help

Use [SUPPORT.md](../SUPPORT.md) to choose a public support, bug, or private security channel and to prepare a sanitized report.
