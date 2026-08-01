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
import { DEFAULT_CURRENCY } from "@/lib/currencies";
import styles from "./dashboard.module.css";

type DashboardPayload = Record<string, unknown>;

function transactionTone(type: string) {
  if (type === "income" || type === "refund") return "positive" as const;
  if (type === "expense") return "negative" as const;
  return "neutral" as const;
}

export default function DashboardPage() {
  const { range, label: rangeLabel } = useDateRange();
  const dashboardUrl = useMemo(() => {
    const params = new URLSearchParams({ from: range.from, to: range.to });
    return `/api/dashboard?${params.toString()}`;
  }, [range.from, range.to]);
  const fallback: DashboardPayload = {};
  const { data: raw, loading, error, reload } = useJson<DashboardPayload>(dashboardUrl, fallback);
  const payload = readRecord(readRecord(raw).data ?? raw);
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
        eyebrow="Overview"
        title="Your money, today"
        description={`Current balances and obligations, with actual activity for ${rangeLabel}. Plans and projections remain clearly separate.`}
        actions={
          <>
            <Link className={`${ui.button} ${ui.button_secondary}`} href="/planned?new=1">
              <CalendarClock size={16} aria-hidden="true" /> Plan payment
            </Link>
            <Link className={`${ui.button} ${ui.button_primary}`} href="/transactions?new=1">
              <Plus size={16} aria-hidden="true" /> Add transaction
            </Link>
          </>
        }
      />

      <DataState loading={loading} error={error} onRetry={reload}>
        <div className={styles.topMetrics}>
          <Metric
            label="Total cash"
            value={formatMoney(totalCash)}
            detail="Current, savings and cash accounts"
            tone="accent"
            info="Sum of actual balances in liquid accounts. Planned payments are excluded until paid."
          />
          <Metric
            label="Net worth"
            value={formatMoney(netWorth)}
            detail="Assets minus credit balances"
            info="Actual balances across all active accounts, with liabilities subtracted."
          />
          <Metric
            label="Cash flow"
            value={formatMoney(net)}
            detail={`${rangeLabel} · ${formatMoney(income)} in · ${formatMoney(spending)} out`}
            tone={net >= 0 ? "positive" : "negative"}
            info="Actual income minus actual spending in the selected date range. Transfers are excluded."
          />
          <Metric
            label="Savings rate"
            value={`${savingsRate.toLocaleString(workspaceLocale(), { maximumFractionDigits: 1 })}%`}
            detail="Of actual income in the selected range"
            tone={savingsRate >= 20 ? "positive" : savingsRate < 0 ? "negative" : "default"}
            info="(Actual income − actual spending) ÷ actual income × 100 for the selected date range. Transfers and planned payments are excluded."
          />
          <Metric
            label="Budget remaining"
            value={budgetApplicable ? formatMoney(remainingBudget) : "—"}
            detail={budgetApplicable ? (budgetTotal ? `${Math.max(0, Math.round((remainingBudget / budgetTotal) * 100))}% available` : "No monthly budget yet") : "Choose one full month to compare budgets"}
            tone={budgetApplicable && remainingBudget < 0 ? "negative" : "default"}
            info="For a selected full calendar month, category budgets less actual eligible spending."
          />
        </div>

        <div className={styles.dashboardGrid}>
          <div className={styles.dashboardColumn}>
            <Section
              title="Accounts"
              description="Reconciled actual balances"
              action={<Link className={`${ui.button} ${ui.button_ghost}`} href="/accounts">Manage <ArrowRight size={15} /></Link>}
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
                          <strong>{stringFrom(account.name, "Account")}</strong>
                          <small>{type.replaceAll("_", " ")}</small>
                        </span>
                        <strong className={balance < 0 ? ui.tone_negative : undefined}>{formatMoney(balance, stringFrom(account.currency, DEFAULT_CURRENCY))}</strong>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className={styles.compactEmpty}>
                  <WalletCards size={22} aria-hidden="true" />
                  <span>Add an account to start tracking real balances.</span>
                  <Link className={`${ui.button} ${ui.button_secondary}`} href="/accounts?new=1">Set up account</Link>
                </div>
              )}
            </Section>

            <Section
              title="Recent transactions"
              description={`Cleared and pending transaction activity in ${rangeLabel}`}
              action={<Link className={`${ui.button} ${ui.button_ghost}`} href="/transactions">See all <ArrowRight size={15} /></Link>}
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
                    const fxProvenance = fxSource === "bnr" ? `BNR${fxDate ? ` · ${fxDate}` : ""}` : fxSource === "manual" ? `Manual FX${fxDate ? ` · ${fxDate}` : ""}` : "FX";
                    return (
                      <div className={styles.transactionRow} key={stringFrom(transaction.id, String(index))}>
                        <span className={styles.transactionIcon}><ReceiptText size={16} aria-hidden="true" /></span>
                        <span>
                          <strong>{stringFrom(transaction.merchantName ?? transaction.merchant ?? transaction.description, type.replaceAll("_", " "))}</strong>
                          <small>{formatDate(transaction.date, { day: "2-digit", month: "short" })} · {stringFrom(transaction.accountName ?? transaction.account, "Account")}</small>
                        </span>
                        <span className={`${styles.transactionAmount} ${hasOriginalAmount ? styles.transactionAmountFx : ""}`}>
                          <strong className={signedAmount > 0 ? styles.positive : signedAmount < 0 ? styles.negative : undefined}>{signedAmount > 0 ? "+" : ""}{formatMoney(signedAmount, accountCurrency)}</strong>
                          {hasOriginalAmount ? <small className={styles.fxOriginal}>{originalSignedAmount > 0 ? "+" : ""}{formatMoney(originalSignedAmount, originalCurrency)} · {fxProvenance}</small> : null}
                          <Pill tone={transactionTone(type)}>{type}</Pill>
                        </span>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className={styles.compactEmpty}>
                  <ReceiptText size={22} aria-hidden="true" />
                  <span>No actual transactions in the selected range.</span>
                  <Link className={`${ui.button} ${ui.button_secondary}`} href="/transactions?new=1">Add transaction</Link>
                </div>
              )}
            </Section>
          </div>

          <div className={styles.dashboardColumn}>
            <Section
              title="Next-month forecast"
              description="Projection · does not change actual balances"
              action={<Pill tone="info">Estimate</Pill>}
              className={styles.forecastSection}
            >
              <div className={styles.forecastHero}>
                <span>Projected closing cash</span>
                <strong>{formatMoney(forecast.closingBalanceMinor ?? forecast.projectedClosingMinor)}</strong>
                <small>Lowest projected point: {formatMoney(forecast.lowestCashPointMinor)}</small>
              </div>
              <div className={styles.forecastRows}>
                <div><span><ArrowUpRight size={15} /> Expected income</span><strong>{formatMoney(forecast.expectedIncomeMinor)}</strong></div>
                <div><span><ArrowDownRight size={15} /> Planned spending</span><strong>{formatMoney(forecast.expectedExpensesMinor ?? forecast.plannedSpendingMinor)}</strong></div>
                <div><span><ArrowDownRight size={15} /> Cash obligations</span><strong>{formatMoney(forecast.expectedCashOutflowMinor ?? forecast.expectedExpensesMinor)}</strong></div>
                <div><span>Confidence</span><Progress value={numberFrom(forecast.confidence, 0)} max={100} /></div>
              </div>
              <Link className={styles.sectionLink} href="/planning">Open monthly forecast <ArrowRight size={14} /></Link>
            </Section>

            <Section
              title="Bills and obligations"
              description="Planned amounts stay outside actual balances"
              action={<Link className={`${ui.button} ${ui.button_ghost}`} href="/planned">View schedule <ArrowRight size={15} /></Link>}
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
                          <small>{isOverdue ? "Overdue" : "Due"}</small>
                          <strong>{formatDate(payment.dueDate ?? payment.date, { day: "2-digit", month: "short" })}</strong>
                        </span>
                        <span>
                          <strong>{stringFrom(payment.name ?? payment.title ?? payment.merchant, "Planned payment")}</strong>
                          <small>{stringFrom(payment.categoryName ?? payment.category, "Uncategorised")}</small>
                        </span>
                        <span className={styles.obligationAmount}>
                          <strong>{formatMoney(payment.expectedAmountMinor ?? payment.amountMinor)}</strong>
                          <Pill tone={isOverdue ? "negative" : "warning"}>{isOverdue ? "overdue" : stringFrom(payment.status, "planned")}</Pill>
                        </span>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className={styles.compactEmpty}>
                  <CalendarClock size={22} aria-hidden="true" />
                  <span>{obligationRemindersDisabled ? "Bill and overdue reminders are disabled." : "No obligations match your enabled reminder window."}</span>
                  <Link className={`${ui.button} ${ui.button_secondary}`} href={obligationRemindersDisabled ? "/settings" : "/planned?new=1"}>
                    {obligationRemindersDisabled ? "Manage reminders" : "Plan a payment"}
                  </Link>
                </div>
              )}
            </Section>
          </div>
        </div>

        <Section
          title="Items to review"
          description="Transparent observations based on recorded activity — not financial advice"
          action={<Link className={`${ui.button} ${ui.button_ghost}`} href="/statistics">Explore statistics <ArrowRight size={15} /></Link>}
        >
          {warnings.length ? (
            <div className={styles.warningGrid}>
              {warnings.slice(0, 4).map((item, index) => {
                const warning = readRecord(item);
                const severity = stringFrom(warning.severity, "info");
                return (
                  <div className={styles.warningItem} key={stringFrom(warning.id, String(index))}>
                    <AlertTriangle size={18} aria-hidden="true" />
                    <span>
                      <strong>{stringFrom(warning.title, "Spending pattern")}</strong>
                      <small>{stringFrom(warning.description ?? warning.message)}</small>
                    </span>
                    <Pill tone={severity === "high" ? "negative" : severity === "medium" ? "warning" : "info"}>{severity}</Pill>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className={styles.noWarnings}>No unusual changes detected from the actual data available.</div>
          )}
        </Section>
      </DataState>
    </Page>
  );
}
