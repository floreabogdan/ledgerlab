# Architecture

LedgerLab is a Next.js App Router application with a Node.js runtime and an embedded SQLite database. One installation can contain several users and several financial workspaces.

```text
Browser
  -> Next.js pages and client components
  -> same-origin /api routes
  -> validation and authentication
  -> active-workspace membership resolution
  -> financial service modules (WorkspaceContext)
  -> Drizzle ORM / workspace-scoped SQL
  -> SQLite database and checked-in migrations
```

Full-installation backup and restore take a separate, explicitly authorized path. They are installation-administrator operations and are not inferred from the active workspace or a household role.

## Main directories

| Path | Responsibility |
| --- | --- |
| `src/app` | App Router pages, layouts, and the same-origin API entry point |
| `src/components` | Shared application and UI components, including the workspace switcher |
| `src/lib/domain` | Pure financial calculations and date/money helpers |
| `src/lib` | Authentication, workspace-context resolution, validation, formatting, and API utilities |
| `src/server` | Workspace-scoped transaction, planning, liability, reporting, FX, attachment, and portability services |
| `src/db` | Drizzle schema and SQLite connection lifecycle |
| `drizzle` | Ordered, checked-in schema migrations |
| `tests/unit` | Pure-domain and service-level regression tests |
| `tests/e2e` | Browser workflows against a disposable SQLite database |
| `scripts` | Database migration, demo seeding, and test preparation |

## Identity, workspaces, and requests

A user is an authenticated person. A workspace is the authorization and financial-data boundary. Every user owns a personal workspace, and a user can also belong to zero or more household workspaces. Personal workspaces have one member and cannot be shared; household workspaces have one or more members.

Each session stores an active workspace. Switching workspaces changes that session only. On every authenticated request, LedgerLab revalidates that the user is still a member and resolves this context:

```text
actorUserId  person performing the operation and receiving audit attribution
workspaceId  only tenant key allowed for workspace-owned financial data
role         owner or member role re-read from current membership
```

If a household membership was removed while a session still points at it, the request falls back to that user's personal workspace and updates the stale session. A workspace identifier supplied by a client never establishes access by itself.

The UI calls a same-origin API. Most endpoints exchange JSON; attachment uploads and downloads use bounded binary payloads. State-changing routes validate the request origin, parse bounded request bodies, require a persistent session, resolve the active workspace, and pass the resulting `WorkspaceContext` into a focused service.

All workspace-owned root records use `workspace_id`. Services must scope reads, writes, uniqueness checks, and aggregates by that value. References such as an account, category, transfer leg, planned payment, or attachment parent are also validated against the same workspace before mutation. Cross-workspace references are rejected without exposing the other workspace's data.

The API currently uses a catch-all route. Additions should keep endpoint dispatch small and move financial behavior into a focused server or domain module rather than growing page components.

## Authorization model

Owners and members intentionally have the same access to ordinary household finances in the MVP. The role controls household administration, not row-level visibility.

| Capability | Household member | Household owner |
| --- | ---: | ---: |
| View and change accounts, transactions, plans, reports, and attachments | Yes | Yes |
| View household members and activity | Yes | Yes |
| Create or revoke invitations | No | Yes |
| Promote, demote, or remove members | No | Yes |
| Transfer ownership or delete the household | No | Yes |
| Leave the household | Yes, unless the last owner | Yes, unless the last owner |

The last owner cannot be demoted, removed, or leave until another owner exists. Removing a member immediately moves that user's sessions which selected the household back to their personal workspace.

Installation administrator is a separate installation-wide flag. The first successfully registered user receives it. It grants full-installation backup and restore authority, but it does not automatically create membership in every household. Conversely, being a household owner does not grant installation-wide backup or restore authority.

## Authentication and invitations

Passwords use `scrypt` with a random per-password salt. Session secrets are random, are stored in the browser as `HttpOnly` `SameSite=Lax` cookies, and are stored in SQLite only as SHA-256 digests. Sessions expire and are periodically touched rather than written on every request.

Household invitations are email-bound, expiring bearer links. Only a SHA-256 digest of the random token is stored. The link can be accepted by an existing matching account or used to create that account even when general registration is closed. Acceptance, expiry, revocation, replacement, and repeated use are checked atomically. LedgerLab does not verify control of an email inbox, so the bearer link is the primary secret for a new invitee. Treat it as confidential until it is used or revoked.

The database is not encrypted at rest. Authentication and workspace authorization protect application access, not a copied database or attachment directory; filesystem and backup protection belong to the operator.

## Persistence, audit, and attachments

Drizzle defines the schema and applies checked-in migrations. Some reporting and portability operations use carefully scoped SQL where that is clearer or more efficient than ORM composition.

SQLite foreign keys are enabled, WAL mode is used for file databases, and writes that must preserve financial invariants run in transactions. Paying a planned occurrence conditionally changes its state and creates its linked transaction in the same immediate transaction, so retries and concurrent requests cannot create a second payment.

Audit rows carry both `workspace_id` and `actor_user_id`: the workspace identifies the affected boundary and the actor identifies who performed the action. Household activity is visible to household members. Audits support traceability; they are not an immutable external compliance log, and an operator with direct database access can change them.

Uploaded receipts and planned-invoice files live in a hardened local attachment directory beside the database by default. An attachment belongs to exactly one transaction or one planned payment, and both the attachment and its parent must be in the same workspace. Workspace JSON exposes only that workspace's attachment records and does not package file bytes; full-installation backups include all validated attachment files. Deleting an attachment removes its database record but deliberately retains the content-addressed blob: immediately unlinking an apparent last reference can race an upload that installed the same hash but has not committed its row yet. Successful full restores reconcile these safe-to-retain orphans while uploads are excluded; a future standalone garbage collector must use the same lifecycle guard.

Deployment is intentionally single-node.

## Container packaging

The multi-stage Docker build compiles Next.js into its standalone Node.js output and copies runtime files, checked-in migrations, and license notices into the final image. The image runs as an unprivileged user. Application state is kept outside the image under `/app/data`, which must be mounted to persistent local storage; replacing an image or container must not replace that volume.

## External data

The FX service downloads official BNR reference XML on demand, normalizes observations, and caches them in SQLite. Quotes use the latest common published banking date on or before the transaction date. Non-RON pairs are triangulated through RON when both sides are present.

Applied transaction rates are snapshots. Cached reference data can help explain a manual override but never retroactively changes a posted transaction. Native account ledgers are converted to the active workspace's canonical reporting currency at read time; missing historical quotes are surfaced rather than silently approximated. The workspace time zone defines shared calendar boundaries used by plans, reports, and date-sensitive defaults.

## Testing strategy

- Pure unit tests lock down money, balances, recurrence, plans, forecasts, currencies, and liability calculations.
- Service tests use migrated in-memory SQLite databases for workspace isolation, cross-workspace reference denial, role authorization, idempotency, atomicity, restore, and reconciliation behavior.
- Authentication tests cover invitation acceptance, concurrent acceptance, workspace switching, removed-member session fallback, and the last-owner invariant.
- Playwright exercises registration and high-value personal and household journeys against `data/e2e.db`.
- The production build is a release gate because App Router compilation can catch integration errors that isolated tests do not.

See [CONTRIBUTING.md](../CONTRIBUTING.md) for the required local checks.
