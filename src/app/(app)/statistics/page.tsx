"use client";

import {
  AlertTriangle,
  ArrowUp,
  Lightbulb,
  ShieldAlert,
  TrendingUp,
} from "lucide-react";
import { useState } from "react";
import { useDateRange } from "@/components/date-range-context";
import { DEFAULT_CURRENCY } from "@/lib/currencies";
import {
  DataState,
  formatDate,
  formatMoney,
  InfoButton,
  Metric,
  numberFrom,
  Page,
  Pill,
  Progress,
  readList,
  readRecord,
  ResponsiveTable,
  Section,
  SparkBars,
  stringFrom,
  Tabs,
  useJson,
  ViewHeader,
  workspaceLocale,
  workspaceTimeZone,
} from "../_components/feature-kit";
import ui from "../_components/pages.module.css";
import styles from "./statistics.module.css";

type Row = Record<string, unknown>;
type StatTab = "overview" | "spending" | "trends" | "forecast" | "debt" | "patterns";

const calculations = {
  income: "Sum of cleared actual income transactions in the selected range. Refunds reduce spending; transfers, adjustments and planned income are excluded.",
  expenses: "Cleared actual expenses less refunds across the whole selected range, floored at zero. Transfers, adjustments and unpaid plans are excluded.",
  cashFlow: "Actual income minus actual spending after refunds. Transfers and balance adjustments do not contribute.",
  savingsRate: "(Actual income − actual spending after refunds) ÷ actual income × 100. Shown as zero when income is zero.",
  rolling: "Arithmetic mean of the latest displayed calendar-month buckets. A partial boundary bucket is not a full-month observation.",
  runway: "Current liquid cash divided by average actual daily spending over observed days in the selected range. Future days are excluded. It is an estimate, not a guarantee.",
  daily: "Actual spending divided by observed selected days through the earlier of the range end and today. Future-only ranges are unavailable.",
  projected: "Current-month actual daily spending through today multiplied by that month's calendar days. Available only when the selected range includes today; this is an estimate.",
  accuracy: "100 minus mean absolute percentage error across completed, fully selected calendar months with planned spending, floored at zero.",
  concentration: "Share of actual spending represented by the three largest spending categories. Higher values mean spending is more concentrated.",
  consistency: "A normalized score based on variation in monthly actual spending. Higher means spending changed less month to month.",
  mom: "Percentage change from the immediately preceding equal-length date range, using actual values only.",
  yoy: "Percentage change from the same selected date range one calendar year earlier, using actual values only.",
  plannedActual: "Compares expected plan amounts with linked and independent actual expenses in the selected date range.",
  recurring: "Sum of active recurring expense rules normalized to an estimated monthly amount.",
  fixedVariable: "Fixed and variable labels assigned to categories or monthly plan items; actual transaction amounts are grouped by those labels.",
  essential: "Actual spending grouped by categories marked essential or discretionary.",
};

function percentage(value: unknown) {
  const numeric = optionalNumber(value);
  return numeric === null ? "—" : `${numeric.toLocaleString(workspaceLocale(), { maximumFractionDigits: 1 })}%`;
}

function optionalNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function displayLabel(row: Row, fallback = "Other") {
  return stringFrom(row.label ?? row.name ?? row.title ?? row.categoryName ?? row.category ?? row.merchantName ?? row.merchant ?? row.accountName ?? row.account ?? row.tagName ?? row.tag ?? row.period ?? row.month, fallback);
}

function valueMinor(row: Row) {
  return numberFrom(row.amountMinor ?? row.valueMinor ?? row.spendingMinor ?? row.expenseMinor ?? row.totalMinor);
}

function monthBucketLabel(row: Row, fallback = "Month") {
  const label = displayLabel(row, fallback);
  return row.partial === true ? `${label} (partial)` : label;
}

function aggregateBreakdown(rows: Row[], key: "nature" | "priority") {
  const totals = new Map<string, number>();
  rows.forEach((item) => {
    const row = readRecord(item);
    const label = stringFrom(row[key], key === "nature" ? "variable" : "discretionary");
    totals.set(label, (totals.get(label) ?? 0) + valueMinor(row));
  });
  return Array.from(totals, ([name, amountMinor]) => ({ name, amountMinor }));
}

export default function StatisticsPage() {
  const [tab, setTab] = useState<StatTab>("overview");
  const { range } = useDateRange();
  const { data: raw, loading, error, reload } = useJson<Record<string, unknown>>(`/api/statistics?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`, {});
  const payload = readRecord(readRecord(raw).data ?? raw);
  const baseSummary = readRecord(payload.summary ?? payload.metrics);
  const summary: Row = {
    ...payload,
    ...baseSummary,
    cashRunwayDays: baseSummary.cashRunwayDays !== undefined
      ? baseSummary.cashRunwayDays
      : payload.cashRunwayMonths === null || payload.cashRunwayMonths === undefined
        ? null
        : numberFrom(payload.cashRunwayMonths) * 30.4375,
    projectedMonthEndSpendingMinor: baseSummary.projectedMonthEndSpendingMinor !== undefined
      ? baseSummary.projectedMonthEndSpendingMinor
      : payload.projectedMonthEndMinor,
    categoryConcentration: baseSummary.categoryConcentration ?? payload.categoryConcentrationPercent,
    spendingConsistency: baseSummary.spendingConsistency ?? payload.spendingConsistencyPercent,
    recurringMonthlyMinor: baseSummary.recurringMonthlyMinor ?? payload.recurringCommitmentMinor,
  };
  const breakdowns = readRecord(payload.breakdowns);
  const comparisons = readRecord(payload.comparisons);
  const recurringBase = readRecord(payload.recurring);
  const recurring: Row = { ...recurringBase, monthlyTotalMinor: recurringBase.monthlyTotalMinor ?? payload.recurringCommitmentMinor };
  const debt = readRecord(payload.debt);
  const explanations = readRecord(payload.explanations);
  const monthly = readList<Row>(payload, "monthly", "timeline", "series");
  const categoriesNested = readList<Row>(breakdowns, "categories", "category");
  const categories = categoriesNested.length ? categoriesNested : readList<Row>(payload, "byCategory");
  const merchantsNested = readList<Row>(breakdowns, "merchants", "merchant");
  const merchants = merchantsNested.length ? merchantsNested : readList<Row>(payload, "byMerchant");
  const accountsNested = readList<Row>(breakdowns, "accounts", "account");
  const accounts = accountsNested.length ? accountsNested : readList<Row>(payload, "byAccount");
  const tagsNested = readList<Row>(breakdowns, "tags", "tag");
  const tags = tagsNested.length ? tagsNested : readList<Row>(payload, "byTag");
  const weekdaysNested = readList<Row>(breakdowns, "weekdays", "weekday");
  const weekdays = weekdaysNested.length ? weekdaysNested : readList<Row>(payload, "byWeekday");
  const weeksNested = readList<Row>(breakdowns, "weeks", "week");
  const weeks = weeksNested.length ? weeksNested : readList<Row>(payload, "byWeek");
  const classifications = readList<Row>(payload, "classifications");
  const fixedVariableNested = readList<Row>(breakdowns, "fixedVariable", "variability");
  const fixedVariable = fixedVariableNested.length ? fixedVariableNested : aggregateBreakdown(classifications, "nature");
  const essentialNested = readList<Row>(breakdowns, "essentialDiscretionary", "priority");
  const essential = essentialNested.length ? essentialNested : aggregateBreakdown(classifications, "priority");
  const largestExpenses = readList<Row>(payload, "largestExpenses");
  const categoryIncreases = readList<Row>(payload, "categoryIncreases", "biggestIncreases");
  const balanceHistory = readList<Row>(payload, "balanceHistory", "netWorthHistory");
  const subscriptions = readList<Row>(recurring, "subscriptions", "commitments");
  const insights = readList<Row>(payload, "insights", "suggestions", "patterns");

  const income = numberFrom(summary.incomeMinor);
  const expenses = numberFrom(summary.expensesMinor ?? summary.spendingMinor);
  const cashFlow = numberFrom(summary.netCashFlowMinor, income - expenses);
  const savingsRate = numberFrom(summary.savingsRate, income ? ((income - expenses) / income) * 100 : 0);
  const monthlyValues = monthly.map((row) => numberFrom(readRecord(row).netCashFlowMinor ?? readRecord(row).netMinor));

  return (
    <Page>
      <ViewHeader
        eyebrow="Actual data analysis"
        title="Statistics"
        description="Understand spending, commitments, trends and forecast quality. Suggestions are transparent observations for review, never guaranteed financial advice."
      />

      <Tabs id="statistics" panelId="statistics-panel" label="Statistics section" value={tab} onChange={setTab} items={[
        { value: "overview", label: "Overview" },
        { value: "spending", label: "Spending detail" },
        { value: "trends", label: "Trends & comparisons" },
        { value: "forecast", label: "Forecast & runway" },
        { value: "debt", label: "Debt" },
        { value: "patterns", label: "Patterns to review" },
      ]} />

      <DataState loading={loading} error={error} onRetry={reload}>
        <div id="statistics-panel" role="tabpanel" aria-labelledby={`statistics-${tab}-tab`} className={styles.tabContent}>
          {tab === "overview" ? <Overview summary={summary} monthly={monthly} categories={categories} income={income} expenses={expenses} cashFlow={cashFlow} savingsRate={savingsRate} monthlyValues={monthlyValues} recurring={recurring} /> : null}
          {tab === "spending" ? <SpendingDetail categories={categories} merchants={merchants} accounts={accounts} tags={tags} weekdays={weekdays} weeks={weeks} fixedVariable={fixedVariable} essential={essential} largestExpenses={largestExpenses} /> : null}
          {tab === "trends" ? <Trends monthly={monthly} comparisons={comparisons} categoryIncreases={categoryIncreases} balanceHistory={balanceHistory} summary={summary} /> : null}
          {tab === "forecast" ? <Forecast summary={summary} monthly={monthly} recurring={recurring} subscriptions={subscriptions} /> : null}
          {tab === "debt" ? <Debt debt={debt} explanations={explanations} /> : null}
          {tab === "patterns" ? <Patterns insights={insights} summary={summary} categories={categories} categoryIncreases={categoryIncreases} /> : null}
        </div>
      </DataState>
    </Page>
  );
}

function Overview({ summary, monthly, categories, income, expenses, cashFlow, savingsRate, monthlyValues, recurring }: { summary: Row; monthly: Row[]; categories: Row[]; income: number; expenses: number; cashFlow: number; savingsRate: number; monthlyValues: number[]; recurring: Row }) {
  return (
    <>
      <div className={ui.metricGrid}>
        <Metric label="Actual income" value={formatMoney(income)} tone="positive" info={calculations.income} />
        <Metric label="Actual expenses" value={formatMoney(expenses)} tone="negative" info={calculations.expenses} />
        <Metric label="Net cash flow" value={formatMoney(cashFlow)} tone={cashFlow >= 0 ? "positive" : "negative"} info={calculations.cashFlow} />
        <Metric label="Savings rate" value={percentage(savingsRate)} tone={savingsRate >= 20 ? "positive" : savingsRate < 0 ? "negative" : "default"} info={calculations.savingsRate} />
      </div>
      <div className={ui.twoColumn}>
        <Section title="Income, spending and cash flow" description="Calendar-month buckets within the selected range · boundary buckets may be partial" action={<InfoButton text={`Each bucket contains only selected dates in that ${workspaceTimeZone()} calendar month. Income minus spending after refunds forms net cash flow; transfers and adjustments are excluded.`} />}>
          <GroupedMonthlyChart rows={monthly} />
        </Section>
        <Section title="Spending by category" description="Share of actual expenses" action={<InfoButton text="Each actual split amount contributes to its assigned category; unsplit transactions use their primary category." />}>
          <BreakdownDonut rows={categories} />
        </Section>
      </div>
      <div className={ui.equalColumns}>
        <Section title="Net cash-flow direction" description="Calendar-month buckets; boundary buckets may be partial" action={<InfoButton text={calculations.cashFlow} />}>
          <div className={ui.chartArea}><SparkBars values={monthlyValues.length ? monthlyValues : [0]} labels={monthly.length ? monthly.map((item) => monthBucketLabel(readRecord(item))) : ["No data"]} tone="mixed" height={150} /></div>
        </Section>
        <Section title="Commitment snapshot" description="Active recurring expenses" action={<InfoButton text={calculations.recurring} />}>
          <div className={ui.summaryList}>
            <div className={ui.summaryRow}><span>Estimated monthly recurring</span><strong>{formatMoney(recurring.monthlyTotalMinor ?? summary.recurringMonthlyMinor)}</strong></div>
            <div className={ui.summaryRow}><span>Subscriptions</span><strong>{formatMoney(recurring.subscriptionTotalMinor)} <small>{numberFrom(recurring.subscriptionCount)} active</small></strong></div>
            <div className={ui.summaryRow}><span>Share of monthly spending</span><strong>{percentage(recurring.spendingShare)}</strong></div>
            <div className={ui.summaryRow}><span>Next 30 days</span><strong>{formatMoney(recurring.next30DaysMinor)} <small>projected</small></strong></div>
          </div>
        </Section>
      </div>
    </>
  );
}

function GroupedMonthlyChart({ rows }: { rows: Row[] }) {
  const values = rows.flatMap((item) => {
    const row = readRecord(item); return [numberFrom(row.incomeMinor), numberFrom(row.expenseMinor ?? row.spendingMinor)];
  });
  const max = Math.max(...values, 1);
  if (!rows.length) return <div className={styles.chartEmpty}>No actual monthly history yet.</div>;
  return (
    <div className={styles.groupedChart} aria-label="Monthly income and spending bar chart">
      {rows.map((item, index) => {
        const row = readRecord(item); const income = numberFrom(row.incomeMinor); const expense = numberFrom(row.expenseMinor ?? row.spendingMinor);
        return <div className={styles.group} key={stringFrom(row.month ?? row.period, String(index))}><div className={styles.barTrack}><span className={styles.incomeBar} style={{ height: `${Math.max(2, income / max * 100)}%` }} title={`Income: ${formatMoney(income)}`} /><span className={styles.expenseBar} style={{ height: `${Math.max(2, expense / max * 100)}%` }} title={`Spending: ${formatMoney(expense)}`} /></div><small title={monthBucketLabel(row, stringFrom(row.month, ""))}>{monthBucketLabel(row, stringFrom(row.month, ""))}</small></div>;
      })}
      <div className={styles.chartLegend}><span><i className={styles.incomeKey} />Income</span><span><i className={styles.expenseKey} />Spending</span></div>
    </div>
  );
}

function BreakdownDonut({ rows }: { rows: Row[] }) {
  const sorted = [...rows].sort((a, b) => valueMinor(readRecord(b)) - valueMinor(readRecord(a)));
  const total = sorted.reduce((sum, item) => sum + valueMinor(readRecord(item)), 0);
  const top = sorted.slice(0, 5);
  const percent = total ? valueMinor(readRecord(top[0])) / total * 100 : 0;
  return (
    <div className={ui.donutWrap}>
      <div className={ui.donut} style={{ "--percent": percent, "--donut-color": stringFrom(readRecord(top[0]).color, "#2563eb") } as React.CSSProperties} aria-label={`Largest category is ${percentage(percent)}`} />
      <div className={ui.donutLegend}>
        {top.length ? top.map((item, index) => { const row = readRecord(item); return <div key={stringFrom(row.id, String(index))}><span><i className={ui.categoryDot} style={{ "--category-color": stringFrom(row.color, "#2563eb") } as React.CSSProperties} />{displayLabel(row)}</span><strong>{formatMoney(valueMinor(row))}<small>{percentage(total ? valueMinor(row) / total * 100 : 0)}</small></strong></div>; }) : <div><span>No categorized expenses yet.</span></div>}
      </div>
    </div>
  );
}

function SpendingDetail({ categories, merchants, accounts, tags, weekdays, weeks, fixedVariable, essential, largestExpenses }: { categories: Row[]; merchants: Row[]; accounts: Row[]; tags: Row[]; weekdays: Row[]; weeks: Row[]; fixedVariable: Row[]; essential: Row[]; largestExpenses: Row[] }) {
  return (
    <>
      <div className={ui.equalColumns}>
        <BreakdownSection title="Categories" rows={categories} explanation="Actual split or transaction expense amounts grouped by category and subcategory." />
        <BreakdownSection title="Merchants" rows={merchants} explanation="Actual expense amounts grouped by normalized merchant name." />
        <BreakdownSection title="Accounts" rows={accounts} explanation="Actual expenses grouped by source account; internal transfer rows are excluded." />
        <BreakdownSection title="Tags" rows={tags} explanation="Actual expense amounts grouped by tag. A transaction with several tags contributes to each selected tag, so tag totals can overlap." />
      </div>
      <div className={ui.equalColumns}>
        <Section title="Spending by weekday" description="Total actual expenses by local weekday" action={<InfoButton text={`Selected-range expense totals are grouped by the ${workspaceTimeZone()} weekday recorded on each transaction.`} />}><div className={ui.chartArea}><SparkBars values={weekdays.length ? weekdays.map((item) => valueMinor(readRecord(item))) : [0]} labels={weekdays.length ? weekdays.map((item) => displayLabel(readRecord(item))) : ["No data"]} tone="negative" height={150} /></div></Section>
        <Section title="Spending by week" description="Actual totals by Monday-based calendar week" action={<InfoButton text="Selected-range actual expenses are grouped into Monday-based calendar weeks. Boundary weeks may be partial." />}><div className={ui.chartArea}><SparkBars values={weeks.length ? weeks.map((item) => valueMinor(readRecord(item))) : [0]} labels={weeks.length ? weeks.map((item) => displayLabel(readRecord(item))) : ["No data"]} tone="negative" height={150} /></div></Section>
      </div>
      <div className={ui.equalColumns}>
        <Section title="Fixed versus variable" description="Actual spending classification" action={<InfoButton text={calculations.fixedVariable} />}><BreakdownDonut rows={fixedVariable} /></Section>
        <Section title="Essential versus discretionary" description="Actual spending classification" action={<InfoButton text={calculations.essential} />}><BreakdownDonut rows={essential} /></Section>
      </div>
      <Section title="Largest actual expenses" description="Single posted expenses in the selected period" action={<InfoButton text="Actual expense transactions ranked by absolute signed amount; transfer pairs and planned-only occurrences are excluded." />}>
        <ResponsiveTable label="Largest expenses"><thead><tr><th>Date</th><th>Merchant</th><th>Category</th><th>Account</th><th>Amount</th></tr></thead><tbody>{largestExpenses.slice(0, 20).map((item, index) => { const row = readRecord(item); return <tr key={stringFrom(row.id, String(index))}><td>{formatDate(row.date)}</td><td><span className={ui.tablePrimary}>{displayLabel(row, "Expense")}</span><span className={ui.tableSecondary}>{stringFrom(row.notes)}</span></td><td>{stringFrom(row.categoryName, "Uncategorised")}</td><td>{stringFrom(row.accountName, "Account")}</td><td className={`${ui.amount} ${ui.negative}`}>−{formatMoney(Math.abs(numberFrom(row.amountMinor)))}</td></tr>; })}</tbody></ResponsiveTable>
      </Section>
    </>
  );
}

function BreakdownSection({ title, rows, explanation }: { title: string; rows: Row[]; explanation: string }) {
  const total = rows.reduce((sum, item) => sum + valueMinor(readRecord(item)), 0);
  const sorted = [...rows].sort((a, b) => valueMinor(readRecord(b)) - valueMinor(readRecord(a))).slice(0, 10);
  return (
    <Section title={`Spending by ${title.toLocaleLowerCase(workspaceLocale())}`} action={<InfoButton text={explanation} />}>
      <div className={styles.rankingList}>
        {sorted.length ? sorted.map((item, index) => { const row = readRecord(item); const value = valueMinor(row); return <div className={styles.rankingRow} key={stringFrom(row.id, String(index))}><span className={styles.rank}>{index + 1}</span><span><strong>{displayLabel(row)}</strong><Progress value={value} max={total || 1} /></span><span><strong>{formatMoney(value)}</strong><small>{percentage(total ? value / total * 100 : 0)}</small></span></div>; }) : <div className={styles.chartEmpty}>No {title.toLowerCase()} data available.</div>}
      </div>
    </Section>
  );
}

function Trends({ monthly, comparisons, categoryIncreases, balanceHistory, summary }: { monthly: Row[]; comparisons: Row; categoryIncreases: Row[]; balanceHistory: Row[]; summary: Row }) {
  const mom = readRecord(comparisons.monthOverMonth ?? comparisons.mom);
  const yoy = readRecord(comparisons.yearOverYear ?? comparisons.yoy);
  const history = balanceHistory.length ? balanceHistory : monthly;
  const spendingChange = optionalNumber(mom.expenseChangePercent ?? mom.spendingPercent);
  const incomeChange = optionalNumber(mom.incomeChangePercent ?? mom.incomePercent);
  const yearlySpendingChange = optionalNumber(yoy.expenseChangePercent ?? yoy.spendingPercent);
  return (
    <>
      <div className={ui.metricGrid}>
        <Metric label="Spending change" value={percentage(spendingChange)} detail={`${formatMoney(mom.expenseChangeMinor)} vs previous range`} tone={spendingChange === null ? "default" : spendingChange > 0 ? "negative" : "positive"} info={calculations.mom} />
        <Metric label="Income change" value={percentage(incomeChange)} detail={`${formatMoney(mom.incomeChangeMinor)} vs previous range`} tone={incomeChange === null ? "default" : incomeChange >= 0 ? "positive" : "negative"} info={calculations.mom} />
        <Metric label="Year-over-year spending" value={percentage(yearlySpendingChange)} detail={formatMoney(yoy.expenseChangeMinor)} tone={yearlySpendingChange === null ? "default" : yearlySpendingChange > 0 ? "warning" : "positive"} info={calculations.yoy} />
        <Metric label="Rolling spend average" value={formatMoney(summary.rollingAverageMinor)} detail="Trailing monthly mean" info={calculations.rolling} />
      </div>
      <div className={ui.equalColumns}>
        <Section title="Monthly trend" description="Selected-date spending in calendar-month buckets; boundary buckets may be partial" action={<InfoButton text="Each bucket contains only dates in the selected range. The trailing mean uses the displayed buckets, so partial boundary months are not full-month observations." />}><GroupedMonthlyChart rows={monthly} /></Section>
        <Section title="Net worth history" description="Recorded account balances at each snapshot" action={<InfoButton text="Balances are reconstructed from account openings and cleared transactions through each snapshot. Archived accounts remain in snapshots before their archive date; unpaid plans and unrecorded future activity are excluded." />}><div className={ui.chartArea}><SparkBars values={history.length ? history.map((item) => numberFrom(readRecord(item).netWorthMinor ?? readRecord(item).balanceMinor)) : [0]} labels={history.length ? history.map((item) => displayLabel(readRecord(item))) : ["No data"]} tone="mixed" height={180} /></div></Section>
      </div>
      <Section title="Categories with the biggest increases" description="Selected range versus the previous equal-length range" action={<InfoButton text="Categories ranked by positive change in actual spending versus the immediately preceding equal-length date range." />}>
        <ResponsiveTable label="Category increases"><thead><tr><th>Category</th><th>Previous</th><th>Current</th><th>Change</th><th>Change %</th></tr></thead><tbody>{categoryIncreases.length ? categoryIncreases.map((item, index) => { const row = readRecord(item); const change = numberFrom(row.changeMinor, numberFrom(row.currentMinor) - numberFrom(row.previousMinor)); const changePercent = optionalNumber(row.changePercent); return <tr key={stringFrom(row.id, String(index))}><td>{displayLabel(row, "Category")}</td><td className={ui.amount}>{formatMoney(row.previousMinor)}</td><td className={ui.amount}>{formatMoney(row.currentMinor)}</td><td className={`${ui.amount} ${ui.negative}`}>+{formatMoney(change)}</td><td><Pill tone="warning">{changePercent === null ? "New" : percentage(changePercent)}</Pill></td></tr>; }) : <tr><td colSpan={5}>No category increased versus the previous equal-length range.</td></tr>}</tbody></ResponsiveTable>
      </Section>
    </>
  );
}

function Forecast({ summary, monthly, recurring, subscriptions }: { summary: Row; monthly: Row[]; recurring: Row; subscriptions: Row[] }) {
  const plannedValues = monthly.map((item) => numberFrom(readRecord(item).plannedMinor));
  const actualValues = monthly.map((item) => numberFrom(readRecord(item).actualMinor ?? readRecord(item).expenseMinor));
  const runwayDays = optionalNumber(summary.cashRunwayDays);
  const averageDailySpending = optionalNumber(summary.averageDailySpendingMinor);
  const projectionApplicable = summary.projectionApplicable === true;
  const projectedMonthEnd = projectionApplicable ? optionalNumber(summary.projectedMonthEndSpendingMinor) : null;
  const forecastAccuracy = optionalNumber(summary.forecastAccuracy);
  return (
    <>
      <div className={ui.metricGrid}>
        <Metric label="Cash runway" value={runwayDays === null ? "—" : `${runwayDays.toLocaleString(workspaceLocale(), { maximumFractionDigits: 0 })} days`} detail="Current cash ÷ selected-range daily spend" tone={runwayDays === null ? "default" : runwayDays < 30 ? "warning" : "accent"} info={calculations.runway} />
        <Metric label="Average daily spending" value={averageDailySpending === null ? "—" : formatMoney(averageDailySpending)} detail="Observed selected days only" info={calculations.daily} />
        <Metric label="Projected month end" value={projectedMonthEnd === null ? "—" : formatMoney(projectedMonthEnd)} tone={projectedMonthEnd === null ? "default" : "warning"} detail={projectionApplicable ? "Current-month estimate" : "Range must include today"} info={calculations.projected} />
        <Metric label="Forecast accuracy" value={percentage(forecastAccuracy)} tone={forecastAccuracy === null ? "default" : "accent"} detail={forecastAccuracy === null ? "No completed planned months" : "Completed planned months only"} info={calculations.accuracy} />
      </div>
      <div className={ui.equalColumns}>
        <Section title="Planned versus actual spending" description="Calendar-month buckets; boundary buckets may be partial" action={<InfoButton text={calculations.plannedActual} />}>
          <div className={styles.comparisonChart}>
            <div><strong>Planned</strong><SparkBars values={plannedValues.length ? plannedValues : [0]} labels={monthly.length ? monthly.map((item) => monthBucketLabel(readRecord(item))) : ["No data"]} tone="accent" height={140} /></div>
            <div><strong>Actual</strong><SparkBars values={actualValues.length ? actualValues : [0]} labels={monthly.length ? monthly.map((item) => monthBucketLabel(readRecord(item))) : ["No data"]} tone="negative" height={140} /></div>
          </div>
        </Section>
        <Section title="Forecast quality" description="Transparent error measures" action={<InfoButton text={calculations.accuracy} />}>
          <div className={ui.summaryList}>
            <div className={ui.summaryRow}><span>Mean absolute error</span><strong>{numberFrom(summary.forecastSampleMonths) ? formatMoney(summary.forecastMeanAbsoluteErrorMinor) : "—"}</strong></div>
            <div className={ui.summaryRow}><span>Average percentage error</span><strong>{numberFrom(summary.forecastSampleMonths) ? percentage(summary.forecastMape) : "—"}</strong></div>
            <div className={ui.summaryRow}><span>Completed months measured</span><strong>{numberFrom(summary.forecastSampleMonths)}</strong></div>
            <div className={ui.summaryRow}><span>Typical bias</span><strong>{stringFrom(summary.forecastBias, "Not enough data")}</strong></div>
          </div>
        </Section>
      </div>
      <Section title="Recurring commitments and subscriptions" description={`${formatMoney(recurring.monthlyTotalMinor)} estimated per month`} action={<InfoButton text={calculations.recurring} />}>
        <ResponsiveTable label="Recurring commitments"><thead><tr><th>Commitment</th><th>Frequency</th><th>Next due</th><th>Monthly equivalent</th><th>Annual equivalent</th></tr></thead><tbody>{subscriptions.map((item, index) => { const row = readRecord(item); const monthlyAmount = numberFrom(row.monthlyAmountMinor ?? row.amountMinor); return <tr key={stringFrom(row.id, String(index))}><td><span className={ui.tablePrimary}>{displayLabel(row, "Commitment")}</span><span className={ui.tableSecondary}>{stringFrom(row.categoryName)}</span></td><td>{stringFrom(row.frequency, "monthly")}</td><td>{formatDate(row.nextDueDate)}</td><td className={ui.amount}>{formatMoney(monthlyAmount)}</td><td className={ui.amount}>{formatMoney(row.annualAmountMinor ?? monthlyAmount * 12)}</td></tr>; })}</tbody></ResponsiveTable>
      </Section>
    </>
  );
}

function Debt({ debt, explanations }: { debt: Row; explanations: Row }) {
  const accounts = readList<Row>(debt, "accounts");
  const monthly = readList<Row>(debt, "monthly");
  const utilization = optionalNumber(debt.creditUtilizationPercent);
  const serviceToIncome = optionalNumber(debt.debtServiceToIncomePercent);
  const cashValues = monthly.map((item) => numberFrom(readRecord(item).cashPaidMinor));
  const principalValues = monthly.map((item) => numberFrom(readRecord(item).principalPaidMinor));
  const interestValues = monthly.map((item) => numberFrom(readRecord(item).interestFeesMinor));
  const labels = monthly.map((item) => displayLabel(readRecord(item)));
  const debtServiceExplanation = stringFrom(explanations.debtService, "Actual cash paid to credit cards and loans in the selected range. Loan principal and card payments are transfers; only loan interest and fees count as spending.");
  const utilizationExplanation = stringFrom(explanations.creditUtilization, "Posted credit-card debt divided by configured credit limits. Credit limits are borrowing capacity, never assets or income.");

  return (
    <>
      <div className={ui.metricGrid}>
        <Metric label="Total liabilities" value={formatMoney(debt.totalLiabilitiesMinor)} tone={numberFrom(debt.totalLiabilitiesMinor) ? "warning" : "default"} info="Posted outstanding balances across active credit-card and loan accounts. A positive card overpayment is not counted as debt." />
        <Metric label="Card utilization" value={percentage(utilization)} detail={`${formatMoney(debt.creditCardOutstandingMinor)} of ${formatMoney(debt.creditLimitMinor)}`} tone={utilization === null ? "default" : utilization > 80 ? "warning" : "accent"} info={utilizationExplanation} />
        <Metric label="Debt cash paid" value={formatMoney(debt.debtServiceMinor)} tone="accent" info={debtServiceExplanation} />
        <Metric label="Loan principal repaid" value={formatMoney(debt.principalRepaidMinor)} info="Principal portions recorded on actual loan payments in the selected range. Principal reduces the liability and is not counted as spending." />
        <Metric label="Interest and fees" value={formatMoney(debt.interestFeesMinor)} tone={numberFrom(debt.interestFeesMinor) ? "negative" : "default"} info="Interest and fee portions recorded on actual loan payments. Unlike principal, these portions count as spending." />
        <Metric label="Debt service / income" value={percentage(serviceToIncome)} detail="Selected range" tone={serviceToIncome === null ? "default" : serviceToIncome > 40 ? "warning" : "default"} info={stringFrom(explanations.debtServiceToIncome, "Actual card and loan cash payments divided by actual income in the selected range. This is an informational ratio, not underwriting advice.")} />
      </div>

      <div className={`${ui.inlineNotice} ${ui.noticeInset}`}>
        <ShieldAlert size={17} />
        <span><strong>Cash paid is not the same as spending.</strong> Credit-card payments and loan principal move money from an asset account to reduce debt. Only loan interest and fees add new spending; the original card purchases were counted when posted.</span>
      </div>

      <div className={ui.equalColumns}>
        <Section title="Debt service over time" description="Actual cash paid by calendar month" action={<InfoButton text={debtServiceExplanation} />}>
          <div className={ui.chartArea}><SparkBars values={cashValues.length ? cashValues : [0]} labels={labels.length ? labels : ["No data"]} tone="accent" height={160} /></div>
        </Section>
        <Section title="Payment composition" description="Principal versus interest and fees" action={<InfoButton text="Principal includes recorded loan principal and credit-card payments. Interest and fees include only the expense portions of recorded loan payments." />}>
          <div className={styles.comparisonChart}>
            <div><strong>Principal and card payments</strong><SparkBars values={principalValues.length ? principalValues : [0]} labels={labels.length ? labels : ["No data"]} tone="accent" height={130} /></div>
            <div><strong>Interest and fees</strong><SparkBars values={interestValues.length ? interestValues : [0]} labels={labels.length ? labels : ["No data"]} tone="negative" height={130} /></div>
          </div>
        </Section>
      </div>

      <Section title="Liability accounts" description="Posted balances and configured borrowing terms" action={<InfoButton text="Outstanding amounts come from signed posted account balances. Limits and original principal provide context but never increase cash or net worth." />}>
        <ResponsiveTable label="Liability account summary">
          <thead><tr><th>Account</th><th>Type</th><th>Outstanding</th><th>Limit / original principal</th><th>Available / repaid</th><th>Utilization</th></tr></thead>
          <tbody>
            {accounts.length ? accounts.map((item, index) => {
              const account = readRecord(item);
              const accountCurrency = stringFrom(account.currency, DEFAULT_CURRENCY).toUpperCase();
              const card = stringFrom(account.type) === "credit_card";
              const cardMetrics = readRecord(account.creditMetrics);
              const loanMetrics = readRecord(account.loanMetrics);
              const outstanding = card
                ? numberFrom(cardMetrics.projectedOutstandingMinor, Math.max(0, -numberFrom(account.balanceMinor)))
                : numberFrom(loanMetrics.outstandingPrincipalMinor, Math.max(0, -numberFrom(account.balanceMinor)));
              const reference = card
                ? numberFrom(cardMetrics.creditLimitMinor ?? account.creditLimitMinor)
                : numberFrom(loanMetrics.originalPrincipalMinor);
              const progress = card
                ? numberFrom(cardMetrics.availableCreditMinor)
                : numberFrom(loanMetrics.principalRepaidMinor);
              const accountUtilization = card && optionalNumber(cardMetrics.utilizationBps) !== null
                ? numberFrom(cardMetrics.utilizationBps) / 100
                : null;
              return (
                <tr key={stringFrom(account.id, String(index))}>
                  <td><span className={ui.tablePrimary}>{stringFrom(account.name, "Liability")}</span><span className={ui.tableSecondary}>{stringFrom(account.institution)}</span></td>
                  <td><Pill tone="info">{card ? "Credit card" : "Loan"}</Pill></td>
                  <td className={`${ui.amount} ${outstanding ? ui.negative : ui.muted}`}>{formatMoney(outstanding, accountCurrency)}</td>
                  <td className={ui.amount}>{formatMoney(reference, accountCurrency)}</td>
                  <td className={`${ui.amount} ${ui.positive}`}>{formatMoney(progress, accountCurrency)}<small>{card ? "available credit" : "principal repaid"}</small></td>
                  <td>{card ? <Pill tone={accountUtilization !== null && accountUtilization > 80 ? "warning" : "neutral"}>{percentage(accountUtilization)}</Pill> : "—"}</td>
                </tr>
              );
            }) : <tr><td colSpan={6}>No credit-card or loan accounts are configured.</td></tr>}
          </tbody>
        </ResponsiveTable>
      </Section>

      <Section title="Recorded payment totals" description="Actual cash movement in the selected range" action={<InfoButton text={debtServiceExplanation} />}>
        <div className={ui.summaryList}>
          <div className={ui.summaryRow}><span>Credit-card payments</span><strong>{formatMoney(debt.cardPaymentsMinor)}</strong></div>
          <div className={ui.summaryRow}><span>Loan payments</span><strong>{formatMoney(debt.loanPaymentsMinor)}</strong></div>
          <div className={ui.summaryRow}><span>Total debt cash paid</span><strong>{formatMoney(debt.debtServiceMinor)}</strong></div>
        </div>
      </Section>

      <div className={`${ui.inlineNotice} ${ui.inlineNoticeWarning}`}>
        <AlertTriangle size={17} />
        <span>{stringFrom(debt.informationalOnly, "Debt ratios and generated schedules are informational estimates. Lender statements and contracts remain authoritative.")} These figures are not guaranteed financial, legal, tax, or lending advice.</span>
      </div>
    </>
  );
}

function Patterns({ insights, summary, categories, categoryIncreases }: { insights: Row[]; summary: Row; categories: Row[]; categoryIncreases: Row[] }) {
  const concentration = numberFrom(summary.categoryConcentration);
  const consistency = numberFrom(summary.spendingConsistency);
  return (
    <>
      <div className={ui.metricGrid}>
        <Metric label="Category concentration" value={percentage(concentration)} detail="Top three categories' share" tone={concentration > 50 ? "warning" : "default"} info={calculations.concentration} />
        <Metric label="Spending consistency" value={percentage(consistency)} detail="Month-to-month stability" tone={consistency > 70 ? "positive" : "default"} info={calculations.consistency} />
        <Metric label="Most active weekday" value={stringFrom(summary.mostActiveWeekday, "—")} detail={formatMoney(summary.mostActiveWeekdayMinor)} info="Weekday with the highest total actual expense amount in the selected range." />
        <Metric label="Largest category" value={displayLabel(readRecord(categories[0]), "—")} detail={formatMoney(valueMinor(readRecord(categories[0])))} info="Category with the greatest actual spending total in the selected period." />
      </div>
      <div className={ui.twoColumn}>
        <Section title="Patterns to review" description="Evidence-based observations, not guaranteed financial advice" action={<InfoButton text="Rules compare actual spending in the selected range with the preceding equal-length range. Each observation names the underlying data and avoids predicting outcomes." />}>
          <div className={ui.insightList}>
            {insights.length ? insights.map((item, index) => {
              const row = readRecord(item); const kind = stringFrom(row.kind ?? row.severity, "info"); const Icon = kind === "warning" || kind === "high" ? ShieldAlert : kind === "trend" ? TrendingUp : Lightbulb;
              return <div className={ui.insight} key={stringFrom(row.id, String(index))}><Icon size={18} /><div><strong>{stringFrom(row.title, "Pattern detected")}</strong><p>{stringFrom(row.description ?? row.message ?? row.detail)}</p>{row.calculation ? <p><strong>How detected:</strong> {stringFrom(row.calculation)}</p> : null}{row.disclaimer ? <p>{stringFrom(row.disclaimer)}</p> : null}</div></div>;
            }) : <div className={styles.chartEmpty}>More actual transaction history is needed before LedgerLab can identify meaningful personal patterns.</div>}
          </div>
        </Section>
        <div>
          <Section title="Concentration check" description="Where actual spending clusters" action={<InfoButton text={calculations.concentration} />}><BreakdownDonut rows={categories} /></Section>
          <Section title="Largest range-over-range increases" description="Potential review candidates" action={<InfoButton text="Positive actual spending changes by category versus the previous equal-length date range. An increase is not inherently bad." />}>
            <div className={styles.changeList}>{categoryIncreases.length ? categoryIncreases.slice(0, 5).map((item, index) => { const row = readRecord(item); const change = numberFrom(row.changeMinor); return <div key={stringFrom(row.id, String(index))}><span><ArrowUp size={15} /><strong>{displayLabel(row)}</strong></span><span className={ui.negative}>+{formatMoney(change)}</span></div>; }) : <div className={styles.chartEmpty}>No category increased versus the previous equal-length range.</div>}</div>
          </Section>
        </div>
      </div>
      <div className={`${ui.inlineNotice} ${ui.inlineNoticeWarning}`}><AlertTriangle size={17} /><span>LedgerLab’s patterns and suggestions are descriptive observations based on the data you recorded. They may be incomplete and should not be treated as guaranteed financial, tax, investment, or legal advice.</span></div>
    </>
  );
}
