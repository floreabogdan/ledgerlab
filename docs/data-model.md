# Data model and financial invariants

LedgerLab is a cash-flow-oriented personal ledger. It is not a general-purpose double-entry accounting system, but it uses explicit paired rows where a movement must affect two accounts.

## Identity and workspace ownership

Users authenticate people and store personal presentation preferences. Workspaces own financial data and form the application privacy boundary.

- Every user has a one-member personal workspace. Its identifier equals the user's identifier so existing installations can be migrated without changing external record identifiers.
- A user may also belong to any number of household workspaces through `workspace_members`.
- A household member is either an `owner` or a `member`. Both roles can view and change all household financial data; owner adds household-management authority.
- Every session records one active workspace. Membership and role are revalidated before each request uses it.
- An installation has one installation administrator: the first successful registration on a new installation, or the earliest existing user selected during migration. That installation-wide authority is independent of workspace membership and household ownership.

Financial roots such as accounts, categories, merchants, tags, transactions, planned payments, liabilities, budgets, plans, attachments, imports, and audit records carry `workspace_id`. Child rows inherit ownership through a parent and services validate cross-entity references against the same workspace. A user identifier records authorship or identity; it is never a substitute tenant key for financial data.

## Money representation

Every persisted monetary amount is an integer in that currency's minor unit. Examples:

- `USD 10.25` is stored as `1025` cents.
- `JPY 500` is stored as `500` because JPY has no decimal minor unit.
- A currency with three minor-unit digits stores `1.234` as `1234`.

Floating-point values are not accepted as ledger amounts. Exchange rates use scaled integers and explicit rounding at the currency boundary.

## Native, original, and reporting currencies

LedgerLab separates three concepts:

- **Account currency** is the immutable native currency of an account ledger. Opening balances and posted transaction amounts use it.
- **Original currency** optionally records what a merchant charged when it differs from the account currency. The original amount, applied rate, rate source, and effective date explain how the native posting was produced.
- **Workspace currency** is the workspace's canonical reporting currency for totals that combine accounts. It is not stored as a duplicate transaction amount.

The posted native account amount is authoritative for reconciliation. Aggregates convert it when read using persisted historical reference observations: flows use the transaction date, a historical balance uses its snapshot date, a planned obligation uses its due date, and a current balance uses the current as-of date. Changing the workspace currency re-expresses reports and forecasts for every member without changing account currencies, opening balances, or transaction rows.

The workspace time zone is likewise canonical. It defines shared calendar concepts such as today, month boundaries, due dates, and report ranges. Locale and interface language remain personal user preferences, so two household members may format and translate the same shared data differently without changing its financial meaning.

If a required reporting quote is unavailable, LedgerLab reports the missing conversion rather than adding unlike minor units. Reference observations are cached; applied transaction rates are immutable context and are never silently replaced by a later feed update.

## Account balance

At a date, an account's cleared balance is:

```text
opening balance + sum(cleared, non-void posted amounts on or before the date)
```

Pending rows and planned occurrences are reported separately. Archived accounts still participate in history and reconciliation.

## Transaction signs and kinds

- Income increases an asset account.
- Expense decreases an asset account.
- Refund reverses or offsets spending according to its signed posted amount.
- Adjustment explicitly corrects an account without pretending it is ordinary income or spending.
- Transfer moves value between accounts using two linked rows.

The service layer validates signs and ownership. Callers should not infer financial meaning from an absolute number alone.

## Categories, splits, merchants, and tags

Categories are typed as income, expense, or both and may be nested up to 32 levels. A child must belong to the same workspace and have a kind allowed by its parent, and a category cannot be moved beneath itself or one of its descendants. Inline category creation during transaction entry derives the category kind from the transaction workflow rather than asking the user to duplicate that choice.

A split transaction still has one authoritative posted account amount. Its category allocations must reconcile exactly to that amount; splits add reporting detail and do not create extra account movements. Merchants and tags are descriptive dimensions and never change the sign or balance effect of a transaction.

Categories, merchants, and tags referenced by history are archived instead of being destructively removed. Archived records remain available to historical reports.

## Transfers

A transfer is one atomic operation with two rows sharing a transfer group. One row decreases the source and the other increases the destination. Both legs must exist, belong to the same workspace, and be excluded from income and expense totals. A transfer cannot bridge a personal workspace and a household workspace.

For a same-currency transfer, the paired native amounts are equal. For a cross-currency transfer, the source and destination legs each store their exact native amount and the destination leg retains the applied conversion context. Both legs must reconcile against that rate. A transfer never creates income or spending.

A foreign purchase is different from a transfer: for example, a USD phone bill paid from a RON account stores the actual RON posting on the account and preserves the USD charge as its original amount.

## Planned, pending, and actual

Planned payments are expected future income or obligations. Recurring rules generate uniquely identified occurrences by planned-payment id and due date. An occurrence may be planned, scheduled, overdue, partially paid, paid, skipped, or cancelled according to the workflow.

Paying an occurrence asks for an actual date, account, and amount, creates a real transaction, and links it to the occurrence. Undo voids the linked actual effect while retaining audit history.

The occurrence-state transition and linked transaction are written atomically. A unique payment link plus a conditional state change makes a repeated idempotency key return the original result, rejects reuse for different input, and prevents concurrent requests from paying one occurrence twice.

Pending transactions describe events that already occurred but have not settled. LedgerLab rejects future transaction dates; future activity must remain planned until it happens.

## Credit cards

A credit card is a liability account:

- A purchase posts an expense to the card and increases the amount owed.
- A repayment transfers money from an asset account to the card.
- The repayment is not a second expense.
- Credit limit, available credit, utilization, statement balance, and minimum due are related but distinct values.

An opening card balance represents debt already owed when tracking begins. It should not be recreated as a new purchase unless it occurred within the tracked history.

## Loans

Loan disbursement and principal repayment move value between accounts. Interest and fees are expenses. A recorded installment groups all allocation legs and undoes them together.

Rate history and schedule output are estimates based on the supported calculation model. Optional jurisdiction, reference index, reset cadence, margin, floor, cap, lag, maturity, and day-count fields preserve lender terms; a field is not silently treated as a calculation input when the engine does not implement that behavior.

## Forecasts and statistics

Historical statistics query actual transactions. Forecasts combine expected opening balances, canonical planned occurrences, liability obligations, and isolated scenario adjustments.

Every projected or estimated value must remain labeled as such. A forecast must not insert or modify actual transactions. Planned-versus-actual reports compare two datasets rather than blending them.

## Archive and audit behavior

Accounts, categories, tags, and merchants are archived rather than deleted when history refers to them. Voids, planned-payment undo, settings changes, imports, and liability actions retain traceable records where the workflow requires them.

Audit rows identify both the affected workspace and the acting user. The household activity view exposes actor, entity type, action, and time to all household members. Audit data is useful for attribution and diagnosis, but it is stored in the same operator-controlled SQLite database and is not a tamper-proof compliance ledger.

## Attachments

An attachment belongs to exactly one parent: either a posted transaction receipt or a planned-payment invoice. The attachment row, transaction or planned-payment parent, and every upload/download/delete operation must resolve to the same workspace. Consequently, every household member with financial access can view its shared attachments; personal-workspace attachments remain private to that workspace's only member.

Attachment bytes live outside SQLite by default, while SQLite stores bounded metadata and an integrity digest. Full-installation backup includes all attachment bytes. Workspace JSON contains the exported workspace's attachment metadata but is not a byte-for-byte attachment backup.

## Household MVP boundaries

The MVP intentionally keeps the sharing model small and explicit:

- There is no private account, transaction, plan, or attachment inside a household. Keep private finances in a personal workspace.
- The account holder label is descriptive metadata, not an access-control rule or proof of ownership.
- There are no per-account, per-category, or per-record permissions and no read-only household role.
- LedgerLab does not calculate partner shares, IOUs, reimbursements, or settlement balances.
- Transfers cannot cross workspace boundaries, and reports never combine workspaces implicitly.
- Workspaces are personal or household only; nested households and organization/team role systems are outside the MVP.
- Invitation links are generated for an owner to share securely; LedgerLab does not provide an outbound email-delivery service.

Changes to any invariant in this document require focused tests and a documentation update in the same pull request.
