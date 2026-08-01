import { describe, expect, it } from "vitest";

import { calculatePlannedVsActual } from "@/lib/domain/planning";

describe("planned versus actual", () => {
  it("keeps the two datasets separate and excludes transfers/pending rows", () => {
    const comparison = calculatePlannedVsActual(
      [
        { id: "p1", categoryId: "food", direction: "expense", expectedAmountMinor: 30_000, status: "paid" },
        { id: "p2", categoryId: "salary", direction: "income", expectedAmountMinor: 100_000, status: "planned" },
        { id: "p3", categoryId: "fun", direction: "expense", expectedAmountMinor: 20_000, status: "cancelled" },
      ],
      [
        { categoryId: "food", kind: "expense", amountMinor: -34_000, status: "cleared" },
        { categoryId: "food", kind: "refund", amountMinor: 4_000, status: "cleared" },
        { categoryId: "salary", kind: "income", amountMinor: 105_000, status: "cleared" },
        { categoryId: null, kind: "transfer", amountMinor: 50_000, status: "cleared" },
        { categoryId: "food", kind: "expense", amountMinor: -5_000, status: "pending" },
      ],
    );
    expect(comparison).toMatchObject({
      plannedIncomeMinor: 100_000,
      actualIncomeMinor: 105_000,
      plannedSpendingMinor: 30_000,
      actualSpendingMinor: 30_000,
      incomeVarianceMinor: 5_000,
      spendingVarianceMinor: 0,
    });
    expect(comparison.byCategory.find((line) => line.categoryId === "food")).toMatchObject({
      plannedSpendingMinor: 30_000,
      actualSpendingMinor: 30_000,
    });
  });
});

