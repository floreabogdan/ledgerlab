"use client";

import {
  Beaker,
  CalendarPlus,
  Copy,
  Save,
  Trash2,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { useDateRange } from "@/components/date-range-context";
import { useTranslations, useTranslator } from "@/i18n/client";
import { monthBounds } from "@/lib/domain/dates";
import { DEFAULT_CURRENCY } from "@/lib/currencies";
import {
  Button,
  DataState,
  Field,
  FormMessage,
  formatDate,
  formatMoney,
  IconButton,
  Input,
  Metric,
  Modal,
  moneyInputToMinor,
  minorToInput,
  monthKey,
  MonthStepper,
  numberFrom,
  Page,
  Pill,
  Progress,
  readList,
  readRecord,
  requestJson,
  ResponsiveTable,
  Section,
  Select,
  stringFrom,
  useJson,
  ViewHeader,
  workspaceTimeZone,
} from "../_components/feature-kit";
import ui from "../_components/pages.module.css";

type Row = Record<string, unknown>;
type Translate = ReturnType<typeof useTranslations>;
type EditableOpening = { accountId: string; amount: string; currency: string };
const LIQUID_ACCOUNT_TYPES = new Set(["current", "current_account", "savings", "cash"]);
type PlanLine = {
  id: string;
  name: string;
  direction: "income" | "expense";
  amountMinor: number;
  paidAmountMinor: number;
  outstandingAmountMinor: number;
  date: string;
  forecastDate: string;
  accountId: string;
  categoryId: string;
  spendingType: "fixed" | "variable";
  essential: boolean;
  source: string;
  sourceType: string;
  liabilityAccountId: string;
  cashFlowAmountMinor: number;
  spendingAmountMinor: number;
  plannedSpendingAmountMinor: number;
  principalAmountMinor: number;
  isEstimate: boolean;
  includedInForecast: boolean;
  status?: string;
  scenario?: boolean;
};

function previousMonth(value: string) {
  const date = new Date(`${value}-01T12:00:00`);
  date.setMonth(date.getMonth() - 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function lastDayOfMonth(value: string) {
  const [year, month] = value.split("-").map(Number);
  return `${value}-${String(new Date(year, month, 0).getDate()).padStart(2, "0")}`;
}

function parseLine(item: unknown, index: number, t: Translate): PlanLine {
  const row = readRecord(item);
  return {
    id: stringFrom(row.id, `line-${index}`),
    name: stringFrom(row.name ?? row.description ?? row.title, t("planning.shared.fallback.forecastItem")),
    direction: stringFrom(row.direction ?? row.kind) === "income" ? "income" : "expense",
    amountMinor: Math.abs(numberFrom(row.amountMinor ?? row.expectedAmountMinor)),
    paidAmountMinor: Math.abs(numberFrom(row.paidAmountMinor)),
    outstandingAmountMinor: row.outstandingAmountMinor === undefined
      ? Math.abs(numberFrom(row.amountMinor ?? row.expectedAmountMinor))
      : Math.abs(numberFrom(row.outstandingAmountMinor)),
    date: stringFrom(row.date ?? row.dueDate ?? row.expectedDate),
    forecastDate: stringFrom(row.forecastDate ?? row.date ?? row.dueDate ?? row.expectedDate),
    accountId: String(row.accountId ?? ""),
    categoryId: String(row.categoryId ?? ""),
    spendingType: stringFrom(row.spendingType ?? row.spendingNature ?? row.variability) === "fixed" ? "fixed" : "variable",
    essential: typeof row.essential === "boolean" ? row.essential : stringFrom(row.priority ?? row.spendingPriority) === "essential",
    source: stringFrom(row.source, row.ruleId ? "recurring planned payment" : "planned payment"),
    sourceType: stringFrom(row.sourceType, "planned_payment"),
    liabilityAccountId: String(row.liabilityAccountId ?? ""),
    cashFlowAmountMinor: row.cashFlowAmountMinor === undefined
      ? Math.abs(numberFrom(row.outstandingAmountMinor ?? row.amountMinor ?? row.expectedAmountMinor))
      : Math.abs(numberFrom(row.cashFlowAmountMinor)),
    spendingAmountMinor: row.spendingAmountMinor === undefined
      ? (stringFrom(row.direction ?? row.kind) === "income" ? 0 : Math.abs(numberFrom(row.outstandingAmountMinor ?? row.amountMinor ?? row.expectedAmountMinor)))
      : Math.abs(numberFrom(row.spendingAmountMinor)),
    plannedSpendingAmountMinor: row.plannedSpendingAmountMinor === undefined
      ? (stringFrom(row.direction ?? row.kind) === "income" ? 0 : Math.abs(numberFrom(row.amountMinor ?? row.expectedAmountMinor)))
      : Math.abs(numberFrom(row.plannedSpendingAmountMinor)),
    principalAmountMinor: Math.abs(numberFrom(row.principalAmountMinor)),
    isEstimate: Boolean(row.isEstimate),
    includedInForecast: typeof row.includedInForecast === "boolean"
      ? row.includedInForecast
      : Math.abs(numberFrom(row.outstandingAmountMinor ?? row.amountMinor ?? row.expectedAmountMinor)) > 0,
    status: stringFrom(row.status),
  };
}

function projectionCash(line: PlanLine, accountTypeById: ReadonlyMap<string, string>) {
  if (!line.scenario) return line.cashFlowAmountMinor;
  return !line.accountId || LIQUID_ACCOUNT_TYPES.has(accountTypeById.get(line.accountId) ?? "")
    ? line.amountMinor
    : 0;
}

function projectionSpending(line: PlanLine) {
  return line.scenario && line.direction === "expense" ? line.amountMinor : line.spendingAmountMinor;
}

function forecastSourceLabel(line: PlanLine, t: Translate) {
  if (line.scenario || line.sourceType === "scenario") return t("planning.forecast.source.scenario");
  if (line.sourceType === "credit_card_statement") return t("planning.forecast.source.cardStatement");
  if (line.sourceType === "loan_schedule") return t("planning.forecast.source.loanSchedule");
  if (line.sourceType === "planned_payment") {
    return line.source === "recurring planned payment"
      ? t("planning.forecast.source.recurringPayment")
      : t("planning.forecast.source.plannedPayment");
  }
  return t("planning.forecast.source.other");
}

function forecastStatusLabel(status: string | undefined, t: Translate) {
  switch (status) {
    case "planned": return t("planning.forecast.status.planned");
    case "scheduled": return t("planning.forecast.status.scheduled");
    case "overdue": return t("planning.forecast.status.overdue");
    case "paid": return t("planning.forecast.status.paid");
    case "cancelled": return t("planning.forecast.status.cancelled");
    case "skipped": return t("planning.forecast.status.skipped");
    default: return t("planning.forecast.status.other");
  }
}

function accountTypeLabel(type: string, t: Translate) {
  switch (type) {
    case "current":
    case "current_account": return t("planning.forecast.accountType.current");
    case "savings": return t("planning.forecast.accountType.savings");
    case "cash": return t("planning.forecast.accountType.cash");
    case "credit_card": return t("planning.forecast.accountType.creditCard");
    case "loan": return t("planning.forecast.accountType.loan");
    case "investment": return t("planning.forecast.accountType.investment");
    case "custom": return t("planning.forecast.accountType.custom");
    default: return t("planning.forecast.accountType.other");
  }
}

function lineContext(line: PlanLine, reportingCurrency: string, t: Translate) {
  if (line.scenario) return t("planning.forecast.line.hypothetical");
  const source = forecastSourceLabel(line, t);
  if (line.outstandingAmountMinor === 0) return t("planning.forecast.line.settled", { source });
  if (!line.includedInForecast) return t("planning.forecast.line.historical", { source });
  if (line.paidAmountMinor > 0) {
    return t("planning.forecast.line.partial", {
      source,
      amount: formatMoney(line.outstandingAmountMinor, reportingCurrency),
    });
  }
  return line.status
    ? t("planning.forecast.line.status", { source, status: forecastStatusLabel(line.status, t) })
    : t("planning.forecast.line.sourceOnly", { source });
}

function accountCurrency(account: Row, reportingCurrency: string) {
  return stringFrom(account.currency, reportingCurrency).toUpperCase();
}

export default function PlanningPage() {
  const t = useTranslations();
  const translator = useTranslator();
  const router = useRouter();
  const { range, setRange } = useDateRange();
  const [month, setMonth] = useState(() => range.to.slice(0, 7) || monthKey(1));
  useEffect(() => {
    queueMicrotask(() => setMonth(range.to.slice(0, 7)));
  }, [range.to]);
  const selectedMonthBounds = monthBounds(month);
  const rangeMatchesMonth = range.from === selectedMonthBounds.start && range.to === selectedMonthBounds.end;
  const selectMonth = (value: string) => {
    setMonth(value);
    const bounds = monthBounds(value);
    setRange({ from: bounds.start, to: bounds.end });
  };
  const { data: raw, loading, error, reload } = useJson<Record<string, unknown>>(`/api/plans?month=${month}`, {});
  const payload = useMemo(() => readRecord(readRecord(raw).data ?? raw), [raw]);
  const plan = useMemo(() => readRecord(payload.plan ?? payload), [payload]);
  const currency = stringFrom(payload.currency, DEFAULT_CURRENCY).toUpperCase();
  const payloadMonth = stringFrom(payload.month ?? plan.month);
  const actual = readRecord(payload.actual ?? plan.actual);
  const accounts = useMemo(() => readList<Row>(payload, "accounts").filter((item) => !Boolean(readRecord(item).archivedAt ?? readRecord(item).isArchived)), [payload]);
  const categories = useMemo(() => readList<Row>(raw, "categories"), [raw]);
  const [openings, setOpenings] = useState<EditableOpening[]>([]);
  const canonicalLines = useMemo(() => {
    if (payloadMonth !== month) return [];
    const savedLines = readList<Row>(plan, "lines", "items", "entries");
    return (savedLines.length ? savedLines : readList<Row>(payload, "items", "lines", "entries"))
      .map((item, index) => parseLine(item, index, t));
  }, [month, payload, payloadMonth, plan, t]);
  const [scenarioLines, setScenarioLines] = useState<PlanLine[]>([]);
  const scenarioHydratedMonth = useRef<string | null>(null);
  const [scenarioActive, setScenarioActive] = useState(false);
  const [scenarioItemOpen, setScenarioItemOpen] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (payloadMonth !== month) return;
    const openingRows = readList<Row>(plan, "openingBalances", "openings");
    queueMicrotask(() => {
      setOpenings(accounts.map((item) => {
        const account = readRecord(item);
        const saved = openingRows.find((opening) => String(readRecord(opening).accountId) === String(account.id));
        const savedOpening = readRecord(saved);
        const nativeCurrency = accountCurrency(account, currency);
        const nativeAmountMinor = saved
          ? savedOpening.nativeAmountMinor ?? savedOpening.amountMinor ?? savedOpening.openingBalanceMinor
          : account.expectedOpeningMinor ?? account.balanceMinor ?? account.currentBalanceMinor;
        return {
          accountId: String(account.id),
          amount: minorToInput(nativeAmountMinor, nativeCurrency),
          currency: nativeCurrency,
        };
      }));
    });
  }, [accounts, currency, month, payloadMonth, plan]);

  useEffect(() => {
    if (loading || payloadMonth !== month || scenarioHydratedMonth.current === month) return;
    const serverLines = readList<Row>(plan, "scenarioLines", "scenarios")
      .map((item, index) => ({ ...parseLine(item, index, t), scenario: true }));
    queueMicrotask(() => {
      setScenarioLines(serverLines);
      scenarioHydratedMonth.current = month;
    });
  }, [loading, month, payloadMonth, plan, t]);

  const includedLines = useMemo(
    () => scenarioActive ? [...canonicalLines, ...scenarioLines] : canonicalLines,
    [canonicalLines, scenarioActive, scenarioLines],
  );
  const projectionLines = useMemo(
    () => [
      ...canonicalLines.filter((line) => line.includedInForecast),
      ...(scenarioActive ? scenarioLines : []),
    ],
    [canonicalLines, scenarioActive, scenarioLines],
  );
  const actualCashEvents = useMemo(() => readList<Row>(payload, "actualCashEvents").map((item) => {
    const event = readRecord(item);
    return { date: stringFrom(event.date), amountMinor: numberFrom(event.amountMinor) };
  }).filter((event) => event.date), [payload]);
  const accountTypeById = useMemo(() => new Map(accounts.map((item) => {
    const account = readRecord(item);
    return [stringFrom(account.id), stringFrom(account.type)] as const;
  })), [accounts]);
  const openingTotal = numberFrom(
    payload.expectedOpeningMinor,
    accounts.filter((item) => LIQUID_ACCOUNT_TYPES.has(stringFrom(readRecord(item).type))).reduce(
      (sum, item) => sum + numberFrom(readRecord(item).reportingExpectedOpeningMinor),
      0,
    ),
  );
  const actualCashActivityTotal = numberFrom(
    payload.actualCashActivityMinor,
    actualCashEvents.reduce((sum, event) => sum + event.amountMinor, 0),
  );
  const baseIncomeTotal = numberFrom(
    payload.expectedIncomeMinor,
    canonicalLines.filter((line) => line.direction === "income").reduce((sum, line) => sum + line.amountMinor, 0),
  );
  const baseExpenseTotal = numberFrom(
    payload.expectedExpensesMinor,
    canonicalLines.filter((line) => line.direction === "expense").reduce((sum, line) => sum + line.plannedSpendingAmountMinor, 0),
  );
  const baseOutstandingIncomeTotal = numberFrom(
    payload.outstandingCashInflowMinor ?? payload.outstandingIncomeMinor,
    canonicalLines.filter((line) => line.direction === "income" && line.includedInForecast).reduce((sum, line) => sum + projectionCash(line, accountTypeById), 0),
  );
  const baseOutstandingExpenseTotal = numberFrom(
    payload.outstandingCashOutflowMinor,
    canonicalLines.filter((line) => line.direction === "expense" && line.includedInForecast).reduce((sum, line) => sum + projectionCash(line, accountTypeById), 0),
  );
  const baseOutstandingSpendingTotal = numberFrom(
    payload.outstandingExpensesMinor,
    canonicalLines.filter((line) => line.direction === "expense" && line.includedInForecast).reduce((sum, line) => sum + projectionSpending(line), 0),
  );
  const baseFixedTotal = numberFrom(
    payload.fixedMinor,
    canonicalLines.filter((line) => line.direction === "expense" && line.spendingType === "fixed").reduce((sum, line) => sum + line.plannedSpendingAmountMinor, 0),
  );
  const baseVariableTotal = numberFrom(payload.variableMinor, baseExpenseTotal - baseFixedTotal);
  const activeScenarioLines = scenarioActive ? scenarioLines : [];
  const incomeTotal = baseIncomeTotal + activeScenarioLines.filter((line) => line.direction === "income").reduce((sum, line) => sum + line.amountMinor, 0);
  const expenseTotal = baseExpenseTotal + activeScenarioLines.filter((line) => line.direction === "expense").reduce((sum, line) => sum + line.amountMinor, 0);
  const outstandingIncomeTotal = baseOutstandingIncomeTotal + activeScenarioLines.filter((line) => line.direction === "income").reduce((sum, line) => sum + projectionCash(line, accountTypeById), 0);
  const outstandingExpenseTotal = baseOutstandingExpenseTotal + activeScenarioLines.filter((line) => line.direction === "expense").reduce((sum, line) => sum + projectionCash(line, accountTypeById), 0);
  const outstandingSpendingTotal = baseOutstandingSpendingTotal + activeScenarioLines.filter((line) => line.direction === "expense").reduce((sum, line) => sum + projectionSpending(line), 0);
  const fixedTotal = baseFixedTotal + activeScenarioLines.filter((line) => line.direction === "expense" && line.spendingType === "fixed").reduce((sum, line) => sum + line.amountMinor, 0);
  const variableTotal = baseVariableTotal + activeScenarioLines.filter((line) => line.direction === "expense" && line.spendingType !== "fixed").reduce((sum, line) => sum + line.amountMinor, 0);
  const discretionarySpent = projectionLines.filter((line) => line.direction === "expense" && !line.essential).reduce((sum, line) => sum + projectionCash(line, accountTypeById), 0);
  const essentialOutstanding = projectionLines.filter((line) => line.direction === "expense" && line.essential).reduce((sum, line) => sum + projectionCash(line, accountTypeById), 0);
  const discretionaryAvailable = openingTotal + actualCashActivityTotal + outstandingIncomeTotal - essentialOutstanding - discretionarySpent;
  const baseClosingTotal = numberFrom(
    payload.forecastClosingMinor,
    openingTotal + actualCashActivityTotal + baseOutstandingIncomeTotal - baseOutstandingExpenseTotal,
  );
  const closingTotal = baseClosingTotal + (outstandingIncomeTotal - baseOutstandingIncomeTotal) - (outstandingExpenseTotal - baseOutstandingExpenseTotal);
  const openingsDirty = openings.some((entry) => {
    const account = readRecord(accounts.find((item) => stringFrom(readRecord(item).id) === entry.accountId));
    const parsed = moneyInputToMinor(entry.amount, accountCurrency(account, entry.currency));
    return parsed === null || parsed !== numberFrom(account.expectedOpeningMinor);
  });

  const cashTimeline = useMemo(() => {
    let balance = openingTotal;
    const points = [{ date: `${month}-01`, balance, label: t("planning.forecast.cashPath.open") }];
    const changesByDate = new Map<string, number>();
    for (const event of actualCashEvents) {
      changesByDate.set(event.date, (changesByDate.get(event.date) ?? 0) + event.amountMinor);
    }
    for (const line of projectionLines) {
      const amount = projectionCash(line, accountTypeById);
      if (!line.forecastDate || amount === 0) continue;
      const signedAmount = line.direction === "income" ? amount : -amount;
      changesByDate.set(line.forecastDate, (changesByDate.get(line.forecastDate) ?? 0) + signedAmount);
    }
    [...changesByDate.entries()].sort(([left], [right]) => left.localeCompare(right)).forEach(([date, amountMinor]) => {
      balance += amountMinor;
      points.push({ date, balance, label: formatDate(date, { day: "2-digit", month: "short", year: undefined }) });
    });
    points.push({ date: lastDayOfMonth(month), balance, label: t("planning.forecast.cashPath.close") });
    return points;
  }, [accountTypeById, actualCashEvents, month, openingTotal, projectionLines, t]);
  const lowest = cashTimeline.reduce((minimum, point) => point.balance < minimum.balance ? point : minimum, cashTimeline[0]);

  const actualIncome = numberFrom(actual.incomeMinor ?? plan.actualIncomeMinor);
  const actualExpense = numberFrom(actual.expenseMinor ?? actual.spendingMinor ?? plan.actualExpenseMinor);
  const daysInMonth = Number(lastDayOfMonth(month).slice(-2));
  const todayDay = month === monthKey() ? Number(new Date().toLocaleDateString("en-CA", { day: "2-digit", timeZone: workspaceTimeZone() })) : month < monthKey() ? daysInMonth : 0;

  async function saveAssumptions() {
    setSaving(true); setActionError(null); setSaveMessage(null);
    try {
      const openingBalances = openings.map((item) => {
        const account = readRecord(accounts.find((entry) => stringFrom(readRecord(entry).id) === item.accountId));
        const nativeCurrency = accountCurrency(account, item.currency);
        const amountMinor = moneyInputToMinor(item.amount, nativeCurrency);
        if (amountMinor === null) {
          throw new Error(t("planning.forecast.validation.openingBalance", {
            currency: nativeCurrency,
            account: stringFrom(account.name, t("planning.shared.fallback.thisAccount")),
          }));
        }
        return { accountId: item.accountId, amountMinor, openingBalanceMinor: amountMinor, currency: nativeCurrency };
      });
      await requestJson("/api/plans", { method: "POST", body: JSON.stringify({ action: "save-assumptions", month, name: t("planning.forecast.plan.defaultName"), openingBalances }) }, translator);
      setSaveMessage(t("planning.forecast.feedback.assumptionsSaved"));
      await reload();
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : t("planning.forecast.feedback.saveAssumptionsFailed"));
    } finally { setSaving(false); }
  }

  async function copyAssumptions() {
    setSaving(true); setActionError(null); setSaveMessage(null);
    try {
      const copied = await requestJson<Record<string, unknown>>("/api/plans", { method: "POST", body: JSON.stringify({ action: "copy-assumptions", sourceMonth: previousMonth(month), targetMonth: month, month, name: t("planning.forecast.plan.defaultName") }) }, translator);
      const copiedPlan = readRecord(readRecord(copied).plan ?? copied);
      setScenarioLines(readList<Row>(copiedPlan, "scenarioLines", "scenarios").map((item, index) => ({ ...parseLine(item, index, t), scenario: true })));
      scenarioHydratedMonth.current = month;
      setSaveMessage(t("planning.forecast.feedback.assumptionsCopied"));
      await reload();
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : t("planning.forecast.feedback.copyAssumptionsFailed"));
    } finally { setSaving(false); }
  }

  async function saveScenario() {
    setSaving(true); setActionError(null);
    try {
      await requestJson("/api/plans", {
        method: "POST",
        body: JSON.stringify({ action: "save-scenario", month, scenarioName: t("planning.forecast.scenario.name"), items: scenarioLines }),
      }, translator);
      setSaveMessage(t("planning.forecast.feedback.scenarioSaved"));
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : t("planning.forecast.feedback.saveScenarioFailed"));
    } finally { setSaving(false); }
  }

  return (
    <Page>
      <ViewHeader
        eyebrow={t("planning.forecast.header.eyebrow")}
        title={t("planning.forecast.header.title")}
        description={t("planning.forecast.header.description")}
        actions={
          <>
            <Button variant="secondary" icon={<Copy size={15} />} disabled={saving} onClick={() => void copyAssumptions()}>{t("planning.forecast.actions.copyPrior")}</Button>
            <Button icon={<Save size={15} />} disabled={saving} onClick={() => void saveAssumptions()}>{saving ? t("planning.forecast.actions.saving") : t("planning.forecast.actions.saveAssumptions")}</Button>
          </>
        }
      />

      <div className={ui.toolbar}>
        <div className={ui.toolbarGroup}>
          <MonthStepper value={month} onChange={selectMonth} />
          {!rangeMatchesMonth ? <Pill tone="info">{t("planning.forecast.range.endMonth")}</Pill> : null}
        </div>
        <div className={ui.toolbarGroup}>
          <Button variant={scenarioActive ? "secondary" : "ghost"} icon={<Beaker size={15} />} onClick={() => setScenarioActive((value) => !value)}>{scenarioActive ? t("planning.forecast.actions.scenarioOn") : t("planning.forecast.actions.tryScenario")}</Button>
          <Button icon={<CalendarPlus size={15} />} onClick={() => router.push("/planned?new=1")}>{t("planning.forecast.actions.addExpectedPayment")}</Button>
        </div>
      </div>
      <FormMessage error={actionError} success={saveMessage} />

      <DataState loading={loading} error={error} onRetry={reload}>
        {scenarioActive ? (
          <div className={ui.scenarioBanner}>
            <span><Beaker className={ui.inlineIcon} size={15} />{t("planning.forecast.scenario.banner", { name: t("planning.forecast.scenario.name") })}</span>
            <div className={ui.toolbarGroup}><Button variant="ghost" onClick={() => setScenarioLines([])}>{t("planning.forecast.actions.clear")}</Button><Button variant="secondary" onClick={() => setScenarioItemOpen(true)}>{t("planning.forecast.actions.addAdjustment")}</Button><Button variant="secondary" onClick={() => void saveScenario()}>{t("planning.forecast.actions.saveScenario")}</Button></div>
          </div>
        ) : null}

        <div className={ui.metricGrid}>
          <Metric label={t("planning.forecast.metrics.opening.label")} value={formatMoney(openingTotal, currency)} detail={openingsDirty ? t("planning.forecast.metrics.opening.dirtyDetail", { currency }) : t("planning.forecast.metrics.opening.detail")} info={t("planning.forecast.metrics.opening.info")} />
          <Metric label={t("planning.forecast.metrics.income.label")} value={formatMoney(incomeTotal, currency)} tone="positive" info={t("planning.forecast.metrics.income.info")} />
          <Metric label={t("planning.forecast.metrics.spending.label")} value={formatMoney(expenseTotal, currency)} tone="warning" detail={t("planning.forecast.metrics.spending.detail", { fixed: formatMoney(fixedTotal, currency), variable: formatMoney(variableTotal, currency) })} info={t("planning.forecast.metrics.spending.info")} />
          <Metric label={t("planning.forecast.metrics.cashDue.label")} value={formatMoney(outstandingExpenseTotal, currency)} tone="warning" detail={t("planning.forecast.metrics.cashDue.detail", { amount: formatMoney(outstandingSpendingTotal, currency) })} info={t("planning.forecast.metrics.cashDue.info")} />
          <Metric label={t("planning.forecast.metrics.closing.label")} value={formatMoney(closingTotal, currency)} tone={closingTotal >= 0 ? "accent" : "negative"} info={t("planning.forecast.metrics.closing.info")} />
        </div>

        <Section title={t("planning.forecast.cashPath.title")} description={t("planning.forecast.cashPath.description")} action={<Pill tone="info">{t("planning.forecast.cashPath.projection")}</Pill>}>
          <div className={ui.planHero}>
            <div className={ui.planBalance}>
              <span>{t("planning.forecast.cashPath.lowest")}</span>
              <strong className={lowest.balance < 0 ? ui.negative : ""}>{formatMoney(lowest.balance, currency)}</strong>
              <small>{t("planning.forecast.cashPath.lowestDetail", { date: formatDate(lowest.date) })}</small>
            </div>
            <div className={ui.cashFlowLine} aria-label={t("planning.forecast.cashPath.timelineLabel")}>
              <div className={ui.cashFlowAxis} />
              {cashTimeline.map((point, index) => {
                const position = cashTimeline.length === 1 ? 0 : (index / (cashTimeline.length - 1)) * 100;
                const edge = index === 0 ? "start" : index === cashTimeline.length - 1 ? "end" : undefined;
                const label = t("planning.forecast.cashPath.pointLabel", { label: point.label, balance: formatMoney(point.balance, currency) });
                return (
                  <span
                    key={`${point.date}-${index}`}
                    className={`${ui.cashFlowPoint} ${point === lowest ? ui.cashFlowLow : ""}`}
                    style={{ left: `${position}%` }}
                    data-edge={edge}
                    data-label={label}
                    data-label-visible={Boolean(edge || point === lowest)}
                    role="img"
                    aria-label={label}
                    title={label}
                  />
                );
              })}
            </div>
          </div>
        </Section>

        <Section title={t("planning.forecast.payments.title")} description={t("planning.forecast.payments.description")}>
              {includedLines.length ? (
                <ResponsiveTable label={t("planning.forecast.payments.tableLabel")}>
                  <thead><tr><th>{t("planning.forecast.payments.date")}</th><th>{t("planning.forecast.payments.item")}</th><th>{t("planning.forecast.payments.type")}</th><th>{t("planning.forecast.payments.priority")}</th><th>{t("planning.forecast.payments.account")}</th><th>{t("planning.forecast.payments.cashDue", { currency })}</th><th>{t("planning.forecast.payments.spending", { currency })}</th><th><span className="sr-only">{t("planning.shared.labels.actions")}</span></th></tr></thead>
                  <tbody>
                    {[...includedLines].sort((a, b) => a.date.localeCompare(b.date)).map((line) => {
                      const account = accounts.find((item) => String(readRecord(item).id) === line.accountId);
                      return (
                        <tr key={line.id}>
                          <td className={ui.nowrap}>{formatDate(line.date, { day: "2-digit", month: "short", year: undefined })}</td>
                          <td><span className={ui.tablePrimary}>{line.name}</span><span className={ui.tableSecondary}>{line.isEstimate ? t("planning.forecast.line.estimate", { context: lineContext(line, currency, t) }) : lineContext(line, currency, t)}</span></td>
                          <td><Pill tone={line.direction === "income" ? "positive" : line.spendingType === "fixed" ? "info" : "warning"}>{line.direction === "income" ? t("planning.forecast.labels.income") : line.spendingType === "fixed" ? t("planning.forecast.labels.fixed") : t("planning.forecast.labels.variable")}</Pill></td>
                          <td>{line.direction === "expense" ? (line.essential ? t("planning.forecast.labels.essential") : t("planning.forecast.labels.discretionary")) : t("planning.shared.labels.notAvailable")}</td>
                          <td>{account ? stringFrom(readRecord(account).name, t("planning.shared.fallback.account")) : t("planning.shared.labels.unassigned")}</td>
                          <td className={`${ui.amount} ${line.direction === "income" ? ui.positive : ui.negative}`}>{line.direction === "income" ? "+" : "−"}{formatMoney(line.scenario || line.includedInForecast ? projectionCash(line, accountTypeById) : 0, currency)}</td>
                          <td className={ui.amount}>{line.direction === "expense" ? formatMoney(line.scenario || line.includedInForecast ? projectionSpending(line) : 0, currency) : t("planning.shared.labels.notAvailable")}</td>
                          <td>{line.scenario ? <IconButton label={t("planning.forecast.actions.removeAdjustment")} onClick={() => setScenarioLines((current) => current.filter((item) => item.id !== line.id))}><Trash2 size={15} /></IconButton> : null}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </ResponsiveTable>
              ) : <div className={`${ui.inlineNotice} ${ui.noticeInset}`}><CalendarPlus size={16} />{t("planning.forecast.payments.empty")} <Button variant="secondary" onClick={() => router.push("/planned?new=1")}>{t("planning.forecast.actions.addExpectedPayment")}</Button></div>}
        </Section>

        <div className={ui.equalColumns}>
          <Section title={t("planning.forecast.openings.title")} description={openingsDirty ? t("planning.forecast.openings.dirtyDescription") : t("planning.forecast.openings.description")}>
              <ResponsiveTable label={t("planning.forecast.openings.tableLabel")}>
                <thead><tr><th>{t("planning.forecast.openings.account")}</th><th>{t("planning.forecast.openings.actualNow")}</th><th>{t("planning.forecast.openings.expectedOpening")}</th><th>{t("planning.forecast.openings.difference")}</th></tr></thead>
                <tbody>
                  {accounts.map((item, index) => {
                    const account = readRecord(item);
                    const id = String(account.id);
                    const entry = openings.find((opening) => opening.accountId === id);
                    const nativeCurrency = accountCurrency(account, entry?.currency ?? currency);
                    const expected = moneyInputToMinor(entry?.amount ?? "", nativeCurrency);
                    const actualBalance = numberFrom(account.balanceMinor ?? account.currentBalanceMinor);
                    const difference = expected === null ? null : expected - actualBalance;
                    return (
                      <tr key={stringFrom(account.id, String(index))}>
                        <td>
                          <span className={ui.tablePrimary}>{stringFrom(account.name, t("planning.shared.fallback.account"))}</span>
                          <span className={ui.tableSecondary}>{t("planning.forecast.openings.accountDetail", { type: accountTypeLabel(stringFrom(account.type), t), currency: nativeCurrency })}</span>
                        </td>
                        <td className={ui.amount}>{formatMoney(actualBalance, nativeCurrency)}</td>
                        <td><Input className={ui.planTableInput} aria-label={t("planning.forecast.openings.inputLabel", { account: stringFrom(account.name, t("planning.shared.fallback.account")), currency: nativeCurrency })} aria-invalid={expected === null} inputMode="decimal" value={entry?.amount ?? ""} onChange={(event) => setOpenings((current) => current.map((opening) => opening.accountId === id ? { ...opening, amount: event.target.value } : opening))} /></td>
                        <td className={`${ui.amount} ${difference === null ? "" : amountDifferenceTone(difference)}`}>{difference === null ? t("planning.shared.labels.notAvailable") : formatMoney(difference, nativeCurrency)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </ResponsiveTable>
          </Section>

          <Section title={t("planning.forecast.discretionary.title")} description={t("planning.forecast.discretionary.description")}>
              <div className={ui.summaryList}>
                <div className={ui.summaryRow}><span>{t("planning.forecast.discretionary.openingCash")}</span><strong>{formatMoney(openingTotal, currency)}</strong></div>
                <div className={ui.summaryRow}><span>{t("planning.forecast.discretionary.actualMovement")}</span><strong className={amountDifferenceTone(actualCashActivityTotal)}>{formatMoney(actualCashActivityTotal, currency)}</strong></div>
                <div className={ui.summaryRow}><span>{t("planning.forecast.discretionary.outstandingIncome")}</span><strong className={ui.positive}>+{formatMoney(outstandingIncomeTotal, currency)}</strong></div>
                <div className={ui.summaryRow}><span>{t("planning.forecast.discretionary.outstandingEssentials")}</span><strong className={ui.negative}>−{formatMoney(essentialOutstanding, currency)}</strong></div>
                <div className={ui.summaryRow}><span>{t("planning.forecast.discretionary.outstandingDiscretionary")}</span><strong className={ui.warning}>−{formatMoney(discretionarySpent, currency)}</strong></div>
                <div className={ui.summaryRow}><span>{t("planning.forecast.discretionary.remaining")}</span><strong className={discretionaryAvailable >= 0 ? ui.positive : ui.negative}>{formatMoney(discretionaryAvailable, currency)}</strong></div>
              </div>
          </Section>
        </div>

        <div className={ui.equalColumns}>
          <Section title={t("planning.forecast.accounts.title")} description={scenarioActive ? t("planning.forecast.accounts.scenarioDescription") : t("planning.forecast.accounts.description")}>
              <div className={ui.summaryList}>
                {accounts.map((item, index) => {
                  const account = readRecord(item);
                  const nativeCurrency = accountCurrency(account, currency);
                  const nativeClosing = numberFrom(account.forecastClosingMinor);
                  const reportingClosing = numberFrom(account.reportingForecastClosingMinor);
                  return (
                    <div className={ui.summaryRow} key={stringFrom(account.id, String(index))}>
                      <span>{stringFrom(account.name, t("planning.shared.fallback.account"))}<small>{t("planning.forecast.accounts.ledger", { currency: nativeCurrency })}</small></span>
                      <strong className={nativeClosing < 0 ? ui.negative : ""}>
                        {formatMoney(nativeClosing, nativeCurrency)}
                        {nativeCurrency !== currency ? <small>{t("planning.forecast.accounts.reportingEquivalent", { amount: formatMoney(reportingClosing, currency) })}</small> : null}
                      </strong>
                    </div>
                  );
                })}
                {!accounts.length ? <div className={ui.summaryRow}><span>{t("planning.forecast.accounts.empty")}</span></div> : null}
              </div>
          </Section>

          <Section title={t("planning.forecast.comparison.title")} description={t("planning.forecast.comparison.description")}>
              <div className={ui.summaryList}>
                <div className={ui.summaryRow}><span>{t("planning.forecast.comparison.income")}</span><strong>{t("planning.forecast.comparison.plannedActual", { planned: formatMoney(incomeTotal, currency), actual: formatMoney(actualIncome, currency) }).split("\n")[0]}<br /><small>{t("planning.forecast.comparison.plannedActual", { planned: formatMoney(incomeTotal, currency), actual: formatMoney(actualIncome, currency) }).split("\n")[1]}</small></strong></div>
                <div className={ui.summaryRow}><span>{t("planning.forecast.comparison.spending")}</span><strong>{t("planning.forecast.comparison.plannedActual", { planned: formatMoney(expenseTotal, currency), actual: formatMoney(actualExpense, currency) }).split("\n")[0]}<br /><small>{t("planning.forecast.comparison.plannedActual", { planned: formatMoney(expenseTotal, currency), actual: formatMoney(actualExpense, currency) }).split("\n")[1]}</small></strong></div>
                <div className={ui.summaryRow}><span>{t("planning.forecast.comparison.cashObligations")}</span><strong>{t("planning.forecast.comparison.outstanding", { amount: formatMoney(outstandingExpenseTotal, currency) })}<br /><small>{t("planning.forecast.comparison.transfersIncluded")}</small></strong></div>
                <div className={ui.summaryRow}><span>{t("planning.forecast.comparison.monthProgress")}</span><Progress value={todayDay} max={daysInMonth} label={t("planning.forecast.comparison.progressLabel", { current: todayDay, total: daysInMonth })} /></div>
                <div className={ui.summaryRow}><span>{t("planning.forecast.comparison.variance")}</span><strong className={actualExpense > expenseTotal ? ui.negative : ui.positive}>{formatMoney(expenseTotal - actualExpense, currency)}<br /><small>{actualExpense > expenseTotal ? t("planning.forecast.comparison.overExpected") : t("planning.forecast.comparison.remainingExpected")}</small></strong></div>
              </div>
          </Section>
        </div>
      </DataState>

      <ScenarioAdjustmentForm key={`scenario-${month}-${currency}-${scenarioItemOpen ? "open" : "closed"}`} open={scenarioItemOpen} onClose={() => setScenarioItemOpen(false)} month={month} currency={currency} accounts={accounts} categories={categories} onAdd={(line) => setScenarioLines((current) => [...current, line])} />
    </Page>
  );
}

function amountDifferenceTone(value: number) { return value > 0 ? ui.positive : value < 0 ? ui.negative : ""; }

function ScenarioAdjustmentForm({ open, onClose, month, currency, accounts, categories, onAdd }: { open: boolean; onClose: () => void; month: string; currency: string; accounts: Row[]; categories: Row[]; onAdd: (line: PlanLine) => void }) {
  const t = useTranslations();
  const [name, setName] = useState("");
  const [direction, setDirection] = useState<"income" | "expense">("expense");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(`${month}-15`);
  const [accountId, setAccountId] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [spendingType, setSpendingType] = useState<"fixed" | "variable">("variable");
  const [essential, setEssential] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const add = () => {
    const amountMinor = moneyInputToMinor(amount, currency);
    if (!name.trim()) { setFormError(t("planning.forecast.scenarioForm.nameError")); return; }
    if (amountMinor === null || amountMinor <= 0) { setFormError(t("planning.forecast.scenarioForm.amountError")); return; }
    onAdd({
      id: `scenario-${Date.now()}`, name: name.trim(), direction, amountMinor,
      paidAmountMinor: 0, outstandingAmountMinor: amountMinor, date, forecastDate: date, accountId,
      categoryId, spendingType, essential, source: "scenario", sourceType: "scenario",
      liabilityAccountId: "", cashFlowAmountMinor: amountMinor,
      spendingAmountMinor: direction === "expense" ? amountMinor : 0,
      plannedSpendingAmountMinor: direction === "expense" ? amountMinor : 0,
      principalAmountMinor: 0, isEstimate: true, includedInForecast: true, scenario: true,
    });
    setName(""); setAmount(""); setFormError(null); onClose();
  };
  return (
    <Modal open={open} onClose={onClose} title={t("planning.forecast.scenarioForm.title")} description={t("planning.forecast.scenarioForm.description")} footer={<><Button variant="ghost" onClick={onClose}>{t("planning.forecast.scenarioForm.cancel")}</Button><Button onClick={add}>{t("planning.forecast.scenarioForm.add")}</Button></>}>
      <div className={ui.formGrid}>
        <Field label={t("planning.forecast.scenarioForm.itemName")} className={ui.formSpan}><Input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder={direction === "income" ? t("planning.forecast.scenarioForm.incomePlaceholder") : t("planning.forecast.scenarioForm.expensePlaceholder")} /></Field>
        <Field label={t("planning.forecast.scenarioForm.direction")}><Select value={direction} onValueChange={(value) => setDirection(value as "income" | "expense")}><option value="expense">{t("planning.forecast.scenarioForm.expense")}</option><option value="income">{t("planning.forecast.scenarioForm.income")}</option></Select></Field>
        <Field label={t("planning.forecast.scenarioForm.amount", { currency })}><Input inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} /></Field>
        <Field label={t("planning.forecast.scenarioForm.expectedDate")}><Input type="date" min={`${month}-01`} max={lastDayOfMonth(month)} value={date} onChange={(event) => setDate(event.target.value)} /></Field>
        <Field label={t("planning.forecast.scenarioForm.account")} hint={t("planning.forecast.scenarioForm.accountHint")}><Select value={accountId} onValueChange={(value) => setAccountId(value)}><option value="">{t("planning.shared.labels.unassigned")}</option>{accounts.map((item, index) => { const account = readRecord(item); return <option value={String(account.id)} key={stringFrom(account.id, String(index))}>{stringFrom(account.name, t("planning.shared.fallback.account"))}</option>; })}</Select></Field>
        {direction === "expense" ? <><Field label={t("planning.forecast.scenarioForm.spendingType")}><Select value={spendingType} onValueChange={(value) => setSpendingType(value as "fixed" | "variable")}><option value="fixed">{t("planning.forecast.scenarioForm.fixed")}</option><option value="variable">{t("planning.forecast.scenarioForm.variable")}</option></Select></Field><Field label={t("planning.forecast.scenarioForm.category")}><Select value={categoryId} onValueChange={(value) => setCategoryId(value)}><option value="">{t("planning.shared.labels.uncategorised")}</option>{categories.map((item, index) => { const category = readRecord(item); return <option value={String(category.id)} key={stringFrom(category.id, String(index))}>{stringFrom(category.name, t("planning.shared.fallback.category"))}</option>; })}</Select></Field><label className={`${ui.inlineNotice} ${ui.formSpan}`}><input type="checkbox" checked={essential} onChange={(event) => setEssential(event.target.checked)} />{t("planning.forecast.scenarioForm.essential")}</label></> : null}
      </div>
      <FormMessage error={formError} />
    </Modal>
  );
}
