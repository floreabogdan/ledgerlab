import { describe, expect, it } from "vitest";

import {
  addMonthsClamped,
  allocateLiabilityPayment,
  buildLoanSchedule,
  calculateCardStatementDue,
  calculateCreditCardMetrics,
  calculateLevelPaymentMinor,
  calculatePeriodicInterestMinor,
  loanInstallmentDates,
  ratePeriodForDate,
  resolveAnnualRateBps,
  type FixedRatePeriod,
  type VariableRatePeriod,
} from "@/lib/domain/liabilities";

const fixedTwelvePercent: FixedRatePeriod = {
  kind: "fixed",
  effectiveFrom: "2026-01-01",
  annualRateBps: 1_200,
};

describe("credit-card liability metrics", () => {
  it("represents a fully used limit as debt rather than available cash", () => {
    expect(
      calculateCreditCardMetrics({ accountBalanceMinor: -500_000, creditLimitMinor: 500_000 }),
    ).toMatchObject({
      postedOutstandingMinor: 500_000,
      projectedOutstandingMinor: 500_000,
      postedAvailableCreditMinor: 0,
      availableCreditMinor: 0,
      overLimitMinor: 0,
      utilizationBps: 10_000,
    });
  });

  it("includes pending charges and credits in availability and over-limit detection", () => {
    const metrics = calculateCreditCardMetrics({
      accountBalanceMinor: -480_000,
      creditLimitMinor: 500_000,
      pendingChargesMinor: 30_000,
      pendingCreditsMinor: 5_000,
    });

    expect(metrics.postedAvailableCreditMinor).toBe(20_000);
    expect(metrics.pendingNetDebtMinor).toBe(25_000);
    expect(metrics.projectedOutstandingMinor).toBe(505_000);
    expect(metrics.availableCreditMinor).toBe(0);
    expect(metrics.overLimitMinor).toBe(5_000);
    expect(metrics.utilizationBps).toBe(10_100);
  });

  it("preserves a card overpayment as a projected credit balance", () => {
    const metrics = calculateCreditCardMetrics({
      accountBalanceMinor: 10_000,
      creditLimitMinor: 500_000,
      pendingChargesMinor: 2_500,
    });

    expect(metrics.postedCreditBalanceMinor).toBe(10_000);
    expect(metrics.projectedOutstandingMinor).toBe(0);
    expect(metrics.projectedCreditBalanceMinor).toBe(7_500);
    expect(metrics.availableCreditMinor).toBe(500_000);
  });

  it("tracks a closed statement separately from newer card activity", () => {
    expect(
      calculateCardStatementDue({
        statementBalanceMinor: 420_000,
        minimumPaymentMinor: 25_000,
        paymentsSinceStatementMinor: 25_000,
        dueDate: "2026-08-15",
        asOfDate: "2026-08-16",
      }),
    ).toEqual({
      remainingStatementMinor: 395_000,
      remainingMinimumMinor: 0,
      status: "minimum_met",
    });
  });
});

describe("loan calendar and integer interest math", () => {
  it("clamps each installment from the original anchor day across month and year boundaries", () => {
    expect(loanInstallmentDates("2027-12-31", 4)).toEqual([
      "2027-12-31",
      "2028-01-31",
      "2028-02-29",
      "2028-03-31",
    ]);
    expect(addMonthsClamped("2027-01-31", 1)).toBe("2027-02-28");
  });

  it("calculates interest and level payments as integer minor units", () => {
    expect(calculatePeriodicInterestMinor(1_200_000, 1_200)).toBe(12_000);
    const paymentMinor = calculateLevelPaymentMinor({
      principalMinor: 1_200_000,
      annualRateBps: 1_200,
      installmentCount: 12,
    });
    expect(paymentMinor).toBe(106_619);
    expect(Number.isSafeInteger(paymentMinor)).toBe(true);
  });
});

describe("rate periods", () => {
  it("supports generic index names, tenors, margins, floors, and caps", () => {
    const irccPeriod: VariableRatePeriod = {
      kind: "variable",
      effectiveFrom: "2026-10-01",
      referenceIndex: "IRCC",
      referenceTenorMonths: 3,
      resetEveryMonths: 3,
      referenceRateBps: 590,
      marginBps: 250,
      floorRateBps: 0,
      capRateBps: 800,
      observationLagDays: 90,
    };
    expect(resolveAnnualRateBps(irccPeriod)).toBe(800);

    const customPeriod: VariableRatePeriod = {
      ...irccPeriod,
      referenceIndex: "Local bank 6M index",
      referenceTenorMonths: 6,
      referenceRateBps: -25,
      marginBps: 175,
      capRateBps: null,
    };
    expect(resolveAnnualRateBps(customPeriod)).toBe(150);
  });

  it("selects inclusive, non-overlapping periods and rejects uncovered dates", () => {
    const periods: FixedRatePeriod[] = [
      { kind: "fixed", effectiveFrom: "2026-01-01", effectiveThrough: "2026-12-31", annualRateBps: 500 },
      { kind: "fixed", effectiveFrom: "2027-01-01", annualRateBps: 600 },
    ];
    expect(resolveAnnualRateBps(ratePeriodForDate(periods, "2026-12-31"))).toBe(500);
    expect(resolveAnnualRateBps(ratePeriodForDate(periods, "2027-01-01"))).toBe(600);
    expect(() => ratePeriodForDate(periods, "2025-12-31")).toThrow("No interest-rate period covers");
  });
});

describe("loan schedules", () => {
  it("fully reconciles a fixed-rate annuity with fees", () => {
    const schedule = buildLoanSchedule({
      principalMinor: 1_200_000,
      firstPaymentDate: "2026-01-31",
      installmentCount: 12,
      repaymentMethod: "annuity",
      ratePeriods: [fixedTwelvePercent],
      fees: [{ amountMinor: 500 }],
    });

    expect(schedule.installments[0]).toMatchObject({
      dueDate: "2026-01-31",
      annualRateBps: 1_200,
      interestMinor: 12_000,
      feesMinor: 500,
    });
    expect(schedule.installments.at(-1)?.closingPrincipalMinor).toBe(0);
    expect(schedule.totalPrincipalMinor).toBe(1_200_000);
    expect(schedule.totalFeesMinor).toBe(6_000);
    expect(schedule.totalPaidMinor).toBe(
      schedule.totalPrincipalMinor + schedule.totalInterestMinor + schedule.totalFeesMinor,
    );
  });

  it("recasts an annuity at a variable-rate reset across a year boundary", () => {
    const schedule = buildLoanSchedule({
      principalMinor: 1_200_000,
      firstPaymentDate: "2026-11-30",
      installmentCount: 4,
      repaymentMethod: "annuity",
      ratePeriods: [
        {
          kind: "variable",
          effectiveFrom: "2026-01-01",
          effectiveThrough: "2026-12-31",
          referenceIndex: "Example 1M",
          referenceTenorMonths: 1,
          resetEveryMonths: 1,
          referenceRateBps: 400,
          marginBps: 200,
        },
        {
          kind: "variable",
          effectiveFrom: "2027-01-01",
          referenceIndex: "Example 1M",
          referenceTenorMonths: 1,
          resetEveryMonths: 1,
          referenceRateBps: 700,
          marginBps: 200,
        },
      ],
    });

    expect(schedule.installments.map((item) => item.dueDate)).toEqual([
      "2026-11-30",
      "2026-12-30",
      "2027-01-30",
      "2027-02-28",
    ]);
    expect(schedule.installments.map((item) => item.annualRateBps)).toEqual([600, 600, 900, 900]);
    expect(schedule.installments[2].referenceIndex).toBe("Example 1M");
    expect(schedule.installments.at(-1)?.closingPrincipalMinor).toBe(0);
  });

  it("supports equal-principal payments with deterministic remainder allocation", () => {
    const schedule = buildLoanSchedule({
      principalMinor: 100,
      firstPaymentDate: "2026-01-01",
      installmentCount: 3,
      repaymentMethod: "equal_principal",
      ratePeriods: [{ kind: "fixed", effectiveFrom: "2026-01-01", annualRateBps: 0 }],
    });
    expect(schedule.installments.map((item) => item.principalPaidMinor)).toEqual([34, 33, 33]);
  });

  it("supports interest-only terms and repays principal at maturity", () => {
    const schedule = buildLoanSchedule({
      principalMinor: 100_000,
      firstPaymentDate: "2026-01-15",
      installmentCount: 3,
      repaymentMethod: "interest_only",
      ratePeriods: [fixedTwelvePercent],
    });
    expect(schedule.installments.map((item) => item.principalPaidMinor)).toEqual([0, 0, 100_000]);
    expect(schedule.installments.map((item) => item.interestMinor)).toEqual([1_000, 1_000, 1_000]);
  });

  it("supports a longer notional amortization with a final balloon", () => {
    const schedule = buildLoanSchedule({
      principalMinor: 1_000_000,
      firstPaymentDate: "2026-01-15",
      installmentCount: 12,
      amortizationInstallmentCount: 24,
      repaymentMethod: "balloon",
      ratePeriods: [{ kind: "fixed", effectiveFrom: "2026-01-01", annualRateBps: 0 }],
    });
    expect(schedule.installments[0].principalPaidMinor).toBe(41_667);
    expect(schedule.installments.at(-1)?.principalPaidMinor).toBe(541_663);
    expect(schedule.totalPrincipalMinor).toBe(1_000_000);
    expect(schedule.installments.at(-1)?.closingPrincipalMinor).toBe(0);
  });
});

describe("liability payment allocation", () => {
  it("allocates fees and interest as expenses before principal reduction", () => {
    expect(
      allocateLiabilityPayment({
        paymentMinor: 70_000,
        feesDueMinor: 10_000,
        accruedInterestMinor: 20_000,
        outstandingPrincipalMinor: 100_000,
      }),
    ).toEqual({
      paymentMinor: 70_000,
      feesPaidMinor: 10_000,
      interestPaidMinor: 20_000,
      principalPaidMinor: 40_000,
      unappliedMinor: 0,
      remainingFeesMinor: 0,
      remainingInterestMinor: 0,
      remainingPrincipalMinor: 60_000,
    });
  });

  it("supports explicit allocation order and reports overpayments as unapplied", () => {
    const allocation = allocateLiabilityPayment({
      paymentMinor: 150_000,
      feesDueMinor: 10_000,
      accruedInterestMinor: 20_000,
      outstandingPrincipalMinor: 100_000,
      allocationOrder: ["principal", "interest", "fees"],
    });
    expect(allocation).toMatchObject({
      principalPaidMinor: 100_000,
      interestPaidMinor: 20_000,
      feesPaidMinor: 10_000,
      unappliedMinor: 20_000,
    });
  });
});
