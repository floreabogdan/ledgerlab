# Release process

This document defines the maintainer checks for a LedgerLab release. A release is cut from one reviewed commit; source, container image, changelog, and documentation must all describe that same revision.

## 1. Prepare the release

1. Choose the semantic version and update package metadata.
2. Move the applicable entries from **Unreleased** in [CHANGELOG.md](../CHANGELOG.md) into a dated version section.
3. Review migrations from both an empty database and the previous released schema.
4. Document operator-visible configuration, backup, compatibility, and upgrade changes.
5. Confirm that all examples contain synthetic data and no local paths, credentials, databases, receipts, logs, screenshots, test reports, or environment files are staged.

## 2. Verify legal and project metadata

1. Keep the unmodified GNU Affero General Public License version 3 text in `LICENSE`.
2. Keep `AGPL-3.0-only` consistent in the README, package metadata, and release metadata.
3. Include `LICENSE` and `NOTICE` in source distributions and preserve third-party notices.
4. Confirm that every contribution can be distributed under the project license.
5. Make the exact corresponding source available for every published container image, including modifications used to build it, as the AGPL requires.

## 3. Run the clean-checkout gate

Run from a clean checkout with Node.js 24 and npm 11:

```bash
npm ci
npm run lint
npm run typecheck -- --incremental false
npm test
npx playwright install --with-deps chromium
npm run test:e2e
npm run build
npm audit
docker build --tag ledgerlab:release-candidate .
```

Review all dependency findings rather than suppressing them. Test the candidate container with a new disposable volume, then test an upgrade using a backup of synthetic data from the previous release. Reconcile account balances, transfer pairs, planned-to-paid links, profile-currency totals, receipts, and liability allocations.

## 4. Review security and operations

1. Exercise `first-user`, `open`, and `closed` registration modes.
2. Test an HTTPS reverse proxy with overwritten `Host`, `X-Forwarded-Host`, and `X-Forwarded-Proto` headers.
3. Confirm authentication cookies are secure under HTTPS and state-changing cross-origin requests are rejected.
4. Complete a full backup and restore drill, including uploaded receipts.
5. Replace the candidate container while retaining its Docker volume and verify that data survives.
6. Review logs and error responses for credentials, cookies, paths, user data, or financial details.
7. Confirm GitHub private vulnerability reporting and the contact guidance in [SECURITY.md](../SECURITY.md).

## 5. Publish

1. Merge the exact reviewed commit and wait for every required GitHub Actions job to pass.
2. Create an annotated `vMAJOR.MINOR.PATCH` tag on that commit and publish release notes derived from the changelog.
3. Confirm that GitHub Container Registry contains the expected version and immutable commit tags, and that `latest` points only to the intended stable release.
4. Pull the published image on a clean host, start it with a named volume, and check `/api/health` plus a basic signup and sign-in flow.
5. Publish checksums for any downloadable artifacts and record known limitations.

Do not move or recreate a release tag after publication. If a release is faulty, publish a new patch version and document the correction.
