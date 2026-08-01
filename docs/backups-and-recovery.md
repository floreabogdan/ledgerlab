# Backups and recovery

LedgerLab offers several portability tools. They solve different problems and have different security implications.

## Choose the right export

| Format | Best for | Includes authentication data | Restore behavior |
| --- | --- | --- | --- |
| Transaction CSV | Spreadsheet review or moving transaction rows | No | Import through the CSV mapping workflow |
| Workspace JSON | Structured user-workspace portability | No password hashes or session tokens | Application-level export; not a byte-for-byte database replacement |
| Full LedgerLab backup | Disaster recovery for the complete local installation | Yes | Replaces the active database and receipt storage after validation |

A full backup can contain emails, password hashes, active session records, account balances, merchant names, notes, financial history, and uploaded receipt files. Encrypt it at rest, limit access, and do not upload it to a public issue or an unencrypted shared drive. LedgerLab currently limits the complete backup envelope to 100 MiB.

## Create a full backup

Use **Data & backups** while signed in. Full-database backup is intentionally available only when the database has one owner, preventing one user from exporting another user's authentication material.

LedgerLab creates a validated backup envelope containing the SQLite database and uploaded receipt bytes, with checksums and file metadata. Keep the backup artifact and its checksum together. Record which LedgerLab version produced it.

For infrastructure-level snapshots, either:

- stop LedgerLab before copying the database and all sidecars, or
- use a SQLite-aware online backup tool.

Do not copy a live `.db` file alone while WAL mode is active.

## Restore

Restore is destructive: it replaces the active database. Before replacement, LedgerLab validates the confirmation, checksum, SQLite header, integrity, foreign keys, required tables, and sole-owner identity. Validation reduces risk but does not make an untrusted backup safe.

1. Back up the current database.
2. Verify that no other LedgerLab process is writing it.
3. Use **Data & backups** and provide the backup plus its required confirmation.
4. Let the restore complete without restarting the process.
5. Sign in again if the restored session state requires it.
6. Check account balances, transfers, planned links, and recent history.

Only restore backups you created or fully trust. SQLite content is application input and may contain sensitive or maliciously crafted data even when its checksum is valid.

## Docker storage

The recommended Docker command mounts the `ledgerlab-data` named volume at `/app/data`. The database, SQLite sidecars, and default attachment directory all live under that mount. Replacing or rebuilding the application container does not remove the volume.

Prefer the in-app full backup because it creates a consistent, validated application artifact while LedgerLab is running. If the app is unavailable, stop the container before copying the entire volume with a Docker-supported volume backup procedure:

```bash
docker stop ledgerlab
docker volume inspect ledgerlab-data
```

Back up the complete volume, not only `ledgerlab.db`, and run `docker start ledgerlab` after the copy. Docker manages the volume's physical location; do not edit its files while the application is running.

Avoid commands that stream an unencrypted database into shared logs or shell history. Document and test the exact volume backup and restore procedure for the host on a disposable installation.

## Recovery drill

A backup is useful only if it can be restored. Periodically:

1. Start an isolated LedgerLab instance with a disposable database path.
2. Restore a recent backup there.
3. Reconcile a few known balances and transfer pairs.
4. Confirm planned payments do not affect actual balances.
5. Delete the isolated copy securely when the drill is complete.

Never point end-to-end tests at the recovered production copy.
