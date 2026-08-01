import { describe, expect, it } from "vitest";

import {
  assertValidTransferPair,
  calculateAccountBalance,
  createTransferPair,
  reconcileBalances,
  summarizeActualCashFlow,
  totalNetWorth,
} from "@/lib/domain/balances";

describe("account reconciliation", () => {
  const account = {
    id: "current",
    openingBalanceMinor: 100_000,
    openingBalanceDate: "2026-01-01",
  };

  it("uses opening balance plus cleared signed transactions", () => {
    const transactions = [
      { id: "1", accountId: "current", kind: "income" as const, amountMinor: 25_000, occurredAt: "2026-01-02", status: "cleared" as const },
      { id: "2", accountId: "current", kind: "expense" as const, amountMinor: -12_500, occurredAt: "2026-01-03", status: "cleared" as const },
      { id: "3", accountId: "current", kind: "expense" as const, amountMinor: -99_000, occurredAt: "2026-01-04", status: "pending" as const },
      { id: "4", accountId: "current", kind: "expense" as const, amountMinor: -99_000, occurredAt: "2026-01-04", status: "void" as const },
    ];
    expect(calculateAccountBalance(account, transactions)).toBe(112_500);
    expect(calculateAccountBalance(account, transactions, { includePending: true })).toBe(13_500);
    expect(calculateAccountBalance(account, transactions, { throughDate: "2026-01-02" })).toBe(125_000);
  });

  it("reconciles all accounts and net worth", () => {
    const savings = { id: "savings", openingBalanceMinor: 200_000, openingBalanceDate: "2026-01-01" };
    const transaction = { accountId: "savings", kind: "income" as const, amountMinor: 5_000, occurredAt: "2026-01-02", status: "cleared" as const };
    expect(Object.fromEntries(reconcileBalances([account, savings], [transaction]))).toEqual({ current: 100_000, savings: 205_000 });
    expect(totalNetWorth([account, savings], [transaction])).toBe(305_000);
  });
});

describe("transfers", () => {
  it("creates inverse legs without inflating cash flow", () => {
    const pair = createTransferPair({
      userId: "user",
      sourceAccountId: "current",
      destinationAccountId: "savings",
      amountMinor: 45_000,
      occurredAt: "2026-02-01",
    });
    assertValidTransferPair(pair);
    expect(pair[0].amountMinor).toBe(-45_000);
    expect(pair[1].amountMinor).toBe(45_000);
    expect(pair[0].transferGroupId).toBe(pair[1].transferGroupId);
    expect(summarizeActualCashFlow(pair)).toMatchObject({ incomeMinor: 0, spendingMinor: 0, netCashFlowMinor: 0 });
  });

  it("rejects malformed and same-account transfers", () => {
    expect(() =>
      createTransferPair({
        userId: "user",
        sourceAccountId: "same",
        destinationAccountId: "same",
        amountMinor: 100,
        occurredAt: "2026-01-01",
      }),
    ).toThrow(/different/);
  });

  it("reconciles asymmetric cross-currency legs without treating them as cash flow", () => {
    const pair = createTransferPair({
      userId: "user",
      sourceAccountId: "ron-current",
      destinationAccountId: "eur-savings",
      amountMinor: 50_000,
      destinationAmountMinor: 10_000,
      sourceCurrency: "RON",
      destinationCurrency: "EUR",
      fxRateScaled: 20_000_000,
      fxRateSource: "bnr",
      fxRateDate: "2026-02-02",
      occurredAt: "2026-02-02",
    });

    expect(() => assertValidTransferPair(pair)).not.toThrow();
    expect(pair[0]).toMatchObject({ amountMinor: -50_000, currency: "RON" });
    expect(pair[1]).toMatchObject({
      amountMinor: 10_000,
      currency: "EUR",
      originalAmountMinor: 50_000,
      originalCurrency: "RON",
      fxRateScaled: 20_000_000,
      fxRateSource: "bnr",
    });
    expect(summarizeActualCashFlow(pair)).toMatchObject({ incomeMinor: 0, spendingMinor: 0, netCashFlowMinor: 0 });
  });

  it("rejects cross-currency legs whose destination amount does not reconcile", () => {
    expect(() => createTransferPair({
      userId: "user",
      sourceAccountId: "ron-current",
      destinationAccountId: "eur-savings",
      amountMinor: 50_000,
      destinationAmountMinor: 9_999,
      sourceCurrency: "RON",
      destinationCurrency: "EUR",
      fxRateScaled: 20_000_000,
      fxRateSource: "manual",
      fxRateDate: "2026-02-02",
      occurredAt: "2026-02-02",
    })).toThrow(/destination amount/i);
  });
});

describe("actual cash flow", () => {
  it("treats refunds as reduced spending, not income", () => {
    const summary = summarizeActualCashFlow([
      { accountId: "a", kind: "income", amountMinor: 100_000, occurredAt: "2026-01-01", status: "cleared" },
      { accountId: "a", kind: "expense", amountMinor: -35_000, occurredAt: "2026-01-02", status: "cleared" },
      { accountId: "a", kind: "refund", amountMinor: 5_000, occurredAt: "2026-01-03", status: "cleared" },
    ]);
    expect(summary).toEqual({
      incomeMinor: 100_000,
      grossSpendingMinor: 35_000,
      refundsMinor: 5_000,
      spendingMinor: 30_000,
      netCashFlowMinor: 70_000,
      savingsRateBasisPoints: 7_000,
    });
  });
});
