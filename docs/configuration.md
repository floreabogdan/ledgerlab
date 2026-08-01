# Configuration

LedgerLab deliberately has a small runtime configuration surface. Keep configuration in the process environment and never commit deployment secrets or real financial data.

## Runtime variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | `./data/ledgerlab.db` | SQLite filename. A leading `file:` is accepted and removed. Relative paths resolve from the process working directory. |
| `REGISTRATION_MODE` | `first-user` | Registration policy: `first-user`, `open`, or `closed`. |
| `HOSTNAME` | Next.js default | Address used by the production Next.js server. Containers set this to `0.0.0.0`. |
| `PORT` | `3000` | HTTP port used by `next start` or the standalone server. |
| `NEXT_TELEMETRY_DISABLED` | unset | Set to `1` to disable Next.js framework telemetry for the process. The published Docker image sets it. |
| `ATTACHMENTS_DIR` | `attachments` beside the database | Local directory for uploaded receipt files. Use a persistent local path. |
| `ATTACHMENT_MAX_FILE_BYTES` | `10485760` | Maximum bytes per uploaded receipt (10 MiB by default). |
| `ATTACHMENT_USER_QUOTA_BYTES` | `262144000` | Maximum stored receipt bytes per user (250 MiB by default). |
| `ATTACHMENT_MAX_FILES_PER_TRANSACTION` | `10` | Maximum uploaded receipts linked to one transaction. |

`DATABASE_URL` must point to a local, persistent, writable filesystem. LedgerLab creates its parent directory when necessary and enables SQLite foreign keys, a busy timeout, and WAL mode.

Do not put the database on NFS, SMB, object storage, or an ephemeral container filesystem. Run one LedgerLab application instance per database; horizontal replicas are not supported.

The published container configures `DATABASE_URL=/app/data/ledgerlab.db`. Keep `/app/data` mounted to a named volume or an explicitly managed local bind mount. The default attachment directory is then `/app/data/attachments`, so one persistent mount covers both the database and receipt files.

### Registration policy

- `first-user` allows registration only while the database has no users. The first successful account becomes the initial owner and registration then closes. This is the default and the recommended mode for a personal installation.
- `open` allows anyone who can reach the registration page to create a user. Use it only for an intentionally shared installation. Once more than one user exists, sole-owner full-database backup/restore is intentionally unavailable; each user can still use user-scoped exports.
- `closed` disables new registration even when the database is empty. Existing users can still sign in.

Keep a brand-new `first-user` deployment on a trusted network or loopback address until you create its owner. Otherwise, the first visitor could claim the installation. Changing the mode does not delete users or sessions.

## Command-only and test variables

| Variable | Used by | Purpose |
| --- | --- | --- |
| `DEMO_PASSWORD` | `npm run db:seed` | Required explicit password for the optional isolated demo user. |
| `E2E_BASE_URL` | `npm run test:e2e` | Tests an existing deployment instead of starting the disposable local test server. Treat this as destructive test traffic. |
| `CI` | test tooling | Enables CI retry behavior for Playwright. |

Never point `E2E_BASE_URL` at a production installation. The workflow creates users and financial records.

## Environment files

Next.js reads its supported `.env*` files for development and application startup. The standalone migration and seed scripts rely on variables already present in their process environment. For a non-default database, set `DATABASE_URL` in the shell that runs both migration and the server.

macOS or Linux:

```bash
export DATABASE_URL=/srv/ledgerlab/ledgerlab.db
npm run db:migrate
npm run start
```

PowerShell:

```powershell
$env:DATABASE_URL = 'D:\LedgerLab\ledgerlab.db'
npm run db:migrate
npm run start
```

The checked-in [.env.example](../.env.example) is documentation, not a production secret file.

For Docker, pass runtime settings with `--env` or an environment file kept outside the repository. Do not bake passwords, private URLs, databases, receipts, or user-specific settings into an image.

## Regional preferences

Reporting currency, locale, and time zone belong to each LedgerLab user rather than the server environment. Set them during onboarding and review them in Profile settings. USD is preselected only for a new signup; it is not forced on accounts or existing workspaces.

- Each account has an immutable native currency. The profile currency only controls cross-account reporting and may be changed without rewriting ledger history.
- Currency values use three-letter ISO codes and currency-specific integer minor units.
- Locale controls display formatting; it does not translate the interface.
- Time zone controls local calendar boundaries. Use an IANA identifier such as `America/New_York`, `Asia/Tokyo`, or `Europe/Bucharest`.

## Network behavior

LedgerLab has no application analytics or advertising integration. It downloads dated exchange-rate reference data from the National Bank of Romania (BNR) when a supported conversion needs it and stores the observation in SQLite. This feed is a reference source, not a Romanian-only application mode: non-RON pairs can be resolved through RON when BNR publishes both currencies for the relevant date. BNR does not publish every ISO currency or a bank's retail spread. Operators who block outbound traffic can still enter manual transaction rates, but a cross-account report that lacks a required historical quote fails explicitly instead of combining unlike currencies.
