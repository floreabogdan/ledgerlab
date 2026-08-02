"use client";

import {
  ArrowLeftRight,
  Ban,
  CalendarDays,
  CheckCircle2,
  Clock3,
  List,
  RotateCcw,
  SkipForward,
  WalletCards,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { useDateRange } from "@/components/date-range-context";
import { CurrencyCombobox } from "@/components/ui/currency-combobox";
import { useTranslations, useTranslator } from "@/i18n/client";
import { DEFAULT_CURRENCY, isSupportedCurrency } from "@/lib/currencies";
import { parseApiError, translateApiError } from "@/lib/api-error";
import { currencyMinorUnitDigits } from "@/lib/domain/currency";
import { monthBounds } from "@/lib/domain/dates";
import {
  convertCurrencyMinor,
  deriveRateScaled,
  FX_RATE_SCALE,
  rateInputToScaled,
  rateScaledToInput,
} from "@/lib/domain/fx-math";
import {
  AddButton,
  Button,
  DataState,
  Field,
  FormMessage,
  formatDate,
  formatMoney,
  IconButton,
  Input,
  isoToday,
  Metric,
  Modal,
  moneyInputToMinor,
  minorToInput,
  MonthStepper,
  numberFrom,
  Page,
  Pill,
  readList,
  readRecord,
  requestJson,
  ResponsiveTable,
  SearchField,
  Section,
  Select,
  stringFrom,
  Tabs,
  Textarea,
  useJson,
  useSubmit,
  ViewHeader,
  workspaceLocale,
} from "../_components/feature-kit";
import ui from "../_components/pages.module.css";
import styles from "./planned.module.css";

type Row = Record<string, unknown>;
type Translate = ReturnType<typeof useTranslations>;
type ViewMode = "list" | "calendar";
type PaymentFilter = "upcoming" | "overdue" | "paid" | "all";
type LiabilitySource = "credit_card_statement" | "loan_schedule";
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

function paymentName(row: Row, t: Translate) {
  const source = liabilitySource(row);
  const account = stringFrom(row.liabilityAccountName, t("planning.shared.fallback.account"));
  if (source === "credit_card_statement") {
    return t("planning.plannedPayments.type.cardStatementName", { account });
  }
  if (source === "loan_schedule") {
    return t("planning.plannedPayments.type.loanInstalmentName", { account });
  }
  return stringFrom(row.name ?? row.title ?? row.merchantName ?? row.merchant, t("planning.shared.fallback.plannedPayment"));
}

function statusTone(status: string) {
  if (status === "paid") return "positive" as const;
  if (status === "overdue") return "negative" as const;
  if (status === "cancelled" || status === "skipped") return "neutral" as const;
  if (status === "scheduled") return "info" as const;
  return "warning" as const;
}

function normalizeDate(value: unknown) {
  return stringFrom(value).slice(0, 10);
}

function liabilitySource(row: Row): LiabilitySource | null {
  const source = stringFrom(row.sourceType);
  return source === "credit_card_statement" || source === "loan_schedule" ? source : null;
}

function optionalNumber(row: Row, ...keys: string[]) {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  }
  return null;
}

function accountFor(row: Row, accounts: Row[]) {
  const id = stringFrom(row.liabilityAccountId ?? row.accountId);
  return readRecord(accounts.find((item) => stringFrom(readRecord(item).id) === id));
}

function nativeCurrency(row: Row, accounts: Row[], reportingCurrency: string) {
  return stringFrom(
    row.nativeCurrency
      ?? (liabilitySource(row) ? accountFor(row, accounts).currency : row.currency)
      ?? reportingCurrency,
    reportingCurrency,
  ).toUpperCase();
}

function baseFieldsAreReporting(row: Row, accounts: Row[], reportingCurrency: string) {
  const baseCurrency = stringFrom(row.currency).toUpperCase();
  const native = nativeCurrency(row, accounts, reportingCurrency);
  return baseCurrency === reportingCurrency || (!baseCurrency && native === reportingCurrency);
}

function nativeExpectedMinor(row: Row) {
  return Math.max(0, optionalNumber(row, "nativeExpectedAmountMinor", "expectedAmountMinor") ?? 0);
}

function nativePaidMinor(row: Row) {
  return Math.max(0, optionalNumber(row, "nativePaidAmountMinor", "paidAmountMinor") ?? 0);
}

function nativeCashDueMinor(row: Row) {
  if (liabilitySource(row)) return Math.max(0, optionalNumber(row, "nativeCashFlowAmountMinor", "cashFlowAmountMinor", "nativeExpectedAmountMinor", "expectedAmountMinor") ?? 0);
  if (["paid", "skipped", "cancelled"].includes(stringFrom(row.status))) return 0;
  return Math.max(0, nativeExpectedMinor(row) - nativePaidMinor(row));
}

function nativeSpendingDueMinor(row: Row) {
  if (liabilitySource(row)) return Math.max(0, optionalNumber(row, "nativeSpendingAmountMinor", "spendingAmountMinor") ?? 0);
  return stringFrom(row.direction, "expense") === "expense" ? nativeCashDueMinor(row) : 0;
}

function reportingExpectedMinor(row: Row, accounts: Row[], reportingCurrency: string) {
  const explicit = optionalNumber(row, "reportingExpectedAmountMinor");
  if (explicit !== null) return Math.max(0, explicit);
  return baseFieldsAreReporting(row, accounts, reportingCurrency)
    ? Math.max(0, optionalNumber(row, "expectedAmountMinor") ?? 0)
    : null;
}

function reportingPaidMinor(row: Row, accounts: Row[], reportingCurrency: string) {
  const explicit = optionalNumber(row, "reportingPaidAmountMinor");
  if (explicit !== null) return Math.max(0, explicit);
  return baseFieldsAreReporting(row, accounts, reportingCurrency)
    ? Math.max(0, optionalNumber(row, "paidAmountMinor") ?? 0)
    : null;
}

function reportingCashDueMinor(row: Row, accounts: Row[], reportingCurrency: string) {
  const explicit = optionalNumber(row, "reportingCashFlowAmountMinor", "reportingOutstandingAmountMinor");
  if (explicit !== null) return Math.max(0, explicit);
  if (liabilitySource(row)) {
    return baseFieldsAreReporting(row, accounts, reportingCurrency)
      ? Math.max(0, optionalNumber(row, "cashFlowAmountMinor", "expectedAmountMinor") ?? 0)
      : null;
  }
  if (["paid", "skipped", "cancelled"].includes(stringFrom(row.status))) return 0;
  const expected = reportingExpectedMinor(row, accounts, reportingCurrency);
  const paid = reportingPaidMinor(row, accounts, reportingCurrency);
  return expected === null || paid === null ? null : Math.max(0, expected - paid);
}

function reportingSpendingDueMinor(row: Row, accounts: Row[], reportingCurrency: string) {
  const explicit = optionalNumber(row, "reportingSpendingAmountMinor");
  if (explicit !== null) return Math.max(0, explicit);
  if (liabilitySource(row)) {
    return baseFieldsAreReporting(row, accounts, reportingCurrency)
      ? Math.max(0, optionalNumber(row, "spendingAmountMinor") ?? 0)
      : null;
  }
  return stringFrom(row.direction, "expense") === "expense"
    ? reportingCashDueMinor(row, accounts, reportingCurrency)
    : 0;
}

function nativePrincipalMinor(row: Row) {
  return Math.max(0, optionalNumber(row, "nativePrincipalAmountMinor", "principalAmountMinor") ?? 0);
}

function obligationType(row: Row, t: Translate) {
  const source = liabilitySource(row);
  if (source === "credit_card_statement") return t("planning.plannedPayments.type.cardStatement");
  if (source === "loan_schedule") return t("planning.plannedPayments.type.loanInstalment");
  return stringFrom(row.direction, "expense") === "income"
    ? t("planning.plannedPayments.type.plannedIncome")
    : t("planning.plannedPayments.type.plannedExpense");
}

function paymentStatusLabel(status: string, t: Translate) {
  if (status === "planned") return t("planning.plannedPayments.status.planned");
  if (status === "scheduled") return t("planning.plannedPayments.status.scheduled");
  if (status === "overdue") return t("planning.plannedPayments.status.overdue");
  if (status === "paid") return t("planning.plannedPayments.status.paid");
  if (status === "cancelled") return t("planning.plannedPayments.status.cancelled");
  if (status === "skipped") return t("planning.plannedPayments.status.skipped");
  return t("planning.plannedPayments.status.unknown");
}

function paymentRecurrenceLabel(row: Row, t: Translate) {
  if (liabilitySource(row)) return t("planning.plannedPayments.recurrence.debtSchedule");
  if (!(row.ruleId ?? row.recurrenceRuleId)) return t("planning.plannedPayments.recurrence.oneTime");
  const interval = Math.max(1, numberFrom(row.interval, 1));
  const frequency = stringFrom(row.frequency);
  if (frequency === "weekly") return t("planning.plannedPayments.recurrence.weekly", { interval });
  if (frequency === "monthly") return t("planning.plannedPayments.recurrence.monthly", { interval });
  if (frequency === "yearly") return t("planning.plannedPayments.recurrence.yearly", { interval });
  return t("planning.plannedPayments.recurrence.recurring");
}

export default function PlannedPaymentsPage() {
  const t = useTranslations();
  const translator = useTranslator();
  const router = useRouter();
  const { range, label: rangeLabel, locale, setRange, timeZone } = useDateRange();
  const plannedUrl = useMemo(() => {
    const params = new URLSearchParams({ from: range.from, to: range.to });
    return `/api/planned?${params.toString()}`;
  }, [range.from, range.to]);
  const { data: raw, loading, error, reload } = useJson<Record<string, unknown>>(plannedUrl, {});
  const occurrences = readList<Row>(raw, "occurrences", "planned", "payments", "plannedPayments");
  const accounts = readList<Row>(raw, "accounts").filter((item) => !Boolean(readRecord(item).archivedAt ?? readRecord(item).isArchived));
  const currency = stringFrom(readRecord(raw).currency ?? readRecord(accounts[0]).currency, DEFAULT_CURRENCY).toUpperCase();
  const categories = readList<Row>(raw, "categories");
  const [view, setView] = useState<ViewMode>("list");
  const [filter, setFilter] = useState<PaymentFilter>("upcoming");
  const [search, setSearch] = useState("");
  const [month, setMonth] = useState(range.from.slice(0, 7));
  const [createOpen, setCreateOpen] = useState(false);
  const [paying, setPaying] = useState<Row | null>(null);
  const [cancelling, setCancelling] = useState<Row | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const selectCalendarMonth = (value: string) => {
    setMonth(value);
    const bounds = monthBounds(value);
    setRange({ from: bounds.start, to: bounds.end });
  };

  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("new") === "1") {
      queueMicrotask(() => setCreateOpen(true));
    }
  }, []);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (active) setMonth(range.from.slice(0, 7));
    });
    return () => {
      active = false;
    };
  }, [range.from]);

  const today = isoToday();
  const overdue = occurrences.filter((item) => {
    const row = readRecord(item);
    return stringFrom(row.status) === "overdue" || (normalizeDate(row.dueDate) < today && ["planned", "scheduled"].includes(stringFrom(row.status)));
  });
  const paid = occurrences.filter((item) => stringFrom(readRecord(item).status) === "paid");
  const upcoming = occurrences.filter((item) => {
    const status = stringFrom(readRecord(item).status);
    return ["planned", "scheduled"].includes(status) && !overdue.includes(item);
  });
  const filtered = (filter === "all" ? occurrences : filter === "overdue" ? overdue : filter === "paid" ? paid : upcoming)
    .filter((item) => {
      const row = readRecord(item);
      return !search || [paymentName(row, t), obligationType(row, t), row.categoryName, row.category, row.accountName, row.account, row.notes, row.note].filter(Boolean).join(" ").toLocaleLowerCase(locale).includes(search.toLocaleLowerCase(locale));
    })
    .sort((a, b) => normalizeDate(readRecord(a).dueDate).localeCompare(normalizeDate(readRecord(b).dueDate)));

  const activeExpenseRows = occurrences.map(readRecord).filter((row) =>
    stringFrom(row.direction, "expense") === "expense" && !["skipped", "cancelled"].includes(stringFrom(row.status)),
  );
  const cashDueValues = activeExpenseRows.map((row) => reportingCashDueMinor(row, accounts, currency));
  const spendingDueValues = activeExpenseRows.map((row) => reportingSpendingDueMinor(row, accounts, currency));
  const overdueValues = overdue.map((item) => reportingCashDueMinor(readRecord(item), accounts, currency));
  const cashDueTotal = cashDueValues.every((value): value is number => value !== null)
    ? cashDueValues.reduce((sum, value) => sum + value, 0)
    : null;
  const spendingDueTotal = spendingDueValues.every((value): value is number => value !== null)
    ? spendingDueValues.reduce((sum, value) => sum + value, 0)
    : null;
  const overdueTotal = overdueValues.every((value): value is number => value !== null)
    ? overdueValues.reduce((sum, value) => sum + value, 0)
    : null;
  const reportingTotalsUnavailable = cashDueTotal === null || spendingDueTotal === null || overdueTotal === null;

  function openPayment(row: Row) {
    const liabilityAccountId = stringFrom(row.liabilityAccountId);
    if (liabilitySource(row) && liabilityAccountId) {
      router.push(`/accounts/${encodeURIComponent(liabilityAccountId)}`);
      return;
    }
    setPaying(row);
  }

  async function occurrenceAction(row: Row, action: "skip" | "cancel" | "undo") {
    setActionError(null);
    try {
      await requestJson(`/api/planned/${encodeURIComponent(String(row.id))}/${action}`, {
        method: "POST",
        body: JSON.stringify({ occurrenceId: row.id }),
      }, translator);
      if (action === "cancel") setCancelling(null);
      await reload();
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : t("planning.plannedPayments.feedback.actionFailed", { action }));
    }
  }

  return (
    <Page>
      <ViewHeader
        eyebrow={t("planning.plannedPayments.header.eyebrow")}
        title={t("planning.plannedPayments.header.title")}
        description={t("planning.plannedPayments.header.description")}
        actions={<AddButton onClick={() => setCreateOpen(true)}>{t("planning.plannedPayments.actions.planPayment")}</AddButton>}
      />

      <div className={ui.metricGrid}>
        <Metric label={t("planning.plannedPayments.metrics.cashDue.label")} value={cashDueTotal === null ? t("planning.shared.labels.notAvailable") : formatMoney(cashDueTotal, currency)} detail={cashDueTotal === null ? t("planning.plannedPayments.metrics.conversionUnavailable") : t("planning.plannedPayments.metrics.cashDue.rangeDetail", { range: rangeLabel, currency })} tone="accent" info={t("planning.plannedPayments.metrics.cashDue.info")} />
        <Metric label={t("planning.plannedPayments.metrics.spending.label")} value={spendingDueTotal === null ? t("planning.shared.labels.notAvailable") : formatMoney(spendingDueTotal, currency)} detail={spendingDueTotal === null ? t("planning.plannedPayments.metrics.conversionUnavailable") : t("planning.plannedPayments.metrics.spending.detail", { currency })} tone="warning" info={t("planning.plannedPayments.metrics.spending.info")} />
        <Metric label={t("planning.plannedPayments.metrics.overdue.label")} value={overdueTotal === null ? t("planning.shared.labels.notAvailable") : formatMoney(overdueTotal, currency)} detail={overdueTotal === null ? t("planning.plannedPayments.metrics.conversionUnavailable") : t("planning.plannedPayments.metrics.overdue.detail", { count: overdue.length, currency })} tone={overdue.length ? "negative" : "default"} info={t("planning.plannedPayments.metrics.overdue.info")} />
        <Metric label={t("planning.plannedPayments.metrics.paid.label")} value={paid.length} detail={t("planning.plannedPayments.metrics.paid.detail")} tone="positive" />
      </div>

      <Section
        title={t("planning.plannedPayments.schedule.title")}
        description={t("planning.plannedPayments.schedule.description", { range: rangeLabel })}
        action={
          <div className={ui.toolbarGroup}>
            <Button variant={view === "list" ? "secondary" : "ghost"} icon={<List size={15} />} onClick={() => setView("list")}>{t("planning.plannedPayments.actions.list")}</Button>
            <Button variant={view === "calendar" ? "secondary" : "ghost"} icon={<CalendarDays size={15} />} onClick={() => setView("calendar")}>{t("planning.plannedPayments.actions.calendar")}</Button>
          </div>
        }
      >
        <Tabs
          id="payment-status"
          panelId="payment-status-panel"
          label={t("planning.plannedPayments.schedule.tabLabel")}
          value={filter}
          onChange={setFilter}
          items={[
            { value: "upcoming", label: t("planning.plannedPayments.schedule.upcoming"), count: upcoming.length },
            { value: "overdue", label: t("planning.plannedPayments.schedule.overdue"), count: overdue.length },
            { value: "paid", label: t("planning.plannedPayments.schedule.paid"), count: paid.length },
            { value: "all", label: t("planning.plannedPayments.schedule.all"), count: occurrences.length },
          ]}
        />
        <div id="payment-status-panel" role="tabpanel" aria-labelledby={`payment-status-${filter}-tab`}>
          <div className={`${ui.toolbar} ${ui.sectionToolbar}`}>
            <SearchField value={search} onChange={setSearch} placeholder={t("planning.plannedPayments.schedule.searchPlaceholder")} />
            <div className={ui.statusSummary}>
              <span><i className={ui.statusPlanned} /> {t("planning.plannedPayments.schedule.legendPlanned")}</span>
              <span><i className={ui.statusScheduled} /> {t("planning.plannedPayments.schedule.legendScheduled")}</span>
              <span><i className={ui.statusPaid} /> {t("planning.plannedPayments.schedule.legendPaid")}</span>
            </div>
          </div>
          <FormMessage error={actionError} />
          {reportingTotalsUnavailable ? (
            <div className={`${ui.inlineNotice} ${ui.inlineNoticeWarning} ${styles.reportingNotice}`} role="status">
              {t("planning.plannedPayments.schedule.reportingUnavailable")}
            </div>
          ) : null}

          <DataState
            loading={loading}
            error={error}
            onRetry={reload}
            empty={!occurrences.length}
            emptyTitle={t("planning.plannedPayments.schedule.emptyTitle")}
            emptyDescription={t("planning.plannedPayments.schedule.emptyDescription")}
            action={<AddButton onClick={() => setCreateOpen(true)}>{t("planning.plannedPayments.actions.planAPayment")}</AddButton>}
          >
            {view === "list" ? (
              <PaymentList rows={filtered} accounts={accounts} reportingCurrency={currency} onPay={openPayment} onAction={occurrenceAction} onCancel={setCancelling} />
            ) : (
              <PaymentCalendar rows={occurrences} accounts={accounts} reportingCurrency={currency} month={month} setMonth={selectCalendarMonth} onSelect={openPayment} />
            )}
          </DataState>
        </div>
      </Section>

      <PlannedForm key={`${createOpen ? "planned-form-open" : "planned-form-closed"}-${currency}`} open={createOpen} onClose={() => setCreateOpen(false)} onCreated={reload} reportingCurrency={currency} timeZone={timeZone} accounts={accounts} categories={categories} />
      {paying ? <PayForm key={`${String(paying.id)}-${currency}`} occurrence={paying} onClose={() => setPaying(null)} onPaid={reload} reportingCurrency={currency} accounts={accounts} /> : null}
      {cancelling ? (
        <Modal
          open
          onClose={() => { setCancelling(null); setActionError(null); }}
          title={t("planning.plannedPayments.cancel.title")}
          description={t("planning.plannedPayments.cancel.description", { name: paymentName(cancelling, t), date: formatDate(cancelling.dueDate) })}
          footer={<><Button variant="ghost" onClick={() => setCancelling(null)}>{t("planning.plannedPayments.actions.keepOccurrence")}</Button><Button variant="danger" onClick={() => void occurrenceAction(cancelling, "cancel")}>{t("planning.plannedPayments.actions.cancelOccurrence")}</Button></>}
        >
          <div className={`${ui.inlineNotice} ${ui.noticeInset}`}><Ban size={16} />{t("planning.plannedPayments.cancel.notice")}</div>
          <FormMessage error={actionError} />
        </Modal>
      ) : null}
    </Page>
  );
}

function MoneyStack({
  nativeAmount,
  nativeCurrency: denomination,
  reportingAmount,
  reportingCurrency,
  detail,
  tone,
}: {
  nativeAmount: number;
  nativeCurrency: string;
  reportingAmount: number | null;
  reportingCurrency: string;
  detail: string;
  tone?: string;
}) {
  const t = useTranslations();
  if (!nativeAmount) return <span className={styles.moneyStack}><strong className={ui.muted}>{t("planning.shared.labels.notAvailable")}</strong><small>{detail}</small></span>;
  const showEquivalent = denomination !== reportingCurrency || reportingAmount !== nativeAmount;
  return (
    <span className={styles.moneyStack}>
      <strong className={tone}>{formatMoney(nativeAmount, denomination)}</strong>
      <small>{t("planning.plannedPayments.money.nativeDetail", { detail, currency: denomination })}</small>
      {showEquivalent ? (
        reportingAmount === null
          ? <small className={styles.reportingUnavailable}>{t("planning.plannedPayments.money.reportingUnavailable")}</small>
          : <small className={styles.reportingEquivalent}>{t("planning.plannedPayments.money.reportingEquivalent", { amount: formatMoney(reportingAmount, reportingCurrency) })}</small>
      ) : null}
    </span>
  );
}

function PaymentList({ rows, accounts, reportingCurrency, onPay, onAction, onCancel }: { rows: Row[]; accounts: Row[]; reportingCurrency: string; onPay: (row: Row) => void; onAction: (row: Row, action: "skip" | "cancel" | "undo") => Promise<void>; onCancel: (row: Row) => void }) {
  const t = useTranslations();
  if (!rows.length) return <div className={`${ui.inlineNotice} ${ui.noticeInset}`}><Clock3 size={16} />{t("planning.plannedPayments.table.empty")}</div>;
  return (
    <ResponsiveTable label={t("planning.plannedPayments.table.label")}>
      <thead><tr><th>{t("planning.plannedPayments.table.due")}</th><th>{t("planning.plannedPayments.table.payment")}</th><th>{t("planning.plannedPayments.table.typeCategory")}</th><th>{t("planning.plannedPayments.table.recurrence")}</th><th>{t("planning.plannedPayments.table.status")}</th><th>{t("planning.plannedPayments.table.cashDue")}</th><th>{t("planning.plannedPayments.table.spending")}</th><th>{t("planning.plannedPayments.table.appliedActual")}</th><th>{t("planning.plannedPayments.table.actions")}</th></tr></thead>
      <tbody>
        {rows.map((item, index) => {
          const row = readRecord(item);
          const status = stringFrom(row.status, "planned");
          const denomination = nativeCurrency(row, accounts, reportingCurrency);
          const paid = nativePaidMinor(row);
          const cashDue = nativeCashDueMinor(row);
          const spendingDue = nativeSpendingDueMinor(row);
          const reportingCashDue = reportingCashDueMinor(row, accounts, reportingCurrency);
          const reportingSpendingDue = reportingSpendingDueMinor(row, accounts, reportingCurrency);
          const reportingPaid = reportingPaidMinor(row, accounts, reportingCurrency);
          const source = liabilitySource(row);
          const canPay = ["planned", "scheduled", "overdue"].includes(status);
          return (
            <tr key={stringFrom(row.id, String(index))}>
              <td className={ui.nowrap}><strong>{formatDate(row.dueDate, { day: "2-digit", month: "short", year: "2-digit" })}</strong>{normalizeDate(row.dueDate) < isoToday() && status !== "paid" ? <small className={ui.negative}>{t("planning.plannedPayments.table.pastDue")}</small> : null}</td>
              <td className={ui.paymentName}><span className={ui.tablePrimary}>{paymentName(row, t)}</span><span className={ui.tableSecondary}>{stringFrom(row.notes ?? row.note)}</span></td>
              <td><Pill tone={source ? "info" : "neutral"}>{obligationType(row, t)}</Pill><small>{source === "credit_card_statement" ? t("planning.plannedPayments.table.cardTransfer") : source === "loan_schedule" ? t("planning.plannedPayments.table.loanExpense") : stringFrom(row.categoryName ?? row.category, t("planning.shared.labels.uncategorised"))}</small></td>
              <td>{paymentRecurrenceLabel(row, t)}{!source && (row.ruleId ?? row.recurrenceRuleId) ? <small>{t("planning.plannedPayments.recurrence.occurrenceOnly")}</small> : row.isEstimate ? <small>{t("planning.plannedPayments.recurrence.currentRateEstimate")}</small> : null}</td>
              <td><Pill tone={statusTone(status)}>{paymentStatusLabel(status, t)}</Pill>{paid > 0 && status !== "paid" ? <small>{t("planning.plannedPayments.table.amountRemains", { amount: formatMoney(cashDue, denomination) })}</small> : null}</td>
              <td className={ui.amount}><MoneyStack nativeAmount={cashDue} nativeCurrency={denomination} reportingAmount={reportingCashDue} reportingCurrency={reportingCurrency} detail={cashDue ? t("planning.plannedPayments.money.nativeCashProjection") : t("planning.plannedPayments.money.settled")} tone={cashDue ? ui.warning : ui.muted} /></td>
              <td className={ui.amount}><MoneyStack nativeAmount={spendingDue} nativeCurrency={denomination} reportingAmount={reportingSpendingDue} reportingCurrency={reportingCurrency} detail={source === "credit_card_statement" ? t("planning.plannedPayments.money.noNewSpending") : source === "loan_schedule" ? t("planning.plannedPayments.money.principalExcluded", { amount: formatMoney(nativePrincipalMinor(row), denomination) }) : spendingDue ? t("planning.plannedPayments.money.nativePlannedExpense") : t("planning.plannedPayments.money.notExpense")} tone={spendingDue ? ui.negative : ui.muted} /></td>
              <td className={ui.amount}><MoneyStack nativeAmount={paid} nativeCurrency={denomination} reportingAmount={reportingPaid} reportingCurrency={reportingCurrency} detail={paid ? t("planning.plannedPayments.money.appliedToPlan") : t("planning.plannedPayments.money.notPosted")} tone={paid ? ui.positive : ui.muted} /></td>
              <td>
                <div className={ui.paymentActions}>
                  {source ? <Button variant="secondary" onClick={() => onPay(row)}>{canPay ? t("planning.plannedPayments.actions.recordPayment") : t("planning.plannedPayments.actions.viewAccount")}</Button> : null}
                  {!source && canPay ? <Button variant="secondary" onClick={() => onPay(row)}>{paid ? t("planning.plannedPayments.actions.payRemainder") : t("planning.plannedPayments.actions.markPaid")}</Button> : null}
                  {!source && canPay ? <IconButton label={t("planning.plannedPayments.actions.skipCycle")} onClick={() => void onAction(row, "skip")}><SkipForward size={15} /></IconButton> : null}
                  {!source && canPay && !paid ? <IconButton label={t("planning.plannedPayments.actions.cancelWithdrawn")} onClick={() => onCancel(row)}><Ban size={15} /></IconButton> : null}
                  {!source && (status === "paid" || paid > 0) ? <IconButton label={t("planning.plannedPayments.actions.undoPayment")} onClick={() => void onAction(row, "undo")}><RotateCcw size={15} /></IconButton> : null}
                  {!source && !paid && ["skipped", "cancelled"].includes(status) ? <IconButton label={t("planning.plannedPayments.actions.restoreOccurrence")} onClick={() => void onAction(row, "undo")}><RotateCcw size={15} /></IconButton> : null}
                </div>
              </td>
            </tr>
          );
        })}
      </tbody>
    </ResponsiveTable>
  );
}

function PaymentCalendar({ rows, accounts, reportingCurrency, month, setMonth, onSelect }: { rows: Row[]; accounts: Row[]; reportingCurrency: string; month: string; setMonth: (value: string) => void; onSelect: (row: Row) => void }) {
  const t = useTranslations();
  const days = useMemo(() => {
    const [year, monthNumber] = month.split("-").map(Number);
    const first = new Date(year, monthNumber - 1, 1, 12);
    const weekday = (first.getDay() + 6) % 7;
    const start = new Date(year, monthNumber - 1, 1 - weekday, 12);
    return Array.from({ length: 42 }, (_, index) => {
      const day = new Date(start);
      day.setDate(start.getDate() + index);
      return day;
    });
  }, [month]);
  const dateKey = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  return (
    <div className={ui.calendarOverflow}>
      <div className={ui.calendarHeader}><MonthStepper value={month} onChange={setMonth} /></div>
      <div className={ui.calendarGrid}>
        {[
          t("planning.plannedPayments.calendar.monday"),
          t("planning.plannedPayments.calendar.tuesday"),
          t("planning.plannedPayments.calendar.wednesday"),
          t("planning.plannedPayments.calendar.thursday"),
          t("planning.plannedPayments.calendar.friday"),
          t("planning.plannedPayments.calendar.saturday"),
          t("planning.plannedPayments.calendar.sunday"),
        ].map((day) => <div className={ui.calendarWeekday} key={day}>{day}</div>)}
        {days.map((day) => {
          const key = dateKey(day);
          const items = rows.filter((item) => normalizeDate(readRecord(item).dueDate) === key);
          const outside = key.slice(0, 7) !== month;
          return (
            <div className={`${ui.calendarDay} ${outside ? ui.calendarDayOutside : ""} ${key === isoToday() ? ui.calendarDayToday : ""}`} key={key}>
              <span className={ui.dayNumber}>{day.getDate()}</span>
              <div className={ui.calendarItems}>
                {items.slice(0, 4).map((item, index) => {
                  const row = readRecord(item);
                  const status = stringFrom(row.status);
                  const denomination = nativeCurrency(row, accounts, reportingCurrency);
                  const cashDue = nativeCashDueMinor(row);
                  const reportingCashDue = reportingCashDueMinor(row, accounts, reportingCurrency);
                  const hasReporting = reportingCashDue !== null && denomination !== reportingCurrency;
                  const source = liabilitySource(row);
                  const titleValues = {
                    name: paymentName(row, t),
                    amount: formatMoney(cashDue, denomination),
                    reportingAmount: reportingCashDue === null ? "" : formatMoney(reportingCashDue, reportingCurrency),
                    type: obligationType(row, t),
                  };
                  const itemTitle = hasReporting && source
                    ? t("planning.plannedPayments.calendar.itemTitleReportingLiability", titleValues)
                    : hasReporting
                      ? t("planning.plannedPayments.calendar.itemTitleReporting", titleValues)
                      : source
                        ? t("planning.plannedPayments.calendar.itemTitleLiability", titleValues)
                        : t("planning.plannedPayments.calendar.itemTitle", titleValues);
                  return (
                    <button
                      type="button"
                      onClick={() => onSelect(row)}
                      className={`${ui.calendarItem} ${status === "paid" ? ui.calendarItemPaid : status === "overdue" ? ui.calendarItemOverdue : ""}`}
                      key={stringFrom(row.id, String(index))}
                      title={itemTitle}
                    >
                      <span>{paymentName(row, t)}</span><strong>{formatMoney(cashDue, denomination)}</strong>
                    </button>
                  );
                })}
                {items.length > 4 ? <small>{t("planning.plannedPayments.calendar.more", { count: items.length - 4 })}</small> : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PlannedForm({ open, onClose, onCreated, reportingCurrency, timeZone, accounts, categories }: { open: boolean; onClose: () => void; onCreated: () => Promise<void>; reportingCurrency: string; timeZone: string; accounts: Row[]; categories: Row[] }) {
  const t = useTranslations();
  const translator = useTranslator();
  const [name, setName] = useState("");
  const [direction, setDirection] = useState("expense");
  const [expectedAmount, setExpectedAmount] = useState("");
  const [dueDate, setDueDate] = useState(isoToday());
  const [accountId, setAccountId] = useState("");
  const [plannedCurrency, setPlannedCurrency] = useState(reportingCurrency);
  const [currencyFollowsAccount, setCurrencyFollowsAccount] = useState(true);
  const [categoryId, setCategoryId] = useState("");
  const [recurring, setRecurring] = useState(false);
  const [frequency, setFrequency] = useState("monthly");
  const [interval, setInterval] = useState("1");
  const [endDate, setEndDate] = useState("");
  const [notes, setNotes] = useState("");
  const selectedAccount = readRecord(accounts.find((item) => stringFrom(readRecord(item).id) === accountId));
  const selectedAccountCurrency = stringFrom(selectedAccount.currency, reportingCurrency).toUpperCase();
  const normalizedPlannedCurrency = plannedCurrency.trim().toUpperCase();
  const plannedCurrencyValid = isSupportedCurrency(normalizedPlannedCurrency);

  const { submit, submitting, submitError, setSubmitError } = useSubmit(async () => {
    const expectedAmountMinor = moneyInputToMinor(expectedAmount, normalizedPlannedCurrency);
    if (!name.trim()) throw new Error(t("planning.plannedPayments.form.paymentNameError"));
    if (!plannedCurrencyValid) throw new Error(t("planning.plannedPayments.form.currencyError"));
    if (expectedAmountMinor === null || expectedAmountMinor <= 0) throw new Error(t("planning.plannedPayments.form.positiveAmountError"));
    if (recurring && (!Number.isInteger(Number(interval)) || Number(interval) < 1)) throw new Error(t("planning.plannedPayments.form.intervalError"));
    await requestJson("/api/planned", {
      method: "POST",
      body: JSON.stringify({
        name: name.trim(),
        direction,
        expectedAmountMinor,
        currency: normalizedPlannedCurrency,
        dueDate,
        accountId: accountId || null,
        categoryId: categoryId || null,
        status: "planned",
        notes: notes.trim() || null,
        recurrence: recurring ? { frequency, interval: Number(interval), startDate: dueDate, endDate: endDate || null } : null,
        frequency: recurring ? frequency : null,
        recurrenceInterval: recurring ? Number(interval) : null,
        recurrenceEndDate: recurring ? endDate || null : null,
      }),
    }, translator);
    setName(""); setExpectedAmount(""); setNotes(""); setRecurring(false);
    onClose();
    await onCreated();
  });

  return (
    <Modal
      open={open}
      onClose={() => { setSubmitError(null); onClose(); }}
      title={t("planning.plannedPayments.form.title")}
      description={t("planning.plannedPayments.form.description")}
      wide
      footer={<><Button variant="ghost" onClick={onClose}>{t("planning.plannedPayments.form.cancel")}</Button><Button disabled={submitting} onClick={() => void submit()}>{submitting ? t("planning.plannedPayments.form.planning") : t("planning.plannedPayments.form.create")}</Button></>}
    >
      <form onSubmit={(event) => void submit(event)}>
        <div className={ui.formGrid}>
          <Field label={t("planning.plannedPayments.form.paymentName")} className={ui.formSpan}><Input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder={t("planning.plannedPayments.form.paymentNamePlaceholder")} maxLength={120} /></Field>
          <Field label={t("planning.plannedPayments.form.direction")}><Select value={direction} onValueChange={(value) => setDirection(value)}><option value="expense">{t("planning.plannedPayments.form.expectedExpense")}</option><option value="income">{t("planning.plannedPayments.form.expectedIncome")}</option></Select></Field>
          <Field label={t("planning.plannedPayments.form.expectedAmount", { currency: normalizedPlannedCurrency || reportingCurrency })} hint={t("planning.plannedPayments.form.expectedAmountHint")}><Input inputMode="decimal" value={expectedAmount} onChange={(event) => setExpectedAmount(event.target.value)} placeholder={minorToInput(0, normalizedPlannedCurrency || reportingCurrency)} /></Field>
          <Field htmlFor="planned-payment-currency" label={t("planning.plannedPayments.form.plannedCurrency")} hint={accountId ? t("planning.plannedPayments.form.accountCurrencyHint", { currency: selectedAccountCurrency }) : t("planning.plannedPayments.form.profileCurrencyHint", { currency: reportingCurrency })}>
            <CurrencyCombobox
              id="planned-payment-currency"
              value={plannedCurrency}
              onChange={(value) => {
                setPlannedCurrency(value);
                setCurrencyFollowsAccount(value.toUpperCase() === (accountId ? selectedAccountCurrency : reportingCurrency));
              }}
              invalid={!plannedCurrencyValid}
            />
          </Field>
          <Field label={recurring ? t("planning.plannedPayments.form.firstDueDate") : t("planning.plannedPayments.form.dueDate")}><Input type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} /></Field>
          <Field label={t("planning.plannedPayments.form.expectedAccount")} hint={t("planning.plannedPayments.form.expectedAccountHint")}><Select value={accountId} onValueChange={(value) => {
            const next = readRecord(accounts.find((item) => stringFrom(readRecord(item).id) === value));
            const nextCurrency = value ? stringFrom(next.currency, reportingCurrency).toUpperCase() : reportingCurrency;
            setAccountId(value);
            if (currencyFollowsAccount) setPlannedCurrency(nextCurrency);
          }}><option value="">{t("planning.plannedPayments.form.decideWhenPaid")}</option>{accounts.map((item, index) => { const account = readRecord(item); const accountCurrency = stringFrom(account.currency, reportingCurrency).toUpperCase(); return <option value={String(account.id)} key={stringFrom(account.id, String(index))}>{t("planning.shared.options.accountWithBalance", { name: stringFrom(account.name, t("planning.shared.fallback.account")), currency: accountCurrency, balance: formatMoney(account.balanceMinor ?? account.currentBalanceMinor, accountCurrency) })}</option>; })}</Select></Field>
          <Field label={t("planning.plannedPayments.form.category")}><Select value={categoryId} onValueChange={(value) => setCategoryId(value)}><option value="">{t("planning.shared.labels.uncategorised")}</option>{categories.map((item, index) => { const category = readRecord(item); return <option value={String(category.id)} key={stringFrom(category.id, String(index))}>{stringFrom(category.name, t("planning.shared.fallback.category"))}</option>; })}</Select></Field>
          <Field label={t("planning.plannedPayments.form.notes")} className={ui.formSpan}><Textarea value={notes} onChange={(event) => setNotes(event.target.value)} placeholder={t("planning.plannedPayments.form.notesPlaceholder")} /></Field>
        </div>
        <label className={`${ui.inlineNotice} ${ui.recurrenceToggle}`}><input type="checkbox" checked={recurring} onChange={(event) => setRecurring(event.target.checked)} /><span><strong>{t("planning.plannedPayments.form.repeatTitle")}</strong><br />{t("planning.plannedPayments.form.repeatDescription")}</span></label>
        {recurring ? (
          <div className={`${ui.formGrid} ${ui.formOffset}`}>
            <Field label={t("planning.plannedPayments.form.frequency")}><Select value={frequency} onValueChange={(value) => setFrequency(value)}><option value="weekly">{t("planning.plannedPayments.form.week")}</option><option value="monthly">{t("planning.plannedPayments.form.month")}</option><option value="yearly">{t("planning.plannedPayments.form.year")}</option></Select></Field>
            <Field label={t("planning.plannedPayments.form.every")}><Input type="number" min="1" max="99" step="1" value={interval} onChange={(event) => setInterval(event.target.value)} /></Field>
            <Field label={t("planning.plannedPayments.form.endDate")} hint={t("planning.plannedPayments.form.endDateHint")}><Input type="date" min={dueDate} value={endDate} onChange={(event) => setEndDate(event.target.value)} /></Field>
            <div className={ui.inlineNotice}><ArrowLeftRight size={16} />{t("planning.plannedPayments.form.monthEndNotice", { timeZone })}</div>
          </div>
        ) : null}
        <FormMessage error={submitError} />
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

function PayForm({ occurrence, onClose, onPaid, reportingCurrency, accounts }: { occurrence: Row; onClose: () => void; onPaid: () => Promise<void>; reportingCurrency: string; accounts: Row[] }) {
  const t = useTranslations();
  const translator = useTranslator();
  const planCurrency = nativeCurrency(occurrence, accounts, reportingCurrency);
  const expected = nativeExpectedMinor(occurrence);
  const alreadyPaid = nativePaidMinor(occurrence);
  const remaining = Math.max(0, expected - alreadyPaid);
  const requestedAccountId = stringFrom(occurrence.accountId);
  const initialAccountId = accounts.some((item) => stringFrom(readRecord(item).id) === requestedAccountId)
    ? requestedAccountId
    : "";
  const [appliedAmount, setAppliedAmount] = useState(() => minorToInput(remaining, planCurrency));
  const [paymentDate, setPaymentDate] = useState(isoToday());
  const [accountId, setAccountId] = useState(initialAccountId);
  const [fxQuote, setFxQuote] = useState<FxQuote | null>(null);
  const [fxLoading, setFxLoading] = useState(false);
  const [fxError, setFxError] = useState<string | null>(null);
  const [rateMode, setRateMode] = useState<"reference" | "manual">("reference");
  const [manualRate, setManualRate] = useState("");
  const [useExactAccountAmount, setUseExactAccountAmount] = useState(false);
  const [exactAccountAmount, setExactAccountAmount] = useState("");
  const fxInputKeyRef = useRef<string | null>(null);
  const selectedAccount = readRecord(accounts.find((item) => stringFrom(readRecord(item).id) === accountId));
  const accountCurrency = stringFrom(selectedAccount.currency, reportingCurrency).toUpperCase();
  const accountName = stringFrom(selectedAccount.name, t("planning.shared.fallback.selectedAccount"));
  const conversionRequired = Boolean(accountId) && planCurrency !== accountCurrency;
  const appliedAmountMinor = moneyInputToMinor(appliedAmount, planCurrency);
  const quoteMatches = Boolean(fxQuote?.fromCurrency === planCurrency && fxQuote?.toCurrency === accountCurrency);
  const referenceRateScaled = quoteMatches ? fxQuote?.rateScaled ?? null : null;
  const rateScale = quoteMatches ? fxQuote?.rateScale ?? FX_RATE_SCALE : FX_RATE_SCALE;
  const sourceDigits = quoteMatches ? fxQuote?.fromMinorUnitDigits ?? 2 : currencyMinorUnitDigits(planCurrency);
  const targetDigits = quoteMatches ? fxQuote?.toMinorUnitDigits ?? 2 : currencyMinorUnitDigits(accountCurrency);
  const parsedManualRateScaled = rateInputToScaled(manualRate, rateScale);
  const parsedExactAccountAmount = moneyInputToMinor(exactAccountAmount, accountCurrency);
  const derivedExactRateScaled = conversionRequired && useExactAccountAmount && appliedAmountMinor && parsedExactAccountAmount
    ? deriveRateScaled(appliedAmountMinor, parsedExactAccountAmount, rateScale, sourceDigits, targetDigits)
    : null;
  const exactRoundTripAmountMinor = derivedExactRateScaled && appliedAmountMinor
    ? convertCurrencyMinor(appliedAmountMinor, derivedExactRateScaled, rateScale, sourceDigits, targetDigits)
    : null;
  const exactAmountReconciles = !useExactAccountAmount || (
    parsedExactAccountAmount !== null && exactRoundTripAmountMinor === parsedExactAccountAmount
  );
  const activeRateScaled = useExactAccountAmount
    ? derivedExactRateScaled
    : rateMode === "manual" ? parsedManualRateScaled : referenceRateScaled;
  const calculatedAccountAmountMinor = conversionRequired && appliedAmountMinor !== null && activeRateScaled
    ? convertCurrencyMinor(appliedAmountMinor, activeRateScaled, rateScale, sourceDigits, targetDigits)
    : appliedAmountMinor;
  const accountAmountMinor = conversionRequired && useExactAccountAmount
    ? parsedExactAccountAmount
    : calculatedAccountAmountMinor;
  const displayedRate = useExactAccountAmount
    ? derivedExactRateScaled ? rateScaledToInput(derivedExactRateScaled, rateScale) : ""
    : rateMode === "manual" ? manualRate : referenceRateScaled ? rateScaledToInput(referenceRateScaled, rateScale) : "";
  const displayedAccountAmount = useExactAccountAmount
    ? exactAccountAmount
    : calculatedAccountAmountMinor === null ? "" : minorToInput(calculatedAccountAmountMinor, accountCurrency);
  const partial = (appliedAmountMinor ?? 0) + alreadyPaid < expected;

  useEffect(() => {
    const requestKey = `${paymentDate}|${planCurrency}|${accountCurrency}|${accountId}`;
    const inputsChanged = fxInputKeyRef.current !== null && fxInputKeyRef.current !== requestKey;
    fxInputKeyRef.current = requestKey;
    const controller = new AbortController();
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      if (inputsChanged) {
        setRateMode("reference");
        setManualRate("");
        setUseExactAccountAmount(false);
        setExactAccountAmount("");
      }
      if (!conversionRequired || !paymentDate) {
        setFxQuote(null);
        setFxError(null);
        setFxLoading(false);
        return;
      }
      setFxLoading(true);
      setFxError(null);
      void (async () => {
        try {
          const params = new URLSearchParams({ date: paymentDate, from: planCurrency, to: accountCurrency });
          const response = await fetch(`/api/fx/quote?${params.toString()}`, {
            headers: { Accept: "application/json" },
            cache: "no-store",
            signal: controller.signal,
          });
          const responseBody = await response.json().catch(() => null);
          if (!response.ok) throw new Error(translateApiError(translator, parseApiError(responseBody)));
          const body = readRecord(responseBody);
          const quote = readRecord(body.quote);
          if (!Number.isSafeInteger(quote.rateScaled) || numberFrom(quote.rateScaled) <= 0) throw new Error(t("planning.plannedPayments.payment.invalidReference"));
          if (active) setFxQuote(quote as FxQuote);
        } catch (error) {
          if (!active || controller.signal.aborted) return;
          setFxQuote(null);
          setFxError(error instanceof Error ? error.message : t("planning.plannedPayments.payment.noReference"));
        } finally {
          if (active) setFxLoading(false);
        }
      })();
    });
    return () => {
      active = false;
      controller.abort();
    };
  }, [accountCurrency, accountId, conversionRequired, paymentDate, planCurrency, t, translator]);

  const { submit, submitting, submitError, setSubmitError } = useSubmit(async () => {
    if (appliedAmountMinor === null || appliedAmountMinor <= 0) throw new Error(t("planning.plannedPayments.payment.positiveAppliedError", { currency: planCurrency }));
    if (!accountId) throw new Error(t("planning.plannedPayments.payment.chooseAccountError"));
    if (conversionRequired) {
      if (rateMode === "reference" && !referenceRateScaled) throw new Error(t("planning.plannedPayments.payment.waitForRateError"));
      if (!activeRateScaled || activeRateScaled <= 0) throw new Error(t("planning.plannedPayments.payment.positiveRateError"));
      if (!accountAmountMinor || accountAmountMinor <= 0) throw new Error(t("planning.plannedPayments.payment.positiveAccountAmountError", { currency: accountCurrency }));
      if (!exactAmountReconciles) throw new Error(t("planning.plannedPayments.payment.exactRateError"));
    }
    const postedAccountAmountMinor = accountAmountMinor ?? appliedAmountMinor;
    const fxRateSource = conversionRequired ? (rateMode === "manual" || useExactAccountAmount ? "manual" : "bnr") : null;
    await requestJson(`/api/planned/${encodeURIComponent(String(occurrence.id))}/pay`, {
      method: "POST",
      body: JSON.stringify({
        occurrenceId: occurrence.id,
        amountMinor: postedAccountAmountMinor,
        actualAmountMinor: postedAccountAmountMinor,
        accountAmountMinor: postedAccountAmountMinor,
        appliedAmountMinor,
        appliedPlannedAmountMinor: appliedAmountMinor,
        paymentDate,
        paidDate: paymentDate,
        date: paymentDate,
        accountId,
        partial,
        fxRateScaled: conversionRequired ? activeRateScaled : null,
        fxRateSource,
        fxRateDate: conversionRequired ? fxRateSource === "bnr" ? fxQuote?.rateDate : paymentDate : null,
        referenceFxRateScaled: conversionRequired && fxRateSource === "manual" && referenceRateScaled ? referenceRateScaled : null,
        referenceFxRateDate: conversionRequired && fxRateSource === "manual" && referenceRateScaled ? fxQuote?.rateDate : null,
      }),
    }, translator);
    onClose();
    await onPaid();
  });
  return (
    <Modal
      open
      onClose={() => { setSubmitError(null); onClose(); }}
      title={t("planning.plannedPayments.payment.title")}
      description={t("planning.plannedPayments.payment.description", { name: paymentName(occurrence, t), amount: formatMoney(expected, planCurrency) })}
      footer={<><Button variant="ghost" onClick={onClose}>{t("common.actions.cancel")}</Button><Button disabled={submitting} icon={<CheckCircle2 size={15} />} onClick={() => void submit()}>{submitting ? t("planning.plannedPayments.payment.recording") : partial ? t("planning.plannedPayments.payment.recordPartial") : t("planning.plannedPayments.payment.markPaid")}</Button></>}
    >
      <div className={`${ui.summaryList} ${ui.summaryBottom}`}>
        <div className={ui.summaryRow}><span>{t("planning.plannedPayments.payment.expectedAmount")}</span><strong className={ui.warning}>{formatMoney(expected, planCurrency)} <small>{t("planning.plannedPayments.payment.nativePlan")}</small></strong></div>
        {alreadyPaid ? <div className={ui.summaryRow}><span>{t("planning.plannedPayments.payment.alreadyApplied")}</span><strong className={ui.positive}>{formatMoney(alreadyPaid, planCurrency)} <small>{t("planning.plannedPayments.payment.nativePlan")}</small></strong></div> : null}
        <div className={ui.summaryRow}><span>{t("planning.plannedPayments.payment.remaining")}</span><strong>{formatMoney(remaining, planCurrency)} <small>{planCurrency}</small></strong></div>
      </div>
      <form className={ui.formGrid} onSubmit={(event) => void submit(event)}>
        <Field label={t("planning.plannedPayments.payment.appliedAmount", { currency: planCurrency })} hint={t("planning.plannedPayments.payment.appliedAmountHint")}><Input autoFocus inputMode="decimal" value={appliedAmount} onChange={(event) => setAppliedAmount(event.target.value)} /></Field>
        <Field label={t("planning.plannedPayments.payment.paymentDate")}><Input type="date" max={isoToday()} value={paymentDate} onChange={(event) => setPaymentDate(event.target.value)} /></Field>
        <Field label={stringFrom(occurrence.direction, "expense") === "income" ? t("planning.plannedPayments.payment.receivedAccount") : t("planning.plannedPayments.payment.paidAccount")}><Select value={accountId} onValueChange={(value) => setAccountId(value)}><option value="">{t("planning.plannedPayments.payment.chooseAccount")}</option>{accounts.map((item, index) => { const account = readRecord(item); const denomination = stringFrom(account.currency, reportingCurrency).toUpperCase(); return <option value={String(account.id)} key={stringFrom(account.id, String(index))}>{t("planning.shared.options.accountWithBalance", { name: stringFrom(account.name, t("planning.shared.fallback.account")), currency: denomination, balance: formatMoney(account.balanceMinor ?? account.currentBalanceMinor, denomination) })}</option>; })}</Select></Field>
        {conversionRequired ? (
          <div className={`${ui.fxPanel} ${ui.formSpan}`}>
            <div className={ui.fxPanelHeader}>
              <span><strong>{t("planning.plannedPayments.payment.conversionTitle")}</strong><small>{t("planning.plannedPayments.payment.conversionDescription", { planCurrency, account: accountName, accountCurrency })}</small></span>
              {fxLoading ? <Pill tone="info">{t("planning.plannedPayments.payment.loadingRate")}</Pill> : fxQuote ? <Pill tone={fxQuote.isFallback ? "warning" : "info"}>{t("planning.plannedPayments.payment.referenceRate")}</Pill> : <Pill tone="warning">{t("planning.plannedPayments.payment.manualRateNeeded")}</Pill>}
            </div>
            {fxQuote ? (
              <div className={ui.fxReference}>
                <strong>{t("planning.plannedPayments.payment.rateEquation", { fromCurrency: planCurrency, rate: formatRate(fxQuote.rateScaled, fxQuote.rateScale), toCurrency: accountCurrency })}</strong>
                <span>{fxQuote.isFallback
                  ? t("planning.plannedPayments.payment.effectiveFallbackRate", { date: formatDate(fxQuote.rateDate, { day: "2-digit", month: "short", year: "numeric" }), count: fxQuote.fallbackDays })
                  : t("planning.plannedPayments.payment.effectiveRate", { date: formatDate(fxQuote.rateDate, { day: "2-digit", month: "short", year: "numeric" }) })}</span>
              </div>
            ) : fxError ? <div className={ui.fxError} role="status">{t("planning.plannedPayments.payment.manualAfterError", { error: fxError })}</div> : null}
            {fxQuote?.isStale ? <div className={ui.fxError} role="status">{t("planning.plannedPayments.payment.staleRate")}</div> : null}
            <div className={ui.fxControls}>
              <Field label={t("planning.plannedPayments.payment.exchangeRate", { accountCurrency, planCurrency })} hint={useExactAccountAmount ? t("planning.plannedPayments.payment.exactRateHint") : rateMode === "manual" ? t("planning.plannedPayments.payment.manualRateHint") : t("planning.plannedPayments.payment.referenceRateHint")}>
                <Input inputMode="decimal" value={displayedRate} disabled={rateMode === "reference" || useExactAccountAmount} onChange={(event) => { setManualRate(event.target.value); setUseExactAccountAmount(false); }} placeholder={fxLoading ? t("planning.plannedPayments.payment.loading") : t("planning.plannedPayments.payment.ratePlaceholder")} />
              </Field>
              <Field label={t("planning.plannedPayments.payment.amountPosted", { account: accountName, currency: accountCurrency })} hint={useExactAccountAmount ? exactAmountReconciles ? t("planning.plannedPayments.payment.exactAmountHint") : t("planning.plannedPayments.payment.unreconciledAmountHint") : t("planning.plannedPayments.payment.calculatedAmountHint")}>
                <Input inputMode="decimal" value={displayedAccountAmount} disabled={!useExactAccountAmount} aria-invalid={useExactAccountAmount && !exactAmountReconciles} onChange={(event) => setExactAccountAmount(event.target.value)} placeholder={fxLoading ? t("planning.plannedPayments.payment.calculating") : minorToInput(0, accountCurrency)} />
              </Field>
            </div>
            <div className={ui.fxOptions}>
              <label className={`${ui.small} ${ui.inlineCheck}`}><input type="checkbox" checked={rateMode === "manual"} onChange={(event) => {
                if (event.target.checked) {
                  setRateMode("manual");
                  setManualRate(referenceRateScaled ? rateScaledToInput(referenceRateScaled, rateScale) : manualRate);
                } else {
                  setRateMode("reference");
                  setUseExactAccountAmount(false);
                }
              }} /> {t("planning.plannedPayments.payment.editRate")}</label>
              <label className={`${ui.small} ${ui.inlineCheck}`}><input type="checkbox" checked={useExactAccountAmount} onChange={(event) => {
                const checked = event.target.checked;
                setUseExactAccountAmount(checked);
                setRateMode("manual");
                if (checked) setExactAccountAmount(calculatedAccountAmountMinor === null ? "" : minorToInput(calculatedAccountAmountMinor, accountCurrency));
                else if (derivedExactRateScaled) setManualRate(rateScaledToInput(derivedExactRateScaled, rateScale));
              }} /> {t("planning.plannedPayments.payment.useExactAmount")}</label>
            </div>
          </div>
        ) : null}
        <div className={`${ui.inlineNotice} ${ui.formSpan}`}><WalletCards size={16} />{partial ? t("planning.plannedPayments.payment.partialNotice") : t("planning.plannedPayments.payment.paidNotice")}</div>
        <button type="submit" hidden />
      </form>
      <FormMessage error={submitError} />
    </Modal>
  );
}
