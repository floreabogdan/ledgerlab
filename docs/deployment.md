# Deployment

LedgerLab is designed for one self-hosted application instance with a persistent local SQLite volume. It is not designed for serverless functions, multiple replicas, or a network-mounted database.

## Before production

- Read the [`AGPL-3.0-only` license](../LICENSE), [security policy](../SECURITY.md), and [backup guide](backups-and-recovery.md).
- Keep the database and uploaded receipts on a persistent local volume with restricted access.
- Use HTTPS through a trusted reverse proxy before sending credentials over an untrusted network.
- Keep `REGISTRATION_MODE=first-user` unless registration is intentionally shared.
- Claim the first account from a trusted network before making the installation publicly reachable.
- Create a full backup and prove that you can restore it.

The default `first-user` policy allows exactly the initial account and then closes registration. An unclaimed public installation can be claimed by its first visitor. After creating the owner, confirm that the registration page reports that signup is closed before widening network access.

## Docker

Published images are available from GitHub Container Registry:

```bash
docker pull ghcr.io/floreabogdan/ledgerlab:latest
docker volume create ledgerlab-data
docker run --detach --name ledgerlab --restart unless-stopped --publish 127.0.0.1:3000:3000 --env REGISTRATION_MODE=first-user --mount source=ledgerlab-data,target=/app/data ghcr.io/floreabogdan/ledgerlab:latest
```

Open <http://localhost:3000>. The container runs as an unprivileged user and stores all mutable application data under `/app/data`:

- `/app/data/ledgerlab.db` is the SQLite database.
- `/app/data/ledgerlab.db-wal` and `/app/data/ledgerlab.db-shm` may exist while SQLite is running.
- `/app/data/attachments` contains uploaded receipt files by default.

The `ledgerlab-data` named volume survives container replacement and image rebuilds. Inspect it with `docker volume inspect ledgerlab-data`. Never remove the volume as part of a routine deployment or upgrade.

The example publishes the port only on the host loopback interface. Keep that default for local use. A remote deployment should put an HTTPS reverse proxy in front of LedgerLab or deliberately change the bind address only after the first account has claimed the installation.

For repeatable production deployments, pin a released version tag or image digest after evaluating it. The `latest` tag is convenient for initial setup, but it changes when a new stable image is published.

### Build from source

The repository contains a multi-stage production `Dockerfile`:

```bash
docker build --tag ledgerlab:local .
docker volume create ledgerlab-data
docker run --detach --name ledgerlab --restart unless-stopped --publish 127.0.0.1:3000:3000 --env REGISTRATION_MODE=first-user --mount source=ledgerlab-data,target=/app/data ledgerlab:local
```

### Change the port or registration policy

The first number in `--publish` is the host port. This example exposes LedgerLab at <http://localhost:8080>:

```bash
docker run --detach --name ledgerlab --restart unless-stopped --publish 127.0.0.1:8080:3000 --env REGISTRATION_MODE=first-user --mount source=ledgerlab-data,target=/app/data ghcr.io/floreabogdan/ledgerlab:latest
```

Use `REGISTRATION_MODE=closed` to disable every new registration. Use `REGISTRATION_MODE=open` only for an intentionally shared installation where anyone who can reach the registration page may create an account. See [Configuration](configuration.md#registration-policy).

## Reverse proxy and HTTPS

Host the interface and `/api` on the same public origin. State-changing cross-origin requests are intentionally rejected.

The proxy must overwrite and forward the public host and protocol:

```text
Host: ledger.example.org
X-Forwarded-Host: ledger.example.org
X-Forwarded-Proto: https
```

Do not append untrusted client values to these headers. LedgerLab uses them for same-origin validation and to decide whether authentication cookies receive the `Secure` attribute. A mismatch between the browser URL and the forwarded host or protocol can produce a “Cross-origin changes are not allowed” response or a sign-in loop.

Configure TLS, request timeouts, and a request-body limit compatible with the features you use. CSV import and full-backup restore have different application limits. Never disable same-origin checks to work around a proxy configuration problem.

The unauthenticated health endpoint is `GET /api/health`. A healthy response confirms that the process can open and migrate the configured database; it does not test BNR connectivity or inspect user data.

## Filesystem and SQLite

The process needs read and write access to the database directory, not only the `.db` file. SQLite creates WAL and shared-memory files beside the database.

- Use a local SSD-backed filesystem.
- Run exactly one LedgerLab container or process per database.
- Do not use NFS, SMB, object storage, or an ephemeral container layer for `/app/data`.
- Do not copy a live `.db` file by itself. Use the in-app backup workflow or stop LedgerLab before a volume-level copy.
- Monitor free space for transactions, audit records, uploaded receipts, cached FX data, and SQLite WAL activity.
- Keep database and backup files outside any web-served directory.

If `ATTACHMENTS_DIR` points outside `/app/data`, mount that location separately and include it in every backup procedure. Keeping the default is simpler and ensures the database and receipts share the persistent volume.

## Upgrade

1. Read [CHANGELOG.md](../CHANGELOG.md) and the release notes.
2. Create and verify a full LedgerLab backup.
3. Pull the intended image tag or digest.
4. Stop and remove the old container without removing `ledgerlab-data`.
5. Start one replacement container with the same volume and environment settings.
6. Check `/api/health`, sign in, and verify accounts, recent transactions, planned payments, and statistics.

For the `latest` image, the container replacement is:

```bash
docker pull ghcr.io/floreabogdan/ledgerlab:latest
docker stop ledgerlab
docker rm ledgerlab
docker run --detach --name ledgerlab --restart unless-stopped --publish 127.0.0.1:3000:3000 --env REGISTRATION_MODE=first-user --mount source=ledgerlab-data,target=/app/data ghcr.io/floreabogdan/ledgerlab:latest
```

Migrations move forward. Rolling back application code may require restoring the matching pre-upgrade database backup.

## Not currently supported

- Multiple application replicas or automatic failover against one SQLite file
- Serverless or edge runtimes
- PostgreSQL, MySQL, or hosted database services
- Hosting the interface and API on different origins
- Built-in TLS certificate management
- Built-in SSO, two-factor authentication, or password recovery
