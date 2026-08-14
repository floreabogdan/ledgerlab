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

## Create the administrator and personal workspace

Registration defaults to `first-user`. The first successful registration becomes the installation administrator, receives a private personal workspace, and closes ordinary registration automatically. Create this account from a trusted device or network before making LedgerLab reachable from the internet.

1. Open **Create an account**.
2. Enter your email, display name, and password.
3. Choose the reporting currency and financial time zone for your new personal workspace.
4. Review your personal locale and interface language. These can differ from the settings another household member uses.
5. Add a financial account with its real native currency, opening balance, and opening date.
6. Add activity that already occurred under **Transactions** and future obligations under **Planned Payments**.

Each account keeps an immutable native ledger currency. Transaction entry defaults to the selected account's currency. If a purchase or bill is denominated differently, LedgerLab preserves the original currency and amount while posting the actual converted amount to the account. You can use a dated BNR reference rate when available or enter the rate your institution actually charged.

Workspace currency is the common reporting currency for totals across that workspace. Changing it re-expresses reports from saved historical rates; it does not rewrite native account balances or transaction history. Workspace time zone defines shared calendar boundaries. In a household, an owner controls both settings for every member; locale and interface language remain personal.

## Add a household

Use a household when two or more people should work with the same accounts, transactions, plans, reports, receipts, and planned invoices.

1. Open **Workspaces** and choose **Create household**.
2. Enter the household name, canonical reporting currency, and IANA time zone.
3. The creator becomes an owner and the household becomes the active workspace.
4. Add household accounts. Use the optional holder label to describe whose or which shared account it is.
5. From **Workspaces**, create an invitation for the exact email address the other person will use. The default role is member.
6. Copy the generated invitation URL and send it through a private channel. LedgerLab does not send invitation email itself.
7. The recipient opens the link and either signs in with the matching account or registers through the invitation. Invitation registration works even while ordinary registration is closed.

A newly registered invitee receives their own personal workspace as well as the invited household membership. Accepting the invitation selects the household in that session. The workspace switcher changes the active workspace without moving or combining any records.

Invitations are bearer secrets tied to one normalized email, role, and expiry. They can be accepted once and can be revoked by an owner. Do not paste an unused invite into an issue, log, or public chat.

### Roles and privacy

- **Member** can view and change every financial record and attachment in the household and can view its members and activity.
- **Owner** has the same financial access and can also invite people, change roles, remove members, transfer ownership, change household financial settings, and delete the household.
- The last owner must transfer or add ownership before being demoted, removed, or leaving.
- **Installation administrator** is separate. Only that first installation-wide administrator can create or restore a full backup of all users and workspaces.

A household has no per-account privacy in the MVP. The holder label is descriptive and does not restrict access. Keep anything another household member must not see—including attachments—in your personal workspace. Transfers and reports cannot cross workspace boundaries.

If an owner removes a member while that household is active in one of the member's sessions, LedgerLab invalidates that selection and falls back to the member's personal workspace.

### Planned, pending, and actual

- **Planned** is a future expectation. It does not affect account balances or historical statistics.
- **Pending** is an event that occurred but has not settled.
- **Actual** is a posted transaction. Cleared actual transactions drive balances and historical statistics.

Monthly Forecast uses planned occurrences plus isolated what-if adjustments. It does not create a second set of transactions.

## Keep the installation

Before updating or moving LedgerLab, sign in as the installation administrator, create a full backup from **Data & backups**, and test that it can be restored. A workspace owner who is not the installation administrator can export that workspace but cannot back up or replace the whole installation. To update the Docker image without deleting its volume:

```bash
docker pull ghcr.io/floreabogdan/ledgerlab:latest
docker stop ledgerlab
docker rm ledgerlab
docker run --detach --name ledgerlab --restart unless-stopped --publish 127.0.0.1:3000:3000 --env REGISTRATION_MODE=first-user --mount source=ledgerlab-data,target=/app/data ghcr.io/floreabogdan/ledgerlab:latest
```

Read [Deployment](deployment.md) before placing LedgerLab behind a reverse proxy or exposing it outside a trusted network. Read [Backups and recovery](backups-and-recovery.md) before moving the volume or restoring data.
