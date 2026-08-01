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
- User-scoped service operations and input/body-size validation
- SQLite foreign keys, integrity checks for restore, and security response headers

Operators remain responsible for:

- TLS and correct, overwritten proxy forwarding headers
- Restricting filesystem, database, volume, log, and backup access
- OS, container, Node.js, and dependency security updates
- Network access controls, registration mode, and securely claiming a new `first-user` installation
- Encryption at rest and off-site backup encryption
- Monitoring and incident response

Current limitations matter to threat modeling:

- The SQLite database and exported backups are not encrypted by LedgerLab.
- `first-user` prevents later sign-ups but an unclaimed public installation can be claimed by its first visitor; `open` intentionally permits every reachable visitor to register.
- There is no built-in 2FA, SSO, password recovery, or account lockout shared across multiple processes.
- Login throttling is local to one process and is not a distributed abuse-control system.
- LedgerLab is a single-node application and should not share a database across replicas.
- Hosting the UI and API on different origins is unsupported.

See [docs/deployment.md](docs/deployment.md) for secure deployment guidance.

## Scope

Security reports can cover authentication/session handling, authorization or cross-user access, injection, cross-site scripting/request forgery, unsafe import or restore behavior, sensitive-data disclosure, dependency vulnerabilities with a reachable exploit path, and financial-integrity bugs that allow unauthorized balance/history changes.

Third-party infrastructure, social engineering, denial-of-service load testing, and vulnerabilities requiring prior compromise of the host OS are outside the project's direct scope, though hardening suggestions remain welcome.
