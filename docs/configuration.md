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
| `ATTACHMENTS_DIR` | `attachments` beside the database | Local directory for uploaded receipt and planned-invoice files. Use a persistent local path. |
| `ATTACHMENT_MAX_FILE_BYTES` | `10485760` | Maximum bytes per uploaded receipt or planned invoice (10 MiB by default). |
| `ATTACHMENT_USER_QUOTA_BYTES` | `262144000` | Maximum stored attachment bytes per workspace (250 MiB by default; the variable name is retained for compatibility). |
| `ATTACHMENT_MAX_FILES_PER_TRANSACTION` | `10` | Maximum files linked to one transaction or planned payment (the variable name is retained for compatibility). |

`DATABASE_URL` must point to a local, persistent, writable filesystem. LedgerLab creates its parent directory when necessary and enables SQLite foreign keys, a busy timeout, and WAL mode.

Do not put the database on NFS, SMB, object storage, or an ephemeral container filesystem. Run one LedgerLab application instance per database; horizontal replicas are not supported.

The published container configures `DATABASE_URL=/app/data/ledgerlab.db`. Keep `/app/data` mounted to a named volume or an explicitly managed local bind mount. The default attachment directory is then `/app/data/attachments`, so one persistent mount covers both the database and attachment files.

### Registration policy

- `first-user` allows ordinary registration only while the database has no users. The first successful account becomes the installation administrator and owner of its personal workspace, then ordinary registration closes. This is the default and recommended mode.
- `open` allows anyone who can reach the registration page to create a user and personal workspace. It does not grant membership in an existing household and does not grant installation-administrator authority.
- `closed` disables ordinary registration even when the database is empty. Existing users can still sign in.

An unexpired household invitation is a separate, email-bound admission path. A person with the link can create the matching account even when ordinary registration is `first-user` or `closed`, or sign in with an existing matching account and accept it. LedgerLab does not verify control of an email inbox; protect the bearer link as the proof for a new invitee. This path lets an owner add household members without opening public registration.

Keep a brand-new `first-user` deployment on a trusted network or loopback address until you create its installation administrator. Otherwise, the first visitor could claim that authority. Changing the mode does not delete users, workspaces, memberships, invitations, or sessions.

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

## Workspace and personal regional settings

Financial settings belong to the active workspace, while presentation settings belong to the signed-in user. They are stored in SQLite rather than server environment variables.

| Setting | Scope | Effect |
| --- | --- | --- |
| Reporting currency | Workspace | Canonical currency for cross-account totals, forecasts, and reports |
| Financial time zone | Workspace | Canonical calendar boundaries for shared dates, months, plans, and reporting |
| Locale | User | Number and date formatting for that person |
| Interface language | User | Translated application copy for that person |

The signup choices initialize the new personal workspace and that user's presentation. Creating a household asks for its own currency and time zone. A household owner can later change those canonical settings; the change affects every member's shared calculations. A member cannot override them locally.

- Each account has an immutable native currency. Workspace currency only controls cross-account reporting and may be changed without rewriting ledger history.
- Currency values use three-letter ISO codes and currency-specific integer minor units.
- Locale and interface language may differ between household members without changing shared data. Names and notes entered by users remain as entered.
- Time zones use IANA identifiers such as `America/New_York`, `Asia/Tokyo`, or `Europe/Bucharest`.

There is no environment variable that establishes a default household, membership, role, currency, or time zone for every user. Those are application records and must be administered through authenticated workflows.

## Network behavior

LedgerLab has no application analytics or advertising integration. It downloads dated exchange-rate reference data from the National Bank of Romania (BNR) when a supported conversion needs it and stores the observation in SQLite. This feed is a reference source, not a Romanian-only application mode: non-RON pairs can be resolved through RON when BNR publishes both currencies for the relevant date. BNR does not publish every ISO currency or a bank's retail spread. Operators who block outbound traffic can still enter manual transaction rates, but a cross-account report that lacks a required historical quote fails explicitly instead of combining unlike currencies.
