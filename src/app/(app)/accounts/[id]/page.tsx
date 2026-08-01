"use client";

import {
  ArrowLeft,
  Banknote,
  CalendarClock,
  Calculator,
  Landmark,
  ReceiptText,
  RotateCcw,
} from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import {
  AddButton,
  Button,
  DataState,
  Field,
  FormMessage,
  formatDate,
  formatMoney,
  Input,
  isoToday,
  Metric,
  Modal,
  moneyInputToMinor,
  minorToInput,
  numberFrom,
  Page,
  Pill,
  readList,
  readRecord,
  requestJson,
  ResponsiveTable,
  Section,
  Select,
  stringFrom,
  SuggestionInput,
  Textarea,
  useJson,
  useSubmit,
  ViewHeader,
  workspaceLocale,
} from "../../_components/feature-kit";
import { DEFAULT_CURRENCY } from "@/lib/currencies";
import { currencyMinorUnitDigits } from "@/lib/domain/currency";
import {
  convertCurrencyMinor,
  deriveRateScaled,
  FX_RATE_SCALE,
  rateInputToScaled,
  rateScaledToInput,
  reverseConvertCurrencyMinor,
} from "@/lib/domain/fx-math";
import { LOAN_REFERENCE_INDEX_SUGGESTIONS } from "@/lib/loan-options";
import ui from "../../_components/pages.module.css";
import styles from "./liability.module.css";

type Row = Record<string, unknown>;
type FxQuote = {
  rateDate: string;
  fromCurrency: string;
  toCurrency: string;
  rateScaled: number;
  rateScale: number;
  fromMinorUnitDigits: number;
  toMinorUnitDigits: number;
  isFallback: boolean;
  fallbackDays: number;
  isStale?: boolean;
};

function formatRate(value: number, rateScale = FX_RATE_SCALE) {
  return new Intl.NumberFormat(workspaceLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 8 })
    .format(value / rateScale);
}

function useFxQuote(date: string, fromCurrency: string, toCurrency: string, enabled: boolean) {
  const [quote, setQuote] = useState<FxQuote | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      if (!enabled || !date) {
        setQuote(null);
        setLoading(false);
        setError(null);
        return;
      }
      setLoading(true);
      setError(null);
      void (async () => {
        try {
          const params = new URLSearchParams({ date, from: fromCurrency, to: toCurrency });
          const response = await fetch(`/api/fx/quote?${params.toString()}`, {
            headers: { Accept: "application/json" },
            cache: "no-store",
            signal: controller.signal,
          });
          const body = readRecord(await response.json().catch(() => null));
          if (!response.ok) throw new Error(stringFrom(body.error ?? body.message, `Reference rate unavailable (${response.status})`));
          const rawQuote = readRecord(body.quote);
          if (!Number.isSafeInteger(rawQuote.rateScaled) || numberFrom(rawQuote.rateScaled) <= 0) {
            throw new Error("The reference-rate response was invalid.");
          }
          if (active) setQuote(rawQuote as FxQuote);
        } catch (caught) {
          if (!active || controller.signal.aborted) return;
          setQuote(null);
          setError(caught instanceof Error ? caught.message : "No reference rate is available.");
        } finally {
          if (active) setLoading(false);
        }
      })();
    });
    return () => {
      active = false;
      controller.abort();
    };
  }, [date, enabled, fromCurrency, toCurrency]);

  return { quote, loading, error };
}

function LiabilityFxPanel({
  title,
  description,
  fromCurrency,
  toCurrency,
  quote,
  loading,
  error,
  rateMode,
  manualRate,
  displayedRate,
  exactAmountMode,
  exactAmount,
  exactAmountCurrency,
  exactAmountLabel,
  calculatedAmountMinor,
  exactAmountReconciles,
  onManualRateChange,
  onManualModeChange,
  onExactAmountChange,
  onExactModeChange,
}: {
  title: string;
  description: string;
  fromCurrency: string;
  toCurrency: string;
  quote: FxQuote | null;
  loading: boolean;
  error: string | null;
  rateMode: "reference" | "manual";
  manualRate: string;
  displayedRate: string;
  exactAmountMode: boolean;
  exactAmount: string;
  exactAmountCurrency: string;
  exactAmountLabel: string;
  calculatedAmountMinor: number | null;
  exactAmountReconciles: boolean;
  onManualRateChange: (value: string) => void;
  onManualModeChange: (manual: boolean) => void;
  onExactAmountChange: (value: string) => void;
  onExactModeChange: (exact: boolean) => void;
}) {
  return (
    <div className={`${ui.fxPanel} ${ui.formSpan}`}>
      <div className={ui.fxPanelHeader}>
        <span><strong>{title}</strong><small>{description}</small></span>
        {loading ? <Pill tone="info">Loading BNR rate…</Pill> : quote ? <Pill tone={quote.isFallback ? "warning" : "info"}>BNR reference</Pill> : <Pill tone="warning">Manual rate needed</Pill>}
      </div>
      {quote ? (
        <div className={ui.fxReference}>
          <strong>1 {fromCurrency} = {formatRate(quote.rateScaled, quote.rateScale)} {toCurrency}</strong>
          <span>Effective {formatDate(quote.rateDate, { day: "2-digit", month: "short", year: "numeric" })}{quote.isFallback ? ` · previous BNR day (${quote.fallbackDays} day${quote.fallbackDays === 1 ? "" : "s"} earlier)` : ""}</span>
        </div>
      ) : error ? <div className={ui.fxError} role="status">{error} Enter a manual exchange rate to continue.</div> : null}
      {quote?.isStale ? <div className={ui.fxError} role="status">The live refresh failed, so this uses the cached official quote. Compare it with the lender or bank statement.</div> : null}
      <div className={ui.fxControls}>
        <Field label={`Exchange rate (${toCurrency} per 1 ${fromCurrency})`} hint={exactAmountMode ? "Derived from both exact amounts." : rateMode === "manual" ? "Manual override; the BNR reference remains recorded when available." : "Official BNR reference for the payment date."}>
          <Input
            inputMode="decimal"
            value={displayedRate}
            disabled={rateMode === "reference" || exactAmountMode}
            onChange={(event) => onManualRateChange(event.target.value)}
            placeholder={loading ? "Loading…" : "e.g. 4.65"}
          />
        </Field>
        <Field label={`${exactAmountLabel} (${exactAmountCurrency})`} hint={exactAmountMode ? exactAmountReconciles ? "Exact statement amount; the rate is derived." : "This cannot reconcile at eight-decimal precision. Edit the rate instead." : "Calculated with integer minor-unit rounding."}>
          <Input
            inputMode="decimal"
            value={exactAmountMode ? exactAmount : calculatedAmountMinor === null ? "" : minorToInput(calculatedAmountMinor, exactAmountCurrency)}
            disabled={!exactAmountMode}
            aria-invalid={exactAmountMode && !exactAmountReconciles}
            onChange={(event) => onExactAmountChange(event.target.value)}
            placeholder={loading ? "Calculating…" : minorToInput(0, exactAmountCurrency)}
          />
        </Field>
      </div>
      <div className={ui.fxOptions}>
        <label className={`${ui.small} ${ui.inlineCheck}`}>
          <input type="checkbox" checked={rateMode === "manual"} onChange={(event) => onManualModeChange(event.target.checked)} /> Edit exchange rate manually
        </label>
        <label className={`${ui.small} ${ui.inlineCheck}`}>
          <input type="checkbox" checked={exactAmountMode} onChange={(event) => onExactModeChange(event.target.checked)} /> Use exact {exactAmountLabel.toLocaleLowerCase()}
        </label>
      </div>
      {rateMode === "manual" && manualRate && quote ? <p className={ui.fxEstimateNote}>The applied manual rate and the available BNR reference will both be retained for audit context.</p> : null}
    </div>
  );
}

function percentage(basisPoints: unknown) {
  const value = numberFrom(basisPoints);
  return `${new Intl.NumberFormat(workspaceLocale(), { maximumFractionDigits: 2 }).format(value / 100)}%`;
}

function bpsInput(value: string, optional = false, allowNegative = false) {
  if (optional && !value.trim()) return null;
  const normalized = value.trim().replace(",", ".");
  if (!/^-?\d+(\.\d{0,2})?$/.test(normalized)) throw new Error("Enter a valid percentage with no more than two decimals.");
  const parsed = Number(normalized);
  if (!allowNegative && parsed < 0) throw new Error("Enter a percentage of zero or greater.");
  return Math.round(parsed * 100);
}

function dateAfter(date: string, days: number) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function dateMonthStart(date: string) {
  return `${date.slice(0, 7)}-01`;
}

function statusTone(status: string): "neutral" | "positive" | "negative" | "warning" | "info" {
  if (["paid", "cleared"].includes(status)) return "positive";
  if (["overdue", "void"].includes(status)) return "negative";
  if (["partial", "due"].includes(status)) return "warning";
  if (["open", "projected"].includes(status)) return "info";
  return "neutral";
}

function availableCashAccounts(raw: Row) {
  return readList<Row>(raw, "accounts").filter((item) => {
    const account = readRecord(item);
    return ["current", "current_account", "savings", "cash"].includes(stringFrom(account.type))
      && !account.archivedAt;
  });
}

export default function LiabilityDetailPage() {
  const { id } = useParams<{ id: string }>();
  const accountId = Array.isArray(id) ? id[0] : id;
  const detailUrl = `/api/liabilities/${encodeURIComponent(accountId ?? "")}`;
  const detailQuery = useJson<Row>(detailUrl, {});
  const accountsQuery = useJson<Row>("/api/accounts", {});
  const categoriesQuery = useJson<Row>("/api/categories", {});
  const detail = readRecord(detailQuery.data);
  const account = readRecord(detail.account);
  const kind = stringFrom(detail.kind);
  const currency = stringFrom(account.currency, DEFAULT_CURRENCY);
  const cashAccounts = availableCashAccounts(accountsQuery.data);
  const categoryNames = new Map(
    readList<Row>(categoriesQuery.data, "categories").map((item) => {
      const category = readRecord(item);
      return [stringFrom(category.id), stringFrom(category.name)] as const;
    }),
  );
  const [statementOpen, setStatementOpen] = useState(false);
  const [cardPaymentTarget, setCardPaymentTarget] = useState<Row | null | undefined>(undefined);
  const [loanPaymentTarget, setLoanPaymentTarget] = useState<Row | null | undefined>(undefined);
  const [rateOpen, setRateOpen] = useState(false);
  const [disburseOpen, setDisburseOpen] = useState(false);
  const [undoTarget, setUndoTarget] = useState<Row | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [undoing, setUndoing] = useState(false);

  async function refresh() {
    await Promise.all([detailQuery.reload(), accountsQuery.reload()]);
  }

  async function undoPayment() {
    if (!undoTarget) return;
    setUndoing(true);
    setActionError(null);
    try {
      await requestJson(`/api/liabilities/payments/${encodeURIComponent(stringFrom(undoTarget.id))}/undo`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      setUndoTarget(null);
      await refresh();
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : "Could not undo this payment");
    } finally {
      setUndoing(false);
    }
  }

  const headerActions = kind === "credit_card" ? (
    <>
      <Button variant="secondary" icon={<ReceiptText size={16} />} onClick={() => setStatementOpen(true)}>Add statement</Button>
      <AddButton onClick={() => setCardPaymentTarget(null)}>Record payment</AddButton>
    </>
  ) : kind === "loan" ? (
    <>
      <Button variant="secondary" icon={<Banknote size={16} />} onClick={() => setDisburseOpen(true)}>Record disbursement</Button>
      <AddButton onClick={() => setLoanPaymentTarget(null)}>Record payment</AddButton>
    </>
  ) : undefined;

  return (
    <Page>
      <Link className={styles.backLink} href="/accounts"><ArrowLeft size={16} aria-hidden="true" />Accounts</Link>
      <DataState loading={detailQuery.loading} error={detailQuery.error} onRetry={detailQuery.reload} empty={!detailQuery.loading && !detailQuery.error && !account.id} emptyTitle="Liability not found" emptyDescription="This account may have been archived or removed.">
        {account.id ? (
          <>
            <ViewHeader
              eyebrow={kind === "credit_card" ? "Credit card" : "Loan"}
              title={stringFrom(account.name, "Liability")}
              description={kind === "credit_card"
                ? "Track the card ledger, lender statements, and payments separately. Card payments are transfers, never new spending."
                : "Track principal as a liability and allocate each actual installment between principal, interest, and fees."}
              actions={headerActions}
            />
            <FormMessage error={actionError} />
            {kind === "credit_card" ? (
              <CreditCardWorkspace
                detail={detail}
                currency={currency}
                onPay={(statement) => setCardPaymentTarget(statement)}
                onUndo={setUndoTarget}
              />
            ) : (
              <LoanWorkspace
                detail={detail}
                currency={currency}
                categoryNames={categoryNames}
                onPay={(entry) => setLoanPaymentTarget(entry)}
                onUndo={setUndoTarget}
                onAddRate={() => setRateOpen(true)}
              />
            )}
          </>
        ) : null}
      </DataState>

      {kind === "credit_card" ? (
        <>
          <StatementModal key={statementOpen ? "statement-open" : "statement-closed"} open={statementOpen} accountId={accountId} currency={currency} onClose={() => setStatementOpen(false)} onSaved={refresh} />
          <CardPaymentModal
            key={cardPaymentTarget === undefined ? "card-payment-closed" : `card-payment-${stringFrom(cardPaymentTarget?.id, "general")}`}
            open={cardPaymentTarget !== undefined}
            accountId={accountId}
            target={cardPaymentTarget ?? null}
            statements={readList<Row>(detail.statements)}
            profile={readRecord(detail.profile)}
            cashAccounts={cashAccounts}
            currency={currency}
            onClose={() => setCardPaymentTarget(undefined)}
            onSaved={refresh}
          />
        </>
      ) : null}
      {kind === "loan" ? (
        <>
          <LoanPaymentModal
            key={loanPaymentTarget === undefined ? "loan-payment-closed" : `loan-payment-${stringFrom(loanPaymentTarget?.id, "general")}`}
            open={loanPaymentTarget !== undefined}
            accountId={accountId}
            target={loanPaymentTarget ?? null}
            cashAccounts={cashAccounts}
            currency={currency}
            onClose={() => setLoanPaymentTarget(undefined)}
            onSaved={refresh}
          />
          <RateModal key={rateOpen ? "rate-open" : "rate-closed"} open={rateOpen} accountId={accountId} onClose={() => setRateOpen(false)} onSaved={refresh} />
          <DisbursementModal key={disburseOpen ? "disburse-open" : "disburse-closed"} open={disburseOpen} accountId={accountId} cashAccounts={cashAccounts} currency={currency} onClose={() => setDisburseOpen(false)} onSaved={refresh} />
        </>
      ) : null}
      <Modal
        open={Boolean(undoTarget)}
        onClose={() => setUndoTarget(null)}
        title="Undo payment?"
        description="The linked transfer and any interest or fee transactions will be voided. The liability history will retain an audit trail."
        footer={<><Button variant="ghost" onClick={() => setUndoTarget(null)}>Keep payment</Button><Button variant="danger" disabled={undoing} onClick={() => void undoPayment()}>{undoing ? "Undoing…" : "Undo payment"}</Button></>}
      >
        <div className={`${styles.notice} ${styles.noticeWarning}`}>
          <RotateCcw size={17} aria-hidden="true" />
          <span>This reverses the accounting effect; it does not reverse a payment at your bank or lender.</span>
        </div>
      </Modal>
    </Page>
  );
}

function CreditCardWorkspace({ detail, currency, onPay, onUndo }: { detail: Row; currency: string; onPay: (statement: Row) => void; onUndo: (payment: Row) => void }) {
  const metrics = readRecord(detail.metrics);
  const profile = readRecord(detail.profile);
  const statements = readList<Row>(detail.statements);
  const payments = readList<Row>(detail.payments);
  const utilization = metrics.utilizationBps == null ? null : numberFrom(metrics.utilizationBps) / 100;
  const minimumPaymentMode = stringFrom(profile.minimumPaymentMode, "manual");
  const minimumPaymentTerm = minimumPaymentMode === "percentage" && profile.minimumPaymentRateBps != null
    ? `${percentage(profile.minimumPaymentRateBps)} of the statement balance`
    : minimumPaymentMode === "fixed" && profile.minimumPaymentFixedMinor != null
      ? `${formatMoney(profile.minimumPaymentFixedMinor, currency)} fixed amount`
      : "Entered from each lender statement";
  return (
    <div className={styles.sectionStack}>
      <div className={styles.metricGrid}>
        <Metric label="Outstanding" value={formatMoney(metrics.projectedOutstandingMinor, currency)} tone={numberFrom(metrics.projectedOutstandingMinor) > 0 ? "warning" : "positive"} info="Posted card debt plus pending charges, less pending credits. The credit limit is never counted as an asset." />
        <Metric label="Available credit" value={formatMoney(metrics.availableCreditMinor, currency)} detail={metrics.pendingNetDebtMinor ? "Includes pending activity · estimate" : "From posted activity"} tone="accent" />
        <Metric label="Credit limit" value={formatMoney(metrics.creditLimitMinor, currency)} detail="Lender-provided facility" info="A limit is borrowing capacity, not cash or net worth." />
        <Metric label="Utilization" value={utilization == null ? "Not available" : `${utilization.toFixed(1)}%`} detail={numberFrom(metrics.overLimitMinor) > 0 ? `${formatMoney(metrics.overLimitMinor, currency)} over limit` : "Projected balance ÷ limit"} tone={numberFrom(metrics.overLimitMinor) > 0 ? "negative" : utilization != null && utilization >= 75 ? "warning" : "default"} />
      </div>

      <div className={styles.overviewGrid}>
        <Section title="Card terms" description="Stored lender references; each closed statement remains authoritative">
          <div className={styles.summaryList}>
            <Summary label="Statement day" value={profile.statementDay ? `Day ${numberFrom(profile.statementDay)}` : "Not set"} />
            <Summary label="Due day" value={profile.dueDay ? `Day ${numberFrom(profile.dueDay)}` : "Not set"} />
            <Summary label="Grace period" value={profile.gracePeriodDays == null ? "Not set" : `${numberFrom(profile.gracePeriodDays)} days`} />
            <Summary label="Purchase APR" value={profile.purchaseAprBps == null ? "Not set" : percentage(profile.purchaseAprBps)} />
            <Summary label="Minimum payment reference" value={minimumPaymentTerm} />
            <Summary label="Payment preference" value={stringFrom(profile.paymentPreference, "full_statement").replaceAll("_", " ")} />
          </div>
          <div className={styles.profileFooter}>Due amounts come from closed statements. LedgerLab does not calculate statement dates, APR interest, or contractual minimums from these reference fields.</div>
        </Section>
        <Section title="Credit position" description="Posted versus projected availability">
          <div className={styles.summaryList}>
            <Summary label="Posted debt" value={formatMoney(metrics.postedOutstandingMinor, currency)} />
            <Summary label="Pending net charges" value={formatMoney(metrics.pendingNetDebtMinor, currency)} />
            <Summary label="Posted available" value={formatMoney(metrics.postedAvailableCreditMinor, currency)} />
            <Summary label="Projected available" value={formatMoney(metrics.availableCreditMinor, currency)} />
          </div>
          <div className={styles.utilizationTrack} aria-label={`Card utilization ${utilization?.toFixed(1) ?? "unavailable"}%`}>
            <span style={{ width: `${Math.min(100, Math.max(0, utilization ?? 0))}%` }} data-warning={Boolean(utilization && utilization >= 75)} data-over={Boolean(utilization && utilization > 100)} />
          </div>
        </Section>
      </div>

      <Section title="Statements" description="Closed lender periods determine what is due, independently of newer card activity">
        <ResponsiveTable label="Credit-card statements">
          <thead><tr><th>Period</th><th>Closing</th><th>Due</th><th>Status</th><th>Statement</th><th>Minimum</th><th>Remaining</th><th><span className="sr-only">Actions</span></th></tr></thead>
          <tbody>
            {statements.length ? statements.map((item) => {
              const row = readRecord(item);
              const remaining = Math.max(0, numberFrom(row.statementBalanceMinor) - numberFrom(row.paymentsAppliedMinor));
              return <tr key={stringFrom(row.id)}>
                <td><span className={styles.nowrap}>{formatDate(row.periodStart, { year: undefined })} – {formatDate(row.periodEnd, { year: undefined })}</span></td>
                <td>{formatDate(row.closingDate)}</td><td>{formatDate(row.dueDate)}</td>
                <td><Pill tone={statusTone(stringFrom(row.status))}>{stringFrom(row.status, "open")}</Pill></td>
                <td className={styles.amount}>{formatMoney(row.statementBalanceMinor, currency)}</td>
                <td className={styles.amount}>{formatMoney(row.minimumDueMinor, currency)}</td>
                <td className={styles.amount}>{formatMoney(remaining, currency)}<small>{numberFrom(row.paymentsAppliedMinor) > 0 ? `${formatMoney(row.paymentsAppliedMinor, currency)} applied` : "No payments applied"}</small></td>
                <td>{remaining > 0 ? <Button variant="ghost" onClick={() => onPay(row)}>Pay</Button> : null}</td>
              </tr>;
            }) : <tr><td className={styles.emptyCell} colSpan={8}>No statements yet. Add the lender’s closed statement before recording an amount due.</td></tr>}
          </tbody>
        </ResponsiveTable>
      </Section>
      <PaymentHistory payments={payments} currency={currency} kind="card" onUndo={onUndo} />
    </div>
  );
}

function LoanWorkspace({ detail, currency, categoryNames, onPay, onUndo, onAddRate }: { detail: Row; currency: string; categoryNames: Map<string, string>; onPay: (entry: Row) => void; onUndo: (payment: Row) => void; onAddRate: () => void }) {
  const metrics = readRecord(detail.metrics);
  const profile = readRecord(detail.profile);
  const rates = readList<Row>(detail.rates);
  const schedule = readList<Row>(detail.schedule);
  const payments = readList<Row>(detail.payments);
  const next = readRecord(metrics.nextInstallment);
  return (
    <div className={styles.sectionStack}>
      <div className={styles.metricGrid}>
        <Metric label="Outstanding principal" value={formatMoney(metrics.outstandingPrincipalMinor, currency)} tone="warning" info="The actual signed loan-account balance shown as a positive debt amount." />
        <Metric label="Principal repaid" value={formatMoney(metrics.principalRepaidMinor, currency)} tone="positive" info="Original principal minus current outstanding principal. Interest and fees do not reduce this balance." />
        <Metric label="Original principal" value={formatMoney(metrics.originalPrincipalMinor, currency)} detail={profile.originationDate ? `Originated ${formatDate(profile.originationDate)}` : "Contract amount"} />
        <Metric label="Next installment" value={next.id ? formatMoney(next.paymentMinor, currency) : "None due"} detail={next.id ? `${formatDate(next.dueDate)} · ${next.isEstimate ? "estimate" : "scheduled"}` : "Schedule complete"} tone={next.id ? "accent" : "positive"} />
      </div>

      <div className={styles.overviewGrid}>
        <Section title="Loan terms" description="Contract structure and bookkeeping defaults">
          <div className={styles.summaryList}>
            <Summary label="Repayment method" value={stringFrom(profile.amortizationMethod, "Not set").replaceAll("_", " ")} />
            <Summary label="Frequency" value={profile.paymentIntervalMonths ? `Every ${numberFrom(profile.paymentIntervalMonths)} month${numberFrom(profile.paymentIntervalMonths) === 1 ? "" : "s"}` : "Not set"} />
            <Summary label="Term" value={profile.termMonths ? `${numberFrom(profile.termMonths)} months` : "Not set"} />
            <Summary label="First payment" value={profile.firstPaymentDate ? formatDate(profile.firstPaymentDate) : "Not set"} />
            <Summary label="Contract maturity (reference)" value={profile.maturityDate ? formatDate(profile.maturityDate) : "Not set"} />
            <Summary label="Jurisdiction" value={stringFrom(profile.jurisdictionCode, "Not specified")} />
            <Summary label="Payment account" value={stringFrom(profile.paymentAccount, "Choose when paying")} />
          </div>
          <div className={styles.profileFooter}>Jurisdiction and local reference indexes are optional. They do not alter historical actual payments.</div>
        </Section>
        <Section title="Expense mapping" description="Only interest and fees count as spending">
          <div className={styles.summaryList}>
            <Summary label="Interest category" value={categoryNames.get(stringFrom(profile.interestCategoryId)) ?? "Uncategorised"} />
            <Summary label="Fee category" value={categoryNames.get(stringFrom(profile.feeCategoryId)) ?? "Uncategorised"} />
            <Summary label="Contract day count (reference)" value={stringFrom(profile.dayCountConvention, "actual_365").replaceAll("_", "/")} />
            <Summary label="Planned obligations" value={profile.generatePlannedPayments ? "Generated" : "Disabled"} />
          </div>
          <div className={`${styles.notice} ${styles.noticeOffset}`}><Calculator size={17} aria-hidden="true" /><span><strong>Principal is a transfer.</strong> Debt service affects cash flow, but spending reports include only interest and fees. Schedule estimates use annual rate and payment cadence; the stored contract day count is reference-only.</span></div>
        </Section>
      </div>

      <Section title="Interest-rate history" description="International reference indexes and reset terms; new variable-rate periods produce estimates" action={<AddButton onClick={onAddRate}>Add rate period</AddButton>}>
        <ResponsiveTable label="Loan interest-rate periods">
          <thead><tr><th>Effective</th><th>Type</th><th>Reference</th><th>Rate</th><th>Reset</th><th>Notes</th></tr></thead>
          <tbody>{rates.length ? rates.map((item) => {
            const row = readRecord(item);
            const variable = stringFrom(row.rateType) === "variable";
            const rawRate = variable ? numberFrom(row.referenceRateBps) + numberFrom(row.marginBps) : numberFrom(row.fixedRateBps);
            const floor = row.floorRateBps == null ? rawRate : Math.max(rawRate, numberFrom(row.floorRateBps));
            const effective = row.capRateBps == null ? floor : Math.min(floor, numberFrom(row.capRateBps));
            return <tr key={stringFrom(row.id)}><td>{formatDate(row.effectiveFrom)}<small>{row.effectiveTo ? `through ${formatDate(row.effectiveTo)}` : "current"}</small></td><td><Pill tone={variable ? "info" : "neutral"}>{variable ? "variable" : "fixed"}</Pill></td><td>{variable ? `${stringFrom(row.referenceIndex)} ${numberFrom(row.referenceTenorMonths)}M` : "Contract rate"}<small>{variable ? `${percentage(row.referenceRateBps)} + ${percentage(row.marginBps)} margin` : ""}</small></td><td className={styles.amount}>{percentage(effective)}<small>{variable ? "current estimate" : "fixed"}</small></td><td>{variable ? `Every ${numberFrom(row.resetFrequencyMonths)} mo.` : "—"}<small>{row.nextResetDate ? `next ${formatDate(row.nextResetDate)}` : ""}</small></td><td>{stringFrom(row.notes, "—")}</td></tr>;
          }) : <tr><td className={styles.emptyCell} colSpan={6}>No rate periods are configured.</td></tr>}</tbody>
        </ResponsiveTable>
      </Section>

      <Section title="Repayment schedule" description="Projected contractual amounts are estimates until an actual payment is recorded">
        <ResponsiveTable label="Loan repayment schedule">
          <thead><tr><th>#</th><th>Due</th><th>Status</th><th>Rate</th><th>Payment</th><th>Principal</th><th>Interest + fees</th><th>Closing principal</th><th><span className="sr-only">Actions</span></th></tr></thead>
          <tbody>{schedule.length ? schedule.map((item) => {
            const row = readRecord(item);
            const remainingPrincipal = Math.max(0, numberFrom(row.principalMinor) - numberFrom(row.paidPrincipalMinor));
            const remainingInterest = Math.max(0, numberFrom(row.interestMinor) - numberFrom(row.paidInterestMinor));
            const remainingFees = Math.max(0, numberFrom(row.feesMinor) - numberFrom(row.paidFeesMinor));
            const remaining = remainingPrincipal + remainingInterest + remainingFees;
            const status = stringFrom(row.status, "projected");
            return <tr key={stringFrom(row.id)}><td>{numberFrom(row.installmentNumber)}</td><td>{formatDate(row.dueDate)}</td><td><span className={styles.statusCell}><Pill tone={statusTone(status)}>{status}</Pill>{row.isEstimate ? <Pill>estimate</Pill> : null}</span></td><td className={styles.nowrap}>{percentage(row.annualRateBps)}</td><td className={styles.amount}>{formatMoney(row.paymentMinor, currency)}{remaining !== numberFrom(row.paymentMinor) ? <small>{formatMoney(remaining, currency)} remaining</small> : null}</td><td className={styles.amount}>{formatMoney(row.principalMinor, currency)}</td><td className={styles.amount}>{formatMoney(numberFrom(row.interestMinor) + numberFrom(row.feesMinor), currency)}<small>{formatMoney(row.interestMinor, currency)} interest</small></td><td className={styles.amount}>{formatMoney(row.closingPrincipalMinor, currency)}</td><td>{!["paid", "skipped"].includes(status) && remaining > 0 ? <Button variant="ghost" onClick={() => onPay(row)}>Pay</Button> : null}</td></tr>;
          }) : <tr><td className={styles.emptyCell} colSpan={9}>No repayment schedule is available. Add the loan terms first.</td></tr>}</tbody>
        </ResponsiveTable>
      </Section>
      <PaymentHistory payments={payments} currency={currency} kind="loan" onUndo={onUndo} />
      <div className={styles.notice}><CalendarClock size={17} aria-hidden="true" /><span><strong>Forecasts are informational.</strong> Variable-rate projections carry the configured reference value forward until you add a new period. Your lender’s contract and statements remain authoritative.</span></div>
    </div>
  );
}

function Summary({ label, value }: { label: string; value: React.ReactNode }) {
  return <div className={styles.summaryRow}><span>{label}</span><strong className={styles.capitalize}>{value}</strong></div>;
}

function PaymentHistory({ payments, currency, kind, onUndo }: { payments: Row[]; currency: string; kind: "card" | "loan"; onUndo: (payment: Row) => void }) {
  return <Section title="Payment history" description="Actual posted payments with recoverable undo">
    <ResponsiveTable label={`${kind === "card" ? "Credit-card" : "Loan"} payment history`}>
      <thead><tr><th>Date</th><th>From</th><th>Total</th>{kind === "loan" ? <><th>Principal</th><th>Interest</th><th>Fees</th></> : <th>Statement</th>}<th>Status</th><th><span className="sr-only">Actions</span></th></tr></thead>
      <tbody>{payments.length ? payments.map((item) => {
        const row = readRecord(item);
        const voided = Boolean(row.voidedAt);
        const amount = kind === "card" ? row.amountMinor : row.totalMinor;
        const liabilityCurrency = stringFrom(row.liabilityCurrency, currency);
        const cashCurrency = stringFrom(row.cashCurrency, liabilityCurrency);
        const cashAmount = numberFrom(row.cashAmountMinor, numberFrom(amount));
        return <tr key={stringFrom(row.id)}><td>{formatDate(row.paymentDate)}</td><td>{stringFrom(row.sourceAccount, "Cash account")}<small>{cashCurrency}</small></td><td className={styles.amount}>{formatMoney(amount, liabilityCurrency)}{cashCurrency !== liabilityCurrency ? <small>{formatMoney(cashAmount, cashCurrency)} debited</small> : null}</td>{kind === "loan" ? <><td className={styles.amount}>{formatMoney(row.principalMinor, liabilityCurrency)}</td><td className={styles.amount}>{formatMoney(row.interestMinor, liabilityCurrency)}</td><td className={styles.amount}>{formatMoney(row.feesMinor, liabilityCurrency)}</td></> : <td>{row.statementId ? "Linked" : "Unallocated"}</td>}<td><Pill tone={voided ? "neutral" : "positive"}>{voided ? "undone" : "posted"}</Pill></td><td>{!voided ? <Button variant="ghost" icon={<RotateCcw size={14} />} onClick={() => onUndo(row)}>Undo</Button> : null}</td></tr>;
      }) : <tr><td className={styles.emptyCell} colSpan={kind === "loan" ? 8 : 6}>No actual payments have been recorded.</td></tr>}</tbody>
    </ResponsiveTable>
  </Section>;
}

function StatementModal({ open, accountId, currency, onClose, onSaved }: { open: boolean; accountId: string; currency: string; onClose: () => void; onSaved: () => Promise<void> }) {
  const today = isoToday();
  const [periodStart, setPeriodStart] = useState(dateMonthStart(today));
  const [periodEnd, setPeriodEnd] = useState(today);
  const [closingDate, setClosingDate] = useState(today);
  const [dueDate, setDueDate] = useState(dateAfter(today, 21));
  const [balance, setBalance] = useState("");
  const [minimum, setMinimum] = useState(() => minorToInput(0, currency));
  const [notes, setNotes] = useState("");
  const { submit, submitting, submitError } = useSubmit(async () => {
    const statementBalanceMinor = moneyInputToMinor(balance, currency);
    const minimumDueMinor = moneyInputToMinor(minimum, currency);
    if (statementBalanceMinor == null || statementBalanceMinor <= 0) throw new Error("Enter a positive statement balance.");
    if (minimumDueMinor == null || minimumDueMinor < 0) throw new Error("Enter a valid minimum amount due.");
    if (periodEnd < periodStart) throw new Error("The statement period cannot end before it starts.");
    if (closingDate < periodEnd) throw new Error("The closing date cannot precede the period end.");
    if (dueDate < closingDate) throw new Error("The payment due date cannot precede the closing date.");
    if (minimumDueMinor > statementBalanceMinor) throw new Error("The minimum due cannot exceed the statement balance.");
    await requestJson(`/api/liabilities/${encodeURIComponent(accountId)}/statements`, { method: "POST", body: JSON.stringify({ periodStart, periodEnd, closingDate, dueDate, statementBalanceMinor, minimumDueMinor, source: "manual", notes: notes.trim() || null }) });
    onClose();
    await onSaved();
  });
  return <Modal open={open} onClose={onClose} title="Add card statement" description="Enter the lender’s closed statement. Newer card activity stays separate from this amount due." footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button disabled={submitting} onClick={() => void submit()}>{submitting ? "Saving…" : "Save statement"}</Button></>}>
    <form className={styles.formGrid} onSubmit={(event) => void submit(event)}>
      <Field label="Period start"><Input type="date" max={today} value={periodStart} onChange={(event) => setPeriodStart(event.target.value)} /></Field>
      <Field label="Period end"><Input type="date" max={today} value={periodEnd} onChange={(event) => setPeriodEnd(event.target.value)} /></Field>
      <Field label="Closing date"><Input type="date" max={today} value={closingDate} onChange={(event) => setClosingDate(event.target.value)} /></Field>
      <Field label="Payment due"><Input type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} /></Field>
      <Field label={`Statement balance (${currency})`}><Input autoFocus inputMode="decimal" value={balance} onChange={(event) => setBalance(event.target.value)} placeholder={minorToInput(0, currency)} /></Field>
      <Field label={`Minimum due (${currency})`}><Input inputMode="decimal" value={minimum} onChange={(event) => setMinimum(event.target.value)} /></Field>
      <Field label="Notes" className={styles.formSpan}><Textarea value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Optional lender reference" /></Field>
      <button type="submit" hidden />
    </form><FormMessage error={submitError} />
  </Modal>;
}

function CardPaymentModal({ open, accountId, target, statements, profile, cashAccounts, currency, onClose, onSaved }: { open: boolean; accountId: string; target: Row | null; statements: Row[]; profile: Row; cashAccounts: Row[]; currency: string; onClose: () => void; onSaved: () => Promise<void> }) {
  const openStatements = statements.filter((item) => numberFrom(readRecord(item).statementBalanceMinor) > numberFrom(readRecord(item).paymentsAppliedMinor));
  const [statementId, setStatementId] = useState(stringFrom(target?.id));
  const chosen = readRecord(openStatements.find((item) => stringFrom(readRecord(item).id) === statementId));
  const initialAmount = (() => {
    const row = target ?? chosen;
    if (!row) return "";
    const remaining = Math.max(0, numberFrom(row.statementBalanceMinor) - numberFrom(row.paymentsAppliedMinor));
    const minimum = Math.max(0, numberFrom(row.minimumDueMinor) - numberFrom(row.paymentsAppliedMinor));
    return minorToInput(stringFrom(profile.paymentPreference) === "minimum" ? Math.min(remaining, minimum) : remaining, currency);
  })();
  const [sourceAccountId, setSourceAccountId] = useState(stringFrom(cashAccounts[0]?.id));
  const [date, setDate] = useState(isoToday());
  const [amount, setAmount] = useState(initialAmount);
  const [note, setNote] = useState("");
  const [rateMode, setRateMode] = useState<"reference" | "manual">("reference");
  const [manualRate, setManualRate] = useState("");
  const [useExactCashAmount, setUseExactCashAmount] = useState(false);
  const [exactCashAmount, setExactCashAmount] = useState("");
  const effectiveSourceAccountId = sourceAccountId || stringFrom(cashAccounts[0]?.id);
  const sourceAccount = readRecord(cashAccounts.find((item) => stringFrom(readRecord(item).id) === effectiveSourceAccountId));
  const sourceCurrency = stringFrom(sourceAccount.currency, currency).toUpperCase();
  const conversionRequired = Boolean(effectiveSourceAccountId) && sourceCurrency !== currency;
  const { quote: fxQuote, loading: fxLoading, error: fxError } = useFxQuote(date, sourceCurrency, currency, conversionRequired);
  const quoteMatches = Boolean(fxQuote?.fromCurrency === sourceCurrency && fxQuote?.toCurrency === currency);
  const referenceRateScaled = quoteMatches ? fxQuote?.rateScaled ?? null : null;
  const rateScale = quoteMatches ? fxQuote?.rateScale ?? FX_RATE_SCALE : FX_RATE_SCALE;
  const sourceDigits = quoteMatches ? fxQuote?.fromMinorUnitDigits ?? 2 : currencyMinorUnitDigits(sourceCurrency);
  const targetDigits = quoteMatches ? fxQuote?.toMinorUnitDigits ?? 2 : currencyMinorUnitDigits(currency);
  const liabilityAmountMinor = moneyInputToMinor(amount, currency);
  const parsedManualRateScaled = rateInputToScaled(manualRate, rateScale);
  const parsedExactCashAmount = moneyInputToMinor(exactCashAmount, sourceCurrency);
  const derivedExactRateScaled = conversionRequired && liabilityAmountMinor && parsedExactCashAmount
    ? deriveRateScaled(parsedExactCashAmount, liabilityAmountMinor, rateScale, sourceDigits, targetDigits)
    : null;
  const activeRateScaled = useExactCashAmount
    ? derivedExactRateScaled
    : rateMode === "manual" ? parsedManualRateScaled : referenceRateScaled;
  const calculatedCashAmountMinor = conversionRequired && liabilityAmountMinor !== null && activeRateScaled
    ? reverseConvertCurrencyMinor(liabilityAmountMinor, activeRateScaled, rateScale, sourceDigits, targetDigits)
    : liabilityAmountMinor;
  const cashAmountMinor = conversionRequired && useExactCashAmount ? parsedExactCashAmount : calculatedCashAmountMinor;
  const amountReconciles = !conversionRequired || Boolean(
    liabilityAmountMinor && cashAmountMinor && activeRateScaled
      && convertCurrencyMinor(cashAmountMinor, activeRateScaled, rateScale, sourceDigits, targetDigits) === liabilityAmountMinor,
  );
  const displayedRate = useExactCashAmount
    ? derivedExactRateScaled ? rateScaledToInput(derivedExactRateScaled, rateScale) : ""
    : rateMode === "manual" ? manualRate : referenceRateScaled ? rateScaledToInput(referenceRateScaled, rateScale) : "";
  const resetFx = () => {
    setRateMode("reference");
    setManualRate("");
    setUseExactCashAmount(false);
    setExactCashAmount("");
  };
  const { submit, submitting, submitError } = useSubmit(async () => {
    if (!effectiveSourceAccountId) throw new Error("Choose the cash account paying the card.");
    if (liabilityAmountMinor == null || liabilityAmountMinor <= 0) throw new Error("Enter a positive payment amount.");
    if (conversionRequired) {
      if (rateMode === "reference" && !referenceRateScaled) throw new Error("Wait for the BNR reference rate or enter the exchange rate manually.");
      if (!activeRateScaled || activeRateScaled <= 0) throw new Error("Enter a positive exchange rate.");
      if (!cashAmountMinor || cashAmountMinor <= 0) throw new Error(`Enter or calculate a positive cash amount in ${sourceCurrency}.`);
      if (!amountReconciles) throw new Error("The cash and card amounts do not reconcile at eight-decimal rate precision. Use the exact cash amount option.");
    }
    const fxRateSource = conversionRequired ? (rateMode === "manual" || useExactCashAmount ? "manual" : "bnr") : null;
    await requestJson(`/api/liabilities/${encodeURIComponent(accountId)}/payments`, {
      method: "POST",
      body: JSON.stringify({
        kind: "card_payment",
        statementId: statementId || null,
        sourceAccountId: effectiveSourceAccountId,
        date,
        amountMinor: liabilityAmountMinor,
        cashAmountMinor: conversionRequired ? cashAmountMinor : null,
        fxRateScaled: conversionRequired ? activeRateScaled : null,
        fxRateSource,
        fxRateDate: conversionRequired ? fxRateSource === "bnr" ? fxQuote?.rateDate : date : null,
        referenceFxRateScaled: conversionRequired && fxRateSource === "manual" && referenceRateScaled ? referenceRateScaled : null,
        referenceFxRateDate: conversionRequired && fxRateSource === "manual" && referenceRateScaled ? fxQuote?.rateDate : null,
        note: note.trim() || null,
      }),
    });
    onClose();
    await onSaved();
  });
  function chooseStatement(nextId: string) {
    setStatementId(nextId);
    const row = readRecord(openStatements.find((item) => stringFrom(readRecord(item).id) === nextId));
    if (!row.id) return;
    const remaining = Math.max(0, numberFrom(row.statementBalanceMinor) - numberFrom(row.paymentsAppliedMinor));
    const minimum = Math.max(0, numberFrom(row.minimumDueMinor) - numberFrom(row.paymentsAppliedMinor));
    setAmount(minorToInput(stringFrom(profile.paymentPreference) === "minimum" ? Math.min(remaining, minimum) : remaining, currency));
  }
  return <Modal open={open} onClose={onClose} title="Record card payment" description="This posts a transfer from cash to the card. It does not add another expense." footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button disabled={submitting || !cashAccounts.length} onClick={() => void submit()}>{submitting ? "Posting…" : "Post payment"}</Button></>}>
    <form className={styles.formGrid} onSubmit={(event) => void submit(event)}>
      <Field label="Apply to statement" className={styles.formSpan} hint="Optional for balance-only payments">
        <Select value={statementId} onValueChange={(value) => chooseStatement(value)}><option value="">No specific statement</option>{openStatements.map((item) => { const row = readRecord(item); return <option key={stringFrom(row.id)} value={stringFrom(row.id)}>{formatDate(row.closingDate)} · {formatMoney(Math.max(0, numberFrom(row.statementBalanceMinor) - numberFrom(row.paymentsAppliedMinor)), currency)} remaining</option>; })}</Select>
      </Field>
      <Field label="Pay from"><Select value={effectiveSourceAccountId} onValueChange={(value) => { setSourceAccountId(value); resetFx(); }}><option value="">Choose account</option>{cashAccounts.map((item) => { const row = readRecord(item); const denomination = stringFrom(row.currency, currency); return <option key={stringFrom(row.id)} value={stringFrom(row.id)}>{stringFrom(row.name)} · {denomination} · {formatMoney(row.balanceMinor ?? row.currentBalanceMinor, denomination)}</option>; })}</Select></Field>
      <Field label="Payment date"><Input type="date" max={isoToday()} value={date} onChange={(event) => { setDate(event.target.value); resetFx(); }} /></Field>
      <Field label={`Amount (${currency})`} className={styles.formSpan}><Input autoFocus inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder={minorToInput(0, currency)} /></Field>
      {conversionRequired ? <LiabilityFxPanel
        title="Card payment conversion"
        description={`The card balance is reduced in ${currency}; ${stringFrom(sourceAccount.name, "the cash account")} is debited in ${sourceCurrency}.`}
        fromCurrency={sourceCurrency}
        toCurrency={currency}
        quote={fxQuote}
        loading={fxLoading}
        error={fxError}
        rateMode={rateMode}
        manualRate={manualRate}
        displayedRate={displayedRate}
        exactAmountMode={useExactCashAmount}
        exactAmount={exactCashAmount}
        exactAmountCurrency={sourceCurrency}
        exactAmountLabel="Cash account amount"
        calculatedAmountMinor={calculatedCashAmountMinor}
        exactAmountReconciles={amountReconciles}
        onManualRateChange={(value) => { setManualRate(value); setUseExactCashAmount(false); }}
        onManualModeChange={(manual) => {
          setRateMode(manual ? "manual" : "reference");
          if (manual) setManualRate(referenceRateScaled ? rateScaledToInput(referenceRateScaled, rateScale) : manualRate);
          else setUseExactCashAmount(false);
        }}
        onExactAmountChange={setExactCashAmount}
        onExactModeChange={(exact) => {
          setUseExactCashAmount(exact);
          setRateMode("manual");
          if (exact) setExactCashAmount(calculatedCashAmountMinor === null ? "" : minorToInput(calculatedCashAmountMinor, sourceCurrency));
          else if (derivedExactRateScaled) setManualRate(rateScaledToInput(derivedExactRateScaled, rateScale));
        }}
      /> : null}
      <Field label="Note" className={styles.formSpan}><Textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="Optional payment reference" /></Field>
      {!cashAccounts.length ? <div className={`${styles.notice} ${styles.noticeWarning} ${styles.formSpan}`}>Add an active current, savings, or cash account before recording a card payment.</div> : null}
      <button type="submit" hidden />
    </form><FormMessage error={submitError} />
  </Modal>;
}

function LoanPaymentModal({ open, accountId, target, cashAccounts, currency, onClose, onSaved }: { open: boolean; accountId: string; target: Row | null; cashAccounts: Row[]; currency: string; onClose: () => void; onSaved: () => Promise<void> }) {
  const [sourceAccountId, setSourceAccountId] = useState(stringFrom(cashAccounts[0]?.id));
  const [date, setDate] = useState(isoToday());
  const [principal, setPrincipal] = useState(() => minorToInput(target ? Math.max(0, numberFrom(target.principalMinor) - numberFrom(target.paidPrincipalMinor)) : 0, currency));
  const [interest, setInterest] = useState(() => minorToInput(target ? Math.max(0, numberFrom(target.interestMinor) - numberFrom(target.paidInterestMinor)) : 0, currency));
  const [fees, setFees] = useState(() => minorToInput(target ? Math.max(0, numberFrom(target.feesMinor) - numberFrom(target.paidFeesMinor)) : 0, currency));
  const [note, setNote] = useState("");
  const [rateMode, setRateMode] = useState<"reference" | "manual">("reference");
  const [manualRate, setManualRate] = useState("");
  const [useExactCashAmount, setUseExactCashAmount] = useState(false);
  const [exactCashAmount, setExactCashAmount] = useState("");
  const effectiveSourceAccountId = sourceAccountId || stringFrom(cashAccounts[0]?.id);
  const sourceAccount = readRecord(cashAccounts.find((item) => stringFrom(readRecord(item).id) === effectiveSourceAccountId));
  const sourceCurrency = stringFrom(sourceAccount.currency, currency).toUpperCase();
  const conversionRequired = Boolean(effectiveSourceAccountId) && sourceCurrency !== currency;
  const parsed = [principal, interest, fees].map((value) => moneyInputToMinor(value, currency));
  const totalMinor = parsed.every((value) => value != null) ? parsed.reduce<number>((sum, value) => sum + (value ?? 0), 0) : 0;
  const { quote: fxQuote, loading: fxLoading, error: fxError } = useFxQuote(date, sourceCurrency, currency, conversionRequired);
  const quoteMatches = Boolean(fxQuote?.fromCurrency === sourceCurrency && fxQuote?.toCurrency === currency);
  const referenceRateScaled = quoteMatches ? fxQuote?.rateScaled ?? null : null;
  const rateScale = quoteMatches ? fxQuote?.rateScale ?? FX_RATE_SCALE : FX_RATE_SCALE;
  const sourceDigits = quoteMatches ? fxQuote?.fromMinorUnitDigits ?? 2 : currencyMinorUnitDigits(sourceCurrency);
  const targetDigits = quoteMatches ? fxQuote?.toMinorUnitDigits ?? 2 : currencyMinorUnitDigits(currency);
  const parsedManualRateScaled = rateInputToScaled(manualRate, rateScale);
  const parsedExactCashAmount = moneyInputToMinor(exactCashAmount, sourceCurrency);
  const derivedExactRateScaled = conversionRequired && totalMinor > 0 && parsedExactCashAmount
    ? deriveRateScaled(parsedExactCashAmount, totalMinor, rateScale, sourceDigits, targetDigits)
    : null;
  const activeRateScaled = useExactCashAmount
    ? derivedExactRateScaled
    : rateMode === "manual" ? parsedManualRateScaled : referenceRateScaled;
  const calculatedCashAmountMinor = conversionRequired && totalMinor > 0 && activeRateScaled
    ? reverseConvertCurrencyMinor(totalMinor, activeRateScaled, rateScale, sourceDigits, targetDigits)
    : totalMinor;
  const cashAmountMinor = conversionRequired && useExactCashAmount ? parsedExactCashAmount : calculatedCashAmountMinor;
  const amountReconciles = !conversionRequired || Boolean(
    totalMinor > 0 && cashAmountMinor && activeRateScaled
      && convertCurrencyMinor(cashAmountMinor, activeRateScaled, rateScale, sourceDigits, targetDigits) === totalMinor,
  );
  const displayedRate = useExactCashAmount
    ? derivedExactRateScaled ? rateScaledToInput(derivedExactRateScaled, rateScale) : ""
    : rateMode === "manual" ? manualRate : referenceRateScaled ? rateScaledToInput(referenceRateScaled, rateScale) : "";
  const resetFx = () => {
    setRateMode("reference");
    setManualRate("");
    setUseExactCashAmount(false);
    setExactCashAmount("");
  };
  const { submit, submitting, submitError } = useSubmit(async () => {
    const [principalMinor, interestMinor, feesMinor] = parsed;
    if (!effectiveSourceAccountId) throw new Error("Choose the cash account paying this loan.");
    if (principalMinor == null || interestMinor == null || feesMinor == null || Math.min(principalMinor, interestMinor, feesMinor) < 0) throw new Error("Enter non-negative principal, interest, and fee amounts.");
    if (totalMinor <= 0) throw new Error("The total payment must be positive.");
    if (conversionRequired) {
      if (rateMode === "reference" && !referenceRateScaled) throw new Error("Wait for the BNR reference rate or enter the exchange rate manually.");
      if (!activeRateScaled || activeRateScaled <= 0) throw new Error("Enter a positive exchange rate.");
      if (!cashAmountMinor || cashAmountMinor <= 0) throw new Error(`Enter or calculate a positive cash amount in ${sourceCurrency}.`);
      if (!amountReconciles) throw new Error("The cash and loan amounts do not reconcile at eight-decimal rate precision. Use the exact cash amount option.");
    }
    const fxRateSource = conversionRequired ? (rateMode === "manual" || useExactCashAmount ? "manual" : "bnr") : null;
    await requestJson(`/api/liabilities/${encodeURIComponent(accountId)}/payments`, {
      method: "POST",
      body: JSON.stringify({
        kind: "loan_payment",
        scheduleEntryId: target?.id ?? null,
        sourceAccountId: effectiveSourceAccountId,
        date,
        totalMinor,
        principalMinor,
        interestMinor,
        feesMinor,
        cashAmountMinor: conversionRequired ? cashAmountMinor : null,
        fxRateScaled: conversionRequired ? activeRateScaled : null,
        fxRateSource,
        fxRateDate: conversionRequired ? fxRateSource === "bnr" ? fxQuote?.rateDate : date : null,
        referenceFxRateScaled: conversionRequired && fxRateSource === "manual" && referenceRateScaled ? referenceRateScaled : null,
        referenceFxRateDate: conversionRequired && fxRateSource === "manual" && referenceRateScaled ? fxQuote?.rateDate : null,
        note: note.trim() || null,
      }),
    });
    onClose();
    await onSaved();
  });
  return <Modal open={open} onClose={onClose} title={target ? `Record installment #${numberFrom(target.installmentNumber)}` : "Record loan payment"} description="Allocate the lender-confirmed actual amount. Principal reduces debt; interest and fees are expenses." wide footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button disabled={submitting || !cashAccounts.length} onClick={() => void submit()}>{submitting ? "Posting…" : "Post payment"}</Button></>}>
    <form className={styles.formGrid} onSubmit={(event) => void submit(event)}>
      <Field label="Pay from"><Select value={effectiveSourceAccountId} onValueChange={(value) => { setSourceAccountId(value); resetFx(); }}><option value="">Choose account</option>{cashAccounts.map((item) => { const row = readRecord(item); const denomination = stringFrom(row.currency, currency); return <option key={stringFrom(row.id)} value={stringFrom(row.id)}>{stringFrom(row.name)} · {denomination} · {formatMoney(row.balanceMinor ?? row.currentBalanceMinor, denomination)}</option>; })}</Select></Field>
      <Field label="Payment date"><Input type="date" max={isoToday()} value={date} onChange={(event) => { setDate(event.target.value); resetFx(); }} /></Field>
      <Field label={`Principal (${currency})`} hint="Transfer · reduces the liability"><Input autoFocus inputMode="decimal" value={principal} onChange={(event) => setPrincipal(event.target.value)} /></Field>
      <Field label={`Interest (${currency})`} hint="Expense"><Input inputMode="decimal" value={interest} onChange={(event) => setInterest(event.target.value)} /></Field>
      <Field label={`Fees (${currency})`} hint="Expense"><Input inputMode="decimal" value={fees} onChange={(event) => setFees(event.target.value)} /></Field>
      <div className={styles.allocation}><span>Total lender allocation ({currency})</span><strong>{formatMoney(totalMinor, currency)}</strong></div>
      {conversionRequired ? <LiabilityFxPanel
        title="Loan payment conversion"
        description={`The lender allocation remains in ${currency}; ${stringFrom(sourceAccount.name, "the cash account")} is debited in ${sourceCurrency}.`}
        fromCurrency={sourceCurrency}
        toCurrency={currency}
        quote={fxQuote}
        loading={fxLoading}
        error={fxError}
        rateMode={rateMode}
        manualRate={manualRate}
        displayedRate={displayedRate}
        exactAmountMode={useExactCashAmount}
        exactAmount={exactCashAmount}
        exactAmountCurrency={sourceCurrency}
        exactAmountLabel="Cash account amount"
        calculatedAmountMinor={calculatedCashAmountMinor}
        exactAmountReconciles={amountReconciles}
        onManualRateChange={(value) => { setManualRate(value); setUseExactCashAmount(false); }}
        onManualModeChange={(manual) => {
          setRateMode(manual ? "manual" : "reference");
          if (manual) setManualRate(referenceRateScaled ? rateScaledToInput(referenceRateScaled, rateScale) : manualRate);
          else setUseExactCashAmount(false);
        }}
        onExactAmountChange={setExactCashAmount}
        onExactModeChange={(exact) => {
          setUseExactCashAmount(exact);
          setRateMode("manual");
          if (exact) setExactCashAmount(calculatedCashAmountMinor === null ? "" : minorToInput(calculatedCashAmountMinor, sourceCurrency));
          else if (derivedExactRateScaled) setManualRate(rateScaledToInput(derivedExactRateScaled, rateScale));
        }}
      /> : null}
      <Field label="Note" className={styles.formSpan}><Textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="Optional lender reference" /></Field>
      {!cashAccounts.length ? <div className={`${styles.notice} ${styles.noticeWarning} ${styles.formSpan}`}>Add an active current, savings, or cash account before recording a loan payment.</div> : null}
      <button type="submit" hidden />
    </form><FormMessage error={submitError} />
  </Modal>;
}

function RateModal({ open, accountId, onClose, onSaved }: { open: boolean; accountId: string; onClose: () => void; onSaved: () => Promise<void> }) {
  const [rateType, setRateType] = useState<"fixed" | "variable">("fixed");
  const [effectiveFrom, setEffectiveFrom] = useState(isoToday());
  const [fixedRate, setFixedRate] = useState("");
  const [referenceIndex, setReferenceIndex] = useState("");
  const [tenor, setTenor] = useState("3");
  const [referenceRate, setReferenceRate] = useState("");
  const [margin, setMargin] = useState("0.00");
  const [resetMonths, setResetMonths] = useState("3");
  const [nextResetDate, setNextResetDate] = useState("");
  const [lagMonths, setLagMonths] = useState("0");
  const [floor, setFloor] = useState("");
  const [cap, setCap] = useState("");
  const [notes, setNotes] = useState("");
  const { submit, submitting, submitError } = useSubmit(async () => {
    const body = rateType === "fixed" ? { rateType, effectiveFrom, fixedRateBps: bpsInput(fixedRate), notes: notes.trim() || null } : { rateType, effectiveFrom, referenceIndex: referenceIndex.trim(), referenceTenorMonths: Number(tenor), referenceRateBps: bpsInput(referenceRate, false, true), marginBps: bpsInput(margin, false, true), resetFrequencyMonths: Number(resetMonths), nextResetDate: nextResetDate || null, observationLagMonths: Number(lagMonths), floorRateBps: bpsInput(floor, true, true), capRateBps: bpsInput(cap, true, true), notes: notes.trim() || null };
    if (rateType === "variable" && !referenceIndex.trim()) throw new Error("Enter the lender’s reference index.");
    await requestJson(`/api/liabilities/${encodeURIComponent(accountId)}/rates`, { method: "POST", body: JSON.stringify(body) });
    onClose();
    await onSaved();
  });
  return <Modal open={open} onClose={onClose} title="Add interest-rate period" description="Use any lender or jurisdiction’s index. IRCC, ROBOR, and EURIBOR are suggestions, not required defaults." wide footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button disabled={submitting} onClick={() => void submit()}>{submitting ? "Calculating…" : "Add rate period"}</Button></>}>
    <form className={styles.formGrid} onSubmit={(event) => void submit(event)}>
      <Field label="Rate type"><Select value={rateType} onValueChange={(value) => setRateType(value as "fixed" | "variable")}><option value="fixed">Fixed rate</option><option value="variable">Variable / indexed rate</option></Select></Field>
      <Field label="Effective from"><Input type="date" value={effectiveFrom} onChange={(event) => setEffectiveFrom(event.target.value)} /></Field>
      {rateType === "fixed" ? <Field label="Annual rate (%)" className={styles.formSpan}><Input autoFocus inputMode="decimal" value={fixedRate} onChange={(event) => setFixedRate(event.target.value)} placeholder="5.75" /></Field> : <>
        <Field label="Reference index" hint="International or custom"><SuggestionInput autoFocus value={referenceIndex} suggestions={LOAN_REFERENCE_INDEX_SUGGESTIONS} onValueChange={setReferenceIndex} maxLength={80} /></Field>
        <Field label="Index tenor"><Select value={tenor} onValueChange={(value) => setTenor(value)}><option value="1">1 month</option><option value="3">3 months</option><option value="6">6 months</option><option value="12">12 months</option></Select></Field>
        <Field label="Reference rate (%)"><Input inputMode="decimal" value={referenceRate} onChange={(event) => setReferenceRate(event.target.value)} placeholder="5.55" /></Field>
        <Field label="Lender margin (%)"><Input inputMode="decimal" value={margin} onChange={(event) => setMargin(event.target.value)} /></Field>
        <Field label="Reset every"><Select value={resetMonths} onValueChange={(value) => setResetMonths(value)}><option value="1">1 month</option><option value="3">3 months</option><option value="6">6 months</option><option value="12">12 months</option></Select></Field>
        <Field label="Next reset" hint="Optional"><Input type="date" value={nextResetDate} onChange={(event) => setNextResetDate(event.target.value)} /></Field>
        <Field label="Observation lag"><Select value={lagMonths} onValueChange={(value) => setLagMonths(value)}><option value="0">No lag</option><option value="1">1 month</option><option value="2">2 months</option><option value="3">3 months</option></Select></Field>
        <Field label="Rate floor (%)" hint="Optional"><Input inputMode="decimal" value={floor} onChange={(event) => setFloor(event.target.value)} /></Field>
        <Field label="Rate cap (%)" hint="Optional"><Input inputMode="decimal" value={cap} onChange={(event) => setCap(event.target.value)} /></Field>
      </>}
      <Field label="Notes" className={styles.formSpan}><Textarea value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Optional contract or reset reference" /></Field>
      <div className={`${styles.notice} ${styles.formSpan}`}><Calculator size={17} aria-hidden="true" /><span>Updating a variable rate recalculates future estimates only. Recorded actual payments remain unchanged.</span></div>
      <button type="submit" hidden />
    </form><FormMessage error={submitError} />
  </Modal>;
}

function DisbursementModal({ open, accountId, cashAccounts, currency, onClose, onSaved }: { open: boolean; accountId: string; cashAccounts: Row[]; currency: string; onClose: () => void; onSaved: () => Promise<void> }) {
  const [destinationAccountId, setDestinationAccountId] = useState(stringFrom(cashAccounts[0]?.id));
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(isoToday());
  const [rateMode, setRateMode] = useState<"reference" | "manual">("reference");
  const [manualRate, setManualRate] = useState("");
  const [useExactCashAmount, setUseExactCashAmount] = useState(false);
  const [exactCashAmount, setExactCashAmount] = useState("");
  const effectiveDestinationAccountId = destinationAccountId || stringFrom(cashAccounts[0]?.id);
  const destinationAccount = readRecord(cashAccounts.find((item) => stringFrom(readRecord(item).id) === effectiveDestinationAccountId));
  const destinationCurrency = stringFrom(destinationAccount.currency, currency).toUpperCase();
  const conversionRequired = Boolean(effectiveDestinationAccountId) && destinationCurrency !== currency;
  const loanAmountMinor = moneyInputToMinor(amount, currency);
  const { quote: fxQuote, loading: fxLoading, error: fxError } = useFxQuote(date, currency, destinationCurrency, conversionRequired);
  const quoteMatches = Boolean(fxQuote?.fromCurrency === currency && fxQuote?.toCurrency === destinationCurrency);
  const referenceRateScaled = quoteMatches ? fxQuote?.rateScaled ?? null : null;
  const rateScale = quoteMatches ? fxQuote?.rateScale ?? FX_RATE_SCALE : FX_RATE_SCALE;
  const sourceDigits = quoteMatches ? fxQuote?.fromMinorUnitDigits ?? 2 : currencyMinorUnitDigits(currency);
  const targetDigits = quoteMatches ? fxQuote?.toMinorUnitDigits ?? 2 : currencyMinorUnitDigits(destinationCurrency);
  const parsedManualRateScaled = rateInputToScaled(manualRate, rateScale);
  const parsedExactCashAmount = moneyInputToMinor(exactCashAmount, destinationCurrency);
  const derivedExactRateScaled = conversionRequired && loanAmountMinor && parsedExactCashAmount
    ? deriveRateScaled(loanAmountMinor, parsedExactCashAmount, rateScale, sourceDigits, targetDigits)
    : null;
  const activeRateScaled = useExactCashAmount
    ? derivedExactRateScaled
    : rateMode === "manual" ? parsedManualRateScaled : referenceRateScaled;
  const calculatedCashAmountMinor = conversionRequired && loanAmountMinor !== null && activeRateScaled
    ? convertCurrencyMinor(loanAmountMinor, activeRateScaled, rateScale, sourceDigits, targetDigits)
    : loanAmountMinor;
  const cashAmountMinor = conversionRequired && useExactCashAmount ? parsedExactCashAmount : calculatedCashAmountMinor;
  const amountReconciles = !conversionRequired || Boolean(
    loanAmountMinor && cashAmountMinor && activeRateScaled
      && convertCurrencyMinor(loanAmountMinor, activeRateScaled, rateScale, sourceDigits, targetDigits) === cashAmountMinor,
  );
  const displayedRate = useExactCashAmount
    ? derivedExactRateScaled ? rateScaledToInput(derivedExactRateScaled, rateScale) : ""
    : rateMode === "manual" ? manualRate : referenceRateScaled ? rateScaledToInput(referenceRateScaled, rateScale) : "";
  const resetFx = () => {
    setRateMode("reference");
    setManualRate("");
    setUseExactCashAmount(false);
    setExactCashAmount("");
  };
  const { submit, submitting, submitError } = useSubmit(async () => {
    if (!effectiveDestinationAccountId) throw new Error("Choose the account that received the proceeds.");
    if (loanAmountMinor == null || loanAmountMinor <= 0) throw new Error("Enter a positive disbursement amount.");
    if (conversionRequired) {
      if (rateMode === "reference" && !referenceRateScaled) throw new Error("Wait for the BNR reference rate or enter the exchange rate manually.");
      if (!activeRateScaled || activeRateScaled <= 0) throw new Error("Enter a positive exchange rate.");
      if (!cashAmountMinor || cashAmountMinor <= 0) throw new Error(`Enter or calculate positive proceeds in ${destinationCurrency}.`);
      if (!amountReconciles) throw new Error("The loan and cash amounts do not reconcile at eight-decimal rate precision. Edit the exchange rate.");
    }
    const fxRateSource = conversionRequired ? (rateMode === "manual" || useExactCashAmount ? "manual" : "bnr") : null;
    await requestJson(`/api/liabilities/${encodeURIComponent(accountId)}/disburse`, {
      method: "POST",
      body: JSON.stringify({
        destinationAccountId: effectiveDestinationAccountId,
        amountMinor: loanAmountMinor,
        cashAmountMinor: conversionRequired ? cashAmountMinor : null,
        date,
        fxRateScaled: conversionRequired ? activeRateScaled : null,
        fxRateSource,
        fxRateDate: conversionRequired ? fxRateSource === "bnr" ? fxQuote?.rateDate : date : null,
        referenceFxRateScaled: conversionRequired && fxRateSource === "manual" && referenceRateScaled ? referenceRateScaled : null,
        referenceFxRateDate: conversionRequired && fxRateSource === "manual" && referenceRateScaled ? fxQuote?.rateDate : null,
      }),
    });
    onClose();
    await onSaved();
  });
  return <Modal open={open} onClose={onClose} title="Record loan disbursement" description="This transfers borrowed proceeds into a cash account and increases the loan liability. It is not income." footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button disabled={submitting || !cashAccounts.length} onClick={() => void submit()}>{submitting ? "Posting…" : "Post disbursement"}</Button></>}>
    <form className={styles.formGrid} onSubmit={(event) => void submit(event)}>
      <Field label="Proceeds received in" className={styles.formSpan}><Select value={effectiveDestinationAccountId} onValueChange={(value) => { setDestinationAccountId(value); resetFx(); }}><option value="">Choose account</option>{cashAccounts.map((item) => { const row = readRecord(item); const denomination = stringFrom(row.currency, currency); return <option key={stringFrom(row.id)} value={stringFrom(row.id)}>{stringFrom(row.name)} · {denomination} · {formatMoney(row.balanceMinor ?? row.currentBalanceMinor, denomination)}</option>; })}</Select></Field>
      <Field label={`Amount (${currency})`}><Input autoFocus inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder={minorToInput(0, currency)} /></Field>
      <Field label="Disbursement date"><Input type="date" max={isoToday()} value={date} onChange={(event) => { setDate(event.target.value); resetFx(); }} /></Field>
      {conversionRequired ? <LiabilityFxPanel
        title="Loan disbursement conversion"
        description={`The liability increases in ${currency}; ${stringFrom(destinationAccount.name, "the cash account")} receives proceeds in ${destinationCurrency}.`}
        fromCurrency={currency}
        toCurrency={destinationCurrency}
        quote={fxQuote}
        loading={fxLoading}
        error={fxError}
        rateMode={rateMode}
        manualRate={manualRate}
        displayedRate={displayedRate}
        exactAmountMode={useExactCashAmount}
        exactAmount={exactCashAmount}
        exactAmountCurrency={destinationCurrency}
        exactAmountLabel="Cash proceeds"
        calculatedAmountMinor={calculatedCashAmountMinor}
        exactAmountReconciles={amountReconciles}
        onManualRateChange={(value) => { setManualRate(value); setUseExactCashAmount(false); }}
        onManualModeChange={(manual) => {
          setRateMode(manual ? "manual" : "reference");
          if (manual) setManualRate(referenceRateScaled ? rateScaledToInput(referenceRateScaled, rateScale) : manualRate);
          else setUseExactCashAmount(false);
        }}
        onExactAmountChange={setExactCashAmount}
        onExactModeChange={(exact) => {
          setUseExactCashAmount(exact);
          setRateMode("manual");
          if (exact) setExactCashAmount(calculatedCashAmountMinor === null ? "" : minorToInput(calculatedCashAmountMinor, destinationCurrency));
          else if (derivedExactRateScaled) setManualRate(rateScaledToInput(derivedExactRateScaled, rateScale));
        }}
      /> : null}
      <div className={`${styles.notice} ${styles.formSpan}`}><Landmark size={17} aria-hidden="true" /><span>The loan and destination accounts each retain their exact native amount. The paired transfer changes debt and cash without counting the proceeds as income.</span></div>
      <button type="submit" hidden />
    </form><FormMessage error={submitError} />
  </Modal>;
}
