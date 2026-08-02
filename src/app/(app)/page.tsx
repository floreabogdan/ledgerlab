"use client";

import Link from "next/link";
import { useMemo } from "react";
import {
  AlertTriangle,
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  CalendarClock,
  CreditCard,
  Landmark,
  Plus,
  ReceiptText,
  WalletCards,
} from "lucide-react";
import {
  DataState,
  formatDate,
  formatMoney,
  Metric,
  numberFrom,
  Page,
  Pill,
  Progress,
  readList,
  readRecord,
  Section,
  stringFrom,
  useJson,
  ViewHeader,
  workspaceLocale,
  featureStyles as ui,
} from "./_components/feature-kit";
import { useDateRange } from "@/components/date-range-context";
import { useTranslations } from "@/i18n/client";
import { DEFAULT_CURRENCY } from "@/lib/currencies";
import styles from "./dashboard.module.css";

type DashboardPayload = Record<string, unknown>;
type Row = Record<string, unknown>;
type Translate = ReturnType<typeof useTranslations>;

function transactionTone(type: string) {
  if (type === "income" || type === "refund") return "positive" as const;
  if (type === "expense") return "negative" as const;
  return "neutral" as const;
}

function accountTypeLabel(type: string, t: Translate) {
  switch (type) {
    case "current":
    case "current_account": return t("finance.dashboard.accountTypes.current");
    case "savings": return t("finance.dashboard.accountTypes.savings");
    case "cash": return t("finance.dashboard.accountTypes.cash");
    case "credit_card":
    case "credit": return t("finance.dashboard.accountTypes.creditCard");
    case "loan": return t("finance.dashboard.accountTypes.loan");
    case "investment": return t("finance.dashboard.accountTypes.investment");
    case "custom": return t("finance.dashboard.accountTypes.custom");
    default: return t("finance.dashboard.accountTypes.other");
  }
}

function transactionTypeLabel(type: string, t: Translate) {
  switch (type) {
    case "income": return t("finance.dashboard.transactionTypes.income");
    case "expense": return t("finance.dashboard.transactionTypes.expense");
    case "transfer": return t("finance.dashboard.transactionTypes.transfer");
    case "refund": return t("finance.dashboard.transactionTypes.refund");
    case "adjustment": return t("finance.dashboard.transactionTypes.adjustment");
    default: return t("finance.dashboard.transactionTypes.other");
  }
}

function paymentStatusLabel(status: string, overdue: boolean, t: Translate) {
  if (overdue || status === "overdue") return t("finance.dashboard.paymentStatuses.overdue");
  switch (status) {
    case "scheduled": return t("finance.dashboard.paymentStatuses.scheduled");
    case "paid": return t("finance.dashboard.paymentStatuses.paid");
    case "cancelled": return t("finance.dashboard.paymentStatuses.cancelled");
    case "skipped": return t("finance.dashboard.paymentStatuses.skipped");
    case "planned": return t("finance.dashboard.paymentStatuses.planned");
    default: return t("finance.dashboard.paymentStatuses.other");
  }
}

function severityLabel(severity: string, t: Translate) {
  switch (severity) {
    case "danger":
    case "high": return t("finance.dashboard.severity.danger");
    case "warning":
    case "medium": return t("finance.dashboard.severity.warning");
    default: return t("finance.dashboard.severity.info");
  }
}

function warningContent(warning: Row, t: Translate) {
  const code = stringFrom(warning.code);
  const params = readRecord(warning.params);
  switch (code) {
    case "DASHBOARD_OVERDUE":
      return {
        title: t("finance.dashboard.warnings.overdue.title"),
        description: t("finance.dashboard.warnings.overdue.description", { count: numberFrom(params.count) }),
      };
    case "DASHBOARD_BUDGET_EXCEEDED":
      return {
        title: t("finance.dashboard.warnings.budgetExceeded.title"),
        description: t("finance.dashboard.warnings.budgetExceeded.description", { percentage: numberFrom(params.percentage) }),
      };
    case "DASHBOARD_CASH_BELOW_ZERO":
      return {
        title: t("finance.dashboard.warnings.cashBelowZero.title"),
        description: t("finance.dashboard.warnings.cashBelowZero.description"),
      };
    case "DASHBOARD_SPENDING_INCREASED":
      return {
        title: t("finance.dashboard.warnings.spendingIncreased.title"),
        description: t("finance.dashboard.warnings.spendingIncreased.description", { percentage: numberFrom(params.percentage) }),
      };
    default:
      return {
        title: t("finance.dashboard.warnings.unknown.title"),
        description: t("finance.dashboard.warnings.unknown.description"),
      };
  }
}

function actualFlowBasisLabel(value: string, t: Translate) {
  return value === "transaction_date"
    ? t("finance.dashboard.reportingBasis.transactionDate")
    : t("finance.dashboard.reportingBasis.recordedActivity");
}

function plannedBasisLabel(value: string, t: Translate) {
  return value === "due_date"
    ? t("finance.dashboard.reportingBasis.dueDate")
    : t("finance.dashboard.reportingBasis.planDate");
}

function rateSourceLabel(value: string, t: Translate) {
  return value === "bnr"
    ? t("finance.dashboard.reportingBasis.bnr")
    : t("finance.dashboard.reportingBasis.configuredRates");
}

export default function DashboardPage() {
  const t = useTranslations();
  const { range, label: rangeLabel } = useDateRange();
  const dashboardUrl = useMemo(() => {
    const params = new URLSearchParams({ from: range.from, to: range.to });
    return `/api/dashboard?${params.toString()}`;
  }, [range.from, range.to]);
  const fallback: DashboardPayload = {};
  const { data: raw, loading, error, reload } = useJson<DashboardPayload>(dashboardUrl, fallback);
  const payload = readRecord(readRecord(raw).data ?? raw);
  const reportingBasis = readRecord(payload.reportingBasis);
  const month = readRecord(payload.month ?? payload.currentMonth);
  const forecast = readRecord(payload.nextMonthForecast ?? payload.forecast);
  const reminders = readRecord(payload.reminders);
  const accounts = readList(payload, "accounts");
  const dueSoon = readList(payload, "dueSoon", "upcomingPayments");
  const overdue = readList(payload, "overdue", "overduePayments");
  const recent = readList(payload, "recentTransactions", "transactions");
  const warnings = readList(payload, "warnings", "insights");

  const totalCash = numberFrom(payload.totalCashMinor ?? payload.totalCash);
  const netWorth = numberFrom(payload.netWorthMinor ?? payload.netWorth);
  const income = numberFrom(month.incomeMinor ?? payload.incomeMinor);
  const spending = numberFrom(month.spendingMinor ?? month.expensesMinor ?? payload.spendingMinor);
  const net = numberFrom(month.netCashFlowMinor ?? payload.netCashFlowMinor, income - spending);
  const savingsRate = numberFrom(month.savingsRate ?? payload.savingsRate);
  const remainingBudget = numberFrom(month.remainingBudgetMinor ?? payload.remainingBudgetMinor);
  const budgetTotal = numberFrom(month.budgetTotalMinor ?? month.budgetMinor);
  const budgetApplicable = month.budgetApplicable === true;
  const obligationRemindersDisabled = reminders.dueSoonEnabled === false && reminders.overdueEnabled === false;

  return (
    <Page>
      <ViewHeader
        eyebrow={t("finance.dashboard.header.eyebrow")}
        title={t("finance.dashboard.header.title")}
        description={t("finance.dashboard.header.description", { range: rangeLabel })}
        actions={
          <>
            <Link className={`${ui.button} ${ui.button_secondary}`} href="/planned?new=1">
              <CalendarClock size={16} aria-hidden="true" /> {t("finance.dashboard.actions.planPayment")}
            </Link>
            <Link className={`${ui.button} ${ui.button_primary}`} href="/transactions?new=1">
              <Plus size={16} aria-hidden="true" /> {t("finance.dashboard.actions.addTransaction")}
            </Link>
          </>
        }
      />

      <DataState loading={loading} error={error} onRetry={reload}>
        <div className={styles.topMetrics}>
          <Metric
            label={t("finance.dashboard.metrics.totalCash.label")}
            value={formatMoney(totalCash)}
            detail={t("finance.dashboard.metrics.totalCash.detail")}
            tone="accent"
            info={t("finance.dashboard.metrics.totalCash.info", {
              balanceDate: reportingBasis.currentBalances
                ? formatDate(reportingBasis.currentBalances)
                : t("finance.dashboard.reportingBasis.latestBalance"),
              source: rateSourceLabel(stringFrom(reportingBasis.source), t),
            })}
          />
          <Metric
            label={t("finance.dashboard.metrics.netWorth.label")}
            value={formatMoney(netWorth)}
            detail={t("finance.dashboard.metrics.netWorth.detail")}
            info={t("finance.dashboard.metrics.netWorth.info")}
          />
          <Metric
            label={t("finance.dashboard.metrics.cashFlow.label")}
            value={formatMoney(net)}
            detail={t("finance.dashboard.metrics.cashFlow.detail", { range: rangeLabel, income: formatMoney(income), spending: formatMoney(spending) })}
            tone={net >= 0 ? "positive" : "negative"}
            info={t("finance.dashboard.metrics.cashFlow.info", { basis: actualFlowBasisLabel(stringFrom(reportingBasis.actualFlows), t) })}
          />
          <Metric
            label={t("finance.dashboard.metrics.savingsRate.label")}
            value={`${savingsRate.toLocaleString(workspaceLocale(), { maximumFractionDigits: 1 })}%`}
            detail={t("finance.dashboard.metrics.savingsRate.detail")}
            tone={savingsRate >= 20 ? "positive" : savingsRate < 0 ? "negative" : "default"}
            info={t("finance.dashboard.metrics.savingsRate.info")}
          />
          <Metric
            label={t("finance.dashboard.metrics.budgetRemaining.label")}
            value={budgetApplicable ? formatMoney(remainingBudget) : t("finance.dashboard.common.unavailable")}
            detail={budgetApplicable ? (budgetTotal ? t("finance.dashboard.metrics.budgetRemaining.available", { percentage: Math.max(0, Math.round((remainingBudget / budgetTotal) * 100)) }) : t("finance.dashboard.metrics.budgetRemaining.noBudget")) : t("finance.dashboard.metrics.budgetRemaining.chooseMonth")}
            tone={budgetApplicable && remainingBudget < 0 ? "negative" : "default"}
            info={t("finance.dashboard.metrics.budgetRemaining.info")}
          />
        </div>

        <div className={styles.dashboardGrid}>
          <div className={styles.dashboardColumn}>
            <Section
              title={t("finance.dashboard.accounts.title")}
              description={t("finance.dashboard.accounts.description")}
              action={<Link className={`${ui.button} ${ui.button_ghost}`} href="/accounts">{t("finance.dashboard.accounts.manage")} <ArrowRight size={15} /></Link>}
              className={styles.accountsSection}
            >
              {accounts.length ? (
                <div className={styles.accountList}>
                  {accounts.slice(0, 7).map((item, index) => {
                    const account = readRecord(item);
                    const type = stringFrom(account.type, "account");
                    const balance = numberFrom(account.balanceMinor ?? account.currentBalanceMinor);
                    return (
                      <div className={styles.accountRow} key={stringFrom(account.id, String(index))}>
                        <span className={styles.accountIcon} aria-hidden="true">
                          {type === "cash" ? <WalletCards size={18} /> : type === "credit_card" || type === "credit" ? <CreditCard size={18} /> : <Landmark size={18} />}
                        </span>
                        <span className={styles.accountName}>
                          <strong>{stringFrom(account.name, t("finance.dashboard.accounts.fallbackName"))}</strong>
                          <small>{accountTypeLabel(type, t)}</small>
                        </span>
                        <strong className={balance < 0 ? ui.tone_negative : undefined}>{formatMoney(balance, stringFrom(account.currency, DEFAULT_CURRENCY))}</strong>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className={styles.compactEmpty}>
                  <WalletCards size={22} aria-hidden="true" />
                  <span>{t("finance.dashboard.accounts.empty")}</span>
                  <Link className={`${ui.button} ${ui.button_secondary}`} href="/accounts?new=1">{t("finance.dashboard.accounts.setUp")}</Link>
                </div>
              )}
            </Section>

            <Section
              title={t("finance.dashboard.transactions.title")}
              description={t("finance.dashboard.transactions.description", { range: rangeLabel })}
              action={<Link className={`${ui.button} ${ui.button_ghost}`} href="/transactions">{t("finance.dashboard.transactions.seeAll")} <ArrowRight size={15} /></Link>}
              className={styles.activitySection}
            >
              {recent.length ? (
                <div className={styles.transactionList}>
                  {recent.slice(0, 8).map((item, index) => {
                    const transaction = readRecord(item);
                    const type = stringFrom(transaction.kind ?? transaction.type, "expense");
                    const rawAmount = numberFrom(transaction.amountMinor);
                    const signedAmount = type === "expense" ? -Math.abs(rawAmount) : type === "income" || type === "refund" ? Math.abs(rawAmount) : rawAmount;
                    const accountCurrency = stringFrom(transaction.accountCurrency ?? transaction.currency, DEFAULT_CURRENCY);
                    const originalCurrency = stringFrom(transaction.originalCurrency);
                    const originalAmountMinor = numberFrom(transaction.originalAmountMinor);
                    const hasOriginalAmount = Boolean(originalCurrency && originalCurrency !== accountCurrency && originalAmountMinor > 0);
                    const originalSignedAmount = signedAmount < 0 ? -originalAmountMinor : originalAmountMinor;
                    const fxSource = stringFrom(transaction.fxRateSource);
                    const fxDate = transaction.fxRateDate ? formatDate(transaction.fxRateDate, { day: "2-digit", month: "short", year: undefined }) : "";
                    const fxProvenance = fxSource === "bnr"
                      ? fxDate ? t("finance.dashboard.transactions.fx.bnrDated", { date: fxDate }) : t("finance.dashboard.transactions.fx.bnr")
                      : fxSource === "manual"
                        ? fxDate ? t("finance.dashboard.transactions.fx.manualDated", { date: fxDate }) : t("finance.dashboard.transactions.fx.manual")
                        : t("finance.dashboard.transactions.fx.other");
                    return (
                      <div className={styles.transactionRow} key={stringFrom(transaction.id, String(index))}>
                        <span className={styles.transactionIcon}><ReceiptText size={16} aria-hidden="true" /></span>
                        <span>
                          <strong>{stringFrom(transaction.merchantName ?? transaction.merchant ?? transaction.description, transactionTypeLabel(type, t))}</strong>
                          <small>{t("finance.dashboard.transactions.context", { date: formatDate(transaction.date, { day: "2-digit", month: "short" }), account: stringFrom(transaction.accountName ?? transaction.account, t("finance.dashboard.accounts.fallbackName")) })}</small>
                        </span>
                        <span className={`${styles.transactionAmount} ${hasOriginalAmount ? styles.transactionAmountFx : ""}`}>
                          <strong className={signedAmount > 0 ? styles.positive : signedAmount < 0 ? styles.negative : undefined}>{signedAmount > 0 ? "+" : ""}{formatMoney(signedAmount, accountCurrency)}</strong>
                          {hasOriginalAmount ? <small className={styles.fxOriginal}>{t("finance.dashboard.transactions.originalAmount", { amount: `${originalSignedAmount > 0 ? "+" : ""}${formatMoney(originalSignedAmount, originalCurrency)}`, provenance: fxProvenance })}</small> : null}
                          <Pill tone={transactionTone(type)}>{transactionTypeLabel(type, t)}</Pill>
                        </span>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className={styles.compactEmpty}>
                  <ReceiptText size={22} aria-hidden="true" />
                  <span>{t("finance.dashboard.transactions.empty")}</span>
                  <Link className={`${ui.button} ${ui.button_secondary}`} href="/transactions?new=1">{t("finance.dashboard.actions.addTransaction")}</Link>
                </div>
              )}
            </Section>
          </div>

          <div className={styles.dashboardColumn}>
            <Section
              title={t("finance.dashboard.forecast.title")}
              description={t("finance.dashboard.forecast.description")}
              action={<Pill tone="info">{t("finance.dashboard.forecast.estimate")}</Pill>}
              className={styles.forecastSection}
            >
              <div className={styles.forecastHero}>
                <span>{t("finance.dashboard.forecast.projectedClosing")}</span>
                <strong>{formatMoney(forecast.closingBalanceMinor ?? forecast.projectedClosingMinor)}</strong>
                <small>{t("finance.dashboard.forecast.lowestPoint", { amount: formatMoney(forecast.lowestCashPointMinor) })}</small>
              </div>
              <div className={styles.forecastRows}>
                <div><span><ArrowUpRight size={15} /> {t("finance.dashboard.forecast.expectedIncome")}</span><strong>{formatMoney(forecast.expectedIncomeMinor)}</strong></div>
                <div><span><ArrowDownRight size={15} /> {t("finance.dashboard.forecast.plannedSpending")}</span><strong>{formatMoney(forecast.expectedExpensesMinor ?? forecast.plannedSpendingMinor)}</strong></div>
                <div><span><ArrowDownRight size={15} /> {t("finance.dashboard.forecast.cashObligations")}</span><strong>{formatMoney(forecast.expectedCashOutflowMinor ?? forecast.expectedExpensesMinor)}</strong></div>
                <div><span>{t("finance.dashboard.forecast.confidence")}</span><Progress value={numberFrom(forecast.confidence, 0)} max={100} /></div>
              </div>
              <Link className={styles.sectionLink} href="/planning">{t("finance.dashboard.forecast.open")} <ArrowRight size={14} /></Link>
            </Section>

            <Section
              title={t("finance.dashboard.obligations.title")}
              description={t("finance.dashboard.obligations.description", { basis: plannedBasisLabel(stringFrom(reportingBasis.plannedAmounts), t) })}
              action={<Link className={`${ui.button} ${ui.button_ghost}`} href="/planned">{t("finance.dashboard.obligations.viewSchedule")} <ArrowRight size={15} /></Link>}
              className={styles.obligationsSection}
            >
              {overdue.length + dueSoon.length ? (
                <div className={styles.obligationList}>
                  {[...overdue, ...dueSoon].slice(0, 6).map((item, index) => {
                    const payment = readRecord(item);
                    const isOverdue = stringFrom(payment.status) === "overdue" || overdue.includes(item);
                    return (
                      <div className={styles.obligationRow} key={stringFrom(payment.id, String(index))}>
                        <span className={styles.dueDate}>
                          <small>{isOverdue ? t("finance.dashboard.obligations.overdue") : t("finance.dashboard.obligations.due")}</small>
                          <strong>{formatDate(payment.dueDate ?? payment.date, { day: "2-digit", month: "short" })}</strong>
                        </span>
                        <span>
                          <strong>{stringFrom(payment.name ?? payment.title ?? payment.merchant, t("finance.dashboard.obligations.fallbackName"))}</strong>
                          <small>{stringFrom(payment.categoryName ?? payment.category, t("finance.dashboard.obligations.uncategorised"))}</small>
                        </span>
                        <span className={styles.obligationAmount}>
                          <strong>{formatMoney(payment.expectedAmountMinor ?? payment.amountMinor)}</strong>
                          <Pill tone={isOverdue ? "negative" : "warning"}>{paymentStatusLabel(stringFrom(payment.status), isOverdue, t)}</Pill>
                        </span>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className={styles.compactEmpty}>
                  <CalendarClock size={22} aria-hidden="true" />
                  <span>{obligationRemindersDisabled ? t("finance.dashboard.obligations.remindersDisabled") : t("finance.dashboard.obligations.empty")}</span>
                  <Link className={`${ui.button} ${ui.button_secondary}`} href={obligationRemindersDisabled ? "/settings" : "/planned?new=1"}>
                    {obligationRemindersDisabled ? t("finance.dashboard.obligations.manageReminders") : t("finance.dashboard.actions.planPayment")}
                  </Link>
                </div>
              )}
            </Section>
          </div>
        </div>

        <Section
          title={t("finance.dashboard.review.title")}
          description={t("finance.dashboard.review.description")}
          action={<Link className={`${ui.button} ${ui.button_ghost}`} href="/statistics">{t("finance.dashboard.review.exploreStatistics")} <ArrowRight size={15} /></Link>}
        >
          {warnings.length ? (
            <div className={styles.warningGrid}>
              {warnings.slice(0, 4).map((item, index) => {
                const warning = readRecord(item);
                const severity = stringFrom(warning.severity, "info");
                const content = warningContent(warning, t);
                return (
                  <div className={styles.warningItem} key={stringFrom(warning.id, String(index))}>
                    <AlertTriangle size={18} aria-hidden="true" />
                    <span>
                      <strong>{content.title}</strong>
                      <small>{content.description}</small>
                    </span>
                    <Pill tone={severity === "danger" || severity === "high" ? "negative" : severity === "warning" || severity === "medium" ? "warning" : "info"}>{severityLabel(severity, t)}</Pill>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className={styles.noWarnings}>{t("finance.dashboard.review.empty")}</div>
          )}
        </Section>
      </DataState>
    </Page>
  );
}
