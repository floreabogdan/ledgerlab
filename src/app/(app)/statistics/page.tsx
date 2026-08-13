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
import { useTranslations } from "@/i18n/client";
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
type Translate = ReturnType<typeof useTranslations>;

function percentage(value: unknown, t: Translate) {
  const numeric = optionalNumber(value);
  return numeric === null
    ? t("finance.statistics.common.unavailable")
    : t("finance.statistics.common.percentage", { value: numeric.toLocaleString(workspaceLocale(), { maximumFractionDigits: 1 }) });
}

function optionalNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function displayLabel(row: Row, t: Translate, fallback = t("finance.statistics.common.other")) {
  return stringFrom(row.label ?? row.name ?? row.title ?? row.categoryName ?? row.category ?? row.merchantName ?? row.merchant ?? row.accountName ?? row.account ?? row.tagName ?? row.tag ?? row.period ?? row.month, fallback);
}

function valueMinor(row: Row) {
  return numberFrom(row.amountMinor ?? row.valueMinor ?? row.spendingMinor ?? row.expenseMinor ?? row.totalMinor);
}

function monthBucketLabel(row: Row, t: Translate, fallback = t("finance.statistics.common.month")) {
  const label = displayLabel(row, t, fallback);
  return row.partial === true ? t("finance.statistics.common.partial", { label }) : label;
}

function semanticBreakdownLabel(row: Row, t: Translate) {
  switch (stringFrom(row.name ?? row.label)) {
    case "fixed": return t("finance.statistics.classifications.fixed");
    case "variable": return t("finance.statistics.classifications.variable");
    case "essential": return t("finance.statistics.classifications.essential");
    case "discretionary": return t("finance.statistics.classifications.discretionary");
    default: return t("finance.statistics.common.other");
  }
}

function weekdayLabel(value: unknown, t: Translate) {
  switch (stringFrom(value).toLocaleLowerCase("en")) {
    case "monday": return t("finance.statistics.weekdays.monday");
    case "tuesday": return t("finance.statistics.weekdays.tuesday");
    case "wednesday": return t("finance.statistics.weekdays.wednesday");
    case "thursday": return t("finance.statistics.weekdays.thursday");
    case "friday": return t("finance.statistics.weekdays.friday");
    case "saturday": return t("finance.statistics.weekdays.saturday");
    case "sunday": return t("finance.statistics.weekdays.sunday");
    default: return t("finance.statistics.common.unavailable");
  }
}

function frequencyLabel(value: unknown, t: Translate) {
  switch (stringFrom(value)) {
    case "daily": return t("finance.statistics.frequencies.daily");
    case "weekly": return t("finance.statistics.frequencies.weekly");
    case "monthly": return t("finance.statistics.frequencies.monthly");
    case "quarterly": return t("finance.statistics.frequencies.quarterly");
    case "yearly": return t("finance.statistics.frequencies.yearly");
    default: return t("finance.statistics.frequencies.recurring");
  }
}

function forecastBiasLabel(value: unknown, t: Translate) {
  switch (stringFrom(value)) {
    case "overestimate": return t("finance.statistics.forecast.bias.overestimate");
    case "underestimate": return t("finance.statistics.forecast.bias.underestimate");
    case "neutral": return t("finance.statistics.forecast.bias.neutral");
    case "insufficient_data": return t("finance.statistics.forecast.bias.insufficientData");
    default: return t("finance.statistics.forecast.bias.unknown");
  }
}

function accountTypeLabel(value: unknown, t: Translate) {
  return stringFrom(value) === "credit_card"
    ? t("finance.statistics.debt.accountTypes.creditCard")
    : stringFrom(value) === "loan"
      ? t("finance.statistics.debt.accountTypes.loan")
      : t("finance.statistics.debt.accountTypes.other");
}

function actualFlowBasisLabel(value: unknown, t: Translate) {
  return stringFrom(value) === "transaction_date"
    ? t("finance.statistics.reportingBasis.transactionDate")
    : t("finance.statistics.reportingBasis.recordedActivity");
}

function historicalBalanceBasisLabel(value: unknown, t: Translate) {
  return stringFrom(value) === "snapshot_date"
    ? t("finance.statistics.reportingBasis.snapshotDate")
    : t("finance.statistics.reportingBasis.recordedSnapshot");
}

function plannedBasisLabel(value: unknown, t: Translate) {
  return stringFrom(value) === "due_date"
    ? t("finance.statistics.reportingBasis.dueDate")
    : t("finance.statistics.reportingBasis.recordedPlanDate");
}

function rateSourceLabel(value: unknown, t: Translate) {
  return stringFrom(value) === "bnr"
    ? t("finance.statistics.reportingBasis.bnr")
    : t("finance.statistics.reportingBasis.configuredRates");
}

function suggestionContent(suggestion: Row, t: Translate) {
  const params = readRecord(suggestion.params);
  switch (stringFrom(suggestion.code)) {
    case "STATISTICS_CATEGORY_CONCENTRATION":
      return {
        title: t("finance.statistics.patterns.suggestions.categoryConcentration.title"),
        description: t("finance.statistics.patterns.suggestions.categoryConcentration.description", {
          categoryName: stringFrom(params.categoryName, t("finance.statistics.common.uncategorised")),
        }),
      };
    case "STATISTICS_MONTH_END_PACE":
      return {
        title: t("finance.statistics.patterns.suggestions.monthEndPace.title"),
        description: t("finance.statistics.patterns.suggestions.monthEndPace.description"),
      };
    case "STATISTICS_BUILD_HISTORY":
      return {
        title: t("finance.statistics.patterns.suggestions.buildHistory.title"),
        description: t("finance.statistics.patterns.suggestions.buildHistory.description"),
      };
    default:
      return {
        title: t("finance.statistics.patterns.suggestions.unknown.title"),
        description: t("finance.statistics.patterns.suggestions.unknown.description"),
      };
  }
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
  const t = useTranslations();
  const [tab, setTab] = useState<StatTab>("overview");
  const { range } = useDateRange();
  const { data: raw, loading, error, reload } = useJson<Record<string, unknown>>(`/api/statistics?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`, {});
  const payload = readRecord(readRecord(raw).data ?? raw);
  const reportingBasis = readRecord(payload.reportingBasis);
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
        eyebrow={t("finance.statistics.header.eyebrow")}
        title={t("finance.statistics.header.title")}
        description={t("finance.statistics.header.description", {
          actualFlows: actualFlowBasisLabel(reportingBasis.actualFlows, t),
          currentBalances: reportingBasis.currentBalances
            ? formatDate(reportingBasis.currentBalances)
            : t("finance.statistics.reportingBasis.latestBalance"),
          historicalBalances: historicalBalanceBasisLabel(reportingBasis.historicalBalances, t),
          plannedAmounts: plannedBasisLabel(reportingBasis.plannedAmounts, t),
          source: rateSourceLabel(reportingBasis.source, t),
        })}
      />

      <Tabs id="statistics" panelId="statistics-panel" label={t("finance.statistics.tabs.aria")} value={tab} onChange={setTab} items={[
        { value: "overview", label: t("finance.statistics.tabs.overview") },
        { value: "spending", label: t("finance.statistics.tabs.spending") },
        { value: "trends", label: t("finance.statistics.tabs.trends") },
        { value: "forecast", label: t("finance.statistics.tabs.forecast") },
        { value: "debt", label: t("finance.statistics.tabs.debt") },
        { value: "patterns", label: t("finance.statistics.tabs.patterns") },
      ]} />

      <DataState loading={loading} error={error} onRetry={reload}>
        <div id="statistics-panel" role="tabpanel" aria-labelledby={`statistics-${tab}-tab`} className={styles.tabContent}>
          {tab === "overview" ? <Overview summary={summary} monthly={monthly} categories={categories} income={income} expenses={expenses} cashFlow={cashFlow} savingsRate={savingsRate} monthlyValues={monthlyValues} recurring={recurring} /> : null}
          {tab === "spending" ? <SpendingDetail categories={categories} merchants={merchants} accounts={accounts} tags={tags} weekdays={weekdays} weeks={weeks} fixedVariable={fixedVariable} essential={essential} largestExpenses={largestExpenses} /> : null}
          {tab === "trends" ? <Trends monthly={monthly} comparisons={comparisons} categoryIncreases={categoryIncreases} balanceHistory={balanceHistory} summary={summary} /> : null}
          {tab === "forecast" ? <Forecast summary={summary} monthly={monthly} recurring={recurring} subscriptions={subscriptions} /> : null}
          {tab === "debt" ? <Debt debt={debt} /> : null}
          {tab === "patterns" ? <Patterns insights={insights} summary={summary} categories={categories} categoryIncreases={categoryIncreases} /> : null}
        </div>
      </DataState>
    </Page>
  );
}

function Overview({ summary, monthly, categories, income, expenses, cashFlow, savingsRate, monthlyValues, recurring }: { summary: Row; monthly: Row[]; categories: Row[]; income: number; expenses: number; cashFlow: number; savingsRate: number; monthlyValues: number[]; recurring: Row }) {
  const t = useTranslations();
  return (
    <>
      <div className={ui.metricGrid}>
        <Metric label={t("finance.statistics.overview.metrics.income")} value={formatMoney(income)} tone="positive" info={t("finance.statistics.calculations.income")} />
        <Metric label={t("finance.statistics.overview.metrics.expenses")} value={formatMoney(expenses)} tone="negative" info={t("finance.statistics.calculations.expenses")} />
        <Metric label={t("finance.statistics.overview.metrics.cashFlow")} value={formatMoney(cashFlow)} tone={cashFlow >= 0 ? "positive" : "negative"} info={t("finance.statistics.calculations.cashFlow")} />
        <Metric label={t("finance.statistics.overview.metrics.savingsRate")} value={percentage(savingsRate, t)} tone={savingsRate >= 20 ? "positive" : savingsRate < 0 ? "negative" : "default"} info={t("finance.statistics.calculations.savingsRate")} />
      </div>
      <div className={ui.twoColumn}>
        <Section title={t("finance.statistics.overview.monthly.title")} description={t("finance.statistics.overview.monthly.description")} action={<InfoButton text={t("finance.statistics.overview.monthly.info", { timeZone: workspaceTimeZone() })} />}>
          <GroupedMonthlyChart rows={monthly} />
        </Section>
        <Section title={t("finance.statistics.overview.category.title")} description={t("finance.statistics.overview.category.description")} action={<InfoButton text={t("finance.statistics.overview.category.info")} />}>
          <BreakdownDonut rows={categories} />
        </Section>
      </div>
      <div className={ui.equalColumns}>
        <Section title={t("finance.statistics.overview.cashFlowDirection.title")} description={t("finance.statistics.overview.cashFlowDirection.description")} action={<InfoButton text={t("finance.statistics.calculations.cashFlow")} />}>
          <div className={ui.chartArea}><SparkBars values={monthlyValues.length ? monthlyValues : [0]} labels={monthly.length ? monthly.map((item) => monthBucketLabel(readRecord(item), t)) : [t("finance.statistics.common.noData")]} tone="mixed" height={150} /></div>
        </Section>
        <Section title={t("finance.statistics.overview.commitments.title")} description={t("finance.statistics.overview.commitments.description")} action={<InfoButton text={t("finance.statistics.calculations.recurring")} />}>
          <div className={ui.summaryList}>
            <div className={ui.summaryRow}><span>{t("finance.statistics.overview.commitments.monthly")}</span><strong>{formatMoney(recurring.monthlyTotalMinor ?? summary.recurringMonthlyMinor)}</strong></div>
            <div className={ui.summaryRow}><span>{t("finance.statistics.overview.commitments.subscriptions")}</span><strong>{formatMoney(recurring.subscriptionTotalMinor)} <small>{t("finance.statistics.overview.commitments.active", { count: numberFrom(recurring.subscriptionCount) })}</small></strong></div>
            <div className={ui.summaryRow}><span>{t("finance.statistics.overview.commitments.share")}</span><strong>{percentage(recurring.spendingShare, t)}</strong></div>
            <div className={ui.summaryRow}><span>{t("finance.statistics.overview.commitments.next30Days")}</span><strong>{formatMoney(recurring.next30DaysMinor)} <small>{t("finance.statistics.overview.commitments.projected")}</small></strong></div>
          </div>
        </Section>
      </div>
    </>
  );
}

function GroupedMonthlyChart({ rows }: { rows: Row[] }) {
  const t = useTranslations();
  const values = rows.flatMap((item) => {
    const row = readRecord(item); return [numberFrom(row.incomeMinor), numberFrom(row.expenseMinor ?? row.spendingMinor)];
  });
  const max = Math.max(...values, 1);
  if (!rows.length) return <div className={styles.chartEmpty}>{t("finance.statistics.charts.monthly.empty")}</div>;
  return (
    <div className={styles.groupedChart} aria-label={t("finance.statistics.charts.monthly.aria")}>
      {rows.map((item, index) => {
        const row = readRecord(item); const income = numberFrom(row.incomeMinor); const expense = numberFrom(row.expenseMinor ?? row.spendingMinor);
        return <div className={styles.group} key={stringFrom(row.month ?? row.period, String(index))}><div className={styles.barTrack}><span className={styles.incomeBar} style={{ height: `${Math.max(2, income / max * 100)}%` }} title={t("finance.statistics.charts.monthly.incomeTitle", { amount: formatMoney(income) })} /><span className={styles.expenseBar} style={{ height: `${Math.max(2, expense / max * 100)}%` }} title={t("finance.statistics.charts.monthly.spendingTitle", { amount: formatMoney(expense) })} /></div><small title={monthBucketLabel(row, t, stringFrom(row.month, ""))}>{monthBucketLabel(row, t, stringFrom(row.month, ""))}</small></div>;
      })}
      <div className={styles.chartLegend}><span><i className={styles.incomeKey} />{t("finance.statistics.charts.monthly.income")}</span><span><i className={styles.expenseKey} />{t("finance.statistics.charts.monthly.spending")}</span></div>
    </div>
  );
}

function BreakdownDonut({ rows, semanticLabels = false }: { rows: Row[]; semanticLabels?: boolean }) {
  const t = useTranslations();
  const sorted = [...rows].sort((a, b) => valueMinor(readRecord(b)) - valueMinor(readRecord(a)));
  const total = sorted.reduce((sum, item) => sum + valueMinor(readRecord(item)), 0);
  const top = sorted.slice(0, 5);
  const percent = total ? valueMinor(readRecord(top[0])) / total * 100 : 0;
  return (
    <div className={ui.donutWrap}>
      <div className={ui.donut} style={{ "--percent": percent, "--donut-color": stringFrom(readRecord(top[0]).color, "#2563eb") } as React.CSSProperties} aria-label={t("finance.statistics.charts.donut.aria", { percentage: percentage(percent, t) })} />
      <div className={ui.donutLegend}>
        {top.length ? top.map((item, index) => { const row = readRecord(item); return <div key={stringFrom(row.id, String(index))}><span><i className={ui.categoryDot} style={{ "--category-color": stringFrom(row.color, "#2563eb") } as React.CSSProperties} />{semanticLabels ? semanticBreakdownLabel(row, t) : displayLabel(row, t)}</span><strong>{formatMoney(valueMinor(row))}<small>{percentage(total ? valueMinor(row) / total * 100 : 0, t)}</small></strong></div>; }) : <div><span>{t("finance.statistics.charts.donut.empty")}</span></div>}
      </div>
    </div>
  );
}

function SpendingDetail({ categories, merchants, accounts, tags, weekdays, weeks, fixedVariable, essential, largestExpenses }: { categories: Row[]; merchants: Row[]; accounts: Row[]; tags: Row[]; weekdays: Row[]; weeks: Row[]; fixedVariable: Row[]; essential: Row[]; largestExpenses: Row[] }) {
  const t = useTranslations();
  return (
    <>
      <div className={ui.equalColumns}>
        <BreakdownSection title={t("finance.statistics.spending.breakdowns.categories.title")} empty={t("finance.statistics.spending.breakdowns.categories.empty")} rows={categories} explanation={t("finance.statistics.spending.breakdowns.categories.info")} />
        <BreakdownSection title={t("finance.statistics.spending.breakdowns.merchants.title")} empty={t("finance.statistics.spending.breakdowns.merchants.empty")} rows={merchants} explanation={t("finance.statistics.spending.breakdowns.merchants.info")} />
        <BreakdownSection title={t("finance.statistics.spending.breakdowns.accounts.title")} empty={t("finance.statistics.spending.breakdowns.accounts.empty")} rows={accounts} explanation={t("finance.statistics.spending.breakdowns.accounts.info")} />
        <BreakdownSection title={t("finance.statistics.spending.breakdowns.tags.title")} empty={t("finance.statistics.spending.breakdowns.tags.empty")} rows={tags} explanation={t("finance.statistics.spending.breakdowns.tags.info")} />
      </div>
      <div className={ui.equalColumns}>
        <Section title={t("finance.statistics.spending.weekday.title")} description={t("finance.statistics.spending.weekday.description")} action={<InfoButton text={t("finance.statistics.spending.weekday.info", { timeZone: workspaceTimeZone() })} />}><div className={ui.chartArea}><SparkBars values={weekdays.length ? weekdays.map((item) => valueMinor(readRecord(item))) : [0]} labels={weekdays.length ? weekdays.map((item) => weekdayLabel(readRecord(item).name ?? readRecord(item).label, t)) : [t("finance.statistics.common.noData")]} tone="negative" height={150} /></div></Section>
        <Section title={t("finance.statistics.spending.week.title")} description={t("finance.statistics.spending.week.description")} action={<InfoButton text={t("finance.statistics.spending.week.info")} />}><div className={ui.chartArea}><SparkBars values={weeks.length ? weeks.map((item) => valueMinor(readRecord(item))) : [0]} labels={weeks.length ? weeks.map((item) => displayLabel(readRecord(item), t)) : [t("finance.statistics.common.noData")]} tone="negative" height={150} /></div></Section>
      </div>
      <div className={ui.equalColumns}>
        <Section title={t("finance.statistics.spending.fixedVariable.title")} description={t("finance.statistics.spending.classificationDescription")} action={<InfoButton text={t("finance.statistics.calculations.fixedVariable")} />}><BreakdownDonut rows={fixedVariable} semanticLabels /></Section>
        <Section title={t("finance.statistics.spending.essential.title")} description={t("finance.statistics.spending.classificationDescription")} action={<InfoButton text={t("finance.statistics.calculations.essential")} />}><BreakdownDonut rows={essential} semanticLabels /></Section>
      </div>
      <Section title={t("finance.statistics.spending.largest.title")} description={t("finance.statistics.spending.largest.description")} action={<InfoButton text={t("finance.statistics.spending.largest.info")} />}>
        <ResponsiveTable label={t("finance.statistics.spending.largest.tableAria")}><thead><tr><th>{t("finance.statistics.spending.largest.columns.date")}</th><th>{t("finance.statistics.spending.largest.columns.merchant")}</th><th>{t("finance.statistics.spending.largest.columns.category")}</th><th>{t("finance.statistics.spending.largest.columns.account")}</th><th>{t("finance.statistics.spending.largest.columns.amount")}</th></tr></thead><tbody>{largestExpenses.slice(0, 20).map((item, index) => { const row = readRecord(item); return <tr key={stringFrom(row.id, String(index))}><td>{formatDate(row.date)}</td><td><span className={ui.tablePrimary}>{displayLabel(row, t, t("finance.statistics.common.expense"))}</span><span className={ui.tableSecondary}>{stringFrom(row.notes)}</span></td><td>{stringFrom(row.categoryName, t("finance.statistics.common.uncategorised"))}</td><td>{stringFrom(row.accountName, t("finance.statistics.common.account"))}</td><td className={`${ui.amount} ${ui.negative}`}>{formatMoney(-Math.abs(numberFrom(row.amountMinor)))}</td></tr>; })}</tbody></ResponsiveTable>
      </Section>
    </>
  );
}

function BreakdownSection({ title, empty, rows, explanation }: { title: string; empty: string; rows: Row[]; explanation: string }) {
  const t = useTranslations();
  const total = rows.reduce((sum, item) => sum + valueMinor(readRecord(item)), 0);
  const sorted = [...rows].sort((a, b) => valueMinor(readRecord(b)) - valueMinor(readRecord(a))).slice(0, 10);
  return (
    <Section title={title} action={<InfoButton text={explanation} />}>
      <div className={styles.rankingList}>
        {sorted.length ? sorted.map((item, index) => { const row = readRecord(item); const value = valueMinor(row); return <div className={styles.rankingRow} key={stringFrom(row.id, String(index))}><span className={styles.rank}>{index + 1}</span><span><strong>{displayLabel(row, t)}</strong><Progress value={value} max={total || 1} /></span><span><strong>{formatMoney(value)}</strong><small>{percentage(total ? value / total * 100 : 0, t)}</small></span></div>; }) : <div className={styles.chartEmpty}>{empty}</div>}
      </div>
    </Section>
  );
}

function Trends({ monthly, comparisons, categoryIncreases, balanceHistory, summary }: { monthly: Row[]; comparisons: Row; categoryIncreases: Row[]; balanceHistory: Row[]; summary: Row }) {
  const t = useTranslations();
  const mom = readRecord(comparisons.monthOverMonth ?? comparisons.mom);
  const yoy = readRecord(comparisons.yearOverYear ?? comparisons.yoy);
  const history = balanceHistory.length ? balanceHistory : monthly;
  const spendingChange = optionalNumber(mom.expenseChangePercent ?? mom.spendingPercent);
  const incomeChange = optionalNumber(mom.incomeChangePercent ?? mom.incomePercent);
  const yearlySpendingChange = optionalNumber(yoy.expenseChangePercent ?? yoy.spendingPercent);
  return (
    <>
      <div className={ui.metricGrid}>
        <Metric label={t("finance.statistics.trends.metrics.spendingChange")} value={percentage(spendingChange, t)} detail={t("finance.statistics.trends.metrics.vsPrevious", { amount: formatMoney(mom.expenseChangeMinor) })} tone={spendingChange === null ? "default" : spendingChange > 0 ? "negative" : "positive"} info={t("finance.statistics.calculations.mom")} />
        <Metric label={t("finance.statistics.trends.metrics.incomeChange")} value={percentage(incomeChange, t)} detail={t("finance.statistics.trends.metrics.vsPrevious", { amount: formatMoney(mom.incomeChangeMinor) })} tone={incomeChange === null ? "default" : incomeChange >= 0 ? "positive" : "negative"} info={t("finance.statistics.calculations.mom")} />
        <Metric label={t("finance.statistics.trends.metrics.yearlySpending")} value={percentage(yearlySpendingChange, t)} detail={formatMoney(yoy.expenseChangeMinor)} tone={yearlySpendingChange === null ? "default" : yearlySpendingChange > 0 ? "warning" : "positive"} info={t("finance.statistics.calculations.yoy")} />
        <Metric label={t("finance.statistics.trends.metrics.rollingAverage")} value={formatMoney(summary.rollingAverageMinor)} detail={t("finance.statistics.trends.metrics.trailingMean")} info={t("finance.statistics.calculations.rolling")} />
      </div>
      <div className={ui.equalColumns}>
        <Section title={t("finance.statistics.trends.monthly.title")} description={t("finance.statistics.trends.monthly.description")} action={<InfoButton text={t("finance.statistics.trends.monthly.info")} />}><GroupedMonthlyChart rows={monthly} /></Section>
        <Section title={t("finance.statistics.trends.netWorth.title")} description={t("finance.statistics.trends.netWorth.description")} action={<InfoButton text={t("finance.statistics.trends.netWorth.info")} />}><div className={ui.chartArea}><SparkBars values={history.length ? history.map((item) => numberFrom(readRecord(item).netWorthMinor ?? readRecord(item).balanceMinor)) : [0]} labels={history.length ? history.map((item) => displayLabel(readRecord(item), t)) : [t("finance.statistics.common.noData")]} tone="mixed" height={180} /></div></Section>
      </div>
      <Section title={t("finance.statistics.trends.increases.title")} description={t("finance.statistics.trends.increases.description")} action={<InfoButton text={t("finance.statistics.trends.increases.info")} />}>
        <ResponsiveTable label={t("finance.statistics.trends.increases.tableAria")}><thead><tr><th>{t("finance.statistics.trends.increases.columns.category")}</th><th>{t("finance.statistics.trends.increases.columns.previous")}</th><th>{t("finance.statistics.trends.increases.columns.current")}</th><th>{t("finance.statistics.trends.increases.columns.change")}</th><th>{t("finance.statistics.trends.increases.columns.changePercentage")}</th></tr></thead><tbody>{categoryIncreases.length ? categoryIncreases.map((item, index) => { const row = readRecord(item); const change = numberFrom(row.changeMinor, numberFrom(row.currentMinor) - numberFrom(row.previousMinor)); const changePercent = optionalNumber(row.changePercent); return <tr key={stringFrom(row.id, String(index))}><td>{displayLabel(row, t, t("finance.statistics.common.category"))}</td><td className={ui.amount}>{formatMoney(row.previousMinor)}</td><td className={ui.amount}>{formatMoney(row.currentMinor)}</td><td className={`${ui.amount} ${ui.negative}`}>+{formatMoney(change)}</td><td><Pill tone="warning">{changePercent === null ? t("finance.statistics.trends.increases.new") : percentage(changePercent, t)}</Pill></td></tr>; }) : <tr><td colSpan={5}>{t("finance.statistics.trends.increases.empty")}</td></tr>}</tbody></ResponsiveTable>
      </Section>
    </>
  );
}

function Forecast({ summary, monthly, recurring, subscriptions }: { summary: Row; monthly: Row[]; recurring: Row; subscriptions: Row[] }) {
  const t = useTranslations();
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
        <Metric label={t("finance.statistics.forecast.metrics.runway")} value={runwayDays === null ? t("finance.statistics.common.unavailable") : t("finance.statistics.forecast.metrics.days", { count: Math.round(runwayDays) })} detail={t("finance.statistics.forecast.metrics.runwayDetail")} tone={runwayDays === null ? "default" : runwayDays < 30 ? "warning" : "accent"} info={t("finance.statistics.calculations.runway")} />
        <Metric label={t("finance.statistics.forecast.metrics.dailySpending")} value={averageDailySpending === null ? t("finance.statistics.common.unavailable") : formatMoney(averageDailySpending)} detail={t("finance.statistics.forecast.metrics.dailySpendingDetail")} info={t("finance.statistics.calculations.daily")} />
        <Metric label={t("finance.statistics.forecast.metrics.projectedMonthEnd")} value={projectedMonthEnd === null ? t("finance.statistics.common.unavailable") : formatMoney(projectedMonthEnd)} tone={projectedMonthEnd === null ? "default" : "warning"} detail={projectionApplicable ? t("finance.statistics.forecast.metrics.currentMonthEstimate") : t("finance.statistics.forecast.metrics.rangeMustIncludeToday")} info={t("finance.statistics.calculations.projected")} />
        <Metric label={t("finance.statistics.forecast.metrics.accuracy")} value={percentage(forecastAccuracy, t)} tone={forecastAccuracy === null ? "default" : "accent"} detail={forecastAccuracy === null ? t("finance.statistics.forecast.metrics.noCompletedMonths") : t("finance.statistics.forecast.metrics.completedMonthsOnly")} info={t("finance.statistics.calculations.accuracy")} />
      </div>
      <div className={ui.equalColumns}>
        <Section title={t("finance.statistics.forecast.comparison.title")} description={t("finance.statistics.forecast.comparison.description")} action={<InfoButton text={t("finance.statistics.calculations.plannedActual")} />}>
          <div className={styles.comparisonChart}>
            <div><strong>{t("finance.statistics.forecast.comparison.planned")}</strong><SparkBars values={plannedValues.length ? plannedValues : [0]} labels={monthly.length ? monthly.map((item) => monthBucketLabel(readRecord(item), t)) : [t("finance.statistics.common.noData")]} tone="accent" height={140} /></div>
            <div><strong>{t("finance.statistics.forecast.comparison.actual")}</strong><SparkBars values={actualValues.length ? actualValues : [0]} labels={monthly.length ? monthly.map((item) => monthBucketLabel(readRecord(item), t)) : [t("finance.statistics.common.noData")]} tone="negative" height={140} /></div>
          </div>
        </Section>
        <Section title={t("finance.statistics.forecast.quality.title")} description={t("finance.statistics.forecast.quality.description")} action={<InfoButton text={t("finance.statistics.calculations.accuracy")} />}>
          <div className={ui.summaryList}>
            <div className={ui.summaryRow}><span>{t("finance.statistics.forecast.quality.meanAbsoluteError")}</span><strong>{numberFrom(summary.forecastSampleMonths) ? formatMoney(summary.forecastMeanAbsoluteErrorMinor) : t("finance.statistics.common.unavailable")}</strong></div>
            <div className={ui.summaryRow}><span>{t("finance.statistics.forecast.quality.averagePercentageError")}</span><strong>{numberFrom(summary.forecastSampleMonths) ? percentage(summary.forecastMape, t) : t("finance.statistics.common.unavailable")}</strong></div>
            <div className={ui.summaryRow}><span>{t("finance.statistics.forecast.quality.completedMonths")}</span><strong>{numberFrom(summary.forecastSampleMonths)}</strong></div>
            <div className={ui.summaryRow}><span>{t("finance.statistics.forecast.quality.typicalBias")}</span><strong>{forecastBiasLabel(summary.forecastBias, t)}</strong></div>
          </div>
        </Section>
      </div>
      <Section title={t("finance.statistics.forecast.recurring.title")} description={t("finance.statistics.forecast.recurring.description", { amount: formatMoney(recurring.monthlyTotalMinor) })} action={<InfoButton text={t("finance.statistics.calculations.recurring")} />}>
        <ResponsiveTable label={t("finance.statistics.forecast.recurring.tableAria")}><thead><tr><th>{t("finance.statistics.forecast.recurring.columns.commitment")}</th><th>{t("finance.statistics.forecast.recurring.columns.frequency")}</th><th>{t("finance.statistics.forecast.recurring.columns.nextDue")}</th><th>{t("finance.statistics.forecast.recurring.columns.monthly")}</th><th>{t("finance.statistics.forecast.recurring.columns.annual")}</th></tr></thead><tbody>{subscriptions.map((item, index) => { const row = readRecord(item); const monthlyAmount = numberFrom(row.monthlyAmountMinor ?? row.amountMinor); return <tr key={stringFrom(row.id, String(index))}><td><span className={ui.tablePrimary}>{displayLabel(row, t, t("finance.statistics.common.commitment"))}</span><span className={ui.tableSecondary}>{stringFrom(row.categoryName)}</span></td><td>{frequencyLabel(row.frequency, t)}</td><td>{formatDate(row.nextDueDate)}</td><td className={ui.amount}>{formatMoney(monthlyAmount)}</td><td className={ui.amount}>{formatMoney(row.annualAmountMinor ?? monthlyAmount * 12)}</td></tr>; })}</tbody></ResponsiveTable>
      </Section>
    </>
  );
}

function Debt({ debt }: { debt: Row }) {
  const t = useTranslations();
  const accounts = readList<Row>(debt, "accounts");
  const monthly = readList<Row>(debt, "monthly");
  const utilization = optionalNumber(debt.creditUtilizationPercent);
  const serviceToIncome = optionalNumber(debt.debtServiceToIncomePercent);
  const cashValues = monthly.map((item) => numberFrom(readRecord(item).cashPaidMinor));
  const principalValues = monthly.map((item) => numberFrom(readRecord(item).principalPaidMinor));
  const interestValues = monthly.map((item) => numberFrom(readRecord(item).interestFeesMinor));
  const labels = monthly.map((item) => displayLabel(readRecord(item), t));
  const debtServiceExplanation = t("finance.statistics.debt.info.debtService");
  const utilizationExplanation = t("finance.statistics.debt.info.utilization");

  return (
    <>
      <div className={ui.metricGrid}>
        <Metric label={t("finance.statistics.debt.metrics.totalLiabilities")} value={formatMoney(debt.totalLiabilitiesMinor)} tone={numberFrom(debt.totalLiabilitiesMinor) ? "warning" : "default"} info={t("finance.statistics.debt.info.totalLiabilities")} />
        <Metric label={t("finance.statistics.debt.metrics.cardUtilization")} value={percentage(utilization, t)} detail={t("finance.statistics.debt.metrics.utilizationDetail", { outstanding: formatMoney(debt.creditCardOutstandingMinor), limit: formatMoney(debt.creditLimitMinor) })} tone={utilization === null ? "default" : utilization > 80 ? "warning" : "accent"} info={utilizationExplanation} />
        <Metric label={t("finance.statistics.debt.metrics.cashPaid")} value={formatMoney(debt.debtServiceMinor)} tone="accent" info={debtServiceExplanation} />
        <Metric label={t("finance.statistics.debt.metrics.principalRepaid")} value={formatMoney(debt.principalRepaidMinor)} info={t("finance.statistics.debt.info.principalRepaid")} />
        <Metric label={t("finance.statistics.debt.metrics.interestFees")} value={formatMoney(debt.interestFeesMinor)} tone={numberFrom(debt.interestFeesMinor) ? "negative" : "default"} info={t("finance.statistics.debt.info.interestFees")} />
        <Metric label={t("finance.statistics.debt.metrics.serviceToIncome")} value={percentage(serviceToIncome, t)} detail={t("finance.statistics.common.selectedRange")} tone={serviceToIncome === null ? "default" : serviceToIncome > 40 ? "warning" : "default"} info={t("finance.statistics.debt.info.serviceToIncome")} />
      </div>

      <div className={`${ui.inlineNotice} ${ui.noticeInset}`}>
        <ShieldAlert size={17} />
        <span><strong>{t("finance.statistics.debt.cashNotice.title")}</strong> {t("finance.statistics.debt.cashNotice.description")}</span>
      </div>

      <div className={ui.equalColumns}>
        <Section title={t("finance.statistics.debt.timeline.title")} description={t("finance.statistics.debt.timeline.description")} action={<InfoButton text={debtServiceExplanation} />}>
          <div className={ui.chartArea}><SparkBars values={cashValues.length ? cashValues : [0]} labels={labels.length ? labels : [t("finance.statistics.common.noData")]} tone="accent" height={160} /></div>
        </Section>
        <Section title={t("finance.statistics.debt.composition.title")} description={t("finance.statistics.debt.composition.description")} action={<InfoButton text={t("finance.statistics.debt.composition.info")} />}>
          <div className={styles.comparisonChart}>
            <div><strong>{t("finance.statistics.debt.composition.principal")}</strong><SparkBars values={principalValues.length ? principalValues : [0]} labels={labels.length ? labels : [t("finance.statistics.common.noData")]} tone="accent" height={130} /></div>
            <div><strong>{t("finance.statistics.debt.composition.interest")}</strong><SparkBars values={interestValues.length ? interestValues : [0]} labels={labels.length ? labels : [t("finance.statistics.common.noData")]} tone="negative" height={130} /></div>
          </div>
        </Section>
      </div>

      <Section title={t("finance.statistics.debt.accounts.title")} description={t("finance.statistics.debt.accounts.description")} action={<InfoButton text={t("finance.statistics.debt.accounts.info")} />}>
        <ResponsiveTable label={t("finance.statistics.debt.accounts.tableAria")}>
          <thead><tr><th>{t("finance.statistics.debt.accounts.columns.account")}</th><th>{t("finance.statistics.debt.accounts.columns.type")}</th><th>{t("finance.statistics.debt.accounts.columns.outstanding")}</th><th>{t("finance.statistics.debt.accounts.columns.reference")}</th><th>{t("finance.statistics.debt.accounts.columns.progress")}</th><th>{t("finance.statistics.debt.accounts.columns.utilization")}</th></tr></thead>
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
                  <td><span className={ui.tablePrimary}>{stringFrom(account.name, t("finance.statistics.common.liability"))}</span><span className={ui.tableSecondary}>{stringFrom(account.institution)}</span></td>
                  <td><Pill tone="info">{accountTypeLabel(account.type, t)}</Pill></td>
                  <td className={`${ui.amount} ${outstanding ? ui.negative : ui.muted}`}>{formatMoney(outstanding, accountCurrency)}</td>
                  <td className={ui.amount}>{formatMoney(reference, accountCurrency)}</td>
                  <td className={`${ui.amount} ${ui.positive}`}>{formatMoney(progress, accountCurrency)}<small>{card ? t("finance.statistics.debt.accounts.availableCredit") : t("finance.statistics.debt.accounts.principalRepaid")}</small></td>
                  <td>{card ? <Pill tone={accountUtilization !== null && accountUtilization > 80 ? "warning" : "neutral"}>{percentage(accountUtilization, t)}</Pill> : t("finance.statistics.common.unavailable")}</td>
                </tr>
              );
            }) : <tr><td colSpan={6}>{t("finance.statistics.debt.accounts.empty")}</td></tr>}
          </tbody>
        </ResponsiveTable>
      </Section>

      <Section title={t("finance.statistics.debt.totals.title")} description={t("finance.statistics.debt.totals.description")} action={<InfoButton text={debtServiceExplanation} />}>
        <div className={ui.summaryList}>
          <div className={ui.summaryRow}><span>{t("finance.statistics.debt.totals.cardPayments")}</span><strong>{formatMoney(debt.cardPaymentsMinor)}</strong></div>
          <div className={ui.summaryRow}><span>{t("finance.statistics.debt.totals.loanPayments")}</span><strong>{formatMoney(debt.loanPaymentsMinor)}</strong></div>
          <div className={ui.summaryRow}><span>{t("finance.statistics.debt.totals.total")}</span><strong>{formatMoney(debt.debtServiceMinor)}</strong></div>
        </div>
      </Section>

      <div className={`${ui.inlineNotice} ${ui.inlineNoticeWarning}`}>
        <AlertTriangle size={17} />
        <span>{t("finance.statistics.debt.disclaimer")}</span>
      </div>
    </>
  );
}

function Patterns({ insights, summary, categories, categoryIncreases }: { insights: Row[]; summary: Row; categories: Row[]; categoryIncreases: Row[] }) {
  const t = useTranslations();
  const concentration = numberFrom(summary.categoryConcentration);
  const consistency = numberFrom(summary.spendingConsistency);
  return (
    <>
      <div className={ui.metricGrid}>
        <Metric label={t("finance.statistics.patterns.metrics.concentration")} value={percentage(concentration, t)} detail={t("finance.statistics.patterns.metrics.concentrationDetail")} tone={concentration > 50 ? "warning" : "default"} info={t("finance.statistics.calculations.concentration")} />
        <Metric label={t("finance.statistics.patterns.metrics.consistency")} value={percentage(consistency, t)} detail={t("finance.statistics.patterns.metrics.consistencyDetail")} tone={consistency > 70 ? "positive" : "default"} info={t("finance.statistics.calculations.consistency")} />
        <Metric label={t("finance.statistics.patterns.metrics.weekday")} value={weekdayLabel(summary.mostActiveWeekday, t)} detail={formatMoney(summary.mostActiveWeekdayMinor)} info={t("finance.statistics.patterns.metrics.weekdayInfo")} />
        <Metric label={t("finance.statistics.patterns.metrics.largestCategory")} value={displayLabel(readRecord(categories[0]), t, t("finance.statistics.common.unavailable"))} detail={formatMoney(valueMinor(readRecord(categories[0])))} info={t("finance.statistics.patterns.metrics.largestCategoryInfo")} />
      </div>
      <div className={ui.twoColumn}>
        <Section title={t("finance.statistics.patterns.review.title")} description={t("finance.statistics.patterns.review.description")} action={<InfoButton text={t("finance.statistics.patterns.review.info")} />}>
          <div className={ui.insightList}>
            {insights.length ? insights.map((item, index) => {
              const row = readRecord(item);
              const severity = stringFrom(row.severity, "info");
              const code = stringFrom(row.code);
              const Icon = severity === "danger" || severity === "warning"
                ? ShieldAlert
                : code === "STATISTICS_MONTH_END_PACE"
                  ? TrendingUp
                  : Lightbulb;
              const content = suggestionContent(row, t);
              return <div className={ui.insight} key={stringFrom(row.id ?? row.code, String(index))}><Icon size={18} /><div><strong>{content.title}</strong><p>{content.description}</p></div></div>;
            }) : <div className={styles.chartEmpty}>{t("finance.statistics.patterns.review.empty")}</div>}
          </div>
        </Section>
        <div>
          <Section title={t("finance.statistics.patterns.concentration.title")} description={t("finance.statistics.patterns.concentration.description")} action={<InfoButton text={t("finance.statistics.calculations.concentration")} />}><BreakdownDonut rows={categories} /></Section>
          <Section title={t("finance.statistics.patterns.increases.title")} description={t("finance.statistics.patterns.increases.description")} action={<InfoButton text={t("finance.statistics.patterns.increases.info")} />}>
            <div className={styles.changeList}>{categoryIncreases.length ? categoryIncreases.slice(0, 5).map((item, index) => { const row = readRecord(item); const change = numberFrom(row.changeMinor); return <div key={stringFrom(row.id, String(index))}><span><ArrowUp size={15} /><strong>{displayLabel(row, t)}</strong></span><span className={ui.negative}>+{formatMoney(change)}</span></div>; }) : <div className={styles.chartEmpty}>{t("finance.statistics.trends.increases.empty")}</div>}</div>
          </Section>
        </div>
      </div>
      <div className={`${ui.inlineNotice} ${ui.inlineNoticeWarning}`}><AlertTriangle size={17} /><span>{t("finance.statistics.patterns.disclaimer")}</span></div>
    </>
  );
}
