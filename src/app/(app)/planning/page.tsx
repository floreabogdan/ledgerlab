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

function parseLine(item: unknown, index: number): PlanLine {
  const row = readRecord(item);
  return {
    id: stringFrom(row.id, `line-${index}`),
    name: stringFrom(row.name ?? row.description ?? row.title, "Forecast item"),
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

function lineContext(line: PlanLine, reportingCurrency: string) {
  if (line.scenario) return "Hypothetical · scenario only";
  if (line.outstandingAmountMinor === 0) return `${line.source} · settled`;
  if (!line.includedInForecast) return `${line.source} · not applied to this historical close`;
  if (line.paidAmountMinor > 0) return `${line.source} · partial · ${formatMoney(line.outstandingAmountMinor, reportingCurrency)} outstanding`;
  return `${line.source}${line.status ? ` · ${line.status}` : ""}`;
}

function accountCurrency(account: Row, reportingCurrency: string) {
  return stringFrom(account.currency, reportingCurrency).toUpperCase();
}

export default function PlanningPage() {
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
    return (savedLines.length ? savedLines : readList<Row>(payload, "items", "lines", "entries")).map(parseLine);
  }, [month, payload, payloadMonth, plan]);
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
      .map((item, index) => ({ ...parseLine(item, index), scenario: true }));
    queueMicrotask(() => {
      setScenarioLines(serverLines);
      scenarioHydratedMonth.current = month;
    });
  }, [loading, month, payloadMonth, plan]);

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
    const points = [{ date: `${month}-01`, balance, label: "Open" }];
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
    points.push({ date: lastDayOfMonth(month), balance, label: "Close" });
    return points;
  }, [accountTypeById, actualCashEvents, month, openingTotal, projectionLines]);
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
        if (amountMinor === null) throw new Error(`Enter a valid ${nativeCurrency} opening balance for ${stringFrom(account.name, "this account")}.`);
        return { accountId: item.accountId, amountMinor, openingBalanceMinor: amountMinor, currency: nativeCurrency };
      });
      await requestJson("/api/plans", { method: "POST", body: JSON.stringify({ action: "save-assumptions", month, openingBalances }) });
      setSaveMessage("Forecast opening assumptions saved.");
      await reload();
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : "Could not save these forecast assumptions");
    } finally { setSaving(false); }
  }

  async function copyAssumptions() {
    setSaving(true); setActionError(null); setSaveMessage(null);
    try {
      const copied = await requestJson<Record<string, unknown>>("/api/plans", { method: "POST", body: JSON.stringify({ action: "copy-assumptions", sourceMonth: previousMonth(month), targetMonth: month, month }) });
      const copiedPlan = readRecord(readRecord(copied).plan ?? copied);
      setScenarioLines(readList<Row>(copiedPlan, "scenarioLines", "scenarios").map((item, index) => ({ ...parseLine(item, index), scenario: true })));
      scenarioHydratedMonth.current = month;
      setSaveMessage("Previous opening assumptions and scenario adjustments copied. Expected payments still come from Planned Payments.");
      await reload();
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : "Could not copy the previous forecast assumptions");
    } finally { setSaving(false); }
  }

  async function saveScenario() {
    setSaving(true); setActionError(null);
    try {
      await requestJson("/api/plans", {
        method: "POST",
        body: JSON.stringify({ action: "save-scenario", month, scenarioName: "Working scenario", items: scenarioLines }),
      });
      setSaveMessage("Scenario saved separately. Actual transactions were not changed.");
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : "Could not save this scenario");
    } finally { setSaving(false); }
  }

  return (
    <Page>
      <ViewHeader
        eyebrow="Forecast workspace"
        title="Monthly forecast"
        description="Forecast cash flow from Planned Payments, opening assumptions, and optional what-if adjustments. Nothing here changes actual transactions."
        actions={
          <>
            <Button variant="secondary" icon={<Copy size={15} />} disabled={saving} onClick={() => void copyAssumptions()}>Copy prior assumptions</Button>
            <Button icon={<Save size={15} />} disabled={saving} onClick={() => void saveAssumptions()}>{saving ? "Saving…" : "Save assumptions"}</Button>
          </>
        }
      />

      <div className={ui.toolbar}>
        <div className={ui.toolbarGroup}>
          <MonthStepper value={month} onChange={selectMonth} />
          {!rangeMatchesMonth ? <Pill tone="info">Monthly view uses the range end month</Pill> : null}
        </div>
        <div className={ui.toolbarGroup}>
          <Button variant={scenarioActive ? "secondary" : "ghost"} icon={<Beaker size={15} />} onClick={() => setScenarioActive((value) => !value)}>{scenarioActive ? "Scenario on" : "Try a scenario"}</Button>
          <Button icon={<CalendarPlus size={15} />} onClick={() => router.push("/planned?new=1")}>Add expected payment</Button>
        </div>
      </div>
      <FormMessage error={actionError} success={saveMessage} />

      <DataState loading={loading} error={error} onRetry={reload}>
        {scenarioActive ? (
          <div className={ui.scenarioBanner}>
            <span><Beaker className={ui.inlineIcon} size={15} /><strong>Working scenario</strong> — hypothetical adjustments affect this projection only.</span>
            <div className={ui.toolbarGroup}><Button variant="ghost" onClick={() => setScenarioLines([])}>Clear</Button><Button variant="secondary" onClick={() => setScenarioItemOpen(true)}>Add adjustment</Button><Button variant="secondary" onClick={() => void saveScenario()}>Save scenario</Button></div>
          </div>
        ) : null}

        <div className={ui.metricGrid}>
          <Metric label="Expected cash opening" value={formatMoney(openingTotal, currency)} detail={openingsDirty ? `Saved ${currency} value · save native edits to refresh` : "Current, savings and cash only"} info="Liquid opening balances converted from each account's native currency at the month-start reporting rate. Investments and liability balances remain in their account forecasts but are not cash." />
          <Metric label="Expected income" value={formatMoney(incomeTotal, currency)} tone="positive" info="Income from Planned Payments, plus enabled hypothetical adjustments, expressed in profile reporting currency." />
          <Metric label="Expected spending" value={formatMoney(expenseTotal, currency)} tone="warning" detail={`${formatMoney(fixedTotal, currency)} fixed · ${formatMoney(variableTotal, currency)} variable`} info="Economic spending in profile reporting currency. Loan principal and card repayments are transfers, so they are excluded; loan interest and fees are included." />
          <Metric label="Cash due" value={formatMoney(outstandingExpenseTotal, currency)} tone="warning" detail={`${formatMoney(outstandingSpendingTotal, currency)} also counts as spending`} info="Expected cash outflow in profile reporting currency. This includes card repayments and full loan installments, while spending includes only purchases, interest, and fees." />
          <Metric label="Projected cash closing" value={formatMoney(closingTotal, currency)} tone={closingTotal >= 0 ? "accent" : "negative"} info="Liquid opening cash plus cleared actual cash movement in the month, then remaining income and obligations, all converted to profile reporting currency. Settled payments are not deducted twice." />
        </div>

        <Section title="Projected cash path" description="Cleared actual movement plus remaining estimates across their dates · actual balances are unchanged" action={<Pill tone="info">Projection</Pill>}>
          <div className={ui.planHero}>
            <div className={ui.planBalance}>
              <span>Lowest projected cash point</span>
              <strong className={lowest.balance < 0 ? ui.negative : ""}>{formatMoney(lowest.balance, currency)}</strong>
              <small>{formatDate(lowest.date)} · after actual movement, remaining payments, and adjustments</small>
            </div>
            <div className={ui.cashFlowLine} aria-label="Projected cash timeline">
              <div className={ui.cashFlowAxis} />
              {cashTimeline.map((point, index) => {
                const position = cashTimeline.length === 1 ? 0 : (index / (cashTimeline.length - 1)) * 100;
                const edge = index === 0 ? "start" : index === cashTimeline.length - 1 ? "end" : undefined;
                const label = `${point.label} · ${formatMoney(point.balance, currency)}`;
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

        <Section title="Expected payments" description="Canonical obligations and income from Planned Payments; scenario adjustments are clearly marked">
              {includedLines.length ? (
                <ResponsiveTable label="Monthly expected payments and scenario adjustments">
                  <thead><tr><th>Date</th><th>Item</th><th>Type</th><th>Priority</th><th>Account</th><th>Cash due ({currency})</th><th>Spending ({currency})</th><th><span className="sr-only">Actions</span></th></tr></thead>
                  <tbody>
                    {[...includedLines].sort((a, b) => a.date.localeCompare(b.date)).map((line) => {
                      const account = accounts.find((item) => String(readRecord(item).id) === line.accountId);
                      return (
                        <tr key={line.id}>
                          <td className={ui.nowrap}>{formatDate(line.date, { day: "2-digit", month: "short", year: undefined })}</td>
                          <td><span className={ui.tablePrimary}>{line.name}</span><span className={ui.tableSecondary}>{lineContext(line, currency)}{line.isEstimate ? " · estimate" : ""}</span></td>
                          <td><Pill tone={line.direction === "income" ? "positive" : line.spendingType === "fixed" ? "info" : "warning"}>{line.direction === "income" ? "income" : line.spendingType}</Pill></td>
                          <td>{line.direction === "expense" ? (line.essential ? "Essential" : "Discretionary") : "—"}</td>
                          <td>{account ? stringFrom(readRecord(account).name, "Account") : "Unassigned"}</td>
                          <td className={`${ui.amount} ${line.direction === "income" ? ui.positive : ui.negative}`}>{line.direction === "income" ? "+" : "−"}{formatMoney(line.scenario || line.includedInForecast ? projectionCash(line, accountTypeById) : 0, currency)}</td>
                          <td className={ui.amount}>{line.direction === "expense" ? formatMoney(line.scenario || line.includedInForecast ? projectionSpending(line) : 0, currency) : "—"}</td>
                          <td>{line.scenario ? <IconButton label="Remove scenario adjustment" onClick={() => setScenarioLines((current) => current.filter((item) => item.id !== line.id))}><Trash2 size={15} /></IconButton> : null}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </ResponsiveTable>
              ) : <div className={`${ui.inlineNotice} ${ui.noticeInset}`}><CalendarPlus size={16} />No expected payments for this month. Add one in Planned Payments; hypothetical adjustments are available in scenario mode. <Button variant="secondary" onClick={() => router.push("/planned?new=1")}>Add expected payment</Button></div>}
        </Section>

        <div className={ui.equalColumns}>
          <Section title="Expected opening balances" description={openingsDirty ? "Edit each account in its native currency · save to refresh reporting totals" : "Each assumption stays in its account's native currency"}>
              <ResponsiveTable label="Expected opening balances">
                <thead><tr><th>Account</th><th>Actual now</th><th>Expected opening (native)</th><th>Difference</th></tr></thead>
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
                          <span className={ui.tablePrimary}>{stringFrom(account.name, "Account")}</span>
                          <span className={ui.tableSecondary}>{stringFrom(account.type).replaceAll("_", " ")} · {nativeCurrency}</span>
                        </td>
                        <td className={ui.amount}>{formatMoney(actualBalance, nativeCurrency)}</td>
                        <td><Input className={ui.planTableInput} aria-label={`Expected opening for ${stringFrom(account.name)} in ${nativeCurrency}`} aria-invalid={expected === null} inputMode="decimal" value={entry?.amount ?? ""} onChange={(event) => setOpenings((current) => current.map((opening) => opening.accountId === id ? { ...opening, amount: event.target.value } : opening))} /></td>
                        <td className={`${ui.amount} ${difference === null ? "" : amountDifferenceTone(difference)}`}>{difference === null ? "—" : formatMoney(difference, nativeCurrency)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </ResponsiveTable>
          </Section>

          <Section title="Discretionary money" description="After essential expected commitments">
              <div className={ui.summaryList}>
                <div className={ui.summaryRow}><span>Opening cash</span><strong>{formatMoney(openingTotal, currency)}</strong></div>
                <div className={ui.summaryRow}><span>Cleared actual movement</span><strong className={amountDifferenceTone(actualCashActivityTotal)}>{formatMoney(actualCashActivityTotal, currency)}</strong></div>
                <div className={ui.summaryRow}><span>Outstanding income</span><strong className={ui.positive}>+{formatMoney(outstandingIncomeTotal, currency)}</strong></div>
                <div className={ui.summaryRow}><span>Outstanding essentials</span><strong className={ui.negative}>−{formatMoney(essentialOutstanding, currency)}</strong></div>
                <div className={ui.summaryRow}><span>Outstanding discretionary</span><strong className={ui.warning}>−{formatMoney(discretionarySpent, currency)}</strong></div>
                <div className={ui.summaryRow}><span>Remaining</span><strong className={discretionaryAvailable >= 0 ? ui.positive : ui.negative}>{formatMoney(discretionaryAvailable, currency)}</strong></div>
              </div>
          </Section>
        </div>

        <div className={ui.equalColumns}>
          <Section title="Forecast by account" description={scenarioActive ? "Canonical closings in native currencies · scenario effects remain in the overall reporting forecast" : "Projected closing balances in each account's native currency"}>
              <div className={ui.summaryList}>
                {accounts.map((item, index) => {
                  const account = readRecord(item);
                  const nativeCurrency = accountCurrency(account, currency);
                  const nativeClosing = numberFrom(account.forecastClosingMinor);
                  const reportingClosing = numberFrom(account.reportingForecastClosingMinor);
                  return (
                    <div className={ui.summaryRow} key={stringFrom(account.id, String(index))}>
                      <span>{stringFrom(account.name, "Account")}<small>{nativeCurrency} ledger</small></span>
                      <strong className={nativeClosing < 0 ? ui.negative : ""}>
                        {formatMoney(nativeClosing, nativeCurrency)}
                        {nativeCurrency !== currency ? <small>≈ {formatMoney(reportingClosing, currency)} reporting</small> : null}
                      </strong>
                    </div>
                  );
                })}
                {!accounts.length ? <div className={ui.summaryRow}><span>Add accounts to allocate forecast cash.</span></div> : null}
              </div>
          </Section>

          <Section title="Planned versus actual" description="Planned values come from expected payments; historical actuals never include unpaid obligations">
              <div className={ui.summaryList}>
                <div className={ui.summaryRow}><span>Income</span><strong>{formatMoney(incomeTotal, currency)} planned<br /><small>{formatMoney(actualIncome, currency)} actual</small></strong></div>
                <div className={ui.summaryRow}><span>Spending</span><strong>{formatMoney(expenseTotal, currency)} planned<br /><small>{formatMoney(actualExpense, currency)} actual</small></strong></div>
                <div className={ui.summaryRow}><span>Cash obligations</span><strong>{formatMoney(outstandingExpenseTotal, currency)} outstanding<br /><small>principal and card transfers included</small></strong></div>
                <div className={ui.summaryRow}><span>Month progress</span><Progress value={todayDay} max={daysInMonth} label={`${todayDay} / ${daysInMonth} days`} /></div>
                <div className={ui.summaryRow}><span>Spending variance</span><strong className={actualExpense > expenseTotal ? ui.negative : ui.positive}>{formatMoney(expenseTotal - actualExpense, currency)}<br /><small>{actualExpense > expenseTotal ? "over expected" : "remaining expected"}</small></strong></div>
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
    if (!name.trim()) { setFormError("Enter an item name."); return; }
    if (amountMinor === null || amountMinor <= 0) { setFormError("Enter an amount greater than zero."); return; }
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
    <Modal open={open} onClose={onClose} title="Add scenario adjustment" description="This hypothetical change affects the forecast only; it never creates a Planned Payment or actual transaction." footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={add}>Add adjustment</Button></>}>
      <div className={ui.formGrid}>
        <Field label="Item name" className={ui.formSpan}><Input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder={direction === "income" ? "Expected salary" : "Expected expense"} /></Field>
        <Field label="Direction"><Select value={direction} onValueChange={(value) => setDirection(value as "income" | "expense")}><option value="expense">Expense</option><option value="income">Income</option></Select></Field>
        <Field label={`Amount (${currency} reporting)`}><Input inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} /></Field>
        <Field label="Expected date"><Input type="date" min={`${month}-01`} max={lastDayOfMonth(month)} value={date} onChange={(event) => setDate(event.target.value)} /></Field>
        <Field label="Account" hint="Optional allocation; the scenario amount remains in reporting currency."><Select value={accountId} onValueChange={(value) => setAccountId(value)}><option value="">Unassigned</option>{accounts.map((item, index) => { const account = readRecord(item); return <option value={String(account.id)} key={stringFrom(account.id, String(index))}>{stringFrom(account.name, "Account")}</option>; })}</Select></Field>
        {direction === "expense" ? <><Field label="Spending type"><Select value={spendingType} onValueChange={(value) => setSpendingType(value as "fixed" | "variable")}><option value="fixed">Fixed</option><option value="variable">Variable</option></Select></Field><Field label="Category"><Select value={categoryId} onValueChange={(value) => setCategoryId(value)}><option value="">Uncategorised</option>{categories.map((item, index) => { const category = readRecord(item); return <option value={String(category.id)} key={stringFrom(category.id, String(index))}>{stringFrom(category.name, "Category")}</option>; })}</Select></Field><label className={`${ui.inlineNotice} ${ui.formSpan}`}><input type="checkbox" checked={essential} onChange={(event) => setEssential(event.target.checked)} />Treat this as essential spending when calculating discretionary money.</label></> : null}
      </div>
      <FormMessage error={formError} />
    </Modal>
  );
}
