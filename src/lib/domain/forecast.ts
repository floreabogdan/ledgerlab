import type { PlannedStatus, TransactionKind, TransactionStatus } from "@/db/schema";

import { datePart, monthBounds } from "./dates";
import { addMinor, assertMinorUnits } from "./money";

export type ForecastAccount = {
  id: string;
  expectedOpeningMinor: number;
  includeInCash?: boolean;
};

export type ForecastActual = {
  id: string;
  accountId: string;
  amountMinor: number;
  occurredAt: string;
  kind: TransactionKind;
  status?: TransactionStatus;
  plannedOccurrenceId?: string | null;
};

export type ForecastPlanned = {
  id: string;
  accountId?: string | null;
  expectedAmountMinor: number;
  paidAmountMinor?: number;
  dueDate: string;
  direction: "income" | "expense";
  status: PlannedStatus;
};

type ForecastPoint = {
  date: string;
  source: "actual" | "planned";
  sourceId: string;
  accountId: string | null;
  changeMinor: number;
  totalCashMinor: number;
  estimated: boolean;
};

export type MonthForecast = {
  month: string;
  openingByAccount: Record<string, number>;
  closingByAccount: Record<string, number>;
  projectedClosingCashMinor: number;
  lowestProjectedCashMinor: number;
  lowestProjectedCashDate: string;
  unallocatedPlannedMinor: number;
  points: ForecastPoint[];
};

type ForecastEvent = Omit<ForecastPoint, "totalCashMinor">;

/**
 * Combines actual-to-date and unpaid planned residuals. A paid occurrence represented
 * by an actual transaction is included exactly once, never as both planned and actual.
 */
export function forecastMonth(input: {
  month: string;
  accounts: readonly ForecastAccount[];
  actualTransactions: readonly ForecastActual[];
  planned: readonly ForecastPlanned[];
}): MonthForecast {
  const { start, end } = monthBounds(input.month);
  const balances = new Map<string, number>();
  const cashAccounts = new Set<string>();
  for (const account of input.accounts) {
    assertMinorUnits(account.expectedOpeningMinor, "expectedOpeningMinor");
    balances.set(account.id, account.expectedOpeningMinor);
    if (account.includeInCash !== false) cashAccounts.add(account.id);
  }

  const linkedActualOccurrences = new Set(
    input.actualTransactions.flatMap((transaction) =>
      transaction.status !== "void" && transaction.plannedOccurrenceId ? [transaction.plannedOccurrenceId] : [],
    ),
  );
  const events: ForecastEvent[] = [];

  for (const transaction of input.actualTransactions) {
    const date = datePart(transaction.occurredAt);
    if (date < start || date > end || transaction.status === "void") continue;
    assertMinorUnits(transaction.amountMinor);
    events.push({
      date,
      source: "actual",
      sourceId: transaction.id,
      accountId: transaction.accountId,
      changeMinor: transaction.amountMinor,
      estimated: transaction.status === "pending",
    });
  }

  let unallocatedPlannedMinor = 0;
  for (const item of input.planned) {
    if (
      item.dueDate < start ||
      item.dueDate > end ||
      ["paid", "skipped", "cancelled"].includes(item.status) ||
      linkedActualOccurrences.has(item.id)
    ) {
      continue;
    }
    const residual = Math.max(0, item.expectedAmountMinor - (item.paidAmountMinor ?? 0));
    assertMinorUnits(residual, "planned residual");
    if (residual === 0) continue;
    const signedResidual = item.direction === "expense" ? -residual : residual;
    if (!item.accountId) unallocatedPlannedMinor = addMinor(unallocatedPlannedMinor, signedResidual);
    events.push({
      date: item.dueDate,
      source: "planned",
      sourceId: item.id,
      accountId: item.accountId ?? null,
      changeMinor: signedResidual,
      estimated: true,
    });
  }

  // Expense first on the same date yields a transparent, conservative intraday low.
  events.sort(
    (left, right) =>
      left.date.localeCompare(right.date) ||
      left.changeMinor - right.changeMinor ||
      left.source.localeCompare(right.source) ||
      left.sourceId.localeCompare(right.sourceId),
  );

  const totalCash = () => addMinor(...[...cashAccounts].map((accountId) => balances.get(accountId) ?? 0));
  let lowestProjectedCashMinor = totalCash();
  let lowestProjectedCashDate = start;
  const points: ForecastPoint[] = [];
  for (const event of events) {
    if (event.accountId && balances.has(event.accountId)) {
      balances.set(event.accountId, addMinor(balances.get(event.accountId)!, event.changeMinor));
    }
    const currentTotal = totalCash();
    if (currentTotal < lowestProjectedCashMinor) {
      lowestProjectedCashMinor = currentTotal;
      lowestProjectedCashDate = event.date;
    }
    points.push({ ...event, totalCashMinor: currentTotal });
  }

  const closingByAccount = Object.fromEntries(balances);
  return {
    month: input.month,
    openingByAccount: Object.fromEntries(input.accounts.map((account) => [account.id, account.expectedOpeningMinor])),
    closingByAccount,
    projectedClosingCashMinor: totalCash(),
    lowestProjectedCashMinor,
    lowestProjectedCashDate,
    unallocatedPlannedMinor,
    points,
  };
}
