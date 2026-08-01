import { describe, expect, it } from "vitest";

import { loanProfileInput } from "@/lib/validation";

const baseProfile = {
  originalPrincipalMinor: 1_000_000,
  originationDate: "2026-01-01",
  firstPaymentDate: "2026-02-01",
  maturityDate: null,
  paymentAccountId: null,
  paymentFrequency: "monthly",
  paymentIntervalMonths: 1,
  termMonths: 12,
  amortizationMethod: "annuity",
  dayCountConvention: "actual_365",
  jurisdictionCode: null,
  interestCategoryId: null,
  feeCategoryId: null,
  generatePlannedPayments: true,
  rate: {
    rateType: "fixed",
    effectiveFrom: "2026-01-01",
    effectiveTo: null,
    fixedRateBps: 500,
  },
} as const;

describe("loan profile validation", () => {
  it("accepts only implemented repayment methods and consistent payment cadences", () => {
    const parsed = loanProfileInput.parse(baseProfile);
    expect(Object.hasOwn(parsed, "regularPaymentMinor")).toBe(false);
    expect(Object.hasOwn(parsed, "balloonMinor")).toBe(false);
    expect(loanProfileInput.safeParse({
      ...baseProfile,
      paymentFrequency: "quarterly",
      paymentIntervalMonths: 3,
      amortizationMethod: "equal_principal",
    }).success).toBe(true);
    expect(loanProfileInput.safeParse({
      ...baseProfile,
      paymentFrequency: "custom",
      paymentIntervalMonths: 5,
      amortizationMethod: "interest_only",
    }).success).toBe(true);

    expect(loanProfileInput.safeParse({ ...baseProfile, amortizationMethod: "balloon" }).success).toBe(false);
    expect(loanProfileInput.safeParse({ ...baseProfile, amortizationMethod: "custom" }).success).toBe(false);
    expect(loanProfileInput.safeParse({ ...baseProfile, paymentFrequency: "quarterly" }).success).toBe(false);
  });

  it("rejects deprecated fixed-payment and balloon fields even at neutral values", () => {
    const regular = loanProfileInput.safeParse({ ...baseProfile, regularPaymentMinor: null });
    const balloon = loanProfileInput.safeParse({ ...baseProfile, balloonMinor: 0 });

    expect(regular.success).toBe(false);
    expect(balloon.success).toBe(false);
    if (!regular.success) expect(regular.error.issues[0]?.path).toEqual(["regularPaymentMinor"]);
    if (!balloon.success) expect(balloon.error.issues[0]?.path).toEqual(["balloonMinor"]);
  });
});
