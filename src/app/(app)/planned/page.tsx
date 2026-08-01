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
import { DEFAULT_CURRENCY, isSupportedCurrency } from "@/lib/currencies";
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

function paymentName(row: Row) {
  return stringFrom(row.name ?? row.title ?? row.merchantName ?? row.merchant, "Planned payment");
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

function obligationType(row: Row) {
  const source = liabilitySource(row);
  if (source === "credit_card_statement") return "Card statement";
  if (source === "loan_schedule") return "Loan instalment";
  return stringFrom(row.direction, "expense") === "income" ? "Planned income" : "Planned expense";
}

export default function PlannedPaymentsPage() {
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
      return !search || [paymentName(row), obligationType(row), row.categoryName, row.category, row.accountName, row.account, row.notes, row.note].filter(Boolean).join(" ").toLocaleLowerCase(locale).includes(search.toLocaleLowerCase(locale));
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
      });
      if (action === "cancel") setCancelling(null);
      await reload();
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : `Could not ${action} this occurrence`);
    }
  }

  return (
    <Page>
      <ViewHeader
        eyebrow="Future money"
        title="Planned payments"
        description="Expected obligations live here before actual activity exists. Debt payments show their cash impact separately from the portion that counts as spending."
        actions={<AddButton onClick={() => setCreateOpen(true)}>Plan payment</AddButton>}
      />

      <div className={ui.metricGrid}>
        <Metric label="Cash payments due" value={cashDueTotal === null ? "—" : formatMoney(cashDueTotal, currency)} detail={cashDueTotal === null ? "Reporting conversion unavailable" : `${rangeLabel} · ${currency} reporting value`} tone="accent" info="Remaining cash expected to leave an account, converted to profile currency by due date. Native planned amounts remain unchanged." />
        <Metric label="Counts as spending" value={spendingDueTotal === null ? "—" : formatMoney(spendingDueTotal, currency)} detail={spendingDueTotal === null ? "Reporting conversion unavailable" : `Planned expense impact · ${currency}`} tone="warning" info="Expected expense impact in profile currency. Credit-card statements and loan principal do not count as new spending." />
        <Metric label="Overdue" value={overdueTotal === null ? "—" : formatMoney(overdueTotal, currency)} detail={overdueTotal === null ? "Reporting conversion unavailable" : `${overdue.length} occurrence${overdue.length === 1 ? "" : "s"} · ${currency}`} tone={overdue.length ? "negative" : "default"} info="Unpaid remainder on overdue occurrences, expressed in profile currency without changing native denominations." />
        <Metric label="Paid occurrences" value={paid.length} detail="Linked to actual transactions" tone="positive" />
      </div>

      <Section
        title="Obligations schedule"
        description={`Due in ${rangeLabel}; planned, pending and actual values are labelled separately`}
        action={
          <div className={ui.toolbarGroup}>
            <Button variant={view === "list" ? "secondary" : "ghost"} icon={<List size={15} />} onClick={() => setView("list")}>List</Button>
            <Button variant={view === "calendar" ? "secondary" : "ghost"} icon={<CalendarDays size={15} />} onClick={() => setView("calendar")}>Calendar</Button>
          </div>
        }
      >
        <Tabs
          id="payment-status"
          panelId="payment-status-panel"
          label="Payment status"
          value={filter}
          onChange={setFilter}
          items={[
            { value: "upcoming", label: "Upcoming", count: upcoming.length },
            { value: "overdue", label: "Overdue", count: overdue.length },
            { value: "paid", label: "Paid", count: paid.length },
            { value: "all", label: "All", count: occurrences.length },
          ]}
        />
        <div id="payment-status-panel" role="tabpanel" aria-labelledby={`payment-status-${filter}-tab`}>
          <div className={`${ui.toolbar} ${ui.sectionToolbar}`}>
            <SearchField value={search} onChange={setSearch} placeholder="Search planned payments…" />
            <div className={ui.statusSummary}>
              <span><i className={ui.statusPlanned} /> Planned</span>
              <span><i className={ui.statusScheduled} /> Scheduled / pending</span>
              <span><i className={ui.statusPaid} /> Actual / paid</span>
            </div>
          </div>
          <FormMessage error={actionError} />
          {reportingTotalsUnavailable ? (
            <div className={`${ui.inlineNotice} ${ui.inlineNoticeWarning} ${styles.reportingNotice}`} role="status">
              Some obligations use a different native currency, but this response does not include their reporting-currency equivalents. Native amounts remain visible; aggregate totals are withheld rather than adding unlike currencies.
            </div>
          ) : null}

          <DataState
            loading={loading}
            error={error}
            onRetry={reload}
            empty={!occurrences.length}
            emptyTitle="No future payments planned"
            emptyDescription="Add a one-time or repeating obligation so it appears in the selected range before any transaction exists."
            action={<AddButton onClick={() => setCreateOpen(true)}>Plan a payment</AddButton>}
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
          title="Cancel this occurrence?"
          description={`${paymentName(cancelling)} · due ${formatDate(cancelling.dueDate)}`}
          footer={<><Button variant="ghost" onClick={() => setCancelling(null)}>Keep occurrence</Button><Button variant="danger" onClick={() => void occurrenceAction(cancelling, "cancel")}>Cancel occurrence</Button></>}
        >
          <div className={`${ui.inlineNotice} ${ui.noticeInset}`}><Ban size={16} />Cancellation removes this occurrence from forecasts without changing the recurring rule or any other occurrence. You can restore it later.</div>
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
  if (!nativeAmount) return <span className={styles.moneyStack}><strong className={ui.muted}>—</strong><small>{detail}</small></span>;
  const showEquivalent = denomination !== reportingCurrency || reportingAmount !== nativeAmount;
  return (
    <span className={styles.moneyStack}>
      <strong className={tone}>{formatMoney(nativeAmount, denomination)}</strong>
      <small>{detail} · {denomination}</small>
      {showEquivalent ? (
        reportingAmount === null
          ? <small className={styles.reportingUnavailable}>Reporting value unavailable</small>
          : <small className={styles.reportingEquivalent}>≈ {formatMoney(reportingAmount, reportingCurrency)} reporting</small>
      ) : null}
    </span>
  );
}

function PaymentList({ rows, accounts, reportingCurrency, onPay, onAction, onCancel }: { rows: Row[]; accounts: Row[]; reportingCurrency: string; onPay: (row: Row) => void; onAction: (row: Row, action: "skip" | "cancel" | "undo") => Promise<void>; onCancel: (row: Row) => void }) {
  if (!rows.length) return <div className={`${ui.inlineNotice} ${ui.noticeInset}`}><Clock3 size={16} />No occurrences match this view.</div>;
  return (
    <ResponsiveTable label="Planned payment occurrences">
      <thead><tr><th>Due</th><th>Payment</th><th>Type / category</th><th>Recurrence</th><th>Status</th><th>Cash due</th><th>Counts as spending</th><th>Applied / actual</th><th>Actions</th></tr></thead>
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
              <td className={ui.nowrap}><strong>{formatDate(row.dueDate, { day: "2-digit", month: "short", year: "2-digit" })}</strong>{normalizeDate(row.dueDate) < isoToday() && status !== "paid" ? <small className={ui.negative}>Past due</small> : null}</td>
              <td className={ui.paymentName}><span className={ui.tablePrimary}>{paymentName(row)}</span><span className={ui.tableSecondary}>{stringFrom(row.notes ?? row.note)}</span></td>
              <td><Pill tone={source ? "info" : "neutral"}>{obligationType(row)}</Pill><small>{source === "credit_card_statement" ? "Payment is a transfer" : source === "loan_schedule" ? "Interest and fees are expenses" : stringFrom(row.categoryName ?? row.category, "Uncategorised")}</small></td>
              <td>{source ? "Debt schedule" : stringFrom(row.recurrenceLabel ?? row.frequency, row.ruleId ?? row.recurrenceRuleId ? "Recurring" : "One-time")}{!source && (row.ruleId ?? row.recurrenceRuleId) ? <small>Occurrence only</small> : row.isEstimate ? <small>Current-rate estimate</small> : null}</td>
              <td><Pill tone={statusTone(status)}>{status}</Pill>{paid > 0 && status !== "paid" ? <small>{formatMoney(cashDue, denomination)} remains</small> : null}</td>
              <td className={ui.amount}><MoneyStack nativeAmount={cashDue} nativeCurrency={denomination} reportingAmount={reportingCashDue} reportingCurrency={reportingCurrency} detail={cashDue ? "native cash projection" : "settled"} tone={cashDue ? ui.warning : ui.muted} /></td>
              <td className={ui.amount}><MoneyStack nativeAmount={spendingDue} nativeCurrency={denomination} reportingAmount={reportingSpendingDue} reportingCurrency={reportingCurrency} detail={source === "credit_card_statement" ? "no new spending" : source === "loan_schedule" ? `${formatMoney(nativePrincipalMinor(row), denomination)} principal excluded` : spendingDue ? "native planned expense" : "not an expense"} tone={spendingDue ? ui.negative : ui.muted} /></td>
              <td className={ui.amount}><MoneyStack nativeAmount={paid} nativeCurrency={denomination} reportingAmount={reportingPaid} reportingCurrency={reportingCurrency} detail={paid ? "applied to this plan" : "not posted"} tone={paid ? ui.positive : ui.muted} /></td>
              <td>
                <div className={ui.paymentActions}>
                  {source ? <Button variant="secondary" onClick={() => onPay(row)}>{canPay ? "Record payment" : "View account"}</Button> : null}
                  {!source && canPay ? <Button variant="secondary" onClick={() => onPay(row)}>{paid ? "Pay remainder" : "Mark paid"}</Button> : null}
                  {!source && canPay ? <IconButton label="Skip this cycle without paying" onClick={() => void onAction(row, "skip")}><SkipForward size={15} /></IconButton> : null}
                  {!source && canPay && !paid ? <IconButton label="Cancel a withdrawn obligation" onClick={() => onCancel(row)}><Ban size={15} /></IconButton> : null}
                  {!source && (status === "paid" || paid > 0) ? <IconButton label="Undo linked payment" onClick={() => void onAction(row, "undo")}><RotateCcw size={15} /></IconButton> : null}
                  {!source && !paid && ["skipped", "cancelled"].includes(status) ? <IconButton label="Restore this occurrence" onClick={() => void onAction(row, "undo")}><RotateCcw size={15} /></IconButton> : null}
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
        {['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map((day) => <div className={ui.calendarWeekday} key={day}>{day}</div>)}
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
                  const reportingLabel = reportingCashDue !== null && denomination !== reportingCurrency
                    ? ` · approximately ${formatMoney(reportingCashDue, reportingCurrency)} reporting`
                    : "";
                  return (
                    <button
                      type="button"
                      onClick={() => onSelect(row)}
                      className={`${ui.calendarItem} ${status === "paid" ? ui.calendarItemPaid : status === "overdue" ? ui.calendarItemOverdue : ""}`}
                      key={stringFrom(row.id, String(index))}
                      title={`${paymentName(row)} — ${formatMoney(cashDue, denomination)} native cash due${reportingLabel}${liabilitySource(row) ? ` · ${obligationType(row)}` : ""}`}
                    >
                      <span>{paymentName(row)}</span><strong>{formatMoney(cashDue, denomination)}</strong>
                    </button>
                  );
                })}
                {items.length > 4 ? <small>+{items.length - 4} more</small> : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PlannedForm({ open, onClose, onCreated, reportingCurrency, timeZone, accounts, categories }: { open: boolean; onClose: () => void; onCreated: () => Promise<void>; reportingCurrency: string; timeZone: string; accounts: Row[]; categories: Row[] }) {
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
    if (!name.trim()) throw new Error("Enter a payment name.");
    if (!plannedCurrencyValid) throw new Error("Choose a supported ISO 4217 currency.");
    if (expectedAmountMinor === null || expectedAmountMinor <= 0) throw new Error("Expected amount must be greater than zero.");
    if (recurring && (!Number.isInteger(Number(interval)) || Number(interval) < 1)) throw new Error("Recurrence interval must be a positive whole number.");
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
    });
    setName(""); setExpectedAmount(""); setNotes(""); setRecurring(false);
    onClose();
    await onCreated();
  });

  return (
    <Modal
      open={open}
      onClose={() => { setSubmitError(null); onClose(); }}
      title="Plan a payment"
      description="Create an expected payment without changing an actual balance."
      wide
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button disabled={submitting} onClick={() => void submit()}>{submitting ? "Planning…" : "Create planned payment"}</Button></>}
    >
      <form onSubmit={(event) => void submit(event)}>
        <div className={ui.formGrid}>
          <Field label="Payment name" className={ui.formSpan}><Input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Electricity bill" maxLength={120} /></Field>
          <Field label="Direction"><Select value={direction} onValueChange={(value) => setDirection(value)}><option value="expense">Expected expense</option><option value="income">Expected income</option></Select></Field>
          <Field label={`Expected amount (${normalizedPlannedCurrency || reportingCurrency})`} hint="This stays in the planned payment's native currency."><Input inputMode="decimal" value={expectedAmount} onChange={(event) => setExpectedAmount(event.target.value)} placeholder={minorToInput(0, normalizedPlannedCurrency || reportingCurrency)} /></Field>
          <Field htmlFor="planned-payment-currency" label="Planned currency" hint={accountId ? `Expected account ledger: ${selectedAccountCurrency}` : `No account selected · defaults to profile currency ${reportingCurrency}`}>
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
          <Field label={recurring ? "First due date" : "Due date"}><Input type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} /></Field>
          <Field label="Expected account" hint="Optional until the payment is made"><Select value={accountId} onValueChange={(value) => {
            const next = readRecord(accounts.find((item) => stringFrom(readRecord(item).id) === value));
            const nextCurrency = value ? stringFrom(next.currency, reportingCurrency).toUpperCase() : reportingCurrency;
            setAccountId(value);
            if (currencyFollowsAccount) setPlannedCurrency(nextCurrency);
          }}><option value="">Decide when paid</option>{accounts.map((item, index) => { const account = readRecord(item); const accountCurrency = stringFrom(account.currency, reportingCurrency).toUpperCase(); return <option value={String(account.id)} key={stringFrom(account.id, String(index))}>{stringFrom(account.name, "Account")} · {accountCurrency} · {formatMoney(account.balanceMinor ?? account.currentBalanceMinor, accountCurrency)}</option>; })}</Select></Field>
          <Field label="Category"><Select value={categoryId} onValueChange={(value) => setCategoryId(value)}><option value="">Uncategorised</option>{categories.map((item, index) => { const category = readRecord(item); return <option value={String(category.id)} key={stringFrom(category.id, String(index))}>{stringFrom(category.name, "Category")}</option>; })}</Select></Field>
          <Field label="Notes" className={ui.formSpan}><Textarea value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Optional context" /></Field>
        </div>
        <label className={`${ui.inlineNotice} ${ui.recurrenceToggle}`}><input type="checkbox" checked={recurring} onChange={(event) => setRecurring(event.target.checked)} /><span><strong>Repeat this payment</strong><br />Occurrences are generated deterministically and existing dates are never duplicated.</span></label>
        {recurring ? (
          <div className={`${ui.formGrid} ${ui.formOffset}`}>
            <Field label="Frequency"><Select value={frequency} onValueChange={(value) => setFrequency(value)}><option value="weekly">Week</option><option value="monthly">Month</option><option value="yearly">Year</option></Select></Field>
            <Field label="Every"><Input type="number" min="1" max="99" step="1" value={interval} onChange={(event) => setInterval(event.target.value)} /></Field>
            <Field label="End date" hint="Optional; leave blank for no end"><Input type="date" min={dueDate} value={endDate} onChange={(event) => setEndDate(event.target.value)} /></Field>
            <div className={ui.inlineNotice}><ArrowLeftRight size={16} />Month-end dates use deterministic calendar clamping in {timeZone}.</div>
          </div>
        ) : null}
        <FormMessage error={submitError} />
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

function PayForm({ occurrence, onClose, onPaid, reportingCurrency, accounts }: { occurrence: Row; onClose: () => void; onPaid: () => Promise<void>; reportingCurrency: string; accounts: Row[] }) {
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
  const accountName = stringFrom(selectedAccount.name, "selected account");
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
          const body = readRecord(await response.json().catch(() => null));
          if (!response.ok) throw new Error(stringFrom(body.error ?? body.message, `Reference rate unavailable (${response.status})`));
          const quote = readRecord(body.quote);
          if (!Number.isSafeInteger(quote.rateScaled) || numberFrom(quote.rateScaled) <= 0) throw new Error("The reference-rate response was invalid.");
          if (active) setFxQuote(quote as FxQuote);
        } catch (error) {
          if (!active || controller.signal.aborted) return;
          setFxQuote(null);
          setFxError(error instanceof Error ? error.message : "No reference rate is available.");
        } finally {
          if (active) setFxLoading(false);
        }
      })();
    });
    return () => {
      active = false;
      controller.abort();
    };
  }, [accountCurrency, accountId, conversionRequired, paymentDate, planCurrency]);

  const { submit, submitting, submitError, setSubmitError } = useSubmit(async () => {
    if (appliedAmountMinor === null || appliedAmountMinor <= 0) throw new Error(`Enter an amount greater than zero in ${planCurrency}.`);
    if (!accountId) throw new Error("Choose the account used for payment.");
    if (conversionRequired) {
      if (rateMode === "reference" && !referenceRateScaled) throw new Error("Wait for the BNR reference rate or enter the exchange rate manually.");
      if (!activeRateScaled || activeRateScaled <= 0) throw new Error("Enter a positive exchange rate.");
      if (!accountAmountMinor || accountAmountMinor <= 0) throw new Error(`Enter or calculate a positive account amount in ${accountCurrency}.`);
      if (!exactAmountReconciles) throw new Error("This exact account amount cannot be represented by the derived eight-decimal exchange rate. Edit the exchange rate instead.");
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
    });
    onClose();
    await onPaid();
  });
  return (
    <Modal
      open
      onClose={() => { setSubmitError(null); onClose(); }}
      title="Record actual payment"
      description={`${paymentName(occurrence)} · expected ${formatMoney(expected, planCurrency)} in the plan's native currency`}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button disabled={submitting} icon={<CheckCircle2 size={15} />} onClick={() => void submit()}>{submitting ? "Recording…" : partial ? "Record partial payment" : "Mark paid"}</Button></>}
    >
      <div className={`${ui.summaryList} ${ui.summaryBottom}`}>
        <div className={ui.summaryRow}><span>Expected amount</span><strong className={ui.warning}>{formatMoney(expected, planCurrency)} <small>native plan</small></strong></div>
        {alreadyPaid ? <div className={ui.summaryRow}><span>Already applied</span><strong className={ui.positive}>{formatMoney(alreadyPaid, planCurrency)} <small>native plan</small></strong></div> : null}
        <div className={ui.summaryRow}><span>Remaining</span><strong>{formatMoney(remaining, planCurrency)} <small>{planCurrency}</small></strong></div>
      </div>
      <form className={ui.formGrid} onSubmit={(event) => void submit(event)}>
        <Field label={`Amount applied to plan (${planCurrency})`} hint="Edit if the amount satisfied on the plan differs from the estimate."><Input autoFocus inputMode="decimal" value={appliedAmount} onChange={(event) => setAppliedAmount(event.target.value)} /></Field>
        <Field label="Payment date"><Input type="date" max={isoToday()} value={paymentDate} onChange={(event) => setPaymentDate(event.target.value)} /></Field>
        <Field label={stringFrom(occurrence.direction, "expense") === "income" ? "Received into account" : "Paid from account"}><Select value={accountId} onValueChange={(value) => setAccountId(value)}><option value="">Choose account</option>{accounts.map((item, index) => { const account = readRecord(item); const denomination = stringFrom(account.currency, reportingCurrency).toUpperCase(); return <option value={String(account.id)} key={stringFrom(account.id, String(index))}>{stringFrom(account.name, "Account")} · {denomination} · {formatMoney(account.balanceMinor ?? account.currentBalanceMinor, denomination)}</option>; })}</Select></Field>
        {conversionRequired ? (
          <div className={`${ui.fxPanel} ${ui.formSpan}`}>
            <div className={ui.fxPanelHeader}>
              <span><strong>Payment conversion</strong><small>The plan remains in {planCurrency}; the linked actual transaction posts to {accountName} in {accountCurrency}.</small></span>
              {fxLoading ? <Pill tone="info">Loading BNR rate…</Pill> : fxQuote ? <Pill tone={fxQuote.isFallback ? "warning" : "info"}>BNR reference</Pill> : <Pill tone="warning">Manual rate needed</Pill>}
            </div>
            {fxQuote ? (
              <div className={ui.fxReference}>
                <strong>1 {planCurrency} = {formatRate(fxQuote.rateScaled, fxQuote.rateScale)} {accountCurrency}</strong>
                <span>Effective {formatDate(fxQuote.rateDate, { day: "2-digit", month: "short", year: "numeric" })}{fxQuote.isFallback ? ` · previous BNR day (${fxQuote.fallbackDays} day${fxQuote.fallbackDays === 1 ? "" : "s"} earlier)` : ""}</span>
              </div>
            ) : fxError ? <div className={ui.fxError} role="status">{fxError} Enter a manual exchange rate to continue.</div> : null}
            {fxQuote?.isStale ? <div className={ui.fxError} role="status">The live refresh failed, so this uses the cached official quote. Compare it with the final account statement.</div> : null}
            <div className={ui.fxControls}>
              <Field label={`Exchange rate (${accountCurrency} per 1 ${planCurrency})`} hint={useExactAccountAmount ? "Derived from both exact amounts." : rateMode === "manual" ? "Manual override; the BNR reference remains recorded when available." : "Official BNR reference for the payment date."}>
                <Input inputMode="decimal" value={displayedRate} disabled={rateMode === "reference" || useExactAccountAmount} onChange={(event) => { setManualRate(event.target.value); setUseExactAccountAmount(false); }} placeholder={fxLoading ? "Loading…" : "e.g. 4.65"} />
              </Field>
              <Field label={`Amount posted to ${accountName} (${accountCurrency})`} hint={useExactAccountAmount ? exactAmountReconciles ? "Exact statement amount; the rate is derived." : "This cannot reconcile at eight-decimal precision. Edit the rate instead." : "Calculated with integer minor-unit rounding."}>
                <Input inputMode="decimal" value={displayedAccountAmount} disabled={!useExactAccountAmount} aria-invalid={useExactAccountAmount && !exactAmountReconciles} onChange={(event) => setExactAccountAmount(event.target.value)} placeholder={fxLoading ? "Calculating…" : minorToInput(0, accountCurrency)} />
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
              }} /> Edit exchange rate manually</label>
              <label className={`${ui.small} ${ui.inlineCheck}`}><input type="checkbox" checked={useExactAccountAmount} onChange={(event) => {
                const checked = event.target.checked;
                setUseExactAccountAmount(checked);
                setRateMode("manual");
                if (checked) setExactAccountAmount(calculatedAccountAmountMinor === null ? "" : minorToInput(calculatedAccountAmountMinor, accountCurrency));
                else if (derivedExactRateScaled) setManualRate(rateScaledToInput(derivedExactRateScaled, rateScale));
              }} /> Use exact account amount</label>
            </div>
          </div>
        ) : null}
        <div className={`${ui.inlineNotice} ${ui.formSpan}`}><WalletCards size={16} />This creates and links a cleared actual transaction. {partial ? "Because the amount is below the remaining estimate, this occurrence stays scheduled." : "The occurrence becomes paid when actual payments meet the expected amount."}</div>
        <button type="submit" hidden />
      </form>
      <FormMessage error={submitError} />
    </Modal>
  );
}
