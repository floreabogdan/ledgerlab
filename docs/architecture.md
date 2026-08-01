# Architecture

LedgerLab is a Next.js App Router application with a Node.js runtime and an embedded SQLite database.

```text
Browser
  -> Next.js pages and client components
  -> same-origin /api routes
  -> validation and authentication
  -> financial service modules
  -> Drizzle ORM / scoped SQL
  -> SQLite database and checked-in migrations
```

## Main directories

| Path | Responsibility |
| --- | --- |
| `src/app` | App Router pages, layouts, and the same-origin API entry point |
| `src/components` | Shared application and UI components |
| `src/lib/domain` | Pure financial calculations and date/money helpers |
| `src/lib` | Authentication, validation, formatting, and API utilities |
| `src/server` | User-scoped transaction, planning, liability, reporting, FX, and portability services |
| `src/db` | Drizzle schema and SQLite connection lifecycle |
| `drizzle` | Ordered, checked-in schema migrations |
| `tests/unit` | Pure-domain and service-level regression tests |
| `tests/e2e` | Browser workflows against a disposable SQLite database |
| `scripts` | Database migration, demo seeding, and test preparation |

## Request boundaries

The UI calls a same-origin API. Most endpoints exchange JSON; receipt uploads and downloads use bounded binary payloads. State-changing routes validate the request origin, parse bounded request bodies, validate structured input with Zod, require a persistent session, and scope records to the authenticated user.

The API currently uses a catch-all route. Additions should keep endpoint dispatch small and move financial behavior into a focused server or domain module rather than growing page components.

## Authentication

Passwords use `scrypt` with a random per-password salt. Session secrets are random, are stored in the browser as `HttpOnly` `SameSite=Lax` cookies, and are stored in SQLite only as SHA-256 digests. Sessions expire and are periodically touched rather than written on every request.

The database is not encrypted at rest. Authentication protects application access, not a copied database file; filesystem and backup protection belong to the operator.

## Persistence

Drizzle defines the schema and applies checked-in migrations. Some reporting and portability operations use carefully scoped SQL where that is clearer or more efficient than ORM composition.

SQLite foreign keys are enabled, WAL mode is used for file databases, and writes that must preserve financial invariants run in transactions. Uploaded receipts live in a hardened local attachment directory beside the database by default and are included in full backup/restore validation. Deployment is intentionally single-node.

## Container packaging

The multi-stage Docker build compiles Next.js into its standalone Node.js output and copies runtime files, checked-in migrations, and license notices into the final image. The image runs as an unprivileged user. Application state is kept outside the image under `/app/data`, which must be mounted to persistent local storage; replacing an image or container must not replace that volume.

## External data

The FX service downloads official BNR reference XML on demand, normalizes observations, and caches them in SQLite. Quotes use the latest common published banking date on or before the transaction date. Non-RON pairs are triangulated through RON when both sides are present.

Applied transaction rates are snapshots. Cached reference data can help explain a manual override but never retroactively changes a posted transaction. Native account ledgers are converted to the user's current reporting currency at read time; missing historical quotes are surfaced rather than silently approximated.

## Testing strategy

- Pure unit tests lock down money, balances, recurrence, plans, forecasts, currencies, and liability calculations.
- Service tests use migrated in-memory SQLite databases for ownership, atomicity, restore, and reconciliation behavior.
- Playwright exercises registration and high-value user journeys against `data/e2e.db`.
- The production build is a release gate because App Router compilation can catch integration errors that isolated tests do not.

See [CONTRIBUTING.md](../CONTRIBUTING.md) for the required local checks.
