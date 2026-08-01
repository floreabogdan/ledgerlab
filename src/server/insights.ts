import { randomUUID } from "node:crypto";

import { HttpError } from "@/lib/api-response";
import { monthKeyInput } from "@/lib/validation";
import {
  all,
  audit,
  database,
  listAccounts,
  listCategories,
  listPlannedPayments,
  listTransactions,
  materializePlannedOccurrences,
  one,
} from "@/server/core";
import { enrichLiabilityAccounts, listLiabilityObligations } from "@/server/liabilities";
import {
  sumInReportingCurrency,
  toReportingMinor,
  toReportingValue,
} from "@/server/reporting-currency";
import { getUserCalendarContext, getUserRegionalSettings } from "@/server/user-settings";

function nextMonth(month: string, amount = 1) {
  const [year, value] = month.split("-").map(Number);
  const date = new Date(Date.UTC(year, value - 1 + amount, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function requireMonthKey(value: string, label = "month") {
  const parsed = monthKeyInput.safeParse(value);
  if (!parsed.success) throw new HttpError(422, `Choose a valid ${label} in YYYY-MM format`);
  return parsed.data;
}

function monthEnd(month: string) {
  const next = nextMonth(month);
  const date = new Date(`${next}-01T00:00:00.000Z`);
  date.setUTCDate(0);
  return date.toISOString().slice(0, 10);
}

function addDays(dateKey: string, days: number) {
  const date = new Date(`${dateKey}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export interface InsightDateRange {
  from: string;
  to: string;
}

function normalizeInsightRange(range?: InsightDateRange, currentMonth?: string): InsightDateRange {
  if (!range) {
    if (!currentMonth) throw new Error("A workspace-local month is required when no insight range is supplied");
    return { from: `${currentMonth}-01`, to: monthEnd(currentMonth) };
  }
  const validDate = /^\d{4}-\d{2}-\d{2}$/;
  const isCalendarDate = (value: string) => {
    if (!validDate.test(value)) return false;
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  };
  if (!isCalendarDate(range.from) || !isCalendarDate(range.to) || range.from > range.to) {
    throw new HttpError(422, "Choose a valid date range");
  }
  return range;
}

function monthsInRange(from: string, to: string) {
  const result: string[] = [];
  let cursor = from.slice(0, 7);
  const last = to.slice(0, 7);
  while (cursor <= last) {
    result.push(cursor);
    cursor = nextMonth(cursor);
  }
  return result;
}

function inclusiveDayCount(from: string, to: string) {
  return Math.round((new Date(`${to}T00:00:00.000Z`).getTime() - new Date(`${from}T00:00:00.000Z`).getTime()) / 86_400_000) + 1;
}

function shiftDateYear(dateKey: string, amount: number) {
  const [year, month, day] = dateKey.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year + amount, month, 0)).getUTCDate();
  return `${year + amount}-${String(month).padStart(2, "0")}-${String(Math.min(day, lastDay)).padStart(2, "0")}`;
}

interface ActualSummary {
  incomeMinor: number;
  spendingMinor: number;
  netCashFlowMinor: number;
}

type ReportingTransactionRow = {
  id: string;
  kind: string;
  amountMinor: number;
  nativeAmountMinor: number;
  nativeCurrency: string;
  date: string;
  accountId: string;
  accountName: string;
  merchantId: string | null;
  merchantName: string;
};

function reportingTransactions(
  userId: string,
  from: string,
  toExclusive: string,
  context = "transaction statistics",
): ReportingTransactionRow[] {
  const reportingCurrency = workspaceCurrency(userId);
  return all<{
    id: string;
    kind: string;
    amountMinor: number;
    currency: string;
    date: string;
    accountId: string;
    accountName: string;
    merchantId: string | null;
    merchantName: string;
  }>(
    `SELECT t.id, t.kind, t.amount_minor AS amountMinor, t.currency,
            substr(t.occurred_at, 1, 10) AS date, t.account_id AS accountId,
            a.name AS accountName, t.merchant_id AS merchantId,
            COALESCE(m.name, t.merchant_text, 'Uncategorised') AS merchantName
       FROM transactions t
       JOIN accounts a ON a.id = t.account_id
       LEFT JOIN merchants m ON m.id = t.merchant_id
      WHERE t.user_id = ? AND t.status = 'cleared' AND t.voided_at IS NULL
        AND substr(t.occurred_at, 1, 10) >= ? AND substr(t.occurred_at, 1, 10) < ?`,
    [userId, from, toExclusive],
  ).map((row) => ({
    id: row.id,
    kind: row.kind,
    nativeAmountMinor: row.amountMinor,
    nativeCurrency: row.currency,
    amountMinor: toReportingMinor(row, reportingCurrency, context),
    date: row.date,
    accountId: row.accountId,
    accountName: row.accountName,
    merchantId: row.merchantId,
    merchantName: row.merchantName,
  }));
}

type ReportingSpendingAllocation = {
  transactionId: string;
  amountMinor: number;
  date: string;
  categoryId: string;
  categoryName: string;
  nature: string;
  priority: string;
};

function reportingSpendingAllocations(
  userId: string,
  from: string,
  toExclusive: string,
  context = "spending statistics",
): ReportingSpendingAllocation[] {
  const reportingCurrency = workspaceCurrency(userId);
  return all<{
    transactionId: string;
    amountMinor: number;
    currency: string;
    date: string;
    categoryId: string;
    categoryName: string;
    nature: string;
    priority: string;
  }>(
    `SELECT t.id AS transactionId,
            CASE WHEN t.is_split = 1 THEN s.amount_minor ELSE t.amount_minor END AS amountMinor,
            t.currency, substr(t.occurred_at, 1, 10) AS date,
            COALESCE(c.id, 'uncategorised') AS categoryId,
            COALESCE(c.name, 'Uncategorised') AS categoryName,
            COALESCE(c.spending_nature, 'variable') AS nature,
            COALESCE(c.spending_priority, 'discretionary') AS priority
       FROM transactions t
       LEFT JOIN transaction_splits s ON s.transaction_id = t.id AND t.is_split = 1
       LEFT JOIN categories c ON c.id = COALESCE(s.category_id, t.category_id)
      WHERE t.user_id = ? AND t.status = 'cleared' AND t.voided_at IS NULL
        AND t.kind IN ('expense', 'refund')
        AND substr(t.occurred_at, 1, 10) >= ? AND substr(t.occurred_at, 1, 10) < ?`,
    [userId, from, toExclusive],
  ).map((row) => ({
    transactionId: row.transactionId,
    amountMinor: toReportingMinor(row, reportingCurrency, context),
    date: row.date,
    categoryId: row.categoryId,
    categoryName: row.categoryName,
    nature: row.nature,
    priority: row.priority,
  }));
}

function groupedSpend<T extends { amountMinor: number; transactionId: string }>(
  rows: readonly T[],
  keyFor: (row: T) => { id: string; name: string },
) {
  const grouped = new Map<string, { id: string; name: string; signedMinor: number; transactionIds: Set<string> }>();
  for (const row of rows) {
    const key = keyFor(row);
    const current = grouped.get(key.id) ?? { ...key, signedMinor: 0, transactionIds: new Set<string>() };
    current.signedMinor += row.amountMinor;
    current.transactionIds.add(row.transactionId);
    grouped.set(key.id, current);
  }
  return [...grouped.values()]
    .map((item) => ({
      id: item.id,
      name: item.name,
      amountMinor: Math.max(0, -item.signedMinor),
      count: item.transactionIds.size,
    }))
    .sort((left, right) => right.amountMinor - left.amountMinor);
}

function actualSummary(userId: string, from: string, toExclusive: string): ActualSummary {
  const reportingCurrency = workspaceCurrency(userId);
  const rows = all<{ kind: string; amountMinor: number; currency: string; date: string }>(
    `SELECT kind, amount_minor AS amountMinor, currency, substr(occurred_at, 1, 10) AS date
       FROM transactions
      WHERE user_id = ? AND status = 'cleared' AND voided_at IS NULL
        AND kind IN ('income', 'expense', 'refund')
        AND substr(occurred_at, 1, 10) >= ? AND substr(occurred_at, 1, 10) < ?`,
    [userId, from, toExclusive],
  ).map((row) => ({
    ...row,
    amountMinor: toReportingMinor(row, reportingCurrency, "actual cash flow"),
  }));
  const incomeMinor = rows
    .filter((row) => row.kind === "income")
    .reduce((sum, row) => sum + row.amountMinor, 0);
  const grossSpendingMinor = Math.max(0, -rows
    .filter((row) => row.kind === "expense")
    .reduce((sum, row) => sum + row.amountMinor, 0));
  const refundsMinor = Math.max(0, rows
    .filter((row) => row.kind === "refund")
    .reduce((sum, row) => sum + row.amountMinor, 0));
  const spendingMinor = Math.max(0, grossSpendingMinor - refundsMinor);
  return {
    incomeMinor,
    spendingMinor,
    netCashFlowMinor: incomeMinor - spendingMinor,
  };
}

function balanceHistory(userId: string, accountId: string, opening: number, openingDate: string, requestedRange?: InsightDateRange) {
  const range = requestedRange ? normalizeInsightRange(requestedRange) : undefined;
  if (range && range.to < openingDate) return [];
  const historyStart = range && range.from > openingDate ? range.from : openingDate;
  const activityWhere = range
    ? "AND substr(occurred_at, 1, 10) >= ? AND substr(occurred_at, 1, 10) <= ?"
    : "AND substr(occurred_at, 1, 10) >= ?";
  const activityParams = range
    ? [userId, accountId, historyStart, range.to]
    : [userId, accountId, openingDate];
  const activity = all<{ month: string; amountMinor: number }>(
    `SELECT substr(occurred_at, 1, 7) AS month, SUM(amount_minor) AS amountMinor
       FROM transactions
      WHERE user_id = ? AND account_id = ? AND status = 'cleared' AND voided_at IS NULL
        ${activityWhere}
      GROUP BY substr(occurred_at, 1, 7) ORDER BY month`,
    activityParams,
  );
  const beforeRange = range && historyStart > openingDate
    ? one<{ amountMinor: number }>(
      `SELECT COALESCE(SUM(amount_minor), 0) AS amountMinor FROM transactions
        WHERE user_id = ? AND account_id = ? AND status = 'cleared' AND voided_at IS NULL
          AND substr(occurred_at, 1, 10) >= ? AND substr(occurred_at, 1, 10) < ?`,
      [userId, accountId, openingDate, historyStart],
    )?.amountMinor ?? 0
    : 0;
  let balance = opening + beforeRange;
  const history: Array<{ date: string; balanceMinor: number }> = [
    { date: historyStart, balanceMinor: balance },
  ];
  for (const row of activity) {
    balance += row.amountMinor;
    const rowEnd = monthEnd(row.month);
    history.push({ date: range && rowEnd > range.to ? range.to : rowEnd, balanceMinor: balance });
  }
  return history;
}

export function accountsPayload(userId: string, range?: InsightDateRange) {
  const defaultCurrency = workspaceCurrency(userId);
  const reportingDate = getUserCalendarContext(userId).today;
  return {
    defaultCurrency,
    reportingBasis: {
      currency: defaultCurrency,
      balanceDate: reportingDate,
      rule: "Account balances stay native; reporting balances use the latest persisted BNR rate on or before the as-of date.",
    },
    accounts: enrichLiabilityAccounts(userId, listAccounts(userId, true)).map((account) => {
      const reporting = toReportingValue(
        { amountMinor: account.balanceMinor, currency: account.currency, date: reportingDate },
        defaultCurrency,
        `the reporting balance for ${account.name}`,
      );
      return {
        ...account,
        type: account.type === "current" ? "current_account" : account.type,
        customTypeLabel: account.customType,
        openingBalanceDate: account.openingDate,
        currentBalanceMinor: account.balanceMinor,
        reportingBalanceMinor: reporting.amountMinor,
        reportingCurrency: defaultCurrency,
        reportingConversion: reporting,
        reconciliationDifferenceMinor: 0,
        balanceHistory: balanceHistory(userId, account.id, account.openingBalanceMinor, account.openingDate, range),
      };
    }),
  };
}

function workspaceCurrency(userId: string) {
  return getUserRegionalSettings(userId).currency;
}

function savedUserSettings(userId: string, action: string) {
  const row = one<{ after: string | null }>(
    "SELECT after FROM audit_logs WHERE user_id = ? AND entity_type = 'user_settings' AND action = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
    [userId, action],
  );
  if (!row?.after) return {} as Record<string, unknown>;
  try {
    const parsed = JSON.parse(row.after) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {} as Record<string, unknown>;
  }
}

export function dashboard(userId: string, requestedRange?: InsightDateRange) {
  const calendar = getUserCalendarContext(userId);
  const range = normalizeInsightRange(requestedRange, calendar.month);
  const currentMonth = calendar.month;
  const nextStart = `${nextMonth(currentMonth)}-01`;
  const followingStart = `${nextMonth(currentMonth, 2)}-01`;
  const accounts = listAccounts(userId).map((account) => ({
    ...account,
    type: account.type === "current" ? "current_account" : account.type,
  }));
  const currency = workspaceCurrency(userId);
  const cashTypes = new Set(["current", "savings", "cash"]);
  const totalCashMinor = accounts
    .filter((account) => cashTypes.has(account.type === "current_account" ? "current" : account.type))
    .reduce((sum, account) => sum + toReportingMinor(
      { amountMinor: account.balanceMinor, currency: account.currency, date: calendar.today },
      currency,
      "total cash",
    ), 0);
  const netWorthMinor = accounts.reduce((sum, account) => sum + toReportingMinor(
    { amountMinor: account.balanceMinor, currency: account.currency, date: calendar.today },
    currency,
    "net worth",
  ), 0);
  const actual = actualSummary(userId, range.from, addDays(range.to, 1));
  const selectedMonths = monthsInRange(range.from, range.to);
  const budgetApplicable = selectedMonths.length === 1
    && range.from === `${selectedMonths[0]}-01`
    && range.to === monthEnd(selectedMonths[0]);
  const budget = budgetApplicable
    ? sumInReportingCurrency(
      all<{ amountMinor: number; currency: string }>(
        "SELECT amount_minor AS amountMinor, currency FROM budgets WHERE user_id = ? AND month = ?",
        [userId, selectedMonths[0]],
      ).map((row) => ({ ...row, date: `${selectedMonths[0]}-01` })),
      currency,
      "the selected monthly budget",
    )
    : 0;

  const reminders = savedUserSettings(userId, "reminders");
  const dueSoonEnabled = reminders.dueSoon !== false;
  const overdueEnabled = reminders.overdue !== false;
  const budgetWarningsEnabled = reminders.budgetWarnings !== false;
  const configuredDays = typeof reminders.daysBefore === "number" ? reminders.daysBefore : 3;
  const daysBefore = Math.min(30, Math.max(1, Number.isFinite(configuredDays) ? Math.round(configuredDays) : 3));

  const dueSoonEnd = addDays(calendar.today, daysBefore);
  const accountCurrencyById = new Map(accounts.map((account) => [account.id, account.currency]));
  const convertPlanned = (item: ReturnType<typeof listPlannedPayments>[number]) => {
    const outstanding = item.status === "paid" ? 0 : Math.max(item.expectedAmountMinor - item.paidAmountMinor, 0);
    const convert = (amountMinor: number) => toReportingMinor(
      { amountMinor, currency: item.currency, date: item.dueDate },
      currency,
      `the planned payment “${item.title}”`,
    );
    return {
      ...item,
      nativeCurrency: item.currency,
      nativeExpectedAmountMinor: item.expectedAmountMinor,
      nativePaidAmountMinor: item.paidAmountMinor,
      currency,
      expectedAmountMinor: convert(item.expectedAmountMinor),
      paidAmountMinor: convert(item.paidAmountMinor),
      cashFlowAmountMinor: convert(outstanding),
      spendingAmountMinor: item.direction === "expense" ? convert(outstanding) : 0,
    };
  };
  const convertLiability = (item: ReturnType<typeof listLiabilityObligations>[number]) => {
    const nativeCurrency = accountCurrencyById.get(item.liabilityAccountId)
      ?? (item.accountId ? accountCurrencyById.get(item.accountId) : undefined);
    if (!nativeCurrency) throw new HttpError(422, `Cannot determine the currency for ${item.title}`);
    const convert = (amountMinor: number) => toReportingMinor(
      { amountMinor, currency: nativeCurrency, date: item.dueDate },
      currency,
      `the liability obligation “${item.title}”`,
    );
    return {
      ...item,
      nativeCurrency,
      nativeExpectedAmountMinor: item.expectedAmountMinor,
      nativePaidAmountMinor: item.paidAmountMinor,
      currency,
      expectedAmountMinor: convert(item.expectedAmountMinor),
      paidAmountMinor: convert(item.paidAmountMinor),
      cashFlowAmountMinor: convert(item.cashFlowAmountMinor),
      spendingAmountMinor: convert(item.spendingAmountMinor),
      plannedSpendingAmountMinor: convert(item.plannedSpendingAmountMinor),
      principalAmountMinor: convert(item.principalAmountMinor),
    };
  };
  const planned = listPlannedPayments(userId, { from: calendar.today, to: followingStart }).map(convertPlanned);
  const liabilityPlanned = listLiabilityObligations(userId, { from: calendar.today, to: followingStart }).map(convertLiability);
  const allPlanned = [...planned, ...liabilityPlanned].sort((left, right) => left.dueDate.localeCompare(right.dueDate));
  const dueSoon = dueSoonEnabled
    ? allPlanned.filter((item) => item.dueDate <= dueSoonEnd && ["planned", "scheduled"].includes(String(item.status)))
    : [];
  const overdue = overdueEnabled
    ? [
        ...listPlannedPayments(userId, { to: addDays(calendar.today, -1), status: "overdue" }).map(convertPlanned),
        ...listLiabilityObligations(userId, { to: addDays(calendar.today, -1), status: "overdue" }).map(convertLiability),
      ]
    : [];
  const nextItems = allPlanned.filter((item) => item.dueDate >= nextStart && item.dueDate < followingStart && !["skipped", "cancelled", "paid"].includes(String(item.status)));
  const expectedIncomeMinor = nextItems
    .filter((item) => item.direction === "income")
    .reduce((sum, item) => sum + Number(item.expectedAmountMinor), 0);
  const expectedExpensesMinor = nextItems
    .filter((item) => item.direction === "expense")
    .reduce((sum, item) => sum + Number(item.spendingAmountMinor), 0);
  const expectedCashOutflowMinor = nextItems
    .filter((item) => item.direction === "expense")
    .reduce((sum, item) => sum + Number(item.cashFlowAmountMinor), 0);
  let running = totalCashMinor;
  let lowest = running;
  for (const item of nextItems) {
    running += item.direction === "income" ? Number(item.cashFlowAmountMinor) : -Number(item.cashFlowAmountMinor);
    lowest = Math.min(lowest, running);
  }

  const warnings: Array<{ id: string; title: string; description: string; severity: "info" | "warning" | "danger" }> = [];
  if (overdue.length) {
    warnings.push({
      id: "overdue",
      title: `${overdue.length} overdue ${overdue.length === 1 ? "payment" : "payments"}`,
      description: "Review these expected obligations; planned items do not change actual balances until paid.",
      severity: "danger",
    });
  }
  if (budgetWarningsEnabled && budget > 0 && actual.spendingMinor > budget) {
    warnings.push({
      id: "budget",
      title: "Budget allocation exceeded",
      description: `Actual spending in the selected range is ${Math.round(((actual.spendingMinor - budget) / budget) * 100)}% above the included monthly budget allocations.`,
      severity: "warning",
    });
  }
  if (lowest < 0) {
    warnings.push({
      id: "cash-point",
      title: "Projected cash drops below zero",
      description: "The next-month estimate has a negative low point. Check dates and assigned accounts.",
      severity: "warning",
    });
  }
  const selectedDays = inclusiveDayCount(range.from, range.to);
  const previous = actualSummary(userId, addDays(range.from, -selectedDays), range.from);
  if (previous.spendingMinor > 0 && actual.spendingMinor > previous.spendingMinor * 1.3) {
    warnings.push({
      id: "spend-change",
      title: "Spending is up from the prior period",
      description: `Actual spending is ${Math.round((actual.spendingMinor / previous.spendingMinor - 1) * 100)}% higher than the preceding equal-length range. Compare context before drawing conclusions.`,
      severity: "info",
    });
  }

  return {
    currency,
    reportingBasis: {
      actualFlows: "transaction_date",
      currentBalances: calendar.today,
      plannedAmounts: "due_date",
      source: "BNR persisted reference rates",
    },
    period: range,
    totalCashMinor,
    netWorthMinor,
    month: {
      ...actual,
      budgetApplicable,
      savingsRate: actual.incomeMinor ? (actual.netCashFlowMinor / actual.incomeMinor) * 100 : 0,
      remainingBudgetMinor: budget - actual.spendingMinor,
      budgetTotalMinor: budget,
    },
    accounts,
    reminders: { dueSoonEnabled, overdueEnabled, budgetWarningsEnabled, daysBefore },
    dueSoon,
    overdue,
    nextMonthForecast: {
      label: nextMonth(currentMonth),
      closingBalanceMinor: totalCashMinor + expectedIncomeMinor - expectedCashOutflowMinor,
      expectedIncomeMinor,
      expectedExpensesMinor,
      expectedCashOutflowMinor,
      lowestCashPointMinor: lowest,
    },
    recentTransactions: listTransactions(userId, { from: range.from, to: range.to, limit: 8 }),
    warnings,
  };
}

export function listBudgets(userId: string, month?: string) {
  month = requireMonthKey(month ?? getUserCalendarContext(userId).month, "budget month");
  const reportingCurrency = workspaceCurrency(userId);
  const storedBudgets = all<{
    id: string;
    month: string;
    categoryId: string | null;
    category: string | null;
    amountMinor: number;
    currency: string;
    rollover: number;
  }>(
    `SELECT b.id, b.month, b.category_id AS categoryId, c.name AS category,
            b.amount_minor AS amountMinor, b.currency, b.rollover
       FROM budgets b
       LEFT JOIN categories c ON c.id = b.category_id
      WHERE b.user_id = ? AND b.month = ?
      ORDER BY c.name`,
    [userId, month],
  );
  const allocationRows = reportingSpendingAllocations(
    userId,
    `${month}-01`,
    `${nextMonth(month)}-01`,
    `actual spending for the ${month} budget`,
  );
  const spentByCategory = new Map<string, number>();
  for (const row of allocationRows) {
    spentByCategory.set(row.categoryId, (spentByCategory.get(row.categoryId) ?? 0) + row.amountMinor);
  }
  const budgets = storedBudgets.map((item) => {
    const amountMinor = toReportingMinor(
      { amountMinor: item.amountMinor, currency: item.currency, date: `${month}-01` },
      reportingCurrency,
      `the ${month} budget for ${item.category ?? "Uncategorised"}`,
    );
    const spentMinor = Math.max(0, -(spentByCategory.get(item.categoryId ?? "uncategorised") ?? 0));
    return {
      ...item,
      nativeAmountMinor: item.amountMinor,
      nativeCurrency: item.currency,
      currency: reportingCurrency,
      amountMinor,
      spentMinor,
    };
  });
  return {
    currency: reportingCurrency,
    month,
    reportingBasis: {
      budgetDenomination: "stored per budget",
      actualFlows: "transaction_date",
      source: "BNR persisted reference rates",
    },
    budgets: budgets.map((item) => ({
      ...item,
      budgetMinor: item.amountMinor,
      remainingMinor: item.amountMinor - item.spentMinor,
      percentUsed: item.amountMinor ? (item.spentMinor / item.amountMinor) * 100 : 0,
    })),
    totalBudgetMinor: budgets.reduce((sum, item) => sum + item.amountMinor, 0),
    totalSpentMinor: budgets.reduce((sum, item) => sum + item.spentMinor, 0),
  };
}

export function saveBudget(
  userId: string,
  rawInput: {
    month: string;
    categoryId: string;
    amountMinor: number;
    rollover?: boolean;
    amountCurrency?: string;
  },
) {
  const input = { ...rawInput, month: requireMonthKey(rawInput.month, "budget month") };
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) {
    throw new HttpError(422, "Budget amount must be a positive integer in minor units");
  }
  const category = one("SELECT id FROM categories WHERE id = ? AND user_id = ? AND archived_at IS NULL", [input.categoryId, userId]);
  if (!category) throw new HttpError(422, "Choose an active category that belongs to your profile");
  const existing = one<{ id: string; currency: string }>(
    "SELECT id, currency FROM budgets WHERE user_id = ? AND month = ? AND category_id = ?",
    [userId, input.month, input.categoryId],
  );
  const id = existing?.id ?? randomUUID();
  const reportingCurrency = workspaceCurrency(userId);
  const amountCurrency = rawInput.amountCurrency?.trim().toUpperCase() ?? reportingCurrency;
  const currency = existing?.currency ?? amountCurrency;
  const storedAmountMinor = toReportingMinor(
    { amountMinor: input.amountMinor, currency: amountCurrency, date: `${input.month}-01` },
    currency,
    "the saved monthly budget",
  );
  database()
    .prepare(
      `INSERT INTO budgets (id, user_id, month, currency, category_id, amount_minor, rollover)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, month, category_id) DO UPDATE SET
         amount_minor = excluded.amount_minor, rollover = excluded.rollover,
         updated_at = CURRENT_TIMESTAMP`,
    )
    .run(id, userId, input.month, currency, input.categoryId, storedAmountMinor, input.rollover ? 1 : 0);
  audit(userId, "budget", id, existing ? "update" : "create", existing, input);
  return {
    id,
    ...input,
    currency: reportingCurrency,
    nativeAmountMinor: storedAmountMinor,
    nativeCurrency: currency,
  };
}

interface PlanInput {
  month: string;
  name?: string;
  expectedIncomeMinor?: number;
  discretionaryTargetMinor?: number | null;
  notes?: string | null;
  copyFromMonth?: string | null;
  action?: string;
  scenarioName?: string;
  openingBalances?: unknown[];
  items?: Array<{
    title: string;
    direction: "income" | "expense";
    amountMinor: number;
    expectedDate: string;
    accountId?: string | null;
    categoryId?: string | null;
    spendingNature?: "fixed" | "variable" | null;
    spendingPriority?: "essential" | "discretionary" | null;
  }>;
}

function getOrCreatePlan(userId: string, targetMonth: string, create = false) {
  let plan = one<Record<string, unknown>>(
    `SELECT id, month, currency, name, status, expected_income_minor AS expectedIncomeMinor,
            discretionary_target_minor AS discretionaryTargetMinor, notes
       FROM month_plans WHERE user_id = ? AND month = ?`,
    [userId, targetMonth],
  );
  if (!plan && create) {
    const id = randomUUID();
    const currency = workspaceCurrency(userId);
    database()
      .prepare("INSERT INTO month_plans (id, user_id, month, currency, name) VALUES (?, ?, ?, ?, 'Base plan')")
      .run(id, userId, targetMonth, currency);
    plan = { id, month: targetMonth, currency, name: "Base plan", status: "draft", expectedIncomeMinor: 0 };
  }
  return plan;
}

export function planningWorkspace(userId: string, targetMonth?: string) {
  const calendar = getUserCalendarContext(userId);
  targetMonth = requireMonthKey(targetMonth ?? nextMonth(calendar.month), "planning month");
  const plan = getOrCreatePlan(userId, targetMonth, false);
  const planId = typeof plan?.id === "string" ? plan.id : null;
  const accounts = listAccounts(userId);
  const occurrences = listPlannedPayments(userId, {
    from: `${targetMonth}-01`,
    to: monthEnd(targetMonth),
  }).filter((item) => !["skipped", "cancelled"].includes(String(item.status)));
  const liabilityObligations = listLiabilityObligations(userId, {
    from: `${targetMonth}-01`,
    to: monthEnd(targetMonth),
  }).filter((item) => !["skipped", "cancelled"].includes(String(item.status)));
  const accountTypeById = new Map(accounts.map((account) => [account.id, account.type]));
  const accountCurrencyById = new Map(accounts.map((account) => [account.id, account.currency]));
  const reportingCurrency = workspaceCurrency(userId);
  const cashTypes = new Set(["current", "savings", "cash"]);
  // Planned-payment occurrences are the canonical forecast inputs. Legacy
  // month_plan_items remain in storage for history, but must never replace or
  // duplicate the obligations generated by Planned Payments.
  const plannedLines = occurrences.map((item) => ({
    id: item.id,
    plannedPaymentId: item.plannedPaymentId,
    title: item.title,
    direction: item.direction,
    amountMinor: item.expectedAmountMinor,
    paidAmountMinor: item.paidAmountMinor,
    outstandingAmountMinor: item.status === "paid"
      ? 0
      : Math.max(item.expectedAmountMinor - item.paidAmountMinor, 0),
    expectedDate: item.dueDate,
    accountId: item.accountId,
    account: item.account,
    categoryId: item.categoryId,
    category: item.category,
    source: item.recurrenceRuleId ? "recurring planned payment" : "planned payment",
    status: item.status,
    actual: item.status === "paid",
    spendingNature: item.spendingNature,
    spendingPriority: item.spendingPriority,
    sourceType: "planned_payment",
    liabilityAccountId: null as string | null,
    cashFlowAmountMinor: !item.accountId
      || cashTypes.has(accountTypeById.get(item.accountId) ?? "")
      ? (item.status === "paid" ? 0 : Math.max(item.expectedAmountMinor - item.paidAmountMinor, 0))
      : 0,
    spendingAmountMinor: item.direction === "expense"
      ? (item.status === "paid" ? 0 : Math.max(item.expectedAmountMinor - item.paidAmountMinor, 0))
      : 0,
    plannedSpendingAmountMinor: item.direction === "expense" ? item.expectedAmountMinor : 0,
    principalAmountMinor: 0,
    isEstimate: false,
    currency: item.currency,
  }));
  const debtLines = liabilityObligations.map((item) => ({
    id: item.id,
    plannedPaymentId: null,
    title: item.title,
    direction: item.direction,
    amountMinor: item.expectedAmountMinor,
    paidAmountMinor: item.paidAmountMinor,
    outstandingAmountMinor: item.expectedAmountMinor,
    expectedDate: item.dueDate,
    accountId: item.accountId,
    account: item.account,
    categoryId: item.categoryId,
    category: item.category,
    source: item.sourceType === "credit_card_statement" ? "card statement" : "loan schedule",
    status: item.status,
    actual: item.status === "paid",
    spendingNature: item.spendingNature,
    spendingPriority: item.spendingPriority,
    sourceType: item.sourceType,
    liabilityAccountId: item.liabilityAccountId,
    cashFlowAmountMinor: item.cashFlowAmountMinor,
    spendingAmountMinor: item.spendingAmountMinor,
    plannedSpendingAmountMinor: item.plannedSpendingAmountMinor,
    principalAmountMinor: item.principalAmountMinor,
    isEstimate: item.isEstimate,
    currency: accountCurrencyById.get(item.liabilityAccountId)
      ?? (item.accountId ? accountCurrencyById.get(item.accountId) : undefined)
      ?? reportingCurrency,
  }));
  const canonicalLines = [...plannedLines, ...debtLines];
  const savedOpenings = planId
    ? all<{ accountId: string; amountMinor: number }>(
        "SELECT account_id AS accountId, expected_opening_minor AS amountMinor FROM month_plan_accounts WHERE month_plan_id = ?",
        [planId],
      )
    : [];
  const monthStart = `${targetMonth}-01`;
  const actualOpenings = all<{ accountId: string; amountMinor: number }>(
    `SELECT a.id AS accountId,
            CASE WHEN a.opening_balance_date <= ?
              THEN a.opening_balance_minor + COALESCE(SUM(
                CASE WHEN t.status = 'cleared' AND t.voided_at IS NULL
                           AND substr(t.occurred_at, 1, 10) >= a.opening_balance_date
                           AND substr(t.occurred_at, 1, 10) < ?
                     THEN t.amount_minor ELSE 0 END
              ), 0)
              ELSE 0 END AS amountMinor
       FROM accounts a
       LEFT JOIN transactions t ON t.account_id = a.id
      WHERE a.user_id = ? AND a.archived_at IS NULL
      GROUP BY a.id`,
    [monthStart, monthStart, userId],
  );
  const actualOpeningByAccount = new Map(actualOpenings.map((item) => [item.accountId, item.amountMinor]));
  const savedOpeningByAccount = new Map(savedOpenings.map((item) => [item.accountId, item.amountMinor]));
  const effectiveOpeningByAccount = new Map(accounts.map((account) => [
    account.id,
    savedOpeningByAccount.get(account.id) ?? actualOpeningByAccount.get(account.id) ?? 0,
  ]));
  const currentMonth = calendar.month;
  const actualThroughExclusive = targetMonth < currentMonth
    ? `${nextMonth(targetMonth)}-01`
    : targetMonth === currentMonth
      ? addDays(calendar.today, 1)
      : monthStart;
  const actualActivity = all<{ accountId: string; amountMinor: number }>(
    `SELECT t.account_id AS accountId, COALESCE(SUM(t.amount_minor), 0) AS amountMinor
       FROM transactions t JOIN accounts a ON a.id = t.account_id
      WHERE t.user_id = ? AND t.status = 'cleared' AND t.voided_at IS NULL
        AND substr(t.occurred_at, 1, 10) >= ? AND substr(t.occurred_at, 1, 10) < ?
        AND substr(t.occurred_at, 1, 10) >= a.opening_balance_date
      GROUP BY t.account_id`,
    [userId, monthStart, actualThroughExclusive],
  );
  const actualActivityByAccount = new Map(actualActivity.map((item) => [item.accountId, item.amountMinor]));
  const actualCashRows = all<{ date: string; amountMinor: number; currency: string }>(
    `SELECT substr(t.occurred_at, 1, 10) AS date, t.amount_minor AS amountMinor, t.currency
       FROM transactions t JOIN accounts a ON a.id = t.account_id
      WHERE t.user_id = ? AND t.status = 'cleared' AND t.voided_at IS NULL
        AND a.type IN ('current', 'savings', 'cash')
        AND a.archived_at IS NULL
        AND substr(t.occurred_at, 1, 10) >= ? AND substr(t.occurred_at, 1, 10) < ?
        AND substr(t.occurred_at, 1, 10) >= a.opening_balance_date
      ORDER BY date`,
    [userId, monthStart, actualThroughExclusive],
  );
  const actualCashByDate = new Map<string, number>();
  for (const row of actualCashRows) {
    const converted = toReportingMinor(row, reportingCurrency, "the monthly cash timeline");
    actualCashByDate.set(row.date, (actualCashByDate.get(row.date) ?? 0) + converted);
  }
  const actualCashEvents = [...actualCashByDate.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, amountMinor]) => ({ date, amountMinor }));
  // Historical workspaces reconcile to their actual month close. Current and
  // future workspaces add only obligations that have not yet produced cash.
  const remainingCanonicalLines = targetMonth < currentMonth
    ? []
    : canonicalLines.filter((item) => item.outstandingAmountMinor > 0);

  const reportingLineAmount = (item: (typeof canonicalLines)[number], amountMinor: number, context: string) =>
    toReportingMinor(
      { amountMinor, currency: item.currency, date: item.expectedDate },
      reportingCurrency,
      context,
    );
  const expectedIncomeMinor = canonicalLines
    .filter((item) => item.direction === "income")
    .reduce((sum, item) => sum + reportingLineAmount(item, Number(item.amountMinor ?? 0), "expected monthly income"), 0);
  const expectedExpensesMinor = canonicalLines
    .filter((item) => item.direction === "expense")
    .reduce((sum, item) => sum + reportingLineAmount(item, Number(item.plannedSpendingAmountMinor ?? 0), "expected monthly spending"), 0);
  const expectedCashOutflowMinor = canonicalLines
    .filter((item) => item.direction === "expense")
    .reduce((sum, item) => sum + reportingLineAmount(item, Number(item.cashFlowAmountMinor ?? 0), "expected monthly cash obligations"), 0);
  const actual = actualSummary(userId, monthStart, actualThroughExclusive);
  const openingTotalMinor = accounts
    .filter((account) => cashTypes.has(account.type))
    .reduce((sum, account) => sum + toReportingMinor(
      {
        amountMinor: effectiveOpeningByAccount.get(account.id) ?? 0,
        currency: account.currency,
        date: monthStart,
      },
      reportingCurrency,
      "expected opening cash",
    ), 0);
  const cashTimelineByDate = new Map<string, number>();
  for (const event of actualCashEvents) {
    cashTimelineByDate.set(event.date, (cashTimelineByDate.get(event.date) ?? 0) + event.amountMinor);
  }
  for (const item of remainingCanonicalLines) {
    const signedNativeAmount = item.direction === "income"
      ? item.cashFlowAmountMinor
      : -item.cashFlowAmountMinor;
    const signedAmount = reportingLineAmount(item, signedNativeAmount, "the monthly cash forecast");
    const forecastDate = targetMonth === currentMonth && String(item.expectedDate) < calendar.today
      ? calendar.today
      : String(item.expectedDate);
    cashTimelineByDate.set(
      forecastDate,
      (cashTimelineByDate.get(forecastDate) ?? 0) + signedAmount,
    );
  }
  let running = openingTotalMinor;
  let lowestCashPointMinor = running;
  for (const [, amountMinor] of [...cashTimelineByDate.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    running += amountMinor;
    lowestCashPointMinor = Math.min(lowestCashPointMinor, running);
  }
  const fixedMinor = canonicalLines
    .filter((item) => item.direction === "expense" && item.spendingNature === "fixed")
    .reduce((sum, item) => sum + reportingLineAmount(item, Number(item.plannedSpendingAmountMinor ?? 0), "fixed monthly spending"), 0);
  const variableMinor = expectedExpensesMinor - fixedMinor;
  const lineAmountInAccountCurrency = (
    item: (typeof canonicalLines)[number],
    amountMinor: number,
    accountCurrency: string,
    context: string,
  ) => toReportingMinor(
    { amountMinor, currency: item.currency, date: item.expectedDate },
    accountCurrency,
    context,
  );
  const forecastAccounts = accounts.map((account) => {
    const expectedOpeningMinor = effectiveOpeningByAccount.get(account.id) ?? 0;
    const impact = remainingCanonicalLines.reduce((sum, item) => {
      let next = sum;
      if (item.accountId === account.id) {
        const cashFlowAmountMinor = lineAmountInAccountCurrency(
          item,
          item.cashFlowAmountMinor,
          account.currency,
          `the forecast cash impact for ${account.name}`,
        );
        next += item.direction === "income" ? cashFlowAmountMinor : -cashFlowAmountMinor;
        if (item.sourceType === "planned_payment" && !cashTypes.has(account.type)) {
          const accountAmountMinor = lineAmountInAccountCurrency(
            item,
            item.outstandingAmountMinor,
            account.currency,
            `the forecast account impact for ${account.name}`,
          );
          next += item.direction === "income" ? accountAmountMinor : -accountAmountMinor;
        }
      }
      if (item.liabilityAccountId === account.id) {
        next += lineAmountInAccountCurrency(
          item,
          item.principalAmountMinor,
          account.currency,
          `the forecast principal impact for ${account.name}`,
        );
      }
      return next;
    }, actualActivityByAccount.get(account.id) ?? 0);
    const forecastClosingMinor = expectedOpeningMinor + impact;
    return {
      ...account,
      expectedOpeningMinor,
      actualActivityMinor: actualActivityByAccount.get(account.id) ?? 0,
      forecastClosingMinor,
      reportingExpectedOpeningMinor: toReportingMinor(
        { amountMinor: expectedOpeningMinor, currency: account.currency, date: monthStart },
        reportingCurrency,
        `the expected opening balance for ${account.name}`,
      ),
      reportingForecastClosingMinor: toReportingMinor(
        { amountMinor: forecastClosingMinor, currency: account.currency, date: monthEnd(targetMonth) },
        reportingCurrency,
        `the forecast closing balance for ${account.name}`,
      ),
      reportingCurrency,
    };
  });
  const scenarios = planId
    ? all<Record<string, unknown>>(
        "SELECT id, name, is_baseline AS isBaseline, notes FROM plan_scenarios WHERE month_plan_id = ? ORDER BY is_baseline DESC, name",
        [planId],
      )
    : [];

  const openingBalances = accounts.map((account) => ({
    accountId: account.id,
    amountMinor: effectiveOpeningByAccount.get(account.id) ?? 0,
    openingBalanceMinor: effectiveOpeningByAccount.get(account.id) ?? 0,
    currency: account.currency,
    reportingAmountMinor: toReportingMinor(
      { amountMinor: effectiveOpeningByAccount.get(account.id) ?? 0, currency: account.currency, date: monthStart },
      reportingCurrency,
      `the expected opening balance for ${account.name}`,
    ),
    reportingCurrency,
  }));
  const forecastLineIds = new Set(remainingCanonicalLines.map((item) => item.id));
  const lines = canonicalLines.map((item) => {
    const convert = (amountMinor: number) => reportingLineAmount(item, amountMinor, `the plan line “${item.title}”`);
    return {
      ...item,
      nativeCurrency: item.currency,
      nativeAmountMinor: item.amountMinor,
      nativePaidAmountMinor: item.paidAmountMinor,
      nativeOutstandingAmountMinor: item.outstandingAmountMinor,
      currency: reportingCurrency,
      amountMinor: convert(item.amountMinor),
      paidAmountMinor: convert(item.paidAmountMinor),
      outstandingAmountMinor: convert(item.outstandingAmountMinor),
      cashFlowAmountMinor: convert(item.cashFlowAmountMinor),
      spendingAmountMinor: convert(item.spendingAmountMinor),
      plannedSpendingAmountMinor: convert(item.plannedSpendingAmountMinor),
      principalAmountMinor: convert(item.principalAmountMinor),
      name: String(item.title ?? "Expected payment"),
      date: String(item.expectedDate ?? `${targetMonth}-01`),
      spendingType: item.spendingNature === "fixed" ? "fixed" : "variable",
      essential: item.spendingPriority === "essential",
      includedInForecast: forecastLineIds.has(item.id),
      forecastDate: targetMonth === currentMonth && String(item.expectedDate) < calendar.today
        ? calendar.today
        : String(item.expectedDate),
    };
  });
  const outstandingIncomeMinor = remainingCanonicalLines
    .filter((item) => item.direction === "income")
    .reduce((sum, item) => sum + reportingLineAmount(item, item.outstandingAmountMinor, "outstanding monthly income"), 0);
  const outstandingExpensesMinor = remainingCanonicalLines
    .filter((item) => item.direction === "expense")
    .reduce((sum, item) => sum + reportingLineAmount(item, item.spendingAmountMinor, "outstanding monthly spending"), 0);
  const outstandingCashInflowMinor = remainingCanonicalLines
    .filter((item) => item.direction === "income")
    .reduce((sum, item) => sum + reportingLineAmount(item, item.cashFlowAmountMinor, "outstanding monthly cash inflow"), 0);
  const outstandingCashOutflowMinor = remainingCanonicalLines
    .filter((item) => item.direction === "expense")
    .reduce((sum, item) => sum + reportingLineAmount(item, item.cashFlowAmountMinor, "outstanding monthly cash outflow"), 0);
  const actualCashActivityMinor = actualCashEvents.reduce((sum, item) => sum + item.amountMinor, 0);
  const forecastClosingMinor = openingTotalMinor + actualCashActivityMinor
    + outstandingCashInflowMinor - outstandingCashOutflowMinor;
  let scenarioLines: unknown[] = [];
  if (planId) {
    const latestScenario = one<{ after: string | null }>(
      "SELECT after FROM audit_logs WHERE user_id = ? AND entity_type = 'month_plan_scenario' AND entity_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
      [userId, planId],
    );
    if (latestScenario?.after) {
      try {
        const saved = JSON.parse(latestScenario.after) as { lines?: unknown[] };
        const planCurrency = typeof plan?.currency === "string" ? plan.currency : reportingCurrency;
        scenarioLines = Array.isArray(saved.lines) ? saved.lines.map((value) => {
          if (!value || typeof value !== "object" || Array.isArray(value)) return value;
          const line = value as Record<string, unknown>;
          const amountMinor = typeof line.amountMinor === "number" && Number.isSafeInteger(line.amountMinor)
            ? toReportingMinor(
              {
                amountMinor: line.amountMinor,
                currency: planCurrency,
                date: typeof line.expectedDate === "string" ? line.expectedDate : monthStart,
              },
              reportingCurrency,
              "the saved scenario assumptions",
            )
            : line.amountMinor;
          return { ...line, amountMinor, nativeCurrency: planCurrency, currency: reportingCurrency };
        }) : [];
      } catch {
        scenarioLines = [];
      }
    }
  }

  return {
    currency: reportingCurrency,
    month: targetMonth,
    reportingBasis: {
      actualFlows: "transaction_date",
      accountOpenings: monthStart,
      plannedAmounts: "due_date",
      planDenomination: typeof plan?.currency === "string" ? plan.currency : reportingCurrency,
      source: "BNR persisted reference rates",
    },
    plan: {
      ...(plan ?? { month: targetMonth, name: "Base plan", status: "draft" }),
      nativeCurrency: typeof plan?.currency === "string" ? plan.currency : reportingCurrency,
      nativeExpectedIncomeMinor: typeof plan?.expectedIncomeMinor === "number" ? plan.expectedIncomeMinor : 0,
      nativeDiscretionaryTargetMinor: typeof plan?.discretionaryTargetMinor === "number" ? plan.discretionaryTargetMinor : null,
      currency: reportingCurrency,
      reportingCurrency,
      reportingExpectedIncomeMinor: typeof plan?.expectedIncomeMinor === "number"
        ? toReportingMinor(
          {
            amountMinor: plan.expectedIncomeMinor,
            currency: typeof plan.currency === "string" ? plan.currency : reportingCurrency,
            date: monthStart,
          },
          reportingCurrency,
          "the saved monthly income assumption",
        )
        : 0,
      reportingDiscretionaryTargetMinor: typeof plan?.discretionaryTargetMinor === "number"
        ? toReportingMinor(
          {
            amountMinor: plan.discretionaryTargetMinor,
            currency: typeof plan.currency === "string" ? plan.currency : reportingCurrency,
            date: monthStart,
          },
          reportingCurrency,
          "the saved discretionary target",
        )
        : null,
      expectedIncomeMinor: typeof plan?.expectedIncomeMinor === "number"
        ? toReportingMinor(
          {
            amountMinor: plan.expectedIncomeMinor,
            currency: typeof plan.currency === "string" ? plan.currency : reportingCurrency,
            date: monthStart,
          },
          reportingCurrency,
          "the saved monthly income assumption",
        )
        : 0,
      discretionaryTargetMinor: typeof plan?.discretionaryTargetMinor === "number"
        ? toReportingMinor(
          {
            amountMinor: plan.discretionaryTargetMinor,
            currency: typeof plan.currency === "string" ? plan.currency : reportingCurrency,
            date: monthStart,
          },
          reportingCurrency,
          "the saved discretionary target",
        )
        : null,
      openingBalances,
      lines,
      items: lines,
      scenarioLines,
    },
    accounts: forecastAccounts,
    items: lines,
    expectedOpeningMinor: openingTotalMinor,
    expectedIncomeMinor,
    expectedExpensesMinor,
    expectedCashOutflowMinor,
    outstandingIncomeMinor,
    outstandingCashInflowMinor,
    outstandingExpensesMinor,
    outstandingCashOutflowMinor,
    fixedMinor,
    variableMinor,
    actualCashActivityMinor,
    actualCashEvents,
    remainingDiscretionaryMinor: forecastClosingMinor,
    forecastClosingMinor,
    lowestCashPointMinor,
    actual: { ...actual, expenseMinor: actual.spendingMinor },
    forecast: {
      closingBalanceMinor: forecastClosingMinor,
      lowestCashPointMinor,
      accounts: forecastAccounts,
      estimate: true,
    },
    plannedVsActual: {
      plannedMinor: expectedExpensesMinor,
      actualMinor: actual.spendingMinor,
      varianceMinor: expectedExpensesMinor - actual.spendingMinor,
    },
    scenarios,
    categories: listCategories(userId),
    estimate: true,
  };
}

export function savePlan(userId: string, rawInput: PlanInput & { action?: string; scenarioName?: string }) {
  const input = {
    ...rawInput,
    month: requireMonthKey(rawInput.month, "planning month"),
    copyFromMonth: rawInput.copyFromMonth
      ? requireMonthKey(rawInput.copyFromMonth, "source month")
      : rawInput.copyFromMonth,
  };
  return database().transaction(() => {
    let sourcePlanId: string | null = null;
    let sourcePlan: Record<string, unknown> | null = null;
    if (input.copyFromMonth) {
      sourcePlan = getOrCreatePlan(userId, input.copyFromMonth, false) ?? null;
      sourcePlanId = typeof sourcePlan?.id === "string" ? sourcePlan.id : null;
    }
    if (["copy", "copy-assumptions"].includes(input.action ?? "") && input.copyFromMonth && !sourcePlanId) {
      throw new HttpError(404, "The previous month has no saved forecast assumptions to copy");
    }
    const existing = getOrCreatePlan(userId, input.month, false);
    const planId = typeof existing?.id === "string" ? existing.id : randomUUID();
    const planCurrency = typeof existing?.currency === "string" ? existing.currency : workspaceCurrency(userId);
    const currentReportingCurrency = workspaceCurrency(userId);
    const denominationDate = `${input.month}-01`;
    let expectedIncomeMinor = input.expectedIncomeMinor === undefined
      ? undefined
      : toReportingMinor(
        { amountMinor: input.expectedIncomeMinor, currency: currentReportingCurrency, date: denominationDate },
        planCurrency,
        "the saved monthly income assumption",
      );
    let discretionaryTargetMinor = input.discretionaryTargetMinor === undefined || input.discretionaryTargetMinor === null
      ? input.discretionaryTargetMinor
      : toReportingMinor(
        { amountMinor: input.discretionaryTargetMinor, currency: currentReportingCurrency, date: denominationDate },
        planCurrency,
        "the saved discretionary target",
      );
    if (sourcePlan && ["copy", "copy-assumptions"].includes(input.action ?? "")) {
      const sourceCurrency = typeof sourcePlan.currency === "string" ? sourcePlan.currency : planCurrency;
      if (expectedIncomeMinor === undefined && typeof sourcePlan.expectedIncomeMinor === "number") {
        expectedIncomeMinor = toReportingMinor(
          { amountMinor: sourcePlan.expectedIncomeMinor, currency: sourceCurrency, date: denominationDate },
          planCurrency,
          "the copied monthly income assumption",
        );
      }
      if (discretionaryTargetMinor === undefined && typeof sourcePlan.discretionaryTargetMinor === "number") {
        discretionaryTargetMinor = toReportingMinor(
          { amountMinor: sourcePlan.discretionaryTargetMinor, currency: sourceCurrency, date: denominationDate },
          planCurrency,
          "the copied discretionary target",
        );
      }
    }
    if (existing) {
      database()
        .prepare(
          `UPDATE month_plans SET name = COALESCE(?, name), expected_income_minor = COALESCE(?, expected_income_minor),
           discretionary_target_minor = COALESCE(?, discretionary_target_minor), notes = COALESCE(?, notes), updated_at = CURRENT_TIMESTAMP
           WHERE id = ? AND user_id = ?`,
        )
        .run(input.name ?? null, expectedIncomeMinor ?? null, discretionaryTargetMinor ?? null, input.notes ?? null, planId, userId);
    } else {
      database()
        .prepare(
          `INSERT INTO month_plans
            (id, user_id, month, currency, name, expected_income_minor, discretionary_target_minor, copied_from_plan_id, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(planId, userId, input.month, planCurrency, input.name ?? "Base plan", expectedIncomeMinor ?? 0, discretionaryTargetMinor ?? null, sourcePlanId, input.notes ?? null);
    }

    if (input.action === "save-scenario") {
      const storedLines = (input.items ?? []).map((line) => ({
        ...line,
        amountMinor: toReportingMinor(
          { amountMinor: line.amountMinor, currency: currentReportingCurrency, date: line.expectedDate },
          planCurrency,
          `the scenario line “${line.title}”`,
        ),
      }));
      database()
        .prepare("INSERT INTO audit_logs (id, user_id, entity_type, entity_id, action, after) VALUES (?, ?, 'month_plan_scenario', ?, 'save', ?)")
        .run(randomUUID(), userId, planId, JSON.stringify({ name: input.scenarioName ?? "Working scenario", lines: storedLines }));
      return planningWorkspace(userId, input.month);
    }

    if (sourcePlanId && ["copy", "copy-assumptions"].includes(input.action ?? "")) {
      database().prepare("DELETE FROM month_plan_accounts WHERE month_plan_id = ?").run(planId);
      database()
        .prepare(
          `INSERT INTO month_plan_accounts (id, month_plan_id, account_id, expected_opening_minor)
           SELECT lower(hex(randomblob(16))), ?, source.account_id, source.expected_opening_minor
             FROM month_plan_accounts source
             JOIN accounts a ON a.id = source.account_id
            WHERE source.month_plan_id = ? AND a.user_id = ?`,
        )
        .run(planId, sourcePlanId, userId);

      const sourceScenario = one<{ after: string | null }>(
        "SELECT after FROM audit_logs WHERE user_id = ? AND entity_type = 'month_plan_scenario' AND entity_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
        [userId, sourcePlanId],
      );
      let copiedScenario: { name: string; lines: Array<Record<string, unknown>> } = {
        name: "Working scenario",
        lines: [],
      };
      if (sourceScenario?.after) {
        try {
          const saved = JSON.parse(sourceScenario.after) as { name?: string; lines?: Array<Record<string, unknown>> };
          const lastDay = Number(monthEnd(input.month).slice(-2));
          const lines = Array.isArray(saved.lines)
            ? saved.lines.map((line) => {
                const date = String(line.expectedDate ?? line.date ?? `${input.month}-01`);
                const day = Math.min(Math.max(Number(date.slice(-2)) || 1, 1), lastDay);
                const sourceCurrency = typeof sourcePlan?.currency === "string" ? sourcePlan.currency : planCurrency;
                const amountMinor = typeof line.amountMinor === "number" && Number.isSafeInteger(line.amountMinor)
                  ? toReportingMinor(
                    { amountMinor: line.amountMinor, currency: sourceCurrency, date },
                    planCurrency,
                    "the copied scenario assumption",
                  )
                  : line.amountMinor;
                return { ...line, amountMinor, expectedDate: `${input.month}-${String(day).padStart(2, "0")}` };
              })
            : [];
          copiedScenario = { name: saved.name ?? "Working scenario", lines };
        } catch {
          // A malformed historical scenario copies as an empty scenario and
          // must not block copying opening assumptions.
        }
      }
      database()
        .prepare("INSERT INTO audit_logs (id, user_id, entity_type, entity_id, action, after) VALUES (?, ?, 'month_plan_scenario', ?, 'copy', ?)")
        .run(randomUUID(), userId, planId, JSON.stringify(copiedScenario));
    }
    if (input.openingBalances) {
      const allowedAccountIds = new Set(
        all<{ id: string }>("SELECT id FROM accounts WHERE user_id = ? AND archived_at IS NULL", [userId]).map((account) => account.id),
      );
      const normalizedOpenings: Array<{ accountId: string; amountMinor: number }> = [];
      const seenAccountIds = new Set<string>();
      for (const value of input.openingBalances) {
        if (!value || typeof value !== "object") throw new HttpError(422, "Choose a valid account for every opening assumption");
        const opening = value as Record<string, unknown>;
        const accountId = typeof opening.accountId === "string" ? opening.accountId : "";
        if (!allowedAccountIds.has(accountId)) throw new HttpError(422, "Choose an account that belongs to your profile");
        if (seenAccountIds.has(accountId)) throw new HttpError(422, "Each account can have only one opening assumption");
        const amountMinor = typeof opening.amountMinor === "number" && Number.isSafeInteger(opening.amountMinor)
          ? opening.amountMinor
          : typeof opening.openingBalanceMinor === "number" && Number.isSafeInteger(opening.openingBalanceMinor)
            ? opening.openingBalanceMinor
            : null;
        if (amountMinor === null) throw new HttpError(422, "Enter each opening balance in minor units");
        seenAccountIds.add(accountId);
        normalizedOpenings.push({ accountId, amountMinor });
      }
      database().prepare("DELETE FROM month_plan_accounts WHERE month_plan_id = ?").run(planId);
      const insertOpening = database().prepare(
        "INSERT INTO month_plan_accounts (id, month_plan_id, account_id, expected_opening_minor) VALUES (?, ?, ?, ?)",
      );
      for (const opening of normalizedOpenings) {
        insertOpening.run(randomUUID(), planId, opening.accountId, opening.amountMinor);
      }
    }
    if (input.action === "scenario" && input.scenarioName) {
      database()
        .prepare("INSERT INTO plan_scenarios (id, month_plan_id, name) VALUES (?, ?, ?)")
        .run(randomUUID(), planId, input.scenarioName);
    }
    audit(userId, "month_plan", planId, existing ? "update" : "create", existing, input);
    return planningWorkspace(userId, input.month);
  })();
}

interface MonthlyRow {
  month: string;
  incomeMinor: number;
  spendingMinor: number;
  netCashFlowMinor: number;
}

export function statistics(userId: string, months = 12, requestedRange?: InsightDateRange) {
  months = Number.isSafeInteger(months) ? Math.min(Math.max(months, 1), 60) : 12;
  const calendar = getUserCalendarContext(userId);
  const normalizedRequestedRange = requestedRange ? normalizeInsightRange(requestedRange) : undefined;
  const selectedMonths = normalizedRequestedRange
    ? monthsInRange(normalizedRequestedRange.from, normalizedRequestedRange.to)
    : Array.from({ length: months }, (_, index) => nextMonth(calendar.month, index - (months - 1)));
  const range = normalizedRequestedRange
    ? normalizedRequestedRange
    : { from: `${selectedMonths[0]}-01`, to: monthEnd(selectedMonths[selectedMonths.length - 1] ?? calendar.month) };
  const first = range.from;
  const lastExclusive = addDays(range.to, 1);
  const reportingCurrency = workspaceCurrency(userId);
  const transactionRows = reportingTransactions(userId, first, lastExclusive);
  const rawMonthlyMap = new Map<string, { month: string; incomeMinor: number; signedSpendingMinor: number }>();
  for (const row of transactionRows) {
    if (!["income", "expense", "refund"].includes(row.kind)) continue;
    const month = row.date.slice(0, 7);
    const bucket = rawMonthlyMap.get(month) ?? { month, incomeMinor: 0, signedSpendingMinor: 0 };
    if (row.kind === "income") bucket.incomeMinor += row.amountMinor;
    else bucket.signedSpendingMinor += row.amountMinor;
    rawMonthlyMap.set(month, bucket);
  }
  const rawMonthly: MonthlyRow[] = [...rawMonthlyMap.values()]
    .sort((left, right) => left.month.localeCompare(right.month))
    .map((row) => {
      const spendingMinor = Math.max(0, -row.signedSpendingMinor);
      return {
        month: row.month,
        incomeMinor: row.incomeMinor,
        spendingMinor,
        netCashFlowMinor: row.incomeMinor - spendingMinor,
      };
    });
  const byMonthMap = new Map(rawMonthly.map((row) => [row.month, row]));
  materializePlannedOccurrences(userId, range.to);
  const rawPlanned = all<{ month: string; plannedMinor: number; currency: string; date: string }>(
    `SELECT substr(o.due_date, 1, 7) AS month, o.expected_amount_minor AS plannedMinor,
            p.currency, o.due_date AS date
       FROM planned_payment_occurrences o JOIN planned_payments p ON p.id = o.planned_payment_id
      WHERE p.user_id = ? AND p.direction = 'expense' AND o.status NOT IN ('skipped', 'cancelled')
        AND o.due_date >= ? AND o.due_date < ?`,
    [userId, first, lastExclusive],
  );
  const rawLoanPlanned = all<{ month: string; plannedMinor: number; currency: string; date: string }>(
    `SELECT substr(e.due_date, 1, 7) AS month,
            e.interest_minor + e.fees_minor AS plannedMinor, a.currency, e.due_date AS date
       FROM loan_schedule_entries e JOIN accounts a ON a.id = e.loan_account_id
      WHERE a.user_id = ? AND e.status <> 'skipped' AND e.due_date >= ? AND e.due_date < ?
      `,
    [userId, first, lastExclusive],
  );
  const plannedByMonth = new Map<string, number>();
  for (const row of [...rawPlanned, ...rawLoanPlanned]) {
    const converted = toReportingMinor(
      { amountMinor: row.plannedMinor, currency: row.currency, date: row.date },
      reportingCurrency,
      "planned-versus-actual statistics",
    );
    plannedByMonth.set(row.month, (plannedByMonth.get(row.month) ?? 0) + converted);
  }
  const monthly = selectedMonths.map((month, index) => {
    const row = byMonthMap.get(month) ?? { month, incomeMinor: 0, spendingMinor: 0, netCashFlowMinor: 0 };
    const bucketFrom = range.from > `${month}-01` ? range.from : `${month}-01`;
    const bucketTo = range.to < monthEnd(month) ? range.to : monthEnd(month);
    const partial = bucketFrom !== `${month}-01` || bucketTo !== monthEnd(month);
    const window = selectedMonths.slice(Math.max(0, index - 2), index + 1).map((key) => byMonthMap.get(key)?.spendingMinor ?? 0);
    const rollingAverageMinor = Math.round(window.reduce((sum, value) => sum + value, 0) / window.length);
    return {
      ...row,
      savingsRate: row.incomeMinor ? (row.netCashFlowMinor / row.incomeMinor) * 100 : 0,
      rollingAverageMinor,
      expenseMinor: row.spendingMinor,
      actualMinor: row.spendingMinor,
      plannedMinor: plannedByMonth.get(month) ?? 0,
      bucketFrom,
      bucketTo,
      partial,
    };
  });

  const spendTransactions = transactionRows
    .filter((row) => row.kind === "expense" || row.kind === "refund")
    .map((row) => ({ ...row, transactionId: row.id }));
  const spendingAllocations = reportingSpendingAllocations(userId, first, lastExclusive);
  const byCategory = groupedSpend(spendingAllocations, (row) => ({ id: row.categoryId, name: row.categoryName }));
  const byMerchant = groupedSpend(spendTransactions, (row) => ({
    id: row.merchantId ?? row.merchantName,
    name: row.merchantName,
  }));
  const byAccount = groupedSpend(spendTransactions, (row) => ({ id: row.accountId, name: row.accountName }));
  const weekdayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const byWeekday = groupedSpend(spendTransactions, (row) => {
    const day = new Date(`${row.date}T00:00:00.000Z`).getUTCDay();
    return { id: String(day), name: weekdayNames[day] };
  }).sort((left, right) => Number(left.id) - Number(right.id));
  const weekKey = (dateKey: string) => {
    const date = new Date(`${dateKey}T00:00:00.000Z`);
    const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
    const firstMondayOffset = (8 - yearStart.getUTCDay()) % 7;
    const days = Math.floor((date.getTime() - yearStart.getTime()) / 86_400_000);
    const week = Math.max(0, Math.floor((days - firstMondayOffset + 7) / 7));
    return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
  };
  const byWeek = groupedSpend(spendTransactions, (row) => {
    const key = weekKey(row.date);
    return { id: key, name: key };
  }).sort((left, right) => left.id.localeCompare(right.id));
  const spendByTransactionId = new Map(spendTransactions.map((row) => [row.id, row]));
  const tagRows = all<{ transactionId: string; id: string; name: string }>(
    `SELECT x.transaction_id AS transactionId, g.id, g.name
       FROM tags g JOIN transaction_tags x ON x.tag_id = g.id
       JOIN transactions t ON t.id = x.transaction_id
      WHERE t.user_id = ? AND t.status = 'cleared' AND t.voided_at IS NULL
        AND t.kind IN ('expense', 'refund')
        AND substr(t.occurred_at, 1, 10) >= ? AND substr(t.occurred_at, 1, 10) < ?`,
    [userId, first, lastExclusive],
  ).flatMap((tag) => {
    const transaction = spendByTransactionId.get(tag.transactionId);
    return transaction ? [{ ...tag, amountMinor: transaction.amountMinor }] : [];
  });
  const byTag = groupedSpend(tagRows, (row) => ({ id: row.id, name: row.name }));
  const classificationMap = new Map<string, { nature: string; priority: string; signedMinor: number }>();
  for (const row of spendingAllocations) {
    const key = `${row.nature}\u0000${row.priority}`;
    const bucket = classificationMap.get(key) ?? { nature: row.nature, priority: row.priority, signedMinor: 0 };
    bucket.signedMinor += row.amountMinor;
    classificationMap.set(key, bucket);
  }
  const classification = [...classificationMap.values()].map((item) => ({
    nature: item.nature,
    priority: item.priority,
    amountMinor: Math.max(0, -item.signedMinor),
  }));
  const categoryByTransactionId = new Map<string, string>();
  for (const row of spendingAllocations) {
    const previous = categoryByTransactionId.get(row.transactionId);
    categoryByTransactionId.set(row.transactionId, previous && previous !== row.categoryName ? "Split transaction" : row.categoryName);
  }
  const largestExpenses = transactionRows
    .filter((row) => row.kind === "expense")
    .sort((left, right) => Math.abs(right.amountMinor) - Math.abs(left.amountMinor))
    .slice(0, 10)
    .map((row) => ({
      id: row.id,
      date: row.date,
      amountMinor: Math.abs(row.amountMinor),
      nativeAmountMinor: Math.abs(row.nativeAmountMinor),
      nativeCurrency: row.nativeCurrency,
      merchant: row.merchantName === "Uncategorised" ? "Expense" : row.merchantName,
      merchantName: row.merchantName === "Uncategorised" ? "Expense" : row.merchantName,
      category: categoryByTransactionId.get(row.id) ?? "Uncategorised",
      categoryName: categoryByTransactionId.get(row.id) ?? "Uncategorised",
      account: row.accountName,
      accountName: row.accountName,
    }));

  const current = monthly.at(-1) ?? { incomeMinor: 0, spendingMinor: 0, netCashFlowMinor: 0, savingsRate: 0, rollingAverageMinor: 0, expenseMinor: 0, actualMinor: 0, plannedMinor: 0, month: range.to.slice(0, 7) };
  const periodTotals = actualSummary(userId, first, lastExclusive);
  const rangeDays = inclusiveDayCount(range.from, range.to);
  const previousPeriod = actualSummary(userId, addDays(range.from, -rangeDays), range.from);
  const yearAgoPeriod = actualSummary(userId, shiftDateYear(range.from, -1), addDays(shiftDateYear(range.to, -1), 1));
  const accounts = listAccounts(userId);
  const cash = accounts
    .filter((account) => ["current", "savings", "cash"].includes(account.type))
    .reduce((sum, account) => sum + toReportingMinor(
      { amountMinor: account.balanceMinor, currency: account.currency, date: calendar.today },
      reportingCurrency,
      "cash runway",
    ), 0);
  const today = calendar.today;
  const observedTo = range.to < today ? range.to : today;
  const hasObservedDays = range.from <= observedTo;
  const observedDays = hasObservedDays ? inclusiveDayCount(range.from, observedTo) : 0;
  const observedTotals = hasObservedDays
    ? actualSummary(userId, range.from, addDays(observedTo, 1))
    : null;
  const averageDailySpending = observedDays && observedTotals
    ? observedTotals.spendingMinor / observedDays
    : null;
  const averageDailySpendingMinor = averageDailySpending === null ? null : Math.round(averageDailySpending);
  const cashRunwayDays = averageDailySpending && averageDailySpending > 0
    ? Math.max(0, cash / averageDailySpending)
    : null;
  const cashRunwayMonths = cashRunwayDays === null ? null : cashRunwayDays / 30.4375;
  const totalSpend = byCategory.reduce((sum, item) => sum + item.amountMinor, 0);
  const concentration = totalSpend ? byCategory.slice(0, 3).reduce((sum, item) => sum + item.amountMinor, 0) / totalSpend * 100 : 0;
  const spendValues = monthly.filter((row) => row.spendingMinor > 0).map((row) => row.spendingMinor);
  const mean = spendValues.length ? spendValues.reduce((sum, value) => sum + value, 0) / spendValues.length : 0;
  const deviation = spendValues.length ? Math.sqrt(spendValues.reduce((sum, value) => sum + (value - mean) ** 2, 0) / spendValues.length) : 0;
  const consistency = mean ? Math.max(0, 100 - (deviation / mean) * 100) : 0;
  const currentMonth = calendar.month;
  const currentMonthStart = `${currentMonth}-01`;
  const currentMonthDays = Number(monthEnd(currentMonth).slice(-2));
  const projectionApplicable = range.from <= today && range.to >= today;
  const projectionObservedFrom = range.from > currentMonthStart ? range.from : currentMonthStart;
  const projectionObservedDays = projectionApplicable ? inclusiveDayCount(projectionObservedFrom, today) : 0;
  const projectionObservedSpendingMinor = projectionApplicable
    ? actualSummary(userId, projectionObservedFrom, addDays(today, 1)).spendingMinor
    : null;
  const projectedMonthEndMinor = projectionApplicable && projectionObservedDays && projectionObservedSpendingMinor !== null
    ? Math.round(projectionObservedSpendingMinor / projectionObservedDays * currentMonthDays)
    : null;

  const plannedMinor = [...plannedByMonth.values()].reduce((sum, value) => sum + value, 0);
  const recurringCommitmentMinor = sumInReportingCurrency(all<{ amountMinor: number; currency: string; date: string }>(
    `SELECT expected_amount_minor AS amountMinor, currency, due_date AS date FROM planned_payments
      WHERE user_id = ? AND direction = 'expense' AND recurrence_rule_id IS NOT NULL AND active = 1 AND archived_at IS NULL`,
    [userId],
  ), reportingCurrency, "recurring commitments");
  const subscriptions = all<{
    id: string;
    name: string;
    amountMinor: number;
    currency: string;
    dueDate: string;
    frequency: string;
    interval: number;
    nextDueDate: string | null;
    categoryName: string | null;
  }>(
    `SELECT p.id, p.title AS name, p.expected_amount_minor AS amountMinor, p.currency, p.due_date AS dueDate,
            r.frequency, r.interval, MIN(CASE WHEN o.status NOT IN ('skipped', 'cancelled', 'paid') THEN o.due_date END) AS nextDueDate,
            c.name AS categoryName
       FROM planned_payments p JOIN recurrence_rules r ON r.id = p.recurrence_rule_id
       LEFT JOIN planned_payment_occurrences o ON o.planned_payment_id = p.id
       LEFT JOIN categories c ON c.id = p.category_id
      WHERE p.user_id = ? AND p.direction = 'expense' AND p.active = 1 AND p.archived_at IS NULL
      GROUP BY p.id ORDER BY p.expected_amount_minor DESC`,
    [userId],
  ).map((item) => {
    const multiplier = item.frequency === "daily" ? 30 / item.interval
      : item.frequency === "weekly" ? 52 / 12 / item.interval
        : item.frequency === "yearly" ? 1 / 12 / item.interval
          : 1 / item.interval;
    const convertedAmountMinor = toReportingMinor(
      { amountMinor: item.amountMinor, currency: item.currency, date: item.nextDueDate ?? item.dueDate },
      reportingCurrency,
      `the recurring commitment “${item.name}”`,
    );
    const monthlyAmountMinor = Math.round(convertedAmountMinor * multiplier);
    return {
      ...item,
      nativeAmountMinor: item.amountMinor,
      nativeCurrency: item.currency,
      currency: reportingCurrency,
      amountMinor: convertedAmountMinor,
      monthlyAmountMinor,
      annualAmountMinor: monthlyAmountMinor * 12,
    };
  });
  const recurringMonthlyMinor = subscriptions.reduce((sum, item) => sum + item.monthlyAmountMinor, 0);
  const inThirtyDays = addDays(calendar.today, 30);
  const next30DaysMinor = listPlannedPayments(userId, { from: calendar.today, to: inThirtyDays })
    .filter((item) => item.direction === "expense" && !["paid", "skipped", "cancelled"].includes(item.status))
    .reduce((sum, item) => sum + toReportingMinor(
      {
        amountMinor: item.expectedAmountMinor - item.paidAmountMinor,
        currency: item.currency,
        date: item.dueDate,
      },
      reportingCurrency,
      "planned payments due in the next 30 days",
    ), 0);
  const liabilityAccounts = enrichLiabilityAccounts(userId, accounts)
    .filter((account) => account.type === "credit_card" || account.type === "loan");
  const totalLiabilitiesMinor = liabilityAccounts.reduce(
    (sum, account) => sum + toReportingMinor(
      { amountMinor: Math.max(0, -account.balanceMinor), currency: account.currency, date: calendar.today },
      reportingCurrency,
      "total liabilities",
    ),
    0,
  );
  const cardLimitMinor = liabilityAccounts.reduce(
    (sum, account) => sum + (account.type === "credit_card" ? toReportingMinor(
      { amountMinor: account.creditLimitMinor ?? 0, currency: account.currency, date: calendar.today },
      reportingCurrency,
      "credit limits",
    ) : 0),
    0,
  );
  const cardOutstandingMinor = liabilityAccounts.reduce(
    (sum, account) => sum + (account.type === "credit_card" ? toReportingMinor(
      { amountMinor: Math.max(0, -account.balanceMinor), currency: account.currency, date: calendar.today },
      reportingCurrency,
      "credit-card balances",
    ) : 0),
    0,
  );
  const loanPaymentRows = all<{
    cashTotalMinor: number;
    cashPrincipalMinor: number;
    cashInterestMinor: number;
    cashFeesMinor: number;
    cashCurrency: string;
    date: string;
  }>(
    `SELECT COALESCE(ABS(principal_source.amount_minor), 0)
              + COALESCE(ABS(interest_transaction.amount_minor), 0)
              + COALESCE(ABS(fee_transaction.amount_minor), 0) AS cashTotalMinor,
            COALESCE(ABS(principal_source.amount_minor), 0) AS cashPrincipalMinor,
            COALESCE(ABS(interest_transaction.amount_minor), 0) AS cashInterestMinor,
            COALESCE(ABS(fee_transaction.amount_minor), 0) AS cashFeesMinor,
            source_account.currency AS cashCurrency, p.payment_date AS date
       FROM loan_payments p
       JOIN accounts source_account ON source_account.id = p.source_account_id
       LEFT JOIN transactions principal_source
         ON principal_source.id = p.source_principal_transaction_id AND principal_source.voided_at IS NULL
       LEFT JOIN transactions interest_transaction
         ON interest_transaction.id = p.interest_transaction_id AND interest_transaction.voided_at IS NULL
       LEFT JOIN transactions fee_transaction
         ON fee_transaction.id = p.fee_transaction_id AND fee_transaction.voided_at IS NULL
      WHERE p.user_id = ? AND p.voided_at IS NULL
        AND p.payment_date >= ? AND p.payment_date < ?`,
    [userId, first, lastExclusive],
  );
  const loanPayments = loanPaymentRows.reduce((sum, row) => ({
    totalMinor: sum.totalMinor + toReportingMinor({ amountMinor: row.cashTotalMinor, currency: row.cashCurrency, date: row.date }, reportingCurrency, "loan cash payments"),
    principalMinor: sum.principalMinor + toReportingMinor({ amountMinor: row.cashPrincipalMinor, currency: row.cashCurrency, date: row.date }, reportingCurrency, "loan principal cash payments"),
    interestMinor: sum.interestMinor + toReportingMinor({ amountMinor: row.cashInterestMinor, currency: row.cashCurrency, date: row.date }, reportingCurrency, "loan interest cash payments"),
    feesMinor: sum.feesMinor + toReportingMinor({ amountMinor: row.cashFeesMinor, currency: row.cashCurrency, date: row.date }, reportingCurrency, "loan fee cash payments"),
  }), { totalMinor: 0, principalMinor: 0, interestMinor: 0, feesMinor: 0 });
  const cardPaymentRows = all<{ totalMinor: number; currency: string; date: string }>(
    `SELECT ABS(source_transaction.amount_minor) AS totalMinor,
            source_transaction.currency, substr(source_transaction.occurred_at, 1, 10) AS date
       FROM credit_card_payments p
       JOIN transactions source_transaction ON source_transaction.id = p.source_transaction_id
      WHERE p.user_id = ? AND p.voided_at IS NULL AND source_transaction.voided_at IS NULL
        AND p.payment_date >= ? AND p.payment_date < ?`,
    [userId, first, lastExclusive],
  );
  const cardPaymentsMinor = sumInReportingCurrency(
    cardPaymentRows.map((row) => ({ amountMinor: row.totalMinor, currency: row.currency, date: row.date })),
    reportingCurrency,
    "credit-card payments",
  );
  const debtServiceMinor = loanPayments.totalMinor + cardPaymentsMinor;
  const debtMonthlyMap = new Map<string, {
    month: string;
    cashPaidMinor: number;
    principalPaidMinor: number;
    interestFeesMinor: number;
  }>();
  for (const row of loanPaymentRows) {
    const month = row.date.slice(0, 7);
    const bucket = debtMonthlyMap.get(month) ?? { month, cashPaidMinor: 0, principalPaidMinor: 0, interestFeesMinor: 0 };
    bucket.cashPaidMinor += toReportingMinor({ amountMinor: row.cashTotalMinor, currency: row.cashCurrency, date: row.date }, reportingCurrency, "monthly debt cash service");
    bucket.principalPaidMinor += toReportingMinor({ amountMinor: row.cashPrincipalMinor, currency: row.cashCurrency, date: row.date }, reportingCurrency, "monthly principal cash payments");
    bucket.interestFeesMinor += toReportingMinor({ amountMinor: row.cashInterestMinor + row.cashFeesMinor, currency: row.cashCurrency, date: row.date }, reportingCurrency, "monthly interest and fee cash payments");
    debtMonthlyMap.set(month, bucket);
  }
  for (const row of cardPaymentRows) {
    const month = row.date.slice(0, 7);
    const bucket = debtMonthlyMap.get(month) ?? { month, cashPaidMinor: 0, principalPaidMinor: 0, interestFeesMinor: 0 };
    const converted = toReportingMinor({ amountMinor: row.totalMinor, currency: row.currency, date: row.date }, reportingCurrency, "monthly card payments");
    bucket.cashPaidMinor += converted;
    bucket.principalPaidMinor += converted;
    debtMonthlyMap.set(month, bucket);
  }
  const debtMonthly = [...debtMonthlyMap.values()].sort((left, right) => left.month.localeCompare(right.month));

  const suggestions: Array<{ title: string; detail: string; disclaimer: string }> = [];
  if (byCategory[0] && concentration > 60) suggestions.push({
    title: `Review ${byCategory[0].name}`,
    detail: "A large share of actual spending is concentrated in the top categories. Check whether this reflects your priorities.",
    disclaimer: "Pattern-based observation, not guaranteed financial advice.",
  });
  if (
    projectionApplicable
    && projectedMonthEndMinor !== null
    && projectionObservedSpendingMinor !== null
    && projectedMonthEndMinor > projectionObservedSpendingMinor * 1.2
    && Number(today.slice(-2)) < currentMonthDays
  ) suggestions.push({
    title: "Review the month-end pace",
    detail: "The straight-line projection is above current month-to-date spending because calendar days remain.",
    disclaimer: "Projection based on recent pace, not a guarantee or financial advice.",
  });
  if (!suggestions.length) suggestions.push({
    title: "Keep building your history",
    detail: "More actual transactions will make comparisons and pattern detection more meaningful.",
    disclaimer: "Informational observation, not financial advice.",
  });

  const categoryPeriodRows = (rangeFrom: string, rangeToExclusive: string) => groupedSpend(
    reportingSpendingAllocations(userId, rangeFrom, rangeToExclusive, "category comparisons"),
    (row) => ({ id: row.categoryId, name: row.categoryName }),
  );
  const currentCategories = categoryPeriodRows(first, lastExclusive);
  const previousCategories = new Map(categoryPeriodRows(addDays(range.from, -rangeDays), range.from).map((item) => [item.id, item]));
  const categoryIncreases = currentCategories.map((item) => {
    const previousMinor = previousCategories.get(item.id)?.amountMinor ?? 0;
    const changeMinor = item.amountMinor - previousMinor;
    return {
      ...item,
      currentMinor: item.amountMinor,
      previousMinor,
      changeMinor,
      changePercent: previousMinor ? changeMinor / previousMinor * 100 : null,
    };
  }).filter((item) => item.changeMinor > 0).sort((left, right) => right.changeMinor - left.changeMinor).slice(0, 8);
  const mostActiveWeekday = [...byWeekday].sort((left, right) => right.amountMinor - left.amountMinor)[0];
  const fixedVariable = ["fixed", "variable"].map((name) => ({
    id: name,
    name,
    amountMinor: classification.filter((item) => item.nature === name).reduce((sum, item) => sum + item.amountMinor, 0),
  }));
  const essentialDiscretionary = ["essential", "discretionary"].map((name) => ({
    id: name,
    name,
    amountMinor: classification.filter((item) => item.priority === name).reduce((sum, item) => sum + item.amountMinor, 0),
  }));
  const forecastRows = monthly.filter((row) => row.plannedMinor > 0 && row.month < currentMonth && !row.partial);
  const forecastMeanAbsoluteErrorMinor = forecastRows.length
    ? Math.round(forecastRows.reduce((sum, row) => sum + Math.abs(row.plannedMinor - row.actualMinor), 0) / forecastRows.length)
    : 0;
  const forecastMape = forecastRows.length
    ? forecastRows.reduce((sum, row) => sum + Math.abs(row.plannedMinor - row.actualMinor) / row.plannedMinor * 100, 0) / forecastRows.length
    : 0;
  const forecastAccuracy = forecastRows.length ? Math.max(0, 100 - forecastMape) : null;
  const forecastBiasValue = forecastRows.length
    ? forecastRows.reduce((sum, row) => sum + row.plannedMinor - row.actualMinor, 0) / forecastRows.length
    : 0;
  const summary = {
    ...current,
    ...periodTotals,
    expensesMinor: periodTotals.spendingMinor,
    savingsRate: periodTotals.incomeMinor ? periodTotals.netCashFlowMinor / periodTotals.incomeMinor * 100 : 0,
    rollingAverageMinor: current.rollingAverageMinor,
    recurringMonthlyMinor,
    cashRunwayDays,
    averageDailySpendingMinor,
    projectedMonthEndSpendingMinor: projectedMonthEndMinor,
    projectionApplicable,
    forecastAccuracy,
    forecastMeanAbsoluteErrorMinor,
    forecastMape,
    forecastSampleMonths: forecastRows.length,
    forecastBias: forecastRows.length ? (forecastBiasValue > 0 ? "Plans tend to overestimate spending" : forecastBiasValue < 0 ? "Plans tend to underestimate spending" : "Broadly neutral") : "Not enough data",
    categoryConcentration: concentration,
    spendingConsistency: consistency,
    mostActiveWeekday: mostActiveWeekday?.name,
    mostActiveWeekdayMinor: mostActiveWeekday?.amountMinor ?? 0,
  };
  const monthOverMonth = {
    incomePercent: previousPeriod.incomeMinor ? (periodTotals.incomeMinor / previousPeriod.incomeMinor - 1) * 100 : null,
    incomeChangePercent: previousPeriod.incomeMinor ? (periodTotals.incomeMinor / previousPeriod.incomeMinor - 1) * 100 : null,
    incomeChangeMinor: periodTotals.incomeMinor - previousPeriod.incomeMinor,
    spendingPercent: previousPeriod.spendingMinor ? (periodTotals.spendingMinor / previousPeriod.spendingMinor - 1) * 100 : null,
    expenseChangePercent: previousPeriod.spendingMinor ? (periodTotals.spendingMinor / previousPeriod.spendingMinor - 1) * 100 : null,
    expenseChangeMinor: periodTotals.spendingMinor - previousPeriod.spendingMinor,
  };
  const yearOverYear = {
    incomePercent: yearAgoPeriod.incomeMinor ? (periodTotals.incomeMinor / yearAgoPeriod.incomeMinor - 1) * 100 : null,
    incomeChangePercent: yearAgoPeriod.incomeMinor ? (periodTotals.incomeMinor / yearAgoPeriod.incomeMinor - 1) * 100 : null,
    incomeChangeMinor: periodTotals.incomeMinor - yearAgoPeriod.incomeMinor,
    spendingPercent: yearAgoPeriod.spendingMinor ? (periodTotals.spendingMinor / yearAgoPeriod.spendingMinor - 1) * 100 : null,
    expenseChangePercent: yearAgoPeriod.spendingMinor ? (periodTotals.spendingMinor / yearAgoPeriod.spendingMinor - 1) * 100 : null,
    expenseChangeMinor: periodTotals.spendingMinor - yearAgoPeriod.spendingMinor,
  };
  const netWorthHistory = selectedMonths.map((month) => {
    const selectedEnd = monthEnd(month) > range.to ? range.to : monthEnd(month);
    const balances = all<{ accountId: string; accountBalanceMinor: number; currency: string }>(
      `SELECT a.id AS accountId, a.currency,
              a.opening_balance_minor + COALESCE(SUM(
                CASE WHEN t.status = 'cleared' AND t.voided_at IS NULL
                           AND substr(t.occurred_at, 1, 10) >= a.opening_balance_date
                           AND substr(t.occurred_at, 1, 10) <= ?
                     THEN t.amount_minor ELSE 0 END
              ), 0) AS accountBalanceMinor
         FROM accounts a
         LEFT JOIN transactions t ON t.account_id = a.id AND t.user_id = ?
        WHERE a.user_id = ?
          AND a.opening_balance_date <= ?
          AND (a.archived_at IS NULL OR substr(a.archived_at, 1, 10) > ?)
        GROUP BY a.id`,
      [selectedEnd, userId, userId, selectedEnd, selectedEnd],
    );
    const netWorthMinor = sumInReportingCurrency(
      balances.map((row) => ({ amountMinor: row.accountBalanceMinor, currency: row.currency, date: selectedEnd })),
      reportingCurrency,
      `net worth on ${selectedEnd}`,
    );
    return { month, date: selectedEnd, netWorthMinor };
  });
  return {
    currency: reportingCurrency,
    reportingBasis: {
      actualFlows: "transaction_date",
      currentBalances: calendar.today,
      historicalBalances: "snapshot_date",
      plannedAmounts: "due_date",
      source: "BNR persisted reference rates",
    },
    period: { from: range.from, to: range.to, months: selectedMonths.length },
    summary,
    monthly,
    byCategory,
    byMerchant,
    byAccount,
    byTag,
    byWeekday,
    byWeek,
    classifications: classification,
    breakdowns: {
      categories: byCategory,
      merchants: byMerchant,
      accounts: byAccount,
      tags: byTag,
      weekdays: byWeekday,
      weeks: byWeek,
      fixedVariable,
      essentialDiscretionary,
    },
    plannedVsActual: { plannedMinor, actualMinor: periodTotals.spendingMinor, varianceMinor: plannedMinor - periodTotals.spendingMinor },
    comparisons: {
      monthOverMonth,
      mom: monthOverMonth,
      yearOverYear,
      yoy: yearOverYear,
    },
    recurringCommitmentMinor,
    recurring: {
      monthlyTotalMinor: recurringMonthlyMinor,
      subscriptionTotalMinor: recurringMonthlyMinor,
      subscriptionCount: subscriptions.length,
      spendingShare: averageDailySpending && averageDailySpending > 0
        ? recurringMonthlyMinor / (averageDailySpending * 30.4375) * 100
        : null,
      next30DaysMinor,
      subscriptions,
      commitments: subscriptions,
    },
    debt: {
      totalLiabilitiesMinor,
      creditCardOutstandingMinor: cardOutstandingMinor,
      creditLimitMinor: cardLimitMinor,
      creditUtilizationPercent: cardLimitMinor ? cardOutstandingMinor / cardLimitMinor * 100 : null,
      debtServiceMinor,
      cardPaymentsMinor,
      loanPaymentsMinor: loanPayments.totalMinor,
      principalRepaidMinor: loanPayments.principalMinor,
      interestFeesMinor: loanPayments.interestMinor + loanPayments.feesMinor,
      debtServiceToIncomePercent: periodTotals.incomeMinor ? debtServiceMinor / periodTotals.incomeMinor * 100 : null,
      accounts: liabilityAccounts,
      monthly: debtMonthly,
      informationalOnly: "Debt ratios and generated schedules are informational estimates. Lender statements and contracts remain authoritative.",
    },
    largestExpenses,
    categoryIncreases,
    accountHistory: accounts.map((account) => ({
      id: account.id,
      name: account.name,
      nativeBalanceMinor: account.balanceMinor,
      nativeCurrency: account.currency,
      balanceMinor: toReportingMinor(
        { amountMinor: account.balanceMinor, currency: account.currency, date: calendar.today },
        reportingCurrency,
        `the current balance for ${account.name}`,
      ),
      currency: reportingCurrency,
    })),
    netWorthHistory: netWorthHistory.map((row) => ({ ...row, balanceMinor: row.netWorthMinor })),
    balanceHistory: netWorthHistory,
    cashRunwayMonths,
    forecastAccuracy,
    averageDailySpendingMinor,
    projectedMonthEndMinor,
    projectionApplicable,
    categoryConcentrationPercent: concentration,
    spendingConsistencyPercent: consistency,
    suggestions: suggestions.map((item, index) => ({ id: `suggestion-${index}`, ...item, description: item.detail, severity: "info" })),
    insights: suggestions.map((item, index) => ({ id: `suggestion-${index}`, ...item, description: item.detail, severity: "info" })),
    explanations: {
      reportingCurrency: "Native account and transaction amounts are never rewritten. Actual flows use the persisted BNR rate on the transaction date; balance snapshots use the rate on their as-of date. Changing profile currency re-expresses reports dynamically.",
      savingsRate: "(Actual income − actual spending after refunds) ÷ actual income × 100. Transfers, adjustments and planned payments are excluded.",
      cashRunway: "Current liquid cash divided by average actual daily spending over observed days in the selected range.",
      forecastAccuracy: "100 minus mean absolute percentage error across completed, fully selected calendar months with planned spending.",
      projectedMonthEnd: "Current-month actual daily spending through today multiplied by the number of calendar days in the month. Available only when the selected range includes today.",
      concentration: "Share of actual spending represented by the three largest categories.",
      consistency: "100 minus the coefficient of variation of monthly actual spending, floored at zero.",
      creditUtilization: "Posted credit-card debt divided by configured credit limits. A card overpayment is not treated as debt.",
      debtService: "Actual cash paid to cards and loans in the selected range. Loan principal is a transfer; only interest and fees count as spending.",
      debtServiceToIncome: "Actual card and loan cash payments divided by actual income in the selected range. It is an informational cash-flow ratio, not underwriting advice.",
    },
    informationalOnly: "Suggestions are transparent review cues, not guaranteed financial advice.",
  };
}
