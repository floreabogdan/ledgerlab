# Getting started

LedgerLab runs as one application container backed by SQLite. It does not need a separate database server, and a new installation starts with no demo or financial data.

## Requirements

- A current [Docker Engine](https://docs.docker.com/engine/install/)
- A current Chromium, Firefox, or Safari-based browser
- Enough local disk space for the database, uploaded receipts, backups, and temporary SQLite files

The commands below work in PowerShell, Command Prompt, and POSIX-compatible shells.

## Start LedgerLab

Pull the published image, create a persistent volume, and start one container:

```bash
docker pull ghcr.io/floreabogdan/ledgerlab:latest
docker volume create ledgerlab-data
docker run --detach --name ledgerlab --restart unless-stopped --publish 127.0.0.1:3000:3000 --env REGISTRATION_MODE=first-user --mount source=ledgerlab-data,target=/app/data ghcr.io/floreabogdan/ledgerlab:latest
```

Open <http://localhost:3000>. You can inspect startup output with:

```bash
docker logs ledgerlab
```

The command binds LedgerLab to the host's loopback interface, so it is reachable locally without being exposed to the surrounding network. Read [Deployment](deployment.md) before changing that bind address or adding a reverse proxy.

The `ledgerlab-data` volume is mounted at `/app/data`. It contains the SQLite database, uploaded receipt files, and SQLite sidecar files. Database migrations run when the application opens the database.

The volume is independent of the container. Rebuilding, stopping, or replacing `ledgerlab` leaves the data intact. Removing the volume is destructive:

```text
docker volume rm ledgerlab-data
```

Do not run that command unless you have a verified backup and intend to erase the installation.

## Build locally

If you prefer to build from a source checkout, use the same persistent volume with a local image:

```bash
docker build --tag ledgerlab:local .
docker volume create ledgerlab-data
docker run --detach --name ledgerlab --restart unless-stopped --publish 127.0.0.1:3000:3000 --env REGISTRATION_MODE=first-user --mount source=ledgerlab-data,target=/app/data ledgerlab:local
```

## Create your workspace

Registration defaults to `first-user`. The first successful registration becomes the installation owner, and registration then closes automatically. Create that owner from a trusted device or network before making LedgerLab reachable from the internet.

1. Open **Create an account**.
2. Enter your email and password.
3. Choose a profile reporting currency. USD is preselected only during signup as an internationally familiar default.
4. Review the browser-detected locale and time zone. Both remain editable in Profile settings.
5. Add a financial account with its real native currency, opening balance, and opening date.
6. Add activity that already occurred under **Transactions** and future obligations under **Planned Payments**.

Each account keeps an immutable native ledger currency. Transaction entry defaults to the selected account's currency. If a purchase or bill is denominated differently, LedgerLab preserves the original currency and amount while posting the actual converted amount to the account. You can use a dated BNR reference rate when available or enter the rate your institution actually charged.

The profile currency is only the common reporting currency for totals across accounts. Changing it re-expresses reports from saved historical rates; it does not rewrite native account balances or transaction history.

### Planned, pending, and actual

- **Planned** is a future expectation. It does not affect account balances or historical statistics.
- **Pending** is an event that occurred but has not settled.
- **Actual** is a posted transaction. Cleared actual transactions drive balances and historical statistics.

Monthly Forecast uses planned occurrences plus isolated what-if adjustments. It does not create a second set of transactions.

## Keep the installation

Before updating or moving LedgerLab, create a full backup from **Data & backups** and test that the backup can be restored. To update the Docker image without deleting its volume:

```bash
docker pull ghcr.io/floreabogdan/ledgerlab:latest
docker stop ledgerlab
docker rm ledgerlab
docker run --detach --name ledgerlab --restart unless-stopped --publish 127.0.0.1:3000:3000 --env REGISTRATION_MODE=first-user --mount source=ledgerlab-data,target=/app/data ghcr.io/floreabogdan/ledgerlab:latest
```

Read [Deployment](deployment.md) before placing LedgerLab behind a reverse proxy or exposing it outside a trusted network. Read [Backups and recovery](backups-and-recovery.md) before moving the volume or restoring data.
