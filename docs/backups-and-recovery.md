# Backups and recovery

LedgerLab offers workspace portability and full-installation disaster recovery. They have different authorization and privacy boundaries.

## Choose the right export

| Format | Scope and best use | Authentication or attachment bytes | Restore behavior |
| --- | --- | --- | --- |
| Transaction CSV | Transactions in the active workspace; spreadsheet review or transaction import | No authentication data; no attachment bytes | Import through the CSV mapping workflow |
| Workspace JSON | Structured records for the active personal or household workspace | No password hashes or session tokens; attachment metadata, not file bytes | Application-level portability; not a complete installation replacement |
| Full LedgerLab backup | Every user, workspace, membership, invitation record, session, audit row, financial record, and validated attachment file in the installation | Yes | Replaces the active installation after validation |

Any member can export the complete active household workspace because every household member already has access to all of its financial data. Switch to the intended workspace before exporting and check the workspace name in the interface. An export never combines personal and household workspaces implicitly.

A workspace export is not an authorization transfer and does not recreate account passwords or a working household invitation. It may contain member identifiers, activity, account-holder labels, merchant names, notes, attachment metadata, and the household's full financial history. Protect it as sensitive data.

## Full-backup authority

Only the installation administrator can create or restore a full backup. The first successfully registered user receives that installation-wide authority. It is independent of the active workspace and household roles:

- A household owner who is not the installation administrator cannot export other users, other workspaces, password hashes, or sessions through full backup.
- The installation administrator can back up the whole installation even when it has several users and households.
- Installation-administrator authority does not itself grant ordinary in-app membership in every household.

This is an intentionally powerful trust boundary. A full backup contains emails, password hashes, active session records, memberships, invitation token hashes, account balances, merchant names, notes, audit history, and uploaded receipts and planned invoices. Anyone who can read it can inspect the installation outside LedgerLab. Encrypt it at rest, restrict access, and never upload it to a public issue or unencrypted shared drive.

LedgerLab currently limits the complete backup envelope to 100 MiB.

## Create a full backup

Use **Data & backups** while signed in as the installation administrator. LedgerLab creates a versioned backup envelope containing the serialized SQLite database and all attachment bytes, with database and file checksums plus attachment metadata. Keep the artifact in protected off-device storage and record which LedgerLab version produced it.

For infrastructure-level snapshots, either:

- stop LedgerLab before copying the complete data volume, or
- use a SQLite-aware online backup tool and separately capture the complete attachment directory.

Do not copy a live `.db` file alone while WAL mode is active.

## Restore

Restore is destructive and installation-wide: it replaces the active database and attachment storage, not only the currently selected workspace. It requires the current installation administrator, the explicit `RESTORE` confirmation, and a backup whose recorded administrator email matches that administrator.

Before replacement, LedgerLab validates the envelope format and size, checksum, SQLite header, database integrity, foreign keys, required tables, administrator identity, attachment ownership, paths, sizes, and file digests. Validated attachment blobs are published before the database replacement, with uploads excluded for the restore's duration. If publication or the database transaction fails, the active database stays unchanged and blobs created only by that attempt are rolled back after a live-reference check. After a successful commit, LedgerLab removes recognized content-addressed blobs absent from the restored database; existing matching and currently referenced blobs are never overwritten or removed. Validation reduces risk but does not make an untrusted backup safe.

1. Create and retain a backup of the current installation.
2. Verify that no other LedgerLab process is writing the database.
3. Sign in as the installation administrator and open **Data & backups**.
4. Select the trusted full backup and type the required confirmation.
5. Let the restore complete without restarting the process.
6. Sign in again if the restored session state requires it.
7. Check users and households, several account balances and transfer pairs, planned-payment links, audit activity, and both receipt and planned-invoice downloads.

Only restore backups you created or fully trust. SQLite content is application input and may contain sensitive or maliciously crafted data even when its checksum is valid.

Ordinary attachment deletion removes metadata immediately but defers physical blob removal. This avoids a delete/upload race for identical content hashes, at the cost of temporary orphan disk usage until a successful full restore or a future offline garbage-collection pass. Monitor attachment-volume free space accordingly.

## Docker storage

The recommended Docker command mounts the `ledgerlab-data` named volume at `/app/data`. The database, SQLite sidecars, and default attachment directory all live under that mount. Replacing or rebuilding the application container does not remove the volume.

Prefer the in-app full backup because it creates a consistent, validated application artifact while LedgerLab is running. If the app is unavailable, stop the container before copying the entire volume with a Docker-supported volume backup procedure:

```bash
docker stop ledgerlab
docker volume inspect ledgerlab-data
```

Back up the complete volume, not only `ledgerlab.db`, and run `docker start ledgerlab` after the copy. Docker manages the volume's physical location; do not edit its files while the application is running.

Avoid commands that stream an unencrypted database into shared logs or shell history. Document and test the exact volume backup and restore procedure for the host on a disposable installation.

## Upgrade rollback

Schema migrations move forward. Before upgrading, stop the application and take a versioned snapshot of the complete data volume, or create and verify a full backup with the release you are leaving. Do not run an older LedgerLab binary against a database already migrated by a newer release.

To roll back, stop all LedgerLab processes, restore the matching pre-upgrade database and attachment set as one unit, then start the matching older image. This discards all changes made after the snapshot. Keep the failed-upgrade copy until recovery is verified.

## Recovery drill

A backup is useful only if it can be restored. Periodically:

1. Start an isolated LedgerLab instance with a disposable volume.
2. Register its installation administrator with the same normalized email as the backup administrator.
3. Restore a recent backup there.
4. Reconcile known personal and household balances and transfer pairs.
5. Confirm memberships, planned payments, receipts, and planned invoices.
6. Delete the isolated copy securely when the drill is complete.

Never point end-to-end tests at the recovered production copy.
