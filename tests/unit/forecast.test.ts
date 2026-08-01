import { describe, expect, it } from "vitest";

import { forecastMonth } from "@/lib/domain/forecast";

describe("monthly forecast", () => {
  it("combines actuals and outstanding plans while reporting the lowest cash point", () => {
    const forecast = forecastMonth({
      month: "2026-08",
      accounts: [
        { id: "current", expectedOpeningMinor: 100_000 },
        { id: "savings", expectedOpeningMinor: 50_000 },
      ],
      actualTransactions: [
        { id: "groceries", accountId: "current", amountMinor: -20_000, occurredAt: "2026-08-03", kind: "expense", status: "cleared" },
        { id: "paid-bill", accountId: "current", amountMinor: -10_000, occurredAt: "2026-08-05", kind: "expense", status: "cleared", plannedOccurrenceId: "bill" },
      ],
      planned: [
        { id: "bill", accountId: "current", expectedAmountMinor: 10_000, dueDate: "2026-08-05", direction: "expense", status: "paid" },
        { id: "rent", accountId: "current", expectedAmountMinor: 60_000, dueDate: "2026-08-10", direction: "expense", status: "scheduled" },
        { id: "salary", accountId: "current", expectedAmountMinor: 120_000, dueDate: "2026-08-15", direction: "income", status: "planned" },
      ],
    });
    expect(forecast.closingByAccount).toEqual({ current: 130_000, savings: 50_000 });
    expect(forecast.projectedClosingCashMinor).toBe(180_000);
    expect(forecast.lowestProjectedCashMinor).toBe(60_000);
    expect(forecast.lowestProjectedCashDate).toBe("2026-08-10");
    expect(forecast.points.map((point) => point.sourceId)).toEqual(["groceries", "paid-bill", "rent", "salary"]);
  });

  it("forecasts only the unpaid residual of a partial payment", () => {
    const forecast = forecastMonth({
      month: "2026-08",
      accounts: [{ id: "cash", expectedOpeningMinor: 50_000 }],
      actualTransactions: [],
      planned: [
        { id: "partial", accountId: "cash", expectedAmountMinor: 20_000, paidAmountMinor: 7_500, dueDate: "2026-08-12", direction: "expense", status: "scheduled" },
      ],
    });
    expect(forecast.closingByAccount.cash).toBe(37_500);
  });
});

