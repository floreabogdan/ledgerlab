# Data model and financial invariants

LedgerLab is a cash-flow-oriented personal ledger. It is not a general-purpose double-entry accounting system, but it uses explicit paired rows where a movement must affect two accounts.

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
- **Profile currency** is the user's mutable reporting currency for totals that combine accounts. It is not stored as a duplicate transaction amount.

The posted native account amount is authoritative for reconciliation. Aggregates convert it when read using persisted historical reference observations: flows use the transaction date, a historical balance uses its snapshot date, a planned obligation uses its due date, and a current balance uses the current as-of date. Changing the profile currency re-expresses reports and forecasts without changing account currencies, opening balances, or transaction rows.

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

Categories are typed as income, expense, or both and may be nested up to 32 levels. A child must belong to the same user and have a kind allowed by its parent, and a category cannot be moved beneath itself or one of its descendants. Inline category creation during transaction entry derives the category kind from the transaction workflow rather than asking the user to duplicate that choice.

A split transaction still has one authoritative posted account amount. Its category allocations must reconcile exactly to that amount; splits add reporting detail and do not create extra account movements. Merchants and tags are descriptive dimensions and never change the sign or balance effect of a transaction.

Categories, merchants, and tags referenced by history are archived instead of being destructively removed. Archived records remain available to historical reports.

## Transfers

A transfer is one atomic operation with two rows sharing a transfer group. One row decreases the source and the other increases the destination. Both legs must exist, belong to the same user, and be excluded from income and expense totals.

For a same-currency transfer, the paired native amounts are equal. For a cross-currency transfer, the source and destination legs each store their exact native amount and the destination leg retains the applied conversion context. Both legs must reconcile against that rate. A transfer never creates income or spending.

A foreign purchase is different from a transfer: for example, a USD phone bill paid from a RON account stores the actual RON posting on the account and preserves the USD charge as its original amount.

## Planned, pending, and actual

Planned payments are expected future income or obligations. Recurring rules generate uniquely identified occurrences by planned-payment id and due date. An occurrence may be planned, scheduled, overdue, partially paid, paid, skipped, or cancelled according to the workflow.

Paying an occurrence asks for an actual date, account, and amount, creates a real transaction, and links it to the occurrence. Undo voids the linked actual effect while retaining audit history.

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

Changes to any invariant in this document require focused tests and a documentation update in the same pull request.
