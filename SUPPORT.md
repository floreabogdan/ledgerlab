# Support

LedgerLab is community-maintained software. Support is best effort and does not include financial, tax, legal, lending, or investment advice.

## Ask a usage question

Use the repository's GitHub Discussions area when it is enabled. Before posting:

1. Read the [documentation index](docs/README.md) and [troubleshooting guide](docs/troubleshooting.md).
2. Search existing discussions and issues.
3. State the LedgerLab version or commit, installation method, operating system, Node.js version, browser, and relevant sanitized logs.

If Discussions is not enabled, open a documentation issue only when the behavior appears undocumented or the documentation is incorrect. Do not use a bug report as a general personal-finance consultation.

## Report a bug

Use the structured bug-report issue form. Provide a minimal reproduction with invented values, expected behavior, actual behavior, and the checks you already ran.

Public issues must never contain:

- Databases or full backups
- Bank CSV files, statements, receipts, or account identifiers
- Passwords, cookies, tokens, email addresses, or personal names
- Unredacted screenshots, notes, merchant history, or balances

Replace all financial details with synthetic data and inspect logs before attaching them.

## Request a feature

Use the feature-request issue form. Explain the user problem, how the feature should interact with planned/pending/actual money, and any financial or jurisdiction-specific semantics. Region-specific features are welcome when optional and clearly modeled rather than silently imposed on everyone.

## Report a security problem

Do not open a public issue. Follow [SECURITY.md](SECURITY.md) and use private vulnerability reporting.

## Financial calculation questions

LedgerLab calculation explanations describe what the software does, not what you should do with your money. Verify lender statements, exchange rates, taxes, and legally regulated calculations against an authoritative source for your jurisdiction.
