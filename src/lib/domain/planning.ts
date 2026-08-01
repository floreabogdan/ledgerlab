import type { PlannedStatus, TransactionKind, TransactionStatus } from "@/db/schema";

import { addMinor, assertMinorUnits } from "./money";

export type ComparisonPlanned = {
  id: string;
  categoryId?: string | null;
  direction: "income" | "expense";
  expectedAmountMinor: number;
  status: PlannedStatus;
};

export type ComparisonActual = {
  categoryId?: string | null;
  kind: TransactionKind;
  amountMinor: number;
  status?: TransactionStatus;
};

type PlannedActualLine = {
  categoryId: string | null;
  plannedIncomeMinor: number;
  actualIncomeMinor: number;
  plannedSpendingMinor: number;
  actualSpendingMinor: number;
  spendingVarianceMinor: number;
};

export type PlannedActualComparison = {
  plannedIncomeMinor: number;
  actualIncomeMinor: number;
  plannedSpendingMinor: number;
  actualSpendingMinor: number;
  incomeVarianceMinor: number;
  spendingVarianceMinor: number;
  byCategory: PlannedActualLine[];
};

/** Planned and actual columns are accumulated independently to avoid historical data contamination. */
export function calculatePlannedVsActual(
  planned: readonly ComparisonPlanned[],
  actual: readonly ComparisonActual[],
): PlannedActualComparison {
  const lines = new Map<string | null, PlannedActualLine>();
  const lineFor = (categoryId: string | null) => {
    const existing = lines.get(categoryId);
    if (existing) return existing;
    const created: PlannedActualLine = {
      categoryId,
      plannedIncomeMinor: 0,
      actualIncomeMinor: 0,
      plannedSpendingMinor: 0,
      actualSpendingMinor: 0,
      spendingVarianceMinor: 0,
    };
    lines.set(categoryId, created);
    return created;
  };

  for (const item of planned) {
    if (["skipped", "cancelled"].includes(item.status)) continue;
    assertMinorUnits(item.expectedAmountMinor);
    const line = lineFor(item.categoryId ?? null);
    if (item.direction === "income") line.plannedIncomeMinor = addMinor(line.plannedIncomeMinor, item.expectedAmountMinor);
    else line.plannedSpendingMinor = addMinor(line.plannedSpendingMinor, item.expectedAmountMinor);
  }

  for (const transaction of actual) {
    if (transaction.status === "void" || transaction.status === "pending") continue;
    if (transaction.kind === "transfer" || transaction.kind === "adjustment") continue;
    assertMinorUnits(transaction.amountMinor);
    const line = lineFor(transaction.categoryId ?? null);
    if (transaction.kind === "income") line.actualIncomeMinor = addMinor(line.actualIncomeMinor, transaction.amountMinor);
    if (transaction.kind === "expense") line.actualSpendingMinor = addMinor(line.actualSpendingMinor, -transaction.amountMinor);
    if (transaction.kind === "refund") line.actualSpendingMinor = Math.max(0, addMinor(line.actualSpendingMinor, -transaction.amountMinor));
  }

  const byCategory = [...lines.values()]
    .map((line) => ({
      ...line,
      spendingVarianceMinor: addMinor(line.actualSpendingMinor, -line.plannedSpendingMinor),
    }))
    .sort((left, right) => (left.categoryId ?? "").localeCompare(right.categoryId ?? ""));
  const plannedIncomeMinor = addMinor(...byCategory.map((line) => line.plannedIncomeMinor));
  const actualIncomeMinor = addMinor(...byCategory.map((line) => line.actualIncomeMinor));
  const plannedSpendingMinor = addMinor(...byCategory.map((line) => line.plannedSpendingMinor));
  const actualSpendingMinor = addMinor(...byCategory.map((line) => line.actualSpendingMinor));
  return {
    plannedIncomeMinor,
    actualIncomeMinor,
    plannedSpendingMinor,
    actualSpendingMinor,
    incomeVarianceMinor: addMinor(actualIncomeMinor, -plannedIncomeMinor),
    spendingVarianceMinor: addMinor(actualSpendingMinor, -plannedSpendingMinor),
    byCategory,
  };
}
