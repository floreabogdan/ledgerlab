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
import { useTranslations, useTranslator } from "@/i18n/client";
import type { Translator } from "@/i18n/runtime";
import { parseApiError, translateApiError } from "@/lib/api-error";
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
  const translator = useTranslator();
  const t = translator.translate;
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
          if (!response.ok) {
            if (active) setError(translateApiError(translator, parseApiError(body)));
            return;
          }
          const rawQuote = readRecord(body.quote);
          if (!Number.isSafeInteger(rawQuote.rateScaled) || numberFrom(rawQuote.rateScaled) <= 0) {
            if (active) setError(t("finance.liabilities.fx.invalidResponse"));
            return;
          }
          if (active) setQuote(rawQuote as FxQuote);
        } catch (caught) {
          if (!active || controller.signal.aborted) return;
          void caught;
          setQuote(null);
          setError(t("finance.liabilities.fx.unavailable"));
        } finally {
          if (active) setLoading(false);
        }
      })();
    });
    return () => {
      active = false;
      controller.abort();
    };
  }, [date, enabled, fromCurrency, t, toCurrency, translator]);

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
  const t = useTranslations();
  return (
    <div className={`${ui.fxPanel} ${ui.formSpan}`}>
      <div className={ui.fxPanelHeader}>
        <span><strong>{title}</strong><small>{description}</small></span>
        {loading ? <Pill tone="info">{t("finance.liabilities.fx.loadingRate")}</Pill> : quote ? <Pill tone={quote.isFallback ? "warning" : "info"}>{t("finance.liabilities.fx.bnrReference")}</Pill> : <Pill tone="warning">{t("finance.liabilities.fx.manualNeeded")}</Pill>}
      </div>
      {quote ? (
        <div className={ui.fxReference}>
          <strong>1 {fromCurrency} = {formatRate(quote.rateScaled, quote.rateScale)} {toCurrency}</strong>
          <span>{quote.isFallback
            ? t("finance.liabilities.fx.effectiveFallback", { date: formatDate(quote.rateDate, { day: "2-digit", month: "short", year: "numeric" }), days: quote.fallbackDays })
            : t("finance.liabilities.fx.effective", { date: formatDate(quote.rateDate, { day: "2-digit", month: "short", year: "numeric" }) })}</span>
        </div>
      ) : error ? <div className={ui.fxError} role="status">{t("finance.liabilities.fx.errorInstruction", { error })}</div> : null}
      {quote?.isStale ? <div className={ui.fxError} role="status">{t("finance.liabilities.fx.stale")}</div> : null}
      <div className={ui.fxControls}>
        <Field label={t("finance.liabilities.fx.rateLabel", { toCurrency, fromCurrency })} hint={exactAmountMode ? t("finance.liabilities.fx.derivedHint") : rateMode === "manual" ? t("finance.liabilities.fx.manualHint") : t("finance.liabilities.fx.referenceHint")}>
          <Input
            inputMode="decimal"
            value={displayedRate}
            disabled={rateMode === "reference" || exactAmountMode}
            onChange={(event) => onManualRateChange(event.target.value)}
            placeholder={loading ? t("finance.liabilities.fx.loading") : t("finance.liabilities.fx.ratePlaceholder")}
          />
        </Field>
        <Field label={t("finance.liabilities.fx.amountLabel", { label: exactAmountLabel, currency: exactAmountCurrency })} hint={exactAmountMode ? exactAmountReconciles ? t("finance.liabilities.fx.exactHint") : t("finance.liabilities.fx.precisionHint") : t("finance.liabilities.fx.roundingHint")}>
          <Input
            inputMode="decimal"
            value={exactAmountMode ? exactAmount : calculatedAmountMinor === null ? "" : minorToInput(calculatedAmountMinor, exactAmountCurrency)}
            disabled={!exactAmountMode}
            aria-invalid={exactAmountMode && !exactAmountReconciles}
            onChange={(event) => onExactAmountChange(event.target.value)}
            placeholder={loading ? t("finance.liabilities.fx.calculating") : minorToInput(0, exactAmountCurrency)}
          />
        </Field>
      </div>
      <div className={ui.fxOptions}>
        <label className={`${ui.small} ${ui.inlineCheck}`}>
          <input type="checkbox" checked={rateMode === "manual"} onChange={(event) => onManualModeChange(event.target.checked)} /> {t("finance.liabilities.fx.editManually")}
        </label>
        <label className={`${ui.small} ${ui.inlineCheck}`}>
          <input type="checkbox" checked={exactAmountMode} onChange={(event) => onExactModeChange(event.target.checked)} /> {t("finance.liabilities.fx.useExact", { label: exactAmountLabel })}
        </label>
      </div>
      {rateMode === "manual" && manualRate && quote ? <p className={ui.fxEstimateNote}>{t("finance.liabilities.fx.auditNote")}</p> : null}
    </div>
  );
}

function percentage(basisPoints: unknown) {
  const value = numberFrom(basisPoints);
  return `${new Intl.NumberFormat(workspaceLocale(), { maximumFractionDigits: 2 }).format(value / 100)}%`;
}

function bpsInput(value: string, translate: Translator["translate"], optional = false, allowNegative = false) {
  if (optional && !value.trim()) return null;
  const normalized = value.trim().replace(",", ".");
  if (!/^-?\d+(\.\d{0,2})?$/.test(normalized)) throw new Error(translate("finance.liabilities.validation.percentagePrecision"));
  const parsed = Number(normalized);
  if (!allowNegative && parsed < 0) throw new Error(translate("finance.liabilities.validation.percentageNonnegative"));
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

function statusLabel(status: string, translate: Translator["translate"]) {
  const keys = {
    paid: "finance.liabilities.status.paid",
    cleared: "finance.liabilities.status.cleared",
    overdue: "finance.liabilities.status.overdue",
    void: "finance.liabilities.status.void",
    partial: "finance.liabilities.status.partial",
    due: "finance.liabilities.status.due",
    open: "finance.liabilities.status.open",
    projected: "finance.liabilities.status.projected",
    pending: "finance.liabilities.status.pending",
    skipped: "finance.liabilities.status.skipped",
    scheduled: "finance.liabilities.status.scheduled",
  } as const;
  return translate(keys[status as keyof typeof keys] ?? "finance.liabilities.status.unknown");
}

function paymentPreferenceLabel(preference: string, translate: Translator["translate"]) {
  if (preference === "minimum") return translate("finance.liabilities.card.terms.preferences.minimum");
  if (preference === "custom") return translate("finance.liabilities.card.terms.preferences.custom");
  return translate("finance.liabilities.card.terms.preferences.fullStatement");
}

function amortizationLabel(method: string, translate: Translator["translate"]) {
  if (method === "equal_principal") return translate("finance.liabilities.loan.terms.methods.equalPrincipal");
  if (method === "interest_only") return translate("finance.liabilities.loan.terms.methods.interestOnly");
  if (method === "annuity") return translate("finance.liabilities.loan.terms.methods.annuity");
  return translate("finance.liabilities.common.notSet");
}

function dayCountLabel(convention: string, translate: Translator["translate"]) {
  if (convention === "actual_360") return translate("finance.liabilities.loan.expenses.dayCounts.actual360");
  if (convention === "30_360") return translate("finance.liabilities.loan.expenses.dayCounts.thirty360");
  return translate("finance.liabilities.loan.expenses.dayCounts.actual365");
}

function availableCashAccounts(raw: Row) {
  return readList<Row>(raw, "accounts").filter((item) => {
    const account = readRecord(item);
    return ["current", "current_account", "savings", "cash"].includes(stringFrom(account.type))
      && !account.archivedAt;
  });
}

export default function LiabilityDetailPage() {
  const t = useTranslations();
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
      setActionError(caught instanceof Error ? caught.message : t("finance.liabilities.validation.undoFallback"));
    } finally {
      setUndoing(false);
    }
  }

  const headerActions = kind === "credit_card" ? (
    <>
      <Button variant="secondary" icon={<ReceiptText size={16} />} onClick={() => setStatementOpen(true)}>{t("finance.liabilities.main.addStatement")}</Button>
      <AddButton onClick={() => setCardPaymentTarget(null)}>{t("finance.liabilities.main.recordPayment")}</AddButton>
    </>
  ) : kind === "loan" ? (
    <>
      <Button variant="secondary" icon={<Banknote size={16} />} onClick={() => setDisburseOpen(true)}>{t("finance.liabilities.main.recordDisbursement")}</Button>
      <AddButton onClick={() => setLoanPaymentTarget(null)}>{t("finance.liabilities.main.recordPayment")}</AddButton>
    </>
  ) : undefined;

  return (
    <Page>
      <Link className={styles.backLink} href="/accounts"><ArrowLeft size={16} aria-hidden="true" />{t("finance.liabilities.main.back")}</Link>
      <DataState loading={detailQuery.loading} error={detailQuery.error} onRetry={detailQuery.reload} empty={!detailQuery.loading && !detailQuery.error && !account.id} emptyTitle={t("finance.liabilities.main.notFound")} emptyDescription={t("finance.liabilities.main.notFoundDescription")}>
        {account.id ? (
          <>
            <ViewHeader
              eyebrow={kind === "credit_card" ? t("finance.liabilities.main.cardEyebrow") : t("finance.liabilities.main.loanEyebrow")}
              title={stringFrom(account.name, t("finance.liabilities.main.titleFallback"))}
              description={kind === "credit_card"
                ? t("finance.liabilities.main.cardDescription")
                : t("finance.liabilities.main.loanDescription")}
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
        title={t("finance.liabilities.main.undoTitle")}
        description={t("finance.liabilities.main.undoDescription")}
        footer={<><Button variant="ghost" onClick={() => setUndoTarget(null)}>{t("finance.liabilities.main.keepPayment")}</Button><Button variant="danger" disabled={undoing} onClick={() => void undoPayment()}>{undoing ? t("finance.liabilities.main.undoing") : t("finance.liabilities.main.undoPayment")}</Button></>}
      >
        <div className={`${styles.notice} ${styles.noticeWarning}`}>
          <RotateCcw size={17} aria-hidden="true" />
          <span>{t("finance.liabilities.main.undoNotice")}</span>
        </div>
      </Modal>
    </Page>
  );
}

function CreditCardWorkspace({ detail, currency, onPay, onUndo }: { detail: Row; currency: string; onPay: (statement: Row) => void; onUndo: (payment: Row) => void }) {
  const t = useTranslations();
  const metrics = readRecord(detail.metrics);
  const profile = readRecord(detail.profile);
  const statements = readList<Row>(detail.statements);
  const payments = readList<Row>(detail.payments);
  const utilization = metrics.utilizationBps == null ? null : numberFrom(metrics.utilizationBps) / 100;
  const minimumPaymentMode = stringFrom(profile.minimumPaymentMode, "manual");
  const minimumPaymentTerm = minimumPaymentMode === "percentage" && profile.minimumPaymentRateBps != null
    ? t("finance.liabilities.card.minimumPercentage", { percentage: percentage(profile.minimumPaymentRateBps) })
    : minimumPaymentMode === "fixed" && profile.minimumPaymentFixedMinor != null
      ? t("finance.liabilities.card.minimumFixed", { amount: formatMoney(profile.minimumPaymentFixedMinor, currency) })
      : t("finance.liabilities.card.minimumFromStatement");
  const utilizationValue = utilization == null
    ? t("finance.liabilities.card.metrics.unavailable")
    : t("finance.liabilities.card.metrics.utilizationValue", { percent: utilization });
  return (
    <div className={styles.sectionStack}>
      <div className={styles.metricGrid}>
        <Metric label={t("finance.liabilities.card.metrics.outstanding")} value={formatMoney(metrics.projectedOutstandingMinor, currency)} tone={numberFrom(metrics.projectedOutstandingMinor) > 0 ? "warning" : "positive"} info={t("finance.liabilities.card.metrics.outstandingInfo")} />
        <Metric label={t("finance.liabilities.card.metrics.available")} value={formatMoney(metrics.availableCreditMinor, currency)} detail={metrics.pendingNetDebtMinor ? t("finance.liabilities.card.metrics.pendingEstimate") : t("finance.liabilities.card.metrics.postedActivity")} tone="accent" />
        <Metric label={t("finance.liabilities.card.metrics.limit")} value={formatMoney(metrics.creditLimitMinor, currency)} detail={t("finance.liabilities.card.metrics.limitDetail")} info={t("finance.liabilities.card.metrics.limitInfo")} />
        <Metric label={t("finance.liabilities.card.metrics.utilization")} value={utilizationValue} detail={numberFrom(metrics.overLimitMinor) > 0 ? t("finance.liabilities.card.metrics.overLimit", { amount: formatMoney(metrics.overLimitMinor, currency) }) : t("finance.liabilities.card.metrics.utilizationDetail")} tone={numberFrom(metrics.overLimitMinor) > 0 ? "negative" : utilization != null && utilization >= 75 ? "warning" : "default"} />
      </div>

      <div className={styles.overviewGrid}>
        <Section title={t("finance.liabilities.card.terms.title")} description={t("finance.liabilities.card.terms.description")}>
          <div className={styles.summaryList}>
            <Summary label={t("finance.liabilities.card.terms.statementDay")} value={profile.statementDay ? t("finance.liabilities.card.terms.day", { day: numberFrom(profile.statementDay) }) : t("finance.liabilities.common.notSet")} />
            <Summary label={t("finance.liabilities.card.terms.dueDay")} value={profile.dueDay ? t("finance.liabilities.card.terms.day", { day: numberFrom(profile.dueDay) }) : t("finance.liabilities.common.notSet")} />
            <Summary label={t("finance.liabilities.card.terms.gracePeriod")} value={profile.gracePeriodDays == null ? t("finance.liabilities.common.notSet") : t("finance.liabilities.card.terms.days", { count: numberFrom(profile.gracePeriodDays) })} />
            <Summary label={t("finance.liabilities.card.terms.purchaseApr")} value={profile.purchaseAprBps == null ? t("finance.liabilities.common.notSet") : percentage(profile.purchaseAprBps)} />
            <Summary label={t("finance.liabilities.card.terms.minimumReference")} value={minimumPaymentTerm} />
            <Summary label={t("finance.liabilities.card.terms.preference")} value={paymentPreferenceLabel(stringFrom(profile.paymentPreference, "full_statement"), t)} />
          </div>
          <div className={styles.profileFooter}>{t("finance.liabilities.card.terms.footer")}</div>
        </Section>
        <Section title={t("finance.liabilities.card.position.title")} description={t("finance.liabilities.card.position.description")}>
          <div className={styles.summaryList}>
            <Summary label={t("finance.liabilities.card.position.postedDebt")} value={formatMoney(metrics.postedOutstandingMinor, currency)} />
            <Summary label={t("finance.liabilities.card.position.pendingCharges")} value={formatMoney(metrics.pendingNetDebtMinor, currency)} />
            <Summary label={t("finance.liabilities.card.position.postedAvailable")} value={formatMoney(metrics.postedAvailableCreditMinor, currency)} />
            <Summary label={t("finance.liabilities.card.position.projectedAvailable")} value={formatMoney(metrics.availableCreditMinor, currency)} />
          </div>
          <div className={styles.utilizationTrack} aria-label={t("finance.liabilities.card.metrics.utilizationAria", { value: utilizationValue })}>
            <span style={{ width: `${Math.min(100, Math.max(0, utilization ?? 0))}%` }} data-warning={Boolean(utilization && utilization >= 75)} data-over={Boolean(utilization && utilization > 100)} />
          </div>
        </Section>
      </div>

      <Section title={t("finance.liabilities.card.statements.title")} description={t("finance.liabilities.card.statements.description")}>
        <ResponsiveTable label={t("finance.liabilities.card.statements.tableLabel")}>
          <thead><tr><th>{t("finance.liabilities.card.statements.period")}</th><th>{t("finance.liabilities.card.statements.closing")}</th><th>{t("finance.liabilities.card.statements.due")}</th><th>{t("finance.liabilities.card.statements.status")}</th><th>{t("finance.liabilities.card.statements.statement")}</th><th>{t("finance.liabilities.card.statements.minimum")}</th><th>{t("finance.liabilities.card.statements.remaining")}</th><th><span className="sr-only">{t("finance.liabilities.common.actions")}</span></th></tr></thead>
          <tbody>
            {statements.length ? statements.map((item) => {
              const row = readRecord(item);
              const remaining = Math.max(0, numberFrom(row.statementBalanceMinor) - numberFrom(row.paymentsAppliedMinor));
              return <tr key={stringFrom(row.id)}>
                <td><span className={styles.nowrap}>{formatDate(row.periodStart, { year: undefined })} – {formatDate(row.periodEnd, { year: undefined })}</span></td>
                <td>{formatDate(row.closingDate)}</td><td>{formatDate(row.dueDate)}</td>
                <td><Pill tone={statusTone(stringFrom(row.status))}>{statusLabel(stringFrom(row.status, "open"), t)}</Pill></td>
                <td className={styles.amount}>{formatMoney(row.statementBalanceMinor, currency)}</td>
                <td className={styles.amount}>{formatMoney(row.minimumDueMinor, currency)}</td>
                <td className={styles.amount}>{formatMoney(remaining, currency)}<small>{numberFrom(row.paymentsAppliedMinor) > 0 ? t("finance.liabilities.card.statements.applied", { amount: formatMoney(row.paymentsAppliedMinor, currency) }) : t("finance.liabilities.card.statements.noPayments")}</small></td>
                <td>{remaining > 0 ? <Button variant="ghost" onClick={() => onPay(row)}>{t("finance.liabilities.common.pay")}</Button> : null}</td>
              </tr>;
            }) : <tr><td className={styles.emptyCell} colSpan={8}>{t("finance.liabilities.card.statements.empty")}</td></tr>}
          </tbody>
        </ResponsiveTable>
      </Section>
      <PaymentHistory payments={payments} currency={currency} kind="card" onUndo={onUndo} />
    </div>
  );
}

function LoanWorkspace({ detail, currency, categoryNames, onPay, onUndo, onAddRate }: { detail: Row; currency: string; categoryNames: Map<string, string>; onPay: (entry: Row) => void; onUndo: (payment: Row) => void; onAddRate: () => void }) {
  const t = useTranslations();
  const metrics = readRecord(detail.metrics);
  const profile = readRecord(detail.profile);
  const rates = readList<Row>(detail.rates);
  const schedule = readList<Row>(detail.schedule);
  const payments = readList<Row>(detail.payments);
  const next = readRecord(metrics.nextInstallment);
  return (
    <div className={styles.sectionStack}>
      <div className={styles.metricGrid}>
        <Metric label={t("finance.liabilities.loan.metrics.outstanding")} value={formatMoney(metrics.outstandingPrincipalMinor, currency)} tone="warning" info={t("finance.liabilities.loan.metrics.outstandingInfo")} />
        <Metric label={t("finance.liabilities.loan.metrics.repaid")} value={formatMoney(metrics.principalRepaidMinor, currency)} tone="positive" info={t("finance.liabilities.loan.metrics.repaidInfo")} />
        <Metric label={t("finance.liabilities.loan.metrics.original")} value={formatMoney(metrics.originalPrincipalMinor, currency)} detail={profile.originationDate ? t("finance.liabilities.loan.metrics.originated", { date: formatDate(profile.originationDate) }) : t("finance.liabilities.loan.metrics.contractAmount")} />
        <Metric label={t("finance.liabilities.loan.metrics.next")} value={next.id ? formatMoney(next.paymentMinor, currency) : t("finance.liabilities.loan.metrics.noneDue")} detail={next.id ? t("finance.liabilities.loan.metrics.nextDetail", { date: formatDate(next.dueDate), status: next.isEstimate ? t("finance.liabilities.status.estimate") : t("finance.liabilities.status.scheduled") }) : t("finance.liabilities.loan.metrics.complete")} tone={next.id ? "accent" : "positive"} />
      </div>

      <div className={styles.overviewGrid}>
        <Section title={t("finance.liabilities.loan.terms.title")} description={t("finance.liabilities.loan.terms.description")}>
          <div className={styles.summaryList}>
            <Summary label={t("finance.liabilities.loan.terms.repaymentMethod")} value={amortizationLabel(stringFrom(profile.amortizationMethod), t)} />
            <Summary label={t("finance.liabilities.loan.terms.frequency")} value={profile.paymentIntervalMonths ? t("finance.liabilities.loan.terms.everyMonths", { count: numberFrom(profile.paymentIntervalMonths) }) : t("finance.liabilities.common.notSet")} />
            <Summary label={t("finance.liabilities.loan.terms.term")} value={profile.termMonths ? t("finance.liabilities.loan.terms.termMonths", { count: numberFrom(profile.termMonths) }) : t("finance.liabilities.common.notSet")} />
            <Summary label={t("finance.liabilities.loan.terms.firstPayment")} value={profile.firstPaymentDate ? formatDate(profile.firstPaymentDate) : t("finance.liabilities.common.notSet")} />
            <Summary label={t("finance.liabilities.loan.terms.maturity")} value={profile.maturityDate ? formatDate(profile.maturityDate) : t("finance.liabilities.common.notSet")} />
            <Summary label={t("finance.liabilities.loan.terms.jurisdiction")} value={stringFrom(profile.jurisdictionCode, t("finance.liabilities.common.notSpecified"))} />
            <Summary label={t("finance.liabilities.loan.terms.paymentAccount")} value={stringFrom(profile.paymentAccount, t("finance.liabilities.loan.terms.chooseWhenPaying"))} />
          </div>
          <div className={styles.profileFooter}>{t("finance.liabilities.loan.terms.footer")}</div>
        </Section>
        <Section title={t("finance.liabilities.loan.expenses.title")} description={t("finance.liabilities.loan.expenses.description")}>
          <div className={styles.summaryList}>
            <Summary label={t("finance.liabilities.loan.expenses.interestCategory")} value={categoryNames.get(stringFrom(profile.interestCategoryId)) ?? t("finance.liabilities.common.uncategorised")} />
            <Summary label={t("finance.liabilities.loan.expenses.feeCategory")} value={categoryNames.get(stringFrom(profile.feeCategoryId)) ?? t("finance.liabilities.common.uncategorised")} />
            <Summary label={t("finance.liabilities.loan.expenses.dayCount")} value={dayCountLabel(stringFrom(profile.dayCountConvention, "actual_365"), t)} />
            <Summary label={t("finance.liabilities.loan.expenses.planned")} value={profile.generatePlannedPayments ? t("finance.liabilities.loan.expenses.generated") : t("finance.liabilities.loan.expenses.disabled")} />
          </div>
          <div className={`${styles.notice} ${styles.noticeOffset}`}><Calculator size={17} aria-hidden="true" /><span><strong>{t("finance.liabilities.loan.expenses.noticeTitle")}</strong> {t("finance.liabilities.loan.expenses.notice")}</span></div>
        </Section>
      </div>

      <Section title={t("finance.liabilities.loan.rates.title")} description={t("finance.liabilities.loan.rates.description")} action={<AddButton onClick={onAddRate}>{t("finance.liabilities.loan.rates.add")}</AddButton>}>
        <ResponsiveTable label={t("finance.liabilities.loan.rates.tableLabel")}>
          <thead><tr><th>{t("finance.liabilities.loan.rates.effective")}</th><th>{t("finance.liabilities.loan.rates.type")}</th><th>{t("finance.liabilities.loan.rates.reference")}</th><th>{t("finance.liabilities.loan.rates.rate")}</th><th>{t("finance.liabilities.loan.rates.reset")}</th><th>{t("finance.liabilities.loan.rates.notes")}</th></tr></thead>
          <tbody>{rates.length ? rates.map((item) => {
            const row = readRecord(item);
            const variable = stringFrom(row.rateType) === "variable";
            const rawRate = variable ? numberFrom(row.referenceRateBps) + numberFrom(row.marginBps) : numberFrom(row.fixedRateBps);
            const floor = row.floorRateBps == null ? rawRate : Math.max(rawRate, numberFrom(row.floorRateBps));
            const effective = row.capRateBps == null ? floor : Math.min(floor, numberFrom(row.capRateBps));
            return <tr key={stringFrom(row.id)}><td>{formatDate(row.effectiveFrom)}<small>{row.effectiveTo ? t("finance.liabilities.loan.rates.through", { date: formatDate(row.effectiveTo) }) : t("finance.liabilities.status.current")}</small></td><td><Pill tone={variable ? "info" : "neutral"}>{variable ? t("finance.liabilities.status.variable") : t("finance.liabilities.status.fixed")}</Pill></td><td>{variable ? t("finance.liabilities.loan.rates.referenceIndexTenor", { index: stringFrom(row.referenceIndex), months: numberFrom(row.referenceTenorMonths) }) : t("finance.liabilities.loan.rates.contractRate")}<small>{variable ? t("finance.liabilities.loan.rates.variableComponents", { referenceRate: percentage(row.referenceRateBps), margin: percentage(row.marginBps) }) : ""}</small></td><td className={styles.amount}>{percentage(effective)}<small>{variable ? t("finance.liabilities.loan.rates.currentEstimate") : t("finance.liabilities.status.fixed")}</small></td><td>{variable ? t("finance.liabilities.loan.rates.resetEvery", { months: numberFrom(row.resetFrequencyMonths) }) : "—"}<small>{row.nextResetDate ? t("finance.liabilities.loan.rates.nextReset", { date: formatDate(row.nextResetDate) }) : ""}</small></td><td>{stringFrom(row.notes, "—")}</td></tr>;
          }) : <tr><td className={styles.emptyCell} colSpan={6}>{t("finance.liabilities.loan.rates.empty")}</td></tr>}</tbody>
        </ResponsiveTable>
      </Section>

      <Section title={t("finance.liabilities.loan.schedule.title")} description={t("finance.liabilities.loan.schedule.description")}>
        <ResponsiveTable label={t("finance.liabilities.loan.schedule.tableLabel")}>
          <thead><tr><th>{t("finance.liabilities.loan.schedule.number")}</th><th>{t("finance.liabilities.loan.schedule.due")}</th><th>{t("finance.liabilities.loan.schedule.status")}</th><th>{t("finance.liabilities.loan.schedule.rate")}</th><th>{t("finance.liabilities.loan.schedule.payment")}</th><th>{t("finance.liabilities.loan.schedule.principal")}</th><th>{t("finance.liabilities.loan.schedule.interestFees")}</th><th>{t("finance.liabilities.loan.schedule.closingPrincipal")}</th><th><span className="sr-only">{t("finance.liabilities.common.actions")}</span></th></tr></thead>
          <tbody>{schedule.length ? schedule.map((item) => {
            const row = readRecord(item);
            const remainingPrincipal = Math.max(0, numberFrom(row.principalMinor) - numberFrom(row.paidPrincipalMinor));
            const remainingInterest = Math.max(0, numberFrom(row.interestMinor) - numberFrom(row.paidInterestMinor));
            const remainingFees = Math.max(0, numberFrom(row.feesMinor) - numberFrom(row.paidFeesMinor));
            const remaining = remainingPrincipal + remainingInterest + remainingFees;
            const status = stringFrom(row.status, "projected");
            return <tr key={stringFrom(row.id)}><td>{numberFrom(row.installmentNumber)}</td><td>{formatDate(row.dueDate)}</td><td><span className={styles.statusCell}><Pill tone={statusTone(status)}>{statusLabel(status, t)}</Pill>{row.isEstimate ? <Pill>{t("finance.liabilities.status.estimate")}</Pill> : null}</span></td><td className={styles.nowrap}>{percentage(row.annualRateBps)}</td><td className={styles.amount}>{formatMoney(row.paymentMinor, currency)}{remaining !== numberFrom(row.paymentMinor) ? <small>{t("finance.liabilities.loan.schedule.remaining", { amount: formatMoney(remaining, currency) })}</small> : null}</td><td className={styles.amount}>{formatMoney(row.principalMinor, currency)}</td><td className={styles.amount}>{formatMoney(numberFrom(row.interestMinor) + numberFrom(row.feesMinor), currency)}<small>{t("finance.liabilities.loan.schedule.interest", { amount: formatMoney(row.interestMinor, currency) })}</small></td><td className={styles.amount}>{formatMoney(row.closingPrincipalMinor, currency)}</td><td>{!["paid", "skipped"].includes(status) && remaining > 0 ? <Button variant="ghost" onClick={() => onPay(row)}>{t("finance.liabilities.common.pay")}</Button> : null}</td></tr>;
          }) : <tr><td className={styles.emptyCell} colSpan={9}>{t("finance.liabilities.loan.schedule.empty")}</td></tr>}</tbody>
        </ResponsiveTable>
      </Section>
      <PaymentHistory payments={payments} currency={currency} kind="loan" onUndo={onUndo} />
      <div className={styles.notice}><CalendarClock size={17} aria-hidden="true" /><span><strong>{t("finance.liabilities.loan.forecastTitle")}</strong> {t("finance.liabilities.loan.forecastNotice")}</span></div>
    </div>
  );
}

function Summary({ label, value }: { label: string; value: React.ReactNode }) {
  return <div className={styles.summaryRow}><span>{label}</span><strong className={styles.capitalize}>{value}</strong></div>;
}

function PaymentHistory({ payments, currency, kind, onUndo }: { payments: Row[]; currency: string; kind: "card" | "loan"; onUndo: (payment: Row) => void }) {
  const t = useTranslations();
  return <Section title={t("finance.liabilities.payments.title")} description={t("finance.liabilities.payments.description")}>
    <ResponsiveTable label={kind === "card" ? t("finance.liabilities.payments.cardTableLabel") : t("finance.liabilities.payments.loanTableLabel")}>
      <thead><tr><th>{t("finance.liabilities.payments.date")}</th><th>{t("finance.liabilities.payments.from")}</th><th>{t("finance.liabilities.payments.total")}</th>{kind === "loan" ? <><th>{t("finance.liabilities.payments.principal")}</th><th>{t("finance.liabilities.payments.interest")}</th><th>{t("finance.liabilities.payments.fees")}</th></> : <th>{t("finance.liabilities.payments.statement")}</th>}<th>{t("finance.liabilities.payments.status")}</th><th><span className="sr-only">{t("finance.liabilities.common.actions")}</span></th></tr></thead>
      <tbody>{payments.length ? payments.map((item) => {
        const row = readRecord(item);
        const voided = Boolean(row.voidedAt);
        const amount = kind === "card" ? row.amountMinor : row.totalMinor;
        const liabilityCurrency = stringFrom(row.liabilityCurrency, currency);
        const cashCurrency = stringFrom(row.cashCurrency, liabilityCurrency);
        const cashAmount = numberFrom(row.cashAmountMinor, numberFrom(amount));
        return <tr key={stringFrom(row.id)}><td>{formatDate(row.paymentDate)}</td><td>{stringFrom(row.sourceAccount, t("finance.liabilities.common.cashAccount"))}<small>{cashCurrency}</small></td><td className={styles.amount}>{formatMoney(amount, liabilityCurrency)}{cashCurrency !== liabilityCurrency ? <small>{t("finance.liabilities.payments.debited", { amount: formatMoney(cashAmount, cashCurrency) })}</small> : null}</td>{kind === "loan" ? <><td className={styles.amount}>{formatMoney(row.principalMinor, liabilityCurrency)}</td><td className={styles.amount}>{formatMoney(row.interestMinor, liabilityCurrency)}</td><td className={styles.amount}>{formatMoney(row.feesMinor, liabilityCurrency)}</td></> : <td>{row.statementId ? t("finance.liabilities.payments.linked") : t("finance.liabilities.payments.unallocated")}</td>}<td><Pill tone={voided ? "neutral" : "positive"}>{voided ? t("finance.liabilities.status.undone") : t("finance.liabilities.status.posted")}</Pill></td><td>{!voided ? <Button variant="ghost" icon={<RotateCcw size={14} />} onClick={() => onUndo(row)}>{t("finance.liabilities.common.undo")}</Button> : null}</td></tr>;
      }) : <tr><td className={styles.emptyCell} colSpan={kind === "loan" ? 8 : 6}>{t("finance.liabilities.payments.empty")}</td></tr>}</tbody>
    </ResponsiveTable>
  </Section>;
}

function StatementModal({ open, accountId, currency, onClose, onSaved }: { open: boolean; accountId: string; currency: string; onClose: () => void; onSaved: () => Promise<void> }) {
  const t = useTranslations();
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
    if (statementBalanceMinor == null || statementBalanceMinor <= 0) throw new Error(t("finance.liabilities.validation.statementBalance"));
    if (minimumDueMinor == null || minimumDueMinor < 0) throw new Error(t("finance.liabilities.validation.minimumDue"));
    if (periodEnd < periodStart) throw new Error(t("finance.liabilities.validation.statementPeriod"));
    if (closingDate < periodEnd) throw new Error(t("finance.liabilities.validation.closingDate"));
    if (dueDate < closingDate) throw new Error(t("finance.liabilities.validation.dueDate"));
    if (minimumDueMinor > statementBalanceMinor) throw new Error(t("finance.liabilities.validation.minimumExceedsBalance"));
    await requestJson(`/api/liabilities/${encodeURIComponent(accountId)}/statements`, { method: "POST", body: JSON.stringify({ periodStart, periodEnd, closingDate, dueDate, statementBalanceMinor, minimumDueMinor, source: "manual", notes: notes.trim() || null }) });
    onClose();
    await onSaved();
  });
  return <Modal open={open} onClose={onClose} title={t("finance.liabilities.statementForm.title")} description={t("finance.liabilities.statementForm.description")} footer={<><Button variant="ghost" onClick={onClose}>{t("common.actions.cancel")}</Button><Button disabled={submitting} onClick={() => void submit()}>{submitting ? t("finance.liabilities.statementForm.saving") : t("finance.liabilities.statementForm.save")}</Button></>}>
    <form className={styles.formGrid} onSubmit={(event) => void submit(event)}>
      <Field label={t("finance.liabilities.statementForm.periodStart")}><Input type="date" max={today} value={periodStart} onChange={(event) => setPeriodStart(event.target.value)} /></Field>
      <Field label={t("finance.liabilities.statementForm.periodEnd")}><Input type="date" max={today} value={periodEnd} onChange={(event) => setPeriodEnd(event.target.value)} /></Field>
      <Field label={t("finance.liabilities.statementForm.closingDate")}><Input type="date" max={today} value={closingDate} onChange={(event) => setClosingDate(event.target.value)} /></Field>
      <Field label={t("finance.liabilities.statementForm.paymentDue")}><Input type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} /></Field>
      <Field label={t("finance.liabilities.statementForm.balance", { currency })}><Input autoFocus inputMode="decimal" value={balance} onChange={(event) => setBalance(event.target.value)} placeholder={minorToInput(0, currency)} /></Field>
      <Field label={t("finance.liabilities.statementForm.minimum", { currency })}><Input inputMode="decimal" value={minimum} onChange={(event) => setMinimum(event.target.value)} /></Field>
      <Field label={t("finance.liabilities.common.notes")} className={styles.formSpan}><Textarea value={notes} onChange={(event) => setNotes(event.target.value)} placeholder={t("finance.liabilities.common.optionalLenderReference")} /></Field>
      <button type="submit" hidden />
    </form><FormMessage error={submitError} />
  </Modal>;
}

function CardPaymentModal({ open, accountId, target, statements, profile, cashAccounts, currency, onClose, onSaved }: { open: boolean; accountId: string; target: Row | null; statements: Row[]; profile: Row; cashAccounts: Row[]; currency: string; onClose: () => void; onSaved: () => Promise<void> }) {
  const t = useTranslations();
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
    if (!effectiveSourceAccountId) throw new Error(t("finance.liabilities.validation.chooseCardCash"));
    if (liabilityAmountMinor == null || liabilityAmountMinor <= 0) throw new Error(t("finance.liabilities.validation.paymentAmount"));
    if (conversionRequired) {
      if (rateMode === "reference" && !referenceRateScaled) throw new Error(t("finance.liabilities.validation.waitForRate"));
      if (!activeRateScaled || activeRateScaled <= 0) throw new Error(t("finance.liabilities.validation.positiveRate"));
      if (!cashAmountMinor || cashAmountMinor <= 0) throw new Error(t("finance.liabilities.validation.positiveCashAmount", { currency: sourceCurrency }));
      if (!amountReconciles) throw new Error(t("finance.liabilities.validation.cardReconcile"));
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
  return <Modal open={open} onClose={onClose} title={t("finance.liabilities.cardPaymentForm.title")} description={t("finance.liabilities.cardPaymentForm.description")} footer={<><Button variant="ghost" onClick={onClose}>{t("common.actions.cancel")}</Button><Button disabled={submitting || !cashAccounts.length} onClick={() => void submit()}>{submitting ? t("finance.liabilities.common.posting") : t("finance.liabilities.common.postPayment")}</Button></>}>
    <form className={styles.formGrid} onSubmit={(event) => void submit(event)}>
      <Field label={t("finance.liabilities.cardPaymentForm.applyStatement")} className={styles.formSpan} hint={t("finance.liabilities.cardPaymentForm.applyHint")}>
        <Select value={statementId} onValueChange={(value) => chooseStatement(value)}><option value="">{t("finance.liabilities.cardPaymentForm.noStatement")}</option>{openStatements.map((item) => { const row = readRecord(item); return <option key={stringFrom(row.id)} value={stringFrom(row.id)}>{t("finance.liabilities.cardPaymentForm.statementOption", { date: formatDate(row.closingDate), amount: formatMoney(Math.max(0, numberFrom(row.statementBalanceMinor) - numberFrom(row.paymentsAppliedMinor)), currency) })}</option>; })}</Select>
      </Field>
      <Field label={t("finance.liabilities.cardPaymentForm.payFrom")}><Select value={effectiveSourceAccountId} onValueChange={(value) => { setSourceAccountId(value); resetFx(); }}><option value="">{t("finance.liabilities.common.chooseAccount")}</option>{cashAccounts.map((item) => { const row = readRecord(item); const denomination = stringFrom(row.currency, currency); return <option key={stringFrom(row.id)} value={stringFrom(row.id)}>{stringFrom(row.name)} · {denomination} · {formatMoney(row.balanceMinor ?? row.currentBalanceMinor, denomination)}</option>; })}</Select></Field>
      <Field label={t("finance.liabilities.cardPaymentForm.paymentDate")}><Input type="date" max={isoToday()} value={date} onChange={(event) => { setDate(event.target.value); resetFx(); }} /></Field>
      <Field label={t("finance.liabilities.common.amount", { currency })} className={styles.formSpan}><Input autoFocus inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder={minorToInput(0, currency)} /></Field>
      {conversionRequired ? <LiabilityFxPanel
        title={t("finance.liabilities.cardPaymentForm.conversionTitle")}
        description={t("finance.liabilities.cardPaymentForm.conversionDescription", { cardCurrency: currency, account: stringFrom(sourceAccount.name, t("finance.liabilities.common.theCashAccount")), cashCurrency: sourceCurrency })}
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
        exactAmountLabel={t("finance.liabilities.cardPaymentForm.cashAmount")}
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
      <Field label={t("finance.liabilities.common.note")} className={styles.formSpan}><Textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder={t("finance.liabilities.common.optionalLenderReference")} /></Field>
      {!cashAccounts.length ? <div className={`${styles.notice} ${styles.noticeWarning} ${styles.formSpan}`}>{t("finance.liabilities.cardPaymentForm.noCashAccount")}</div> : null}
      <button type="submit" hidden />
    </form><FormMessage error={submitError} />
  </Modal>;
}

function LoanPaymentModal({ open, accountId, target, cashAccounts, currency, onClose, onSaved }: { open: boolean; accountId: string; target: Row | null; cashAccounts: Row[]; currency: string; onClose: () => void; onSaved: () => Promise<void> }) {
  const t = useTranslations();
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
    if (!effectiveSourceAccountId) throw new Error(t("finance.liabilities.validation.chooseLoanCash"));
    if (principalMinor == null || interestMinor == null || feesMinor == null || Math.min(principalMinor, interestMinor, feesMinor) < 0) throw new Error(t("finance.liabilities.validation.allocationNonnegative"));
    if (totalMinor <= 0) throw new Error(t("finance.liabilities.validation.totalPositive"));
    if (conversionRequired) {
      if (rateMode === "reference" && !referenceRateScaled) throw new Error(t("finance.liabilities.validation.waitForRate"));
      if (!activeRateScaled || activeRateScaled <= 0) throw new Error(t("finance.liabilities.validation.positiveRate"));
      if (!cashAmountMinor || cashAmountMinor <= 0) throw new Error(t("finance.liabilities.validation.positiveCashAmount", { currency: sourceCurrency }));
      if (!amountReconciles) throw new Error(t("finance.liabilities.validation.loanReconcile"));
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
  return <Modal open={open} onClose={onClose} title={target ? t("finance.liabilities.loanPaymentForm.installmentTitle", { number: numberFrom(target.installmentNumber) }) : t("finance.liabilities.loanPaymentForm.title")} description={t("finance.liabilities.loanPaymentForm.description")} wide footer={<><Button variant="ghost" onClick={onClose}>{t("common.actions.cancel")}</Button><Button disabled={submitting || !cashAccounts.length} onClick={() => void submit()}>{submitting ? t("finance.liabilities.common.posting") : t("finance.liabilities.common.postPayment")}</Button></>}>
    <form className={styles.formGrid} onSubmit={(event) => void submit(event)}>
      <Field label={t("finance.liabilities.loanPaymentForm.payFrom")}><Select value={effectiveSourceAccountId} onValueChange={(value) => { setSourceAccountId(value); resetFx(); }}><option value="">{t("finance.liabilities.common.chooseAccount")}</option>{cashAccounts.map((item) => { const row = readRecord(item); const denomination = stringFrom(row.currency, currency); return <option key={stringFrom(row.id)} value={stringFrom(row.id)}>{stringFrom(row.name)} · {denomination} · {formatMoney(row.balanceMinor ?? row.currentBalanceMinor, denomination)}</option>; })}</Select></Field>
      <Field label={t("finance.liabilities.loanPaymentForm.paymentDate")}><Input type="date" max={isoToday()} value={date} onChange={(event) => { setDate(event.target.value); resetFx(); }} /></Field>
      <Field label={t("finance.liabilities.loanPaymentForm.principal", { currency })} hint={t("finance.liabilities.loanPaymentForm.principalHint")}><Input autoFocus inputMode="decimal" value={principal} onChange={(event) => setPrincipal(event.target.value)} /></Field>
      <Field label={t("finance.liabilities.loanPaymentForm.interest", { currency })} hint={t("finance.liabilities.loanPaymentForm.expenseHint")}><Input inputMode="decimal" value={interest} onChange={(event) => setInterest(event.target.value)} /></Field>
      <Field label={t("finance.liabilities.loanPaymentForm.fees", { currency })} hint={t("finance.liabilities.loanPaymentForm.expenseHint")}><Input inputMode="decimal" value={fees} onChange={(event) => setFees(event.target.value)} /></Field>
      <div className={styles.allocation}><span>{t("finance.liabilities.loanPaymentForm.allocation", { currency })}</span><strong>{formatMoney(totalMinor, currency)}</strong></div>
      {conversionRequired ? <LiabilityFxPanel
        title={t("finance.liabilities.loanPaymentForm.conversionTitle")}
        description={t("finance.liabilities.loanPaymentForm.conversionDescription", { loanCurrency: currency, account: stringFrom(sourceAccount.name, t("finance.liabilities.common.theCashAccount")), cashCurrency: sourceCurrency })}
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
        exactAmountLabel={t("finance.liabilities.loanPaymentForm.cashAmount")}
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
      <Field label={t("finance.liabilities.common.note")} className={styles.formSpan}><Textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder={t("finance.liabilities.common.optionalLenderReference")} /></Field>
      {!cashAccounts.length ? <div className={`${styles.notice} ${styles.noticeWarning} ${styles.formSpan}`}>{t("finance.liabilities.loanPaymentForm.noCashAccount")}</div> : null}
      <button type="submit" hidden />
    </form><FormMessage error={submitError} />
  </Modal>;
}

function RateModal({ open, accountId, onClose, onSaved }: { open: boolean; accountId: string; onClose: () => void; onSaved: () => Promise<void> }) {
  const t = useTranslations();
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
  const referenceIndexSuggestions = LOAN_REFERENCE_INDEX_SUGGESTIONS.map((suggestion) => ({
    value: suggestion.value,
    label: t(suggestion.labelKey),
    description: t(suggestion.descriptionKey),
  }));
  const { submit, submitting, submitError } = useSubmit(async () => {
    const body = rateType === "fixed" ? { rateType, effectiveFrom, fixedRateBps: bpsInput(fixedRate, t), notes: notes.trim() || null } : { rateType, effectiveFrom, referenceIndex: referenceIndex.trim(), referenceTenorMonths: Number(tenor), referenceRateBps: bpsInput(referenceRate, t, false, true), marginBps: bpsInput(margin, t, false, true), resetFrequencyMonths: Number(resetMonths), nextResetDate: nextResetDate || null, observationLagMonths: Number(lagMonths), floorRateBps: bpsInput(floor, t, true, true), capRateBps: bpsInput(cap, t, true, true), notes: notes.trim() || null };
    if (rateType === "variable" && !referenceIndex.trim()) throw new Error(t("finance.liabilities.validation.referenceIndex"));
    await requestJson(`/api/liabilities/${encodeURIComponent(accountId)}/rates`, { method: "POST", body: JSON.stringify(body) });
    onClose();
    await onSaved();
  });
  return <Modal open={open} onClose={onClose} title={t("finance.liabilities.rateForm.title")} description={t("finance.liabilities.rateForm.description")} wide footer={<><Button variant="ghost" onClick={onClose}>{t("common.actions.cancel")}</Button><Button disabled={submitting} onClick={() => void submit()}>{submitting ? t("finance.liabilities.rateForm.calculating") : t("finance.liabilities.rateForm.add")}</Button></>}>
    <form className={styles.formGrid} onSubmit={(event) => void submit(event)}>
      <Field label={t("finance.liabilities.rateForm.rateType")}><Select value={rateType} onValueChange={(value) => setRateType(value as "fixed" | "variable")}><option value="fixed">{t("finance.liabilities.rateForm.fixed")}</option><option value="variable">{t("finance.liabilities.rateForm.variable")}</option></Select></Field>
      <Field label={t("finance.liabilities.rateForm.effectiveFrom")}><Input type="date" value={effectiveFrom} onChange={(event) => setEffectiveFrom(event.target.value)} /></Field>
      {rateType === "fixed" ? <Field label={t("finance.liabilities.rateForm.annualRate")} className={styles.formSpan}><Input autoFocus inputMode="decimal" value={fixedRate} onChange={(event) => setFixedRate(event.target.value)} placeholder="5.75" /></Field> : <>
        <Field label={t("finance.liabilities.rateForm.referenceIndex")} hint={t("finance.liabilities.rateForm.referenceHint")}><SuggestionInput autoFocus value={referenceIndex} suggestions={referenceIndexSuggestions} onValueChange={setReferenceIndex} maxLength={80} /></Field>
        <Field label={t("finance.liabilities.rateForm.indexTenor")}><Select value={tenor} onValueChange={(value) => setTenor(value)}><option value="1">{t("finance.loanOptions.intervals.oneMonth")}</option><option value="3">{t("finance.loanOptions.intervals.threeMonths")}</option><option value="6">{t("finance.loanOptions.intervals.sixMonths")}</option><option value="12">{t("finance.loanOptions.intervals.twelveMonths")}</option></Select></Field>
        <Field label={t("finance.liabilities.rateForm.referenceRate")}><Input inputMode="decimal" value={referenceRate} onChange={(event) => setReferenceRate(event.target.value)} placeholder="5.55" /></Field>
        <Field label={t("finance.liabilities.rateForm.lenderMargin")}><Input inputMode="decimal" value={margin} onChange={(event) => setMargin(event.target.value)} /></Field>
        <Field label={t("finance.liabilities.rateForm.resetEvery")}><Select value={resetMonths} onValueChange={(value) => setResetMonths(value)}><option value="1">{t("finance.loanOptions.intervals.oneMonth")}</option><option value="3">{t("finance.loanOptions.intervals.threeMonths")}</option><option value="6">{t("finance.loanOptions.intervals.sixMonths")}</option><option value="12">{t("finance.loanOptions.intervals.twelveMonths")}</option></Select></Field>
        <Field label={t("finance.liabilities.rateForm.nextReset")} hint={t("finance.liabilities.common.optional")}><Input type="date" value={nextResetDate} onChange={(event) => setNextResetDate(event.target.value)} /></Field>
        <Field label={t("finance.liabilities.rateForm.observationLag")}><Select value={lagMonths} onValueChange={(value) => setLagMonths(value)}><option value="0">{t("finance.liabilities.rateForm.noLag")}</option><option value="1">{t("finance.loanOptions.intervals.oneMonth")}</option><option value="2">{t("finance.liabilities.rateForm.twoMonths")}</option><option value="3">{t("finance.loanOptions.intervals.threeMonths")}</option></Select></Field>
        <Field label={t("finance.liabilities.rateForm.rateFloor")} hint={t("finance.liabilities.common.optional")}><Input inputMode="decimal" value={floor} onChange={(event) => setFloor(event.target.value)} /></Field>
        <Field label={t("finance.liabilities.rateForm.rateCap")} hint={t("finance.liabilities.common.optional")}><Input inputMode="decimal" value={cap} onChange={(event) => setCap(event.target.value)} /></Field>
      </>}
      <Field label={t("finance.liabilities.common.notes")} className={styles.formSpan}><Textarea value={notes} onChange={(event) => setNotes(event.target.value)} placeholder={t("finance.liabilities.rateForm.notesPlaceholder")} /></Field>
      <div className={`${styles.notice} ${styles.formSpan}`}><Calculator size={17} aria-hidden="true" /><span>{t("finance.liabilities.rateForm.notice")}</span></div>
      <button type="submit" hidden />
    </form><FormMessage error={submitError} />
  </Modal>;
}

function DisbursementModal({ open, accountId, cashAccounts, currency, onClose, onSaved }: { open: boolean; accountId: string; cashAccounts: Row[]; currency: string; onClose: () => void; onSaved: () => Promise<void> }) {
  const t = useTranslations();
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
    if (!effectiveDestinationAccountId) throw new Error(t("finance.liabilities.validation.chooseProceedsAccount"));
    if (loanAmountMinor == null || loanAmountMinor <= 0) throw new Error(t("finance.liabilities.validation.disbursementAmount"));
    if (conversionRequired) {
      if (rateMode === "reference" && !referenceRateScaled) throw new Error(t("finance.liabilities.validation.waitForRate"));
      if (!activeRateScaled || activeRateScaled <= 0) throw new Error(t("finance.liabilities.validation.positiveRate"));
      if (!cashAmountMinor || cashAmountMinor <= 0) throw new Error(t("finance.liabilities.validation.positiveProceeds", { currency: destinationCurrency }));
      if (!amountReconciles) throw new Error(t("finance.liabilities.validation.disbursementReconcile"));
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
  return <Modal open={open} onClose={onClose} title={t("finance.liabilities.disbursementForm.title")} description={t("finance.liabilities.disbursementForm.description")} footer={<><Button variant="ghost" onClick={onClose}>{t("common.actions.cancel")}</Button><Button disabled={submitting || !cashAccounts.length} onClick={() => void submit()}>{submitting ? t("finance.liabilities.common.posting") : t("finance.liabilities.disbursementForm.post")}</Button></>}>
    <form className={styles.formGrid} onSubmit={(event) => void submit(event)}>
      <Field label={t("finance.liabilities.disbursementForm.destination")} className={styles.formSpan}><Select value={effectiveDestinationAccountId} onValueChange={(value) => { setDestinationAccountId(value); resetFx(); }}><option value="">{t("finance.liabilities.common.chooseAccount")}</option>{cashAccounts.map((item) => { const row = readRecord(item); const denomination = stringFrom(row.currency, currency); return <option key={stringFrom(row.id)} value={stringFrom(row.id)}>{stringFrom(row.name)} · {denomination} · {formatMoney(row.balanceMinor ?? row.currentBalanceMinor, denomination)}</option>; })}</Select></Field>
      <Field label={t("finance.liabilities.common.amount", { currency })}><Input autoFocus inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder={minorToInput(0, currency)} /></Field>
      <Field label={t("finance.liabilities.disbursementForm.date")}><Input type="date" max={isoToday()} value={date} onChange={(event) => { setDate(event.target.value); resetFx(); }} /></Field>
      {conversionRequired ? <LiabilityFxPanel
        title={t("finance.liabilities.disbursementForm.conversionTitle")}
        description={t("finance.liabilities.disbursementForm.conversionDescription", { loanCurrency: currency, account: stringFrom(destinationAccount.name, t("finance.liabilities.common.theCashAccount")), cashCurrency: destinationCurrency })}
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
        exactAmountLabel={t("finance.liabilities.disbursementForm.cashProceeds")}
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
      <div className={`${styles.notice} ${styles.formSpan}`}><Landmark size={17} aria-hidden="true" /><span>{t("finance.liabilities.disbursementForm.notice")}</span></div>
      <button type="submit" hidden />
    </form><FormMessage error={submitError} />
  </Modal>;
}
