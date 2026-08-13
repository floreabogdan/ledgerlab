# Security policy

LedgerLab stores authentication material and detailed financial history. Please report vulnerabilities privately and avoid testing against anyone else's installation or data.

## Supported versions

Before the first stable release, security fixes are made only on the current default branch. After releases begin, this table will identify supported version lines:

| Version | Supported |
| --- | --- |
| Current default branch | Yes |
| Unreleased snapshots and old commits | No |

## Report a vulnerability

Use GitHub's **Report a vulnerability** / private security advisory feature for this repository. If private vulnerability reporting is not enabled yet, contact the repository owner privately through the verified contact method on their GitHub profile and ask for a secure reporting channel.

Do not open a public issue for a suspected vulnerability. Do not send a real LedgerLab database, backup, bank export, password, session cookie, receipt, or unredacted screenshot unless a maintainer has provided an encrypted channel and explicitly requested it.

Include, using synthetic data where possible:

- A concise description and affected version/commit
- Preconditions and deployment topology
- Reproduction steps or a minimal proof of concept
- Expected and observed impact
- Whether authentication or user interaction is required
- Suggested remediation, if known

We will acknowledge reports on a best-effort basis, investigate, coordinate a fix and disclosure, and credit reporters who want attribution. This volunteer project does not promise a response-time SLA. Please allow maintainers a reasonable remediation window before disclosure.

## Security model and operator responsibilities

LedgerLab provides:

- Scrypt password hashing with random per-password salts
- Random session tokens stored in SQLite only as SHA-256 digests
- `HttpOnly`, `SameSite=Lax` cookies, with `Secure` enabled for effective HTTPS requests
- Same-origin validation for state-changing requests
- Per-request workspace-membership validation, workspace-scoped service operations, and input/body-size validation
- Email-bound, expiring household invitations whose random tokens are stored only as SHA-256 digests
- Workspace-and-actor attribution for audited application actions
- SQLite foreign keys, integrity checks for restore, and security response headers

Operators remain responsible for:

- TLS and correct, overwritten proxy forwarding headers
- Restricting filesystem, database, volume, log, and backup access
- OS, container, Node.js, and dependency security updates
- Network access controls, registration mode, confidential invitation delivery, and securely claiming a new `first-user` installation
- Encryption at rest and off-site backup encryption
- Monitoring and incident response

Current limitations matter to threat modeling:

- The SQLite database and exported backups are not encrypted by LedgerLab.
- `first-user` prevents later sign-ups but an unclaimed public installation can be claimed by its first visitor; `open` intentionally permits every reachable visitor to register.
- An email-bound household invitation intentionally permits its matching recipient to register even when ordinary registration is closed.
- There is no built-in 2FA, SSO, password recovery, or account lockout shared across multiple processes.
- Login throttling is local to one process and is not a distributed abuse-control system.
- LedgerLab is a single-node application and should not share a database across replicas.
- Hosting the UI and API on different origins is unsupported.

See [docs/deployment.md](docs/deployment.md) for secure deployment guidance.

## Privacy and authorization boundaries

A user account identifies a person. A workspace is the financial privacy boundary.

- Every user has a personal workspace with exactly one member. Personal accounts, transactions, plans, reports, audit rows, and attachments are accessible through the application only to that user.
- A household workspace is fully shared. Every owner and member can read and change all household accounts, transactions, categories, plans, reports, transaction receipts, and planned-payment invoices.
- `owner` is a household-administration role, not a more privileged financial-data tier. Owners additionally manage invitations, roles, removals, ownership transfer, shared currency/time-zone settings, and household deletion.
- Account holder labels are descriptive. They do not create private records or restrict another household member.
- The active workspace is stored per session. LedgerLab revalidates membership and role on every authenticated request; a removed member's stale household selection falls back to their personal workspace.
- Cross-workspace references and mutations are denied. Transfers, reports, imports, and attachment parents cannot bridge a personal and household workspace.

Use a personal workspace for data that must remain private from household members. The MVP does not offer per-account or per-record permissions, a read-only role, private attachments inside a household, nested workspaces, partner-share calculations, IOUs, reimbursements, or implicit cross-workspace reporting.

### Installation administrator

The first successfully registered user is the installation administrator. Only that account can create or restore a full-installation backup. This authority is independent of household ownership and the active workspace:

- A household owner who is not the installation administrator cannot use full backup/restore to obtain another workspace or another user's authentication data.
- A full backup made by the installation administrator contains every user, workspace, membership, financial record, audit row, session record, and validated attachment file.
- Installation-administrator status does not automatically make that user an application member of every household, but direct access to a full backup can reveal all installation data.

Operators and the installation administrator are therefore inside the installation-wide trust boundary. Direct database, volume, process, or backup access bypasses application workspace authorization. Do not host mutually distrustful people together unless they accept that operator trust model.

### Invitations, audit, and attachments

Invitation URLs are bearer secrets bound to a normalized email, role, and expiry. Only the token digest is stored. An existing signed-in account must match the email, but LedgerLab has no email-verification service: someone holding an unused URL can register a new account with the invited address. Share links privately, revoke unused links, and keep them out of logs, screenshots, support bundles, and issue trackers. LedgerLab does not deliver invitation email for you.

Household members can view household activity attribution, including the actor, entity type, action, and time. Audit records support traceability but are not tamper-proof: they live in the same database controlled by the operator. Audit payloads and full backups should be handled as financial data.

Attachments are authorized through both their workspace and exactly one transaction or planned-payment parent. Every household member can download household receipts and planned invoices. The attachment directory is not encrypted and must never be served directly by a web server; access it only through LedgerLab's authenticated download path.

## Scope

Security reports can cover authentication/session handling, invitation handling, authorization or cross-user/cross-workspace access, role escalation, installation-administrator bypass, injection, cross-site scripting/request forgery, unsafe import or restore behavior, sensitive-data disclosure, dependency vulnerabilities with a reachable exploit path, and financial-integrity bugs that allow unauthorized balance/history changes.

Third-party infrastructure, social engineering, denial-of-service load testing, and vulnerabilities requiring prior compromise of the host OS are outside the project's direct scope, though hardening suggestions remain welcome.
