import { formatDateKey, parseDateKey } from "./dates";
import { assertMinorUnits } from "./money";

const BASIS_POINTS_PER_UNIT = 10_000;
const MONTHS_PER_YEAR = 12;

function assertNonNegativeMinor(value: number, field: string): void {
  assertMinorUnits(value, field);
  if (value < 0) throw new RangeError(`${field} must not be negative.`);
}

function assertInteger(value: number, field: string, minimum = 0): void {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new RangeError(`${field} must be a safe integer of at least ${minimum}.`);
  }
}

function safeAdd(left: number, right: number, field: string): number {
  const result = left + right;
  assertMinorUnits(result, field);
  return result;
}

function safeSubtract(left: number, right: number, field: string): number {
  const result = left - right;
  assertMinorUnits(result, field);
  return result;
}

function bigintToSafeNumber(value: bigint, field: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new RangeError(`${field} exceeds the safe integer range.`);
  return result;
}

/** Rounds a non-negative rational value to the closest integer, with halves rounded up. */
function roundRatio(numerator: bigint, denominator: bigint, field: string): number {
  if (numerator < 0n || denominator <= 0n) throw new RangeError(`${field} cannot be calculated.`);
  return bigintToSafeNumber((numerator + denominator / 2n) / denominator, field);
}

export type CreditCardMetricsInput = {
  /** Signed ledger balance: a debt is negative and an overpayment/credit is positive. */
  accountBalanceMinor: number;
  creditLimitMinor: number;
  pendingChargesMinor?: number;
  pendingCreditsMinor?: number;
};

export type CreditCardMetrics = {
  creditLimitMinor: number;
  postedOutstandingMinor: number;
  postedCreditBalanceMinor: number;
  postedAvailableCreditMinor: number;
  pendingNetDebtMinor: number;
  projectedOutstandingMinor: number;
  projectedCreditBalanceMinor: number;
  availableCreditMinor: number;
  overLimitMinor: number;
  /** 10,000 means 100%; values can exceed 10,000 when the card is over its limit. */
  utilizationBps: number | null;
};

/**
 * Derives card debt and availability without ever treating the credit limit as an asset.
 * Pending charges increase projected debt; pending credits and card overpayments reduce it.
 */
export function calculateCreditCardMetrics(input: CreditCardMetricsInput): CreditCardMetrics {
  assertMinorUnits(input.accountBalanceMinor, "accountBalanceMinor");
  assertNonNegativeMinor(input.creditLimitMinor, "creditLimitMinor");
  const pendingChargesMinor = input.pendingChargesMinor ?? 0;
  const pendingCreditsMinor = input.pendingCreditsMinor ?? 0;
  assertNonNegativeMinor(pendingChargesMinor, "pendingChargesMinor");
  assertNonNegativeMinor(pendingCreditsMinor, "pendingCreditsMinor");

  const postedDebtPositionMinor = -input.accountBalanceMinor;
  assertMinorUnits(postedDebtPositionMinor, "postedDebtPositionMinor");
  const pendingNetDebtMinor = safeSubtract(pendingChargesMinor, pendingCreditsMinor, "pendingNetDebtMinor");
  const projectedDebtPositionMinor = safeAdd(
    postedDebtPositionMinor,
    pendingNetDebtMinor,
    "projectedDebtPositionMinor",
  );
  const postedOutstandingMinor = Math.max(0, postedDebtPositionMinor);
  const projectedOutstandingMinor = Math.max(0, projectedDebtPositionMinor);
  const postedAvailableCreditMinor = Math.max(0, input.creditLimitMinor - postedOutstandingMinor);
  const availableCreditMinor = Math.max(0, input.creditLimitMinor - projectedOutstandingMinor);
  const overLimitMinor = Math.max(0, projectedOutstandingMinor - input.creditLimitMinor);
  const utilizationBps =
    input.creditLimitMinor === 0
      ? null
      : roundRatio(
          BigInt(projectedOutstandingMinor) * BigInt(BASIS_POINTS_PER_UNIT),
          BigInt(input.creditLimitMinor),
          "utilizationBps",
        );

  return {
    creditLimitMinor: input.creditLimitMinor,
    postedOutstandingMinor,
    postedCreditBalanceMinor: Math.max(0, input.accountBalanceMinor),
    postedAvailableCreditMinor,
    pendingNetDebtMinor,
    projectedOutstandingMinor,
    projectedCreditBalanceMinor: Math.max(0, -projectedDebtPositionMinor),
    availableCreditMinor,
    overLimitMinor,
    utilizationBps,
  };
}

export type CardStatementDueStatus = "not_due" | "minimum_met" | "due" | "overdue" | "paid";

export type CardStatementDueInput = {
  statementBalanceMinor: number;
  minimumPaymentMinor: number;
  paymentsSinceStatementMinor?: number;
  dueDate: string;
  asOfDate: string;
};

/** Calculates what remains due from a closed statement, independently of newer card activity. */
export function calculateCardStatementDue(input: CardStatementDueInput): {
  remainingStatementMinor: number;
  remainingMinimumMinor: number;
  status: CardStatementDueStatus;
} {
  assertNonNegativeMinor(input.statementBalanceMinor, "statementBalanceMinor");
  assertNonNegativeMinor(input.minimumPaymentMinor, "minimumPaymentMinor");
  const paymentsSinceStatementMinor = input.paymentsSinceStatementMinor ?? 0;
  assertNonNegativeMinor(paymentsSinceStatementMinor, "paymentsSinceStatementMinor");
  parseDateKey(input.dueDate);
  parseDateKey(input.asOfDate);
  if (input.minimumPaymentMinor > input.statementBalanceMinor) {
    throw new RangeError("minimumPaymentMinor cannot exceed statementBalanceMinor.");
  }

  const remainingStatementMinor = Math.max(0, input.statementBalanceMinor - paymentsSinceStatementMinor);
  const remainingMinimumMinor = Math.max(0, input.minimumPaymentMinor - paymentsSinceStatementMinor);
  let status: CardStatementDueStatus;
  if (remainingStatementMinor === 0) status = "paid";
  else if (remainingMinimumMinor === 0) status = "minimum_met";
  else if (input.asOfDate > input.dueDate) status = "overdue";
  else if (input.asOfDate === input.dueDate) status = "due";
  else status = "not_due";

  return { remainingStatementMinor, remainingMinimumMinor, status };
}

type RatePeriodBase = {
  effectiveFrom: string;
  /** Inclusive. Omit for an open-ended final period. */
  effectiveThrough?: string | null;
};

export type FixedRatePeriod = RatePeriodBase & {
  kind: "fixed";
  annualRateBps: number;
};

export type VariableRatePeriod = RatePeriodBase & {
  kind: "variable";
  /** Generic name such as IRCC, ROBOR, EURIBOR, SOFR, Prime, or a custom index. */
  referenceIndex: string;
  /** Supports common 1/3/6/12-month tenors without making the list country-specific. */
  referenceTenorMonths: number;
  resetEveryMonths: number;
  referenceRateBps: number;
  marginBps: number;
  floorRateBps?: number | null;
  capRateBps?: number | null;
  observationLagDays?: number;
};

export type LoanRatePeriod = FixedRatePeriod | VariableRatePeriod;

function assertBasisPoints(value: number, field: string, allowNegative = false): void {
  if (!Number.isSafeInteger(value) || (!allowNegative && value < 0)) {
    throw new RangeError(`${field} must be ${allowNegative ? "an" : "a non-negative"} integer number of basis points.`);
  }
}

export function resolveAnnualRateBps(period: LoanRatePeriod): number {
  if (period.kind === "fixed") {
    assertBasisPoints(period.annualRateBps, "annualRateBps");
    return period.annualRateBps;
  }

  if (!period.referenceIndex.trim()) throw new RangeError("referenceIndex is required for a variable rate.");
  assertInteger(period.referenceTenorMonths, "referenceTenorMonths", 1);
  assertInteger(period.resetEveryMonths, "resetEveryMonths", 1);
  assertBasisPoints(period.referenceRateBps, "referenceRateBps", true);
  assertBasisPoints(period.marginBps, "marginBps", true);
  if (period.observationLagDays != null) assertInteger(period.observationLagDays, "observationLagDays");
  if (period.floorRateBps != null) assertBasisPoints(period.floorRateBps, "floorRateBps", true);
  if (period.capRateBps != null) assertBasisPoints(period.capRateBps, "capRateBps", true);
  if (
    period.floorRateBps != null &&
    period.capRateBps != null &&
    period.floorRateBps > period.capRateBps
  ) {
    throw new RangeError("floorRateBps cannot exceed capRateBps.");
  }

  const indexedRate = safeAdd(period.referenceRateBps, period.marginBps, "indexedRateBps");
  const flooredRate = period.floorRateBps == null ? indexedRate : Math.max(indexedRate, period.floorRateBps);
  const effectiveRate = period.capRateBps == null ? flooredRate : Math.min(flooredRate, period.capRateBps);
  assertBasisPoints(effectiveRate, "effectiveAnnualRateBps");
  return effectiveRate;
}

function validateRatePeriods(periods: readonly LoanRatePeriod[]): LoanRatePeriod[] {
  if (periods.length === 0) throw new RangeError("At least one interest-rate period is required.");
  const sorted = [...periods].sort((left, right) => left.effectiveFrom.localeCompare(right.effectiveFrom));

  sorted.forEach((period, index) => {
    parseDateKey(period.effectiveFrom);
    if (period.effectiveThrough) {
      parseDateKey(period.effectiveThrough);
      if (period.effectiveThrough < period.effectiveFrom) {
        throw new RangeError("An interest-rate period cannot end before it starts.");
      }
    }
    resolveAnnualRateBps(period);
    const previous = sorted[index - 1];
    if (!previous) return;
    if (!previous.effectiveThrough || previous.effectiveThrough >= period.effectiveFrom) {
      throw new RangeError("Interest-rate periods cannot overlap or follow an open-ended period.");
    }
  });
  return sorted;
}

export function ratePeriodForDate(periods: readonly LoanRatePeriod[], date: string): LoanRatePeriod {
  parseDateKey(date);
  const sorted = validateRatePeriods(periods);
  const match = sorted.find(
    (period) => period.effectiveFrom <= date && (!period.effectiveThrough || period.effectiveThrough >= date),
  );
  if (!match) throw new RangeError(`No interest-rate period covers ${date}.`);
  return match;
}

/** Adds calendar months while retaining the original day when possible (31 Jan -> 28 Feb -> 31 Mar). */
export function addMonthsClamped(date: string, months: number): string {
  const source = parseDateKey(date);
  assertInteger(months, "months");
  const absoluteMonth = source.getUTCFullYear() * MONTHS_PER_YEAR + source.getUTCMonth() + months;
  const year = Math.floor(absoluteMonth / MONTHS_PER_YEAR);
  const zeroBasedMonth = absoluteMonth % MONTHS_PER_YEAR;
  const lastDay = new Date(Date.UTC(year, zeroBasedMonth + 1, 0)).getUTCDate();
  return formatDateKey(new Date(Date.UTC(year, zeroBasedMonth, Math.min(source.getUTCDate(), lastDay))));
}

export function loanInstallmentDates(
  firstPaymentDate: string,
  installmentCount: number,
  intervalMonths = 1,
): string[] {
  parseDateKey(firstPaymentDate);
  assertInteger(installmentCount, "installmentCount", 1);
  assertInteger(intervalMonths, "intervalMonths", 1);
  return Array.from({ length: installmentCount }, (_, index) => addMonthsClamped(firstPaymentDate, index * intervalMonths));
}

/** Periodic interest using integer-only arithmetic and half-up rounding to minor units. */
export function calculatePeriodicInterestMinor(
  principalMinor: number,
  annualRateBps: number,
  intervalMonths = 1,
): number {
  assertNonNegativeMinor(principalMinor, "principalMinor");
  assertBasisPoints(annualRateBps, "annualRateBps");
  assertInteger(intervalMonths, "intervalMonths", 1);
  return roundRatio(
    BigInt(principalMinor) * BigInt(annualRateBps) * BigInt(intervalMonths),
    BigInt(BASIS_POINTS_PER_UNIT * MONTHS_PER_YEAR),
    "interestMinor",
  );
}

function balanceAfterLevelPayments(
  principalMinor: number,
  annualRateBps: number,
  installmentCount: number,
  intervalMonths: number,
  paymentMinor: number,
): number {
  let balance = principalMinor;
  for (let index = 0; index < installmentCount && balance > 0; index += 1) {
    const interest = calculatePeriodicInterestMinor(balance, annualRateBps, intervalMonths);
    const principalPaid = Math.max(0, paymentMinor - interest);
    balance = Math.max(0, balance - principalPaid);
  }
  return balance;
}

/** Finds the smallest level installment that amortizes the principal in the requested term. */
export function calculateLevelPaymentMinor(input: {
  principalMinor: number;
  annualRateBps: number;
  installmentCount: number;
  intervalMonths?: number;
}): number {
  assertNonNegativeMinor(input.principalMinor, "principalMinor");
  assertBasisPoints(input.annualRateBps, "annualRateBps");
  assertInteger(input.installmentCount, "installmentCount", 1);
  const intervalMonths = input.intervalMonths ?? 1;
  assertInteger(intervalMonths, "intervalMonths", 1);
  if (input.principalMinor === 0) return 0;

  let low = 1;
  let high = safeAdd(
    input.principalMinor,
    calculatePeriodicInterestMinor(input.principalMinor, input.annualRateBps, intervalMonths),
    "levelPaymentUpperBoundMinor",
  );
  while (low < high) {
    const midpoint = low + Math.floor((high - low) / 2);
    const remaining = balanceAfterLevelPayments(
      input.principalMinor,
      input.annualRateBps,
      input.installmentCount,
      intervalMonths,
      midpoint,
    );
    if (remaining === 0) high = midpoint;
    else low = midpoint + 1;
  }
  return low;
}

type LoanRepaymentMethod = "annuity" | "equal_principal" | "interest_only" | "balloon";

type LoanFeeRule = {
  amountMinor: number;
  fromInstallment?: number;
  throughInstallment?: number;
  everyInstallments?: number;
};

export type LoanScheduleInput = {
  principalMinor: number;
  firstPaymentDate: string;
  installmentCount: number;
  intervalMonths?: number;
  /** Number of contractual installments already elapsed; preserves the original calendar anchor on rebuild. */
  installmentOffset?: number;
  repaymentMethod: LoanRepaymentMethod;
  ratePeriods: readonly LoanRatePeriod[];
  /** Balloon schedules calculate regular payments over this longer notional term. */
  amortizationInstallmentCount?: number;
  fees?: readonly LoanFeeRule[];
};

type LoanInstallment = {
  installmentNumber: number;
  dueDate: string;
  openingPrincipalMinor: number;
  annualRateBps: number;
  rateKind: LoanRatePeriod["kind"];
  referenceIndex: string | null;
  referenceTenorMonths: number | null;
  resetEveryMonths: number | null;
  principalPaidMinor: number;
  interestMinor: number;
  feesMinor: number;
  totalPaymentMinor: number;
  closingPrincipalMinor: number;
};

export type LoanSchedule = {
  installments: LoanInstallment[];
  totalPrincipalMinor: number;
  totalInterestMinor: number;
  totalFeesMinor: number;
  totalPaidMinor: number;
};

function validateFeeRules(rules: readonly LoanFeeRule[]): void {
  for (const rule of rules) {
    assertNonNegativeMinor(rule.amountMinor, "fee.amountMinor");
    if (rule.fromInstallment != null) assertInteger(rule.fromInstallment, "fee.fromInstallment", 1);
    if (rule.throughInstallment != null) assertInteger(rule.throughInstallment, "fee.throughInstallment", 1);
    if (rule.everyInstallments != null) assertInteger(rule.everyInstallments, "fee.everyInstallments", 1);
    if (
      rule.fromInstallment != null &&
      rule.throughInstallment != null &&
      rule.fromInstallment > rule.throughInstallment
    ) {
      throw new RangeError("A fee cannot end before its first installment.");
    }
  }
}

function feesForInstallment(rules: readonly LoanFeeRule[], installmentNumber: number): number {
  return rules.reduce((total, rule) => {
    const from = rule.fromInstallment ?? 1;
    const through = rule.throughInstallment ?? Number.MAX_SAFE_INTEGER;
    const every = rule.everyInstallments ?? 1;
    if (installmentNumber < from || installmentNumber > through || (installmentNumber - from) % every !== 0) {
      return total;
    }
    return safeAdd(total, rule.amountMinor, "installmentFeesMinor");
  }, 0);
}

/**
 * Builds a deterministic contractual estimate. Variable-rate annuities are recast whenever
 * the effective annual rate changes; actual lender statements remain authoritative.
 */
export function buildLoanSchedule(input: LoanScheduleInput): LoanSchedule {
  assertNonNegativeMinor(input.principalMinor, "principalMinor");
  if (input.principalMinor === 0) throw new RangeError("principalMinor must be greater than zero.");
  assertInteger(input.installmentCount, "installmentCount", 1);
  const intervalMonths = input.intervalMonths ?? 1;
  assertInteger(intervalMonths, "intervalMonths", 1);
  const installmentOffset = input.installmentOffset ?? 0;
  assertInteger(installmentOffset, "installmentOffset");
  parseDateKey(input.firstPaymentDate);
  const dates = Array.from(
    { length: input.installmentCount },
    (_, index) => addMonthsClamped(input.firstPaymentDate, (installmentOffset + index) * intervalMonths),
  );
  const periods = validateRatePeriods(input.ratePeriods);
  const fees = input.fees ?? [];
  validateFeeRules(fees);

  if (input.repaymentMethod === "balloon") {
    assertInteger(input.amortizationInstallmentCount ?? 0, "amortizationInstallmentCount", input.installmentCount + 1);
  } else if (input.amortizationInstallmentCount != null) {
    throw new RangeError("amortizationInstallmentCount is only valid for a balloon schedule.");
  }

  let balance = input.principalMinor;
  let previousRateBps: number | null = null;
  let regularPaymentMinor = 0;
  let totalPrincipalMinor = 0;
  let totalInterestMinor = 0;
  let totalFeesMinor = 0;
  let totalPaidMinor = 0;
  const installments: LoanInstallment[] = [];

  dates.forEach((dueDate, index) => {
    const installmentNumber = index + 1;
    const isLast = installmentNumber === input.installmentCount;
    const ratePeriod = ratePeriodForDate(periods, dueDate);
    const annualRateBps = resolveAnnualRateBps(ratePeriod);
    const openingPrincipalMinor = balance;
    const interestMinor = calculatePeriodicInterestMinor(openingPrincipalMinor, annualRateBps, intervalMonths);
    let principalPaidMinor: number;

    switch (input.repaymentMethod) {
      case "annuity": {
        if (previousRateBps !== annualRateBps) {
          regularPaymentMinor = calculateLevelPaymentMinor({
            principalMinor: openingPrincipalMinor,
            annualRateBps,
            installmentCount: input.installmentCount - index,
            intervalMonths,
          });
        }
        principalPaidMinor = isLast
          ? openingPrincipalMinor
          : Math.min(openingPrincipalMinor, Math.max(0, regularPaymentMinor - interestMinor));
        break;
      }
      case "equal_principal": {
        const base = Math.floor(input.principalMinor / input.installmentCount);
        const remainder = input.principalMinor % input.installmentCount;
        principalPaidMinor = isLast
          ? openingPrincipalMinor
          : Math.min(openingPrincipalMinor, base + (index < remainder ? 1 : 0));
        break;
      }
      case "interest_only":
        principalPaidMinor = isLast ? openingPrincipalMinor : 0;
        break;
      case "balloon": {
        if (previousRateBps !== annualRateBps) {
          const notionalRemaining = (input.amortizationInstallmentCount as number) - index;
          regularPaymentMinor = calculateLevelPaymentMinor({
            principalMinor: openingPrincipalMinor,
            annualRateBps,
            installmentCount: notionalRemaining,
            intervalMonths,
          });
        }
        principalPaidMinor = isLast
          ? openingPrincipalMinor
          : Math.min(openingPrincipalMinor, Math.max(0, regularPaymentMinor - interestMinor));
        break;
      }
    }

    balance = safeSubtract(openingPrincipalMinor, principalPaidMinor, "closingPrincipalMinor");
    const feesMinor = feesForInstallment(fees, installmentNumber);
    const debtServiceMinor = safeAdd(principalPaidMinor, interestMinor, "debtServiceMinor");
    const totalPaymentMinor = safeAdd(debtServiceMinor, feesMinor, "totalPaymentMinor");
    totalPrincipalMinor = safeAdd(totalPrincipalMinor, principalPaidMinor, "totalPrincipalMinor");
    totalInterestMinor = safeAdd(totalInterestMinor, interestMinor, "totalInterestMinor");
    totalFeesMinor = safeAdd(totalFeesMinor, feesMinor, "totalFeesMinor");
    totalPaidMinor = safeAdd(totalPaidMinor, totalPaymentMinor, "totalPaidMinor");

    installments.push({
      installmentNumber,
      dueDate,
      openingPrincipalMinor,
      annualRateBps,
      rateKind: ratePeriod.kind,
      referenceIndex: ratePeriod.kind === "variable" ? ratePeriod.referenceIndex : null,
      referenceTenorMonths: ratePeriod.kind === "variable" ? ratePeriod.referenceTenorMonths : null,
      resetEveryMonths: ratePeriod.kind === "variable" ? ratePeriod.resetEveryMonths : null,
      principalPaidMinor,
      interestMinor,
      feesMinor,
      totalPaymentMinor,
      closingPrincipalMinor: balance,
    });
    previousRateBps = annualRateBps;
  });

  return { installments, totalPrincipalMinor, totalInterestMinor, totalFeesMinor, totalPaidMinor };
}

type LiabilityPaymentBucket = "fees" | "interest" | "principal";

export type LiabilityPaymentAllocationInput = {
  paymentMinor: number;
  outstandingPrincipalMinor: number;
  accruedInterestMinor?: number;
  feesDueMinor?: number;
  /** Must contain each bucket exactly once. Defaults to fees, interest, then principal. */
  allocationOrder?: readonly LiabilityPaymentBucket[];
};

export type LiabilityPaymentAllocation = {
  paymentMinor: number;
  feesPaidMinor: number;
  interestPaidMinor: number;
  principalPaidMinor: number;
  unappliedMinor: number;
  remainingFeesMinor: number;
  remainingInterestMinor: number;
  remainingPrincipalMinor: number;
};

/** Splits an actual payment into debt reduction and expense components without double-counting cash outflow. */
export function allocateLiabilityPayment(input: LiabilityPaymentAllocationInput): LiabilityPaymentAllocation {
  assertNonNegativeMinor(input.paymentMinor, "paymentMinor");
  assertNonNegativeMinor(input.outstandingPrincipalMinor, "outstandingPrincipalMinor");
  const accruedInterestMinor = input.accruedInterestMinor ?? 0;
  const feesDueMinor = input.feesDueMinor ?? 0;
  assertNonNegativeMinor(accruedInterestMinor, "accruedInterestMinor");
  assertNonNegativeMinor(feesDueMinor, "feesDueMinor");
  const order = input.allocationOrder ?? ["fees", "interest", "principal"];
  const expected = new Set<LiabilityPaymentBucket>(["fees", "interest", "principal"]);
  if (order.length !== expected.size || new Set(order).size !== expected.size || order.some((item) => !expected.has(item))) {
    throw new RangeError("allocationOrder must contain fees, interest, and principal exactly once.");
  }

  const due: Record<LiabilityPaymentBucket, number> = {
    fees: feesDueMinor,
    interest: accruedInterestMinor,
    principal: input.outstandingPrincipalMinor,
  };
  const paid: Record<LiabilityPaymentBucket, number> = { fees: 0, interest: 0, principal: 0 };
  let remainingPayment = input.paymentMinor;
  for (const bucket of order) {
    const amount = Math.min(remainingPayment, due[bucket]);
    paid[bucket] = amount;
    remainingPayment -= amount;
  }

  return {
    paymentMinor: input.paymentMinor,
    feesPaidMinor: paid.fees,
    interestPaidMinor: paid.interest,
    principalPaidMinor: paid.principal,
    unappliedMinor: remainingPayment,
    remainingFeesMinor: feesDueMinor - paid.fees,
    remainingInterestMinor: accruedInterestMinor - paid.interest,
    remainingPrincipalMinor: input.outstandingPrincipalMinor - paid.principal,
  };
}
