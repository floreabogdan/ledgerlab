import { randomUUID } from "node:crypto";

import { HttpError, type ApiErrorParameters } from "@/lib/api-response";
import {
  buildLoanSchedule,
  calculateCardStatementDue,
  calculateCreditCardMetrics,
  type LoanRatePeriod,
} from "@/lib/domain/liabilities";
import { parseDateKey } from "@/lib/domain/dates";
import {
  audit,
  createLiabilityTransaction,
  database,
  listAccounts,
  one,
  voidWorkflowTransaction,
} from "@/server/core";
import {
  convertMinorAtRate,
  currencyMinorUnitDigits,
  deriveRateScaledFromAmounts,
  findPersistedBnrQuote,
  validateTransferFxForPosting,
  type PreparedTransferFx,
} from "@/server/fx";
import { getUserCalendarContext } from "@/server/user-settings";

type SqlValue = string | number | bigint | Buffer | null;

function liabilityError(
  status: number,
  code: `LIABILITY_${string}`,
  message: string,
  params?: ApiErrorParameters,
) {
  return new HttpError(status, { code, message, params });
}

export type CreditCardProfileInput = {
  creditLimitMinor: number;
  statementDay?: number | null;
  dueDay?: number | null;
  gracePeriodDays?: number | null;
  purchaseAprBps?: number | null;
  minimumPaymentMode?: "manual" | "percentage" | "fixed";
  minimumPaymentRateBps?: number | null;
  minimumPaymentFixedMinor?: number | null;
  paymentPreference?: "full_statement" | "minimum" | "custom";
  generatePlannedPayments?: boolean;
};

/**
 * FX values describe major units in the liability account per major unit in
 * the cash account. `cashAmountMinor` is optional only for same-currency
 * legacy callers, where it is identical to the liability amount.
 */
export type LiabilityPaymentFxInput = {
  cashAmountMinor?: number | null;
  fxRateScaled?: number | null;
  fxRateSource?: "bnr" | "manual" | null;
  fxRateDate?: string | null;
  referenceFxRateScaled?: number | null;
  referenceFxRateDate?: string | null;
};

export type CreditCardPaymentInput = LiabilityPaymentFxInput & {
  statementId?: string | null;
  sourceAccountId: string;
  date: string;
  /** Amount allocated to the card balance, in the card account currency. */
  amountMinor: number;
  note?: string | null;
};

export type LoanPaymentInput = LiabilityPaymentFxInput & {
  scheduleEntryId?: string | null;
  sourceAccountId: string;
  date: string;
  /** Total lender allocation, in the loan account currency. */
  totalMinor: number;
  /** All three allocations are in the loan account currency. */
  principalMinor: number;
  interestMinor: number;
  feesMinor: number;
  note?: string | null;
};

export type LoanDisbursementInput = {
  destinationAccountId: string;
  date: string;
  /** Amount added to principal, in the loan account currency. */
  amountMinor: number;
  /** Amount received by the cash account; required when currencies differ. */
  cashAmountMinor?: number | null;
  /** Major cash-account units received per major loan-account unit borrowed. */
  fxRateScaled?: number | null;
  fxRateSource?: "bnr" | "manual" | null;
  fxRateDate?: string | null;
  referenceFxRateScaled?: number | null;
  referenceFxRateDate?: string | null;
  note?: string | null;
};

export type LoanRateInput = {
  rateType: "fixed" | "variable";
  effectiveFrom: string;
  effectiveTo?: string | null;
  fixedRateBps?: number | null;
  referenceIndex?: string | null;
  referenceTenorMonths?: number | null;
  referenceRateBps?: number | null;
  marginBps?: number;
  resetFrequencyMonths?: number | null;
  nextResetDate?: string | null;
  observationLagMonths?: number;
  floorRateBps?: number | null;
  capRateBps?: number | null;
  notes?: string | null;
};

export type LoanProfileInput = {
  originalPrincipalMinor: number;
  originationDate: string;
  firstPaymentDate: string;
  maturityDate?: string | null;
  paymentAccountId?: string | null;
  paymentFrequency?: "monthly" | "quarterly" | "yearly" | "custom";
  paymentIntervalMonths?: number;
  termMonths: number;
  amortizationMethod?: "annuity" | "equal_principal" | "interest_only";
  dayCountConvention?: "actual_365" | "actual_360" | "30_360";
  jurisdictionCode?: string | null;
  interestCategoryId?: string | null;
  feeCategoryId?: string | null;
  generatePlannedPayments?: boolean;
  rate: LoanRateInput;
};

type SupportedLoanAmortizationMethod = NonNullable<LoanProfileInput["amortizationMethod"]>;
type LoanPaymentFrequency = NonNullable<LoanProfileInput["paymentFrequency"]>;

const SUPPORTED_LOAN_AMORTIZATION_METHODS = new Set<SupportedLoanAmortizationMethod>([
  "annuity",
  "equal_principal",
  "interest_only",
]);

function requireSupportedLoanAmortization(value: unknown): SupportedLoanAmortizationMethod {
  if (typeof value === "string" && SUPPORTED_LOAN_AMORTIZATION_METHODS.has(value as SupportedLoanAmortizationMethod)) {
    return value as SupportedLoanAmortizationMethod;
  }
  throw liabilityError(422, "LIABILITY_LOAN_AMORTIZATION_UNSUPPORTED", "This loan uses an unsupported repayment schedule. Choose annuity, equal principal, or interest only");
}

function requireSupportedPaymentCadence(frequency: unknown, intervalMonths: unknown): LoanPaymentFrequency {
  if (!Number.isSafeInteger(intervalMonths) || Number(intervalMonths) < 1 || Number(intervalMonths) > 120) {
    throw liabilityError(422, "LIABILITY_PAYMENT_INTERVAL_INVALID", "The loan payment interval must be between 1 and 120 months");
  }
  const canonicalInterval = frequency === "monthly"
    ? 1
    : frequency === "quarterly"
      ? 3
      : frequency === "yearly" ? 12 : frequency === "custom" ? null : undefined;
  if (canonicalInterval === undefined) {
    throw liabilityError(422, "LIABILITY_PAYMENT_CADENCE_UNSUPPORTED", "This loan uses an unsupported payment cadence");
  }
  const supportedFrequency = frequency as LoanPaymentFrequency;
  if (canonicalInterval !== null && intervalMonths !== canonicalInterval) {
    throw liabilityError(
      422,
      "LIABILITY_PAYMENT_CADENCE_INTERVAL_MISMATCH",
      `${supportedFrequency} cadence does not match the payment interval`,
      { frequency: supportedFrequency },
    );
  }
  return supportedFrequency;
}

function rejectUnsupportedLoanProfileFields(input: LoanProfileInput): void {
  const raw = input as LoanProfileInput & Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(raw, "regularPaymentMinor")) {
    throw liabilityError(422, "LIABILITY_FIXED_PAYMENT_SCHEDULE_UNSUPPORTED", "Contractual fixed-payment schedules are not supported yet; remove regularPaymentMinor");
  }
  if (Object.prototype.hasOwnProperty.call(raw, "balloonMinor")) {
    throw liabilityError(422, "LIABILITY_BALLOON_SCHEDULE_UNSUPPORTED", "Explicit balloon schedules are not supported yet; remove balloonMinor");
  }
}

type OwnedAccount = {
  id: string;
  name: string;
  type: string;
  currency: string;
  archivedAt: string | null;
  openingBalanceMinor: number;
  creditLimitMinor: number | null;
  balanceMinor: number;
  pendingMinor: number;
};

function ownedAccount(
  userId: string,
  accountId: string,
  expectedType?: "credit_card" | "loan",
  options: { allowArchived?: boolean } = {},
): OwnedAccount {
  const account = one<OwnedAccount>(
    `SELECT a.id, a.name, a.type, a.currency, a.archived_at AS archivedAt,
            a.opening_balance_minor AS openingBalanceMinor,
            a.credit_limit_minor AS creditLimitMinor,
            a.opening_balance_minor + COALESCE(SUM(CASE
              WHEN t.status = 'cleared' AND t.voided_at IS NULL
               AND substr(t.occurred_at, 1, 10) >= a.opening_balance_date
              THEN t.amount_minor ELSE 0 END), 0) AS balanceMinor,
            COALESCE(SUM(CASE WHEN t.status = 'pending' AND t.voided_at IS NULL
              AND substr(t.occurred_at, 1, 10) >= a.opening_balance_date
              THEN t.amount_minor ELSE 0 END), 0) AS pendingMinor
       FROM accounts a LEFT JOIN transactions t ON t.account_id = a.id
      WHERE a.id = ? AND a.user_id = ? GROUP BY a.id`,
    [accountId, userId],
  );
  if (!account) throw liabilityError(404, "LIABILITY_ACCOUNT_NOT_FOUND", "Account not found");
  if (account.archivedAt && !options.allowArchived) {
    throw liabilityError(409, "LIABILITY_ACCOUNT_RESTORE_REQUIRED", "Restore this account before changing its liability records");
  }
  if (expectedType && account.type !== expectedType) {
    throw expectedType === "loan"
      ? liabilityError(422, "LIABILITY_LOAN_ACCOUNT_REQUIRED", "Choose a loan account")
      : liabilityError(422, "LIABILITY_CREDIT_CARD_ACCOUNT_REQUIRED", "Choose a credit-card account");
  }
  return account;
}

function sourceCashAccount(userId: string, accountId: string) {
  const account = ownedAccount(userId, accountId);
  if (!new Set(["current", "savings", "cash"]).has(account.type)) {
    throw liabilityError(422, "LIABILITY_CASH_ACCOUNT_REQUIRED", "Debt payments must come from a current, savings, or cash account");
  }
  return account;
}

type LiabilityComponent = "principalMinor" | "interestMinor" | "feesMinor";
type CashAllocation = Record<LiabilityComponent, number>;

function hasLiabilityFxFields(input: LiabilityPaymentFxInput | LoanDisbursementInput) {
  return [
    input.fxRateScaled,
    input.fxRateSource,
    input.fxRateDate,
    input.referenceFxRateScaled,
    input.referenceFxRateDate,
  ].some((value) => value !== undefined && value !== null && value !== "");
}

function resolvePaymentTransfer(
  cashAccount: OwnedAccount,
  liabilityAccount: OwnedAccount,
  liabilityAmountMinor: number,
  date: string,
  input: LiabilityPaymentFxInput,
) {
  const crossCurrency = cashAccount.currency !== liabilityAccount.currency;
  if (crossCurrency && input.cashAmountMinor == null) {
    throw liabilityError(422, "LIABILITY_CROSS_CURRENCY_CASH_AMOUNT_REQUIRED", "Cross-currency debt payments require an explicit cash-account amount");
  }
  const cashAmountMinor = input.cashAmountMinor ?? liabilityAmountMinor;
  assertMinor(cashAmountMinor, "Cash-account amount");
  if (!crossCurrency && cashAmountMinor !== liabilityAmountMinor) {
    throw liabilityError(422, "LIABILITY_SAME_CURRENCY_PAYMENT_AMOUNT_MISMATCH", "Same-currency cash and liability amounts must match");
  }
  const prepared = validateTransferFxForPosting(
    cashAccount.currency,
    liabilityAccount.currency,
    cashAmountMinor,
    date,
    {
      destinationAmountMinor: liabilityAmountMinor,
      fxRateScaled: input.fxRateScaled,
      fxRateSource: input.fxRateSource,
      fxRateDate: input.fxRateDate,
      referenceFxRateScaled: input.referenceFxRateScaled,
      referenceFxRateDate: input.referenceFxRateDate,
    },
  );
  return { cashAmountMinor, crossCurrency, prepared };
}

/** Deterministic largest-remainder allocation with one minor unit per non-zero component. */
function allocateCashPayment(
  cashAmountMinor: number,
  liabilityAmounts: CashAllocation,
  sameCurrency: boolean,
): CashAllocation {
  if (sameCurrency) return { ...liabilityAmounts };
  const components = (Object.entries(liabilityAmounts) as Array<[LiabilityComponent, number]>)
    .filter(([, amount]) => amount > 0);
  if (cashAmountMinor < components.length) {
    throw liabilityError(422, "LIABILITY_CASH_ALLOCATION_TOO_SMALL", "The cash amount is too small to represent every non-zero loan allocation");
  }
  const liabilityTotal = components.reduce((sum, [, amount]) => sum + BigInt(amount), 0n);
  const remainingCash = cashAmountMinor - components.length;
  const allocated: CashAllocation = { principalMinor: 0, interestMinor: 0, feesMinor: 0 };
  const ranked = components.map(([key, amount], index) => {
    const weighted = BigInt(remainingCash) * BigInt(amount);
    const quotient = liabilityTotal ? weighted / liabilityTotal : 0n;
    const remainder = liabilityTotal ? weighted % liabilityTotal : 0n;
    allocated[key] = Number(quotient) + 1;
    return { key, remainder, index };
  });
  const undistributed = cashAmountMinor - Object.values(allocated).reduce((sum, amount) => sum + amount, 0);
  ranked.sort((left, right) => left.remainder === right.remainder
    ? left.index - right.index
    : left.remainder > right.remainder ? -1 : 1);
  for (let index = 0; index < undistributed; index += 1) {
    allocated[ranked[index % ranked.length].key] += 1;
  }
  return allocated;
}

function exactEffectiveRate(
  fromAmountMinor: number,
  toAmountMinor: number,
  fromCurrency: string,
  toCurrency: string,
) {
  const rateScaled = deriveRateScaledFromAmounts(
    fromAmountMinor,
    toAmountMinor,
    currencyMinorUnitDigits(fromCurrency),
    currencyMinorUnitDigits(toCurrency),
  );
  if (convertMinorAtRate(
    fromAmountMinor,
    rateScaled,
    currencyMinorUnitDigits(fromCurrency),
    currencyMinorUnitDigits(toCurrency),
  ) !== toAmountMinor) {
    throw liabilityError(422, "LIABILITY_FX_ALLOCATION_PRECISION_UNSUPPORTED", "This cash/liability allocation cannot be represented at the supported FX precision");
  }
  return rateScaled;
}

function referenceQuoteFields(
  date: string,
  fromCurrency: string,
  toCurrency: string,
  prepared: PreparedTransferFx,
) {
  if (prepared.fxRateSource !== "bnr" && prepared.referenceFxRateScaled == null) return {};
  const quote = findPersistedBnrQuote(date, fromCurrency, toCurrency);
  if (!quote) {
    throw liabilityError(422, "LIABILITY_REFERENCE_QUOTE_NOT_CACHED", "The reference BNR quote is not cached. Request the FX quote before posting this liability payment");
  }
  return {
    referenceFxRateScaled: quote.rateScaled,
    referenceFxRateDate: quote.rateDate,
  };
}

function componentTransferFx(
  cashAccount: OwnedAccount,
  liabilityAccount: OwnedAccount,
  cashAmountMinor: number,
  liabilityAmountMinor: number,
  date: string,
  prepared: PreparedTransferFx,
) {
  if (cashAccount.currency === liabilityAccount.currency) return {};
  if (
    prepared.fxRateScaled
    && convertMinorAtRate(
      cashAmountMinor,
      prepared.fxRateScaled,
      currencyMinorUnitDigits(cashAccount.currency),
      currencyMinorUnitDigits(liabilityAccount.currency),
    ) === liabilityAmountMinor
  ) {
    return {
      destinationAmountMinor: liabilityAmountMinor,
      fxRateScaled: prepared.fxRateScaled,
      fxRateSource: prepared.fxRateSource,
      fxRateDate: prepared.fxRateDate,
      referenceFxRateScaled: prepared.referenceFxRateScaled,
      referenceFxRateDate: prepared.referenceFxRateDate,
    };
  }
  return {
    destinationAmountMinor: liabilityAmountMinor,
    fxRateScaled: exactEffectiveRate(
      cashAmountMinor,
      liabilityAmountMinor,
      cashAccount.currency,
      liabilityAccount.currency,
    ),
    fxRateSource: "manual" as const,
    fxRateDate: prepared.fxRateDate ?? date,
    ...referenceQuoteFields(date, cashAccount.currency, liabilityAccount.currency, prepared),
  };
}

function componentExpenseFx(
  cashAccount: OwnedAccount,
  liabilityAccount: OwnedAccount,
  cashAmountMinor: number,
  liabilityAmountMinor: number,
  date: string,
  prepared: PreparedTransferFx,
) {
  if (cashAccount.currency === liabilityAccount.currency) return {};
  return {
    originalAmountMinor: liabilityAmountMinor,
    originalCurrency: liabilityAccount.currency,
    fxRateScaled: exactEffectiveRate(
      liabilityAmountMinor,
      cashAmountMinor,
      liabilityAccount.currency,
      cashAccount.currency,
    ),
    fxRateSource: "manual" as const,
    fxRateDate: prepared.fxRateDate ?? date,
    ...referenceQuoteFields(date, liabilityAccount.currency, cashAccount.currency, prepared),
  };
}

function assertOwnedCategory(userId: string, categoryId?: string | null) {
  if (!categoryId) return;
  const category = one<{ id: string }>(
    "SELECT id FROM categories WHERE id = ? AND user_id = ? AND archived_at IS NULL",
    [categoryId, userId],
  );
  if (!category) throw liabilityError(422, "LIABILITY_CATEGORY_REQUIRED", "Choose an active category that belongs to you");
}

const LIABILITY_MINOR_ERROR_CODES = {
  "Cash-account amount": "LIABILITY_CASH_ACCOUNT_AMOUNT_INVALID",
  "Credit limit": "LIABILITY_CREDIT_LIMIT_INVALID",
  "Original principal": "LIABILITY_ORIGINAL_PRINCIPAL_INVALID",
  "Statement balance": "LIABILITY_STATEMENT_BALANCE_INVALID",
  "Minimum due": "LIABILITY_MINIMUM_DUE_INVALID",
  "Payment amount": "LIABILITY_PAYMENT_AMOUNT_INVALID",
  "Total payment": "LIABILITY_TOTAL_PAYMENT_INVALID",
  "Principal amount": "LIABILITY_PRINCIPAL_AMOUNT_INVALID",
  "Interest amount": "LIABILITY_INTEREST_AMOUNT_INVALID",
  "Fee amount": "LIABILITY_FEE_AMOUNT_INVALID",
  "Disbursement amount": "LIABILITY_DISBURSEMENT_AMOUNT_INVALID",
} as const;

function assertMinor(value: number, label: keyof typeof LIABILITY_MINOR_ERROR_CODES, allowZero = false) {
  if (!Number.isSafeInteger(value) || (allowZero ? value < 0 : value <= 0)) {
    throw liabilityError(
      422,
      LIABILITY_MINOR_ERROR_CODES[label],
      `${label} must be ${allowZero ? "a non-negative" : "a positive"} integer in minor units`,
    );
  }
}

const LIABILITY_DATE_ERROR_CODES = {
  "rate effective date": "LIABILITY_RATE_EFFECTIVE_DATE_INVALID",
  "rate end date": "LIABILITY_RATE_END_DATE_INVALID",
  "next reset date": "LIABILITY_NEXT_RESET_DATE_INVALID",
  "origination date": "LIABILITY_LOAN_ORIGINATION_DATE_INVALID",
  "first payment date": "LIABILITY_FIRST_PAYMENT_DATE_INVALID",
  "maturity date": "LIABILITY_MATURITY_DATE_INVALID",
  "statement period start": "LIABILITY_STATEMENT_PERIOD_START_INVALID",
  "statement period end": "LIABILITY_STATEMENT_PERIOD_END_INVALID",
  "statement closing date": "LIABILITY_STATEMENT_CLOSING_DATE_INVALID",
  "statement due date": "LIABILITY_STATEMENT_DUE_DATE_INVALID",
  "payment date": "LIABILITY_PAYMENT_DATE_INVALID",
  "disbursement date": "LIABILITY_DISBURSEMENT_DATE_INVALID",
} as const;

function assertDate(value: string, label: keyof typeof LIABILITY_DATE_ERROR_CODES) {
  try {
    parseDateKey(value);
  } catch {
    throw liabilityError(
      422,
      LIABILITY_DATE_ERROR_CODES[label],
      `Choose a valid ${label} in YYYY-MM-DD format`,
    );
  }
}

function assertRatePeriod(input: LoanRateInput) {
  assertDate(input.effectiveFrom, "rate effective date");
  if (input.effectiveTo) assertDate(input.effectiveTo, "rate end date");
  if (input.nextResetDate) assertDate(input.nextResetDate, "next reset date");
  if (input.effectiveTo && input.effectiveTo < input.effectiveFrom) {
    throw liabilityError(422, "LIABILITY_RATE_PERIOD_ORDER_INVALID", "The rate period cannot end before it starts");
  }
  if (input.rateType === "fixed" && input.fixedRateBps == null) {
    throw liabilityError(422, "LIABILITY_FIXED_RATE_REQUIRED", "Enter the fixed annual interest rate");
  }
  if (input.rateType === "variable" && (
    !input.referenceIndex?.trim()
    || input.referenceTenorMonths == null
    || input.referenceRateBps == null
    || input.resetFrequencyMonths == null
  )) {
    throw liabilityError(422, "LIABILITY_VARIABLE_RATE_FIELDS_REQUIRED", "Variable rates require an index, tenor, observed rate, and reset frequency");
  }
  if (input.floorRateBps != null && input.capRateBps != null && input.floorRateBps > input.capRateBps) {
    throw liabilityError(422, "LIABILITY_RATE_CAP_BELOW_FLOOR", "The rate cap cannot be below the floor");
  }
}

function previousDate(date: string): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() - 1);
  return value.toISOString().slice(0, 10);
}

export function saveCreditCardProfile(userId: string, accountId: string, input: CreditCardProfileInput) {
  const account = ownedAccount(userId, accountId, "credit_card");
  assertMinor(input.creditLimitMinor, "Credit limit", true);
  const before = one<Record<string, unknown>>("SELECT * FROM credit_card_profiles WHERE account_id = ?", [accountId]);
  database().transaction(() => {
    database().prepare("UPDATE accounts SET credit_limit_minor = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?")
      .run(input.creditLimitMinor, accountId, userId);
    database().prepare(
      `INSERT INTO credit_card_profiles
        (account_id, statement_day, due_day, grace_period_days, purchase_apr_bps,
         minimum_payment_mode, minimum_payment_rate_bps, minimum_payment_fixed_minor,
         payment_preference, generate_planned_payments)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(account_id) DO UPDATE SET
         statement_day = excluded.statement_day, due_day = excluded.due_day,
         grace_period_days = excluded.grace_period_days, purchase_apr_bps = excluded.purchase_apr_bps,
         minimum_payment_mode = excluded.minimum_payment_mode,
         minimum_payment_rate_bps = excluded.minimum_payment_rate_bps,
         minimum_payment_fixed_minor = excluded.minimum_payment_fixed_minor,
         payment_preference = excluded.payment_preference,
         generate_planned_payments = excluded.generate_planned_payments,
         updated_at = CURRENT_TIMESTAMP`,
    ).run(
      accountId,
      input.statementDay ?? null,
      input.dueDay ?? null,
      input.gracePeriodDays ?? null,
      input.purchaseAprBps ?? null,
      input.minimumPaymentMode ?? "manual",
      input.minimumPaymentRateBps ?? null,
      input.minimumPaymentFixedMinor ?? null,
      input.paymentPreference ?? "full_statement",
      input.generatePlannedPayments === false ? 0 : 1,
    );
    audit(userId, "credit_card_profile", accountId, before ? "update" : "create", before, input);
  })();
  return liabilityAccountDetail(userId, account.id);
}

function insertRatePeriod(accountId: string, input: LoanRateInput) {
  assertRatePeriod(input);
  const id = randomUUID();
  database().prepare(
    `INSERT INTO loan_rate_periods
      (id, loan_account_id, effective_from, effective_to, rate_type, fixed_rate_bps,
       reference_index, reference_tenor_months, reference_rate_bps, margin_bps,
       reset_frequency_months, next_reset_date, observation_lag_months,
       floor_rate_bps, cap_rate_bps, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id, accountId, input.effectiveFrom, input.effectiveTo ?? null, input.rateType,
    input.rateType === "fixed" ? input.fixedRateBps ?? null : null,
    input.rateType === "variable" ? input.referenceIndex ?? null : null,
    input.rateType === "variable" ? input.referenceTenorMonths ?? null : null,
    input.rateType === "variable" ? input.referenceRateBps ?? null : null,
    input.rateType === "variable" ? input.marginBps ?? 0 : 0,
    input.rateType === "variable" ? input.resetFrequencyMonths ?? null : null,
    input.rateType === "variable" ? input.nextResetDate ?? null : null,
    input.rateType === "variable" ? input.observationLagMonths ?? 0 : 0,
    input.rateType === "variable" ? input.floorRateBps ?? null : null,
    input.rateType === "variable" ? input.capRateBps ?? null : null,
    input.notes ?? null,
  );
  return id;
}

type StoredRate = {
  effectiveFrom: string;
  effectiveTo: string | null;
  rateType: "fixed" | "variable";
  fixedRateBps: number | null;
  referenceIndex: string | null;
  referenceTenorMonths: number | null;
  referenceRateBps: number | null;
  marginBps: number;
  resetFrequencyMonths: number | null;
  observationLagMonths: number;
  floorRateBps: number | null;
  capRateBps: number | null;
};

function domainRates(accountId: string): LoanRatePeriod[] {
  const rows = database().prepare(
    `SELECT effective_from AS effectiveFrom, effective_to AS effectiveTo, rate_type AS rateType,
            fixed_rate_bps AS fixedRateBps, reference_index AS referenceIndex,
            reference_tenor_months AS referenceTenorMonths, reference_rate_bps AS referenceRateBps,
            margin_bps AS marginBps, reset_frequency_months AS resetFrequencyMonths,
            observation_lag_months AS observationLagMonths, floor_rate_bps AS floorRateBps,
            cap_rate_bps AS capRateBps
       FROM loan_rate_periods WHERE loan_account_id = ? ORDER BY effective_from`,
  ).all(accountId) as StoredRate[];
  return rows.map((row) => row.rateType === "fixed" ? {
    kind: "fixed" as const,
    effectiveFrom: row.effectiveFrom,
    effectiveThrough: row.effectiveTo,
    annualRateBps: row.fixedRateBps ?? 0,
  } : {
    kind: "variable" as const,
    effectiveFrom: row.effectiveFrom,
    effectiveThrough: row.effectiveTo,
    referenceIndex: row.referenceIndex ?? "Custom index",
    referenceTenorMonths: row.referenceTenorMonths ?? 1,
    resetEveryMonths: row.resetFrequencyMonths ?? 1,
    referenceRateBps: row.referenceRateBps ?? 0,
    marginBps: row.marginBps,
    observationLagDays: row.observationLagMonths * 30,
    floorRateBps: row.floorRateBps,
    capRateBps: row.capRateBps,
  });
}

type StoredLoanProfile = {
  originalPrincipalMinor: number;
  firstPaymentDate: string;
  termMonths: number;
  paymentFrequency: string;
  paymentIntervalMonths: number;
  amortizationMethod: string;
  regularPaymentMinor: number | null;
  balloonMinor: number;
};

function requireSupportedStoredLoanProfile(profile: {
  paymentFrequency: unknown;
  paymentIntervalMonths: unknown;
  amortizationMethod: unknown;
  regularPaymentMinor: unknown;
  balloonMinor: unknown;
}): SupportedLoanAmortizationMethod {
  const repaymentMethod = requireSupportedLoanAmortization(profile.amortizationMethod);
  requireSupportedPaymentCadence(profile.paymentFrequency, profile.paymentIntervalMonths);
  if (profile.regularPaymentMinor !== null) {
    throw liabilityError(422, "LIABILITY_STORED_FIXED_PAYMENT_UNSUPPORTED", "This loan contains an unsupported contractual fixed-payment value. Update its terms before using projections");
  }
  if (profile.balloonMinor !== 0) {
    throw liabilityError(422, "LIABILITY_STORED_BALLOON_UNSUPPORTED", "This loan contains an unsupported balloon value. Update its terms before using projections");
  }
  return repaymentMethod;
}

function rebuildLoanSchedule(accountId: string) {
  const profile = one<StoredLoanProfile>(
    `SELECT original_principal_minor AS originalPrincipalMinor,
            first_payment_date AS firstPaymentDate, term_months AS termMonths,
            payment_frequency AS paymentFrequency, payment_interval_months AS paymentIntervalMonths,
            amortization_method AS amortizationMethod,
            regular_payment_minor AS regularPaymentMinor, balloon_minor AS balloonMinor
       FROM loan_profiles WHERE account_id = ?`,
    [accountId],
  );
  if (!profile) throw liabilityError(404, "LIABILITY_LOAN_TERMS_NOT_FOUND", "Loan terms not found");
  const repaymentMethod = requireSupportedStoredLoanProfile(profile);
  const locked = database().prepare(
    `SELECT installment_number AS installmentNumber, due_date AS dueDate,
            principal_minor AS principalMinor, paid_principal_minor AS paidPrincipalMinor,
            status
       FROM loan_schedule_entries
      WHERE loan_account_id = ? AND status IN ('paid', 'partial')
      ORDER BY installment_number`,
  ).all(accountId) as Array<{
    installmentNumber: number;
    dueDate: string;
    principalMinor: number;
    paidPrincipalMinor: number;
    status: string;
  }>;
  const lockedThrough = locked.at(-1)?.installmentNumber ?? 0;
  const totalInstallmentCount = Math.max(1, Math.ceil(profile.termMonths / profile.paymentIntervalMonths));
  const installmentCount = totalInstallmentCount - lockedThrough;
  const account = one<{ balanceMinor: number }>(
    `SELECT a.opening_balance_minor + COALESCE(SUM(CASE
              WHEN t.status = 'cleared' AND t.voided_at IS NULL
               AND substr(t.occurred_at, 1, 10) >= a.opening_balance_date
              THEN t.amount_minor ELSE 0 END), 0) AS balanceMinor
       FROM accounts a LEFT JOIN transactions t ON t.account_id = a.id
      WHERE a.id = ? GROUP BY a.id`,
    [accountId],
  );
  const ledgerOutstandingMinor = Math.max(0, -(account?.balanceMinor ?? 0));
  const preservedPartialPrincipalMinor = locked.reduce(
    (sum, item) => sum + Math.max(0, item.principalMinor - item.paidPrincipalMinor),
    0,
  );
  const principalMinor = lockedThrough
    ? Math.max(0, ledgerOutstandingMinor - preservedPartialPrincipalMinor)
    : ledgerOutstandingMinor || profile.originalPrincipalMinor;
  if (installmentCount <= 0 || principalMinor <= 0) {
    database().prepare("DELETE FROM loan_schedule_entries WHERE loan_account_id = ? AND installment_number > ?")
      .run(accountId, lockedThrough);
    return { installments: [], totalPrincipalMinor: 0, totalInterestMinor: 0, totalFeesMinor: 0, totalPaidMinor: 0 };
  }
  let schedule;
  try {
    schedule = buildLoanSchedule({
      principalMinor,
      firstPaymentDate: profile.firstPaymentDate,
      installmentCount,
      intervalMonths: profile.paymentIntervalMonths,
      installmentOffset: lockedThrough,
      repaymentMethod,
      ratePeriods: domainRates(accountId),
    });
  } catch (error) {
    throw liabilityError(
      422,
      "LIABILITY_LOAN_SCHEDULE_CALCULATION_FAILED",
      error instanceof Error ? error.message : "Could not calculate the loan schedule",
    );
  }
  database().prepare("DELETE FROM loan_schedule_entries WHERE loan_account_id = ? AND installment_number > ?")
    .run(accountId, lockedThrough);
  const insert = database().prepare(
    `INSERT INTO loan_schedule_entries
      (id, loan_account_id, installment_number, due_date, opening_principal_minor,
       payment_minor, principal_minor, interest_minor, fees_minor, closing_principal_minor,
       annual_rate_bps, status, is_estimate)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'projected', ?)`,
  );
  for (const item of schedule.installments) {
    insert.run(
      randomUUID(), accountId, lockedThrough + item.installmentNumber, item.dueDate,
      item.openingPrincipalMinor, item.totalPaymentMinor, item.principalPaidMinor,
      item.interestMinor, item.feesMinor, item.closingPrincipalMinor,
      item.annualRateBps, item.rateKind === "variable" ? 1 : 0,
    );
  }
  return schedule;
}

export function saveLoanProfile(userId: string, accountId: string, input: LoanProfileInput) {
  ownedAccount(userId, accountId, "loan");
  rejectUnsupportedLoanProfileFields(input);
  const amortizationMethod = requireSupportedLoanAmortization(input.amortizationMethod ?? "annuity");
  const paymentFrequency = requireSupportedPaymentCadence(
    input.paymentFrequency ?? "monthly",
    input.paymentIntervalMonths ?? 1,
  );
  const paymentIntervalMonths = input.paymentIntervalMonths ?? 1;
  assertMinor(input.originalPrincipalMinor, "Original principal");
  assertDate(input.originationDate, "origination date");
  assertDate(input.firstPaymentDate, "first payment date");
  if (input.maturityDate) assertDate(input.maturityDate, "maturity date");
  if (input.originationDate > getUserCalendarContext(userId).today) {
    throw liabilityError(422, "LIABILITY_LOAN_ORIGINATION_IN_FUTURE", "Loan origination date cannot be in the future");
  }
  if (input.firstPaymentDate < input.originationDate) {
    throw liabilityError(422, "LIABILITY_FIRST_PAYMENT_BEFORE_ORIGINATION", "The first payment cannot precede loan origination");
  }
  if (input.rate.effectiveFrom > input.firstPaymentDate) {
    throw liabilityError(422, "LIABILITY_FIRST_RATE_AFTER_FIRST_PAYMENT", "The first rate must cover the first installment");
  }
  if (input.maturityDate && input.maturityDate < input.firstPaymentDate) {
    throw liabilityError(422, "LIABILITY_MATURITY_BEFORE_FIRST_PAYMENT", "Maturity cannot precede the first payment");
  }
  if (input.paymentAccountId) sourceCashAccount(userId, input.paymentAccountId);
  assertOwnedCategory(userId, input.interestCategoryId);
  assertOwnedCategory(userId, input.feeCategoryId);
  const before = one<Record<string, unknown>>("SELECT * FROM loan_profiles WHERE account_id = ?", [accountId]);
  return database().transaction(() => {
    database().prepare(
      `INSERT INTO loan_profiles
        (account_id, original_principal_minor, origination_date, first_payment_date,
         maturity_date, payment_account_id, payment_frequency, payment_interval_months,
         term_months, amortization_method, regular_payment_minor, balloon_minor,
         day_count_convention, jurisdiction_code, interest_category_id, fee_category_id,
         generate_planned_payments)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(account_id) DO UPDATE SET
         original_principal_minor = excluded.original_principal_minor,
         origination_date = excluded.origination_date, first_payment_date = excluded.first_payment_date,
         maturity_date = excluded.maturity_date, payment_account_id = excluded.payment_account_id,
         payment_frequency = excluded.payment_frequency,
         payment_interval_months = excluded.payment_interval_months, term_months = excluded.term_months,
         amortization_method = excluded.amortization_method,
         regular_payment_minor = excluded.regular_payment_minor, balloon_minor = excluded.balloon_minor,
         day_count_convention = excluded.day_count_convention,
         jurisdiction_code = excluded.jurisdiction_code,
         interest_category_id = excluded.interest_category_id, fee_category_id = excluded.fee_category_id,
         generate_planned_payments = excluded.generate_planned_payments,
         updated_at = CURRENT_TIMESTAMP`,
    ).run(
      accountId, input.originalPrincipalMinor, input.originationDate, input.firstPaymentDate,
      input.maturityDate ?? null, input.paymentAccountId ?? null, paymentFrequency,
      paymentIntervalMonths, input.termMonths, amortizationMethod,
      null, 0, input.dayCountConvention ?? "actual_365",
      input.jurisdictionCode?.toUpperCase() || null, input.interestCategoryId ?? null,
      input.feeCategoryId ?? null, input.generatePlannedPayments === false ? 0 : 1,
    );
    if (!before) insertRatePeriod(accountId, input.rate);
    else {
      const paymentCount = one<{ count: number }>("SELECT COUNT(*) AS count FROM loan_payments WHERE loan_account_id = ? AND voided_at IS NULL", [accountId])?.count ?? 0;
      if (paymentCount === 0) {
        database().prepare("DELETE FROM loan_rate_periods WHERE loan_account_id = ?").run(accountId);
        insertRatePeriod(accountId, input.rate);
      }
    }
    const schedule = rebuildLoanSchedule(accountId);
    audit(userId, "loan_profile", accountId, before ? "update" : "create", before, input);
    return { account: liabilityAccountDetail(userId, accountId), scheduleSummary: schedule };
  })();
}

export function addLoanRatePeriod(userId: string, accountId: string, input: LoanRateInput) {
  ownedAccount(userId, accountId, "loan");
  assertRatePeriod(input);
  const last = one<{ id: string; effectiveFrom: string }>(
    "SELECT id, effective_from AS effectiveFrom FROM loan_rate_periods WHERE loan_account_id = ? ORDER BY effective_from DESC LIMIT 1",
    [accountId],
  );
  if (last && input.effectiveFrom <= last.effectiveFrom) {
    throw liabilityError(422, "LIABILITY_RATE_PERIOD_NOT_AFTER_LATEST", "A new rate period must start after the latest existing period");
  }
  return database().transaction(() => {
    if (last) database().prepare("UPDATE loan_rate_periods SET effective_to = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(previousDate(input.effectiveFrom), last.id);
    const id = insertRatePeriod(accountId, input);
    rebuildLoanSchedule(accountId);
    audit(userId, "loan_rate_period", id, "create", undefined, input);
    return liabilityAccountDetail(userId, accountId);
  })();
}

export function createCreditCardStatement(userId: string, accountId: string, input: {
  periodStart: string;
  periodEnd: string;
  closingDate: string;
  dueDate: string;
  statementBalanceMinor: number;
  minimumDueMinor: number;
  source?: "manual" | "imported";
  notes?: string | null;
}) {
  ownedAccount(userId, accountId, "credit_card");
  assertDate(input.periodStart, "statement period start");
  assertDate(input.periodEnd, "statement period end");
  assertDate(input.closingDate, "statement closing date");
  assertDate(input.dueDate, "statement due date");
  assertMinor(input.statementBalanceMinor, "Statement balance");
  assertMinor(input.minimumDueMinor, "Minimum due", true);
  if (input.periodEnd < input.periodStart) {
    throw liabilityError(422, "LIABILITY_STATEMENT_PERIOD_ORDER_INVALID", "The statement period cannot end before it starts");
  }
  if (input.closingDate < input.periodEnd) {
    throw liabilityError(422, "LIABILITY_STATEMENT_CLOSING_BEFORE_PERIOD_END", "The closing date cannot precede the statement period end");
  }
  if (input.dueDate < input.closingDate) {
    throw liabilityError(422, "LIABILITY_STATEMENT_DUE_BEFORE_CLOSING", "The due date cannot precede the closing date");
  }
  if (input.minimumDueMinor > input.statementBalanceMinor) {
    throw liabilityError(422, "LIABILITY_MINIMUM_DUE_EXCEEDS_BALANCE", "Minimum due cannot exceed the statement balance");
  }
  const today = getUserCalendarContext(userId).today;
  const id = randomUUID();
  try {
    database().prepare(
      `INSERT INTO credit_card_statements
        (id, account_id, period_start, period_end, closing_date, due_date,
         statement_balance_minor, minimum_due_minor, status, source, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id, accountId, input.periodStart, input.periodEnd, input.closingDate, input.dueDate,
      input.statementBalanceMinor, input.minimumDueMinor,
      input.dueDate < today ? "overdue" : "open", input.source ?? "manual", input.notes ?? null,
    );
  } catch (error) {
    const message = String(error);
    if (
      message.includes("credit_card_statements_account_closing_unique")
      || message.includes("credit_card_statements.account_id, credit_card_statements.closing_date")
    ) {
      throw liabilityError(409, "LIABILITY_STATEMENT_CLOSING_DATE_DUPLICATE", "A statement for this closing date already exists");
    }
    throw error;
  }
  audit(userId, "credit_card_statement", id, "create", undefined, input);
  return liabilityAccountDetail(userId, accountId);
}

function refreshCreditCardStatementPaymentState(userId: string, statementId: string) {
  const statement = one<{ balance: number; dueDate: string }>(
    "SELECT statement_balance_minor AS balance, due_date AS dueDate FROM credit_card_statements WHERE id = ?",
    [statementId],
  );
  if (!statement) return;
  const paidMinor = one<{ total: number }>(
    `SELECT COALESCE(SUM(amount_minor), 0) AS total
       FROM credit_card_payments
      WHERE statement_id = ? AND voided_at IS NULL`,
    [statementId],
  )?.total ?? 0;
  const applied = Math.min(statement.balance, Math.max(0, paidMinor));
  const status = applied >= statement.balance
    ? "paid"
    : statement.dueDate < getUserCalendarContext(userId).today ? "overdue" : "open";
  database().prepare(
    "UPDATE credit_card_statements SET payments_applied_minor = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
  ).run(applied, status, statementId);
}

function creditCardStatementDisplayStatus(input: {
  statementBalanceMinor: number;
  paymentsAppliedMinor: number;
  dueDate: string;
}, today: string) {
  const remaining = Math.max(0, input.statementBalanceMinor - input.paymentsAppliedMinor);
  if (remaining === 0) return "paid";
  if (input.dueDate < today) return "overdue";
  if (input.paymentsAppliedMinor > 0) return "partial";
  return "open";
}

export function recordCreditCardPayment(userId: string, accountId: string, input: CreditCardPaymentInput) {
  const card = ownedAccount(userId, accountId, "credit_card");
  assertDate(input.date, "payment date");
  assertMinor(input.amountMinor, "Payment amount");
  const cashAccount = sourceCashAccount(userId, input.sourceAccountId);
  const paymentTransfer = resolvePaymentTransfer(cashAccount, card, input.amountMinor, input.date, input);
  const statement = input.statementId ? one<{ id: string }>(
    `SELECT s.id
       FROM credit_card_statements s JOIN accounts a ON a.id = s.account_id
      WHERE s.id = ? AND s.account_id = ? AND a.user_id = ?`,
    [input.statementId, accountId, userId],
  ) : undefined;
  if (input.statementId && !statement) {
    throw liabilityError(404, "LIABILITY_CARD_STATEMENT_NOT_FOUND", "Card statement not found");
  }
  return database().transaction(() => {
    const transfer = createLiabilityTransaction(userId, {
      kind: "transfer",
      accountId: input.sourceAccountId,
      transferAccountId: accountId,
      amountMinor: paymentTransfer.cashAmountMinor,
      destinationAmountMinor: input.amountMinor,
      fxRateScaled: paymentTransfer.prepared.fxRateScaled,
      fxRateSource: paymentTransfer.prepared.fxRateSource,
      fxRateDate: paymentTransfer.prepared.fxRateDate,
      referenceFxRateScaled: paymentTransfer.prepared.referenceFxRateScaled,
      referenceFxRateDate: paymentTransfer.prepared.referenceFxRateDate,
      date: input.date,
      note: input.note ?? `Credit-card payment to ${card.name}`,
      duplicateConfirmed: true,
    });
    const id = randomUUID();
    database().prepare(
      `INSERT INTO credit_card_payments
        (id, user_id, account_id, source_account_id, statement_id, payment_date,
         amount_minor, transfer_group_id, source_transaction_id, card_transaction_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id, userId, accountId, input.sourceAccountId, statement?.id ?? null, input.date,
      input.amountMinor, transfer.transferGroupId, transfer.id, transfer.peerId,
    );
    if (statement) refreshCreditCardStatementPaymentState(userId, statement.id);
    const auditRecord = {
      ...input,
      cashAmountMinor: paymentTransfer.cashAmountMinor,
      cashCurrency: cashAccount.currency,
      liabilityAmountMinor: input.amountMinor,
      liabilityCurrency: card.currency,
      fxRateScaled: paymentTransfer.prepared.fxRateScaled ?? null,
      fxRateSource: paymentTransfer.prepared.fxRateSource ?? null,
      fxRateDate: paymentTransfer.prepared.fxRateDate ?? null,
      referenceFxRateScaled: paymentTransfer.prepared.referenceFxRateScaled ?? null,
      referenceFxRateDate: paymentTransfer.prepared.referenceFxRateDate ?? null,
      transferGroupId: transfer.transferGroupId,
    };
    audit(userId, "credit_card_payment", id, "create", undefined, auditRecord);
    return {
      paymentId: id,
      transferGroupId: transfer.transferGroupId,
      cashAmountMinor: paymentTransfer.cashAmountMinor,
      cashCurrency: cashAccount.currency,
      liabilityAmountMinor: input.amountMinor,
      liabilityCurrency: card.currency,
      account: liabilityAccountDetail(userId, accountId),
    };
  })();
}

export function recordLoanPayment(userId: string, accountId: string, input: LoanPaymentInput) {
  const loan = ownedAccount(userId, accountId, "loan");
  assertDate(input.date, "payment date");
  assertMinor(input.totalMinor, "Total payment");
  assertMinor(input.principalMinor, "Principal amount", true);
  assertMinor(input.interestMinor, "Interest amount", true);
  assertMinor(input.feesMinor, "Fee amount", true);
  const cashAccount = sourceCashAccount(userId, input.sourceAccountId);
  if (BigInt(input.principalMinor) + BigInt(input.interestMinor) + BigInt(input.feesMinor) !== BigInt(input.totalMinor)) {
    throw liabilityError(422, "LIABILITY_PAYMENT_ALLOCATION_MISMATCH", "Principal, interest, and fees must equal the total payment");
  }
  const paymentTransfer = resolvePaymentTransfer(cashAccount, loan, input.totalMinor, input.date, input);
  const cashAllocations = allocateCashPayment(paymentTransfer.cashAmountMinor, {
    principalMinor: input.principalMinor,
    interestMinor: input.interestMinor,
    feesMinor: input.feesMinor,
  }, !paymentTransfer.crossCurrency);
  const profile = one<{ interestCategoryId: string | null; feeCategoryId: string | null }>(
    "SELECT interest_category_id AS interestCategoryId, fee_category_id AS feeCategoryId FROM loan_profiles WHERE account_id = ?",
    [accountId],
  );
  if (!profile) throw liabilityError(409, "LIABILITY_LOAN_TERMS_REQUIRED", "Add the loan terms before recording installments");
  const schedule = input.scheduleEntryId ? one<{
    id: string;
    installmentNumber: number;
    principalMinor: number;
    interestMinor: number;
    feesMinor: number;
    paidPrincipalMinor: number;
    paidInterestMinor: number;
    paidFeesMinor: number;
    status: string;
  }>(
    `SELECT id, installment_number AS installmentNumber,
            principal_minor AS principalMinor, interest_minor AS interestMinor,
            fees_minor AS feesMinor, paid_principal_minor AS paidPrincipalMinor,
            paid_interest_minor AS paidInterestMinor, paid_fees_minor AS paidFeesMinor, status
       FROM loan_schedule_entries WHERE id = ? AND loan_account_id = ?`,
    [input.scheduleEntryId, accountId],
  ) : undefined;
  if (input.scheduleEntryId && !schedule) {
    throw liabilityError(404, "LIABILITY_LOAN_INSTALLMENT_NOT_FOUND", "Loan installment not found");
  }
  if (schedule?.status === "paid") {
    throw liabilityError(409, "LIABILITY_LOAN_INSTALLMENT_ALREADY_PAID", "This installment is already paid");
  }
  if (schedule) {
    const earliestOutstanding = one<{ id: string }>(
      `SELECT id FROM loan_schedule_entries
        WHERE loan_account_id = ? AND status <> 'paid'
        ORDER BY installment_number LIMIT 1`,
      [accountId],
    );
    if (earliestOutstanding?.id !== schedule.id) {
      throw liabilityError(409, "LIABILITY_EARLIEST_INSTALLMENT_REQUIRED", "Record the earliest outstanding installment before paying a later one");
    }
    const remainingPrincipal = Math.max(0, schedule.principalMinor - schedule.paidPrincipalMinor);
    const remainingInterest = Math.max(0, schedule.interestMinor - schedule.paidInterestMinor);
    const remainingFees = Math.max(0, schedule.feesMinor - schedule.paidFeesMinor);
    if (input.principalMinor > remainingPrincipal) {
      throw liabilityError(422, "LIABILITY_INSTALLMENT_PRINCIPAL_EXCEEDED", "Principal allocation exceeds this installment's remaining principal; record extra principal without selecting an installment");
    }
    if (input.interestMinor > remainingInterest) {
      throw liabilityError(422, "LIABILITY_INSTALLMENT_INTEREST_EXCEEDED", "Interest allocation exceeds this installment's remaining interest");
    }
    if (input.feesMinor > remainingFees) {
      throw liabilityError(422, "LIABILITY_INSTALLMENT_FEES_EXCEEDED", "Fee allocation exceeds this installment's remaining fees");
    }
  }
  if (input.principalMinor > Math.max(0, -loan.balanceMinor)) {
    throw liabilityError(422, "LIABILITY_PRINCIPAL_EXCEEDS_BALANCE", "Principal payment exceeds the current outstanding loan balance");
  }

  return database().transaction(() => {
    const principalTransfer = input.principalMinor > 0 ? createLiabilityTransaction(userId, {
      kind: "transfer",
      accountId: input.sourceAccountId,
      transferAccountId: accountId,
      amountMinor: cashAllocations.principalMinor,
      destinationAmountMinor: input.principalMinor,
      ...componentTransferFx(
        cashAccount,
        loan,
        cashAllocations.principalMinor,
        input.principalMinor,
        input.date,
        paymentTransfer.prepared,
      ),
      date: input.date,
      note: input.note ?? `Loan principal payment to ${loan.name}`,
      duplicateConfirmed: true,
    }) : null;
    const interest = input.interestMinor > 0 ? createLiabilityTransaction(userId, {
      kind: "expense",
      accountId: input.sourceAccountId,
      amountMinor: cashAllocations.interestMinor,
      ...componentExpenseFx(
        cashAccount,
        loan,
        cashAllocations.interestMinor,
        input.interestMinor,
        input.date,
        paymentTransfer.prepared,
      ),
      date: input.date,
      categoryId: profile.interestCategoryId,
      note: input.note ?? `Loan interest for ${loan.name}`,
      duplicateConfirmed: true,
    }) : null;
    const fee = input.feesMinor > 0 ? createLiabilityTransaction(userId, {
      kind: "expense",
      accountId: input.sourceAccountId,
      amountMinor: cashAllocations.feesMinor,
      ...componentExpenseFx(
        cashAccount,
        loan,
        cashAllocations.feesMinor,
        input.feesMinor,
        input.date,
        paymentTransfer.prepared,
      ),
      date: input.date,
      categoryId: profile.feeCategoryId,
      note: input.note ?? `Loan fees for ${loan.name}`,
      duplicateConfirmed: true,
    }) : null;
    const id = randomUUID();
    database().prepare(
      `INSERT INTO loan_payments
        (id, user_id, loan_account_id, source_account_id, schedule_entry_id, payment_date,
         total_minor, principal_minor, interest_minor, fees_minor, principal_transfer_group_id,
         source_principal_transaction_id, loan_principal_transaction_id,
         interest_transaction_id, fee_transaction_id, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id, userId, accountId, input.sourceAccountId, schedule?.id ?? null, input.date,
      input.totalMinor, input.principalMinor, input.interestMinor, input.feesMinor,
      principalTransfer?.transferGroupId ?? null, principalTransfer?.id ?? null,
      principalTransfer?.peerId ?? null, interest?.id ?? null, fee?.id ?? null, input.note ?? null,
    );
    if (schedule) {
      const paidPrincipal = schedule.paidPrincipalMinor + input.principalMinor;
      const paidInterest = schedule.paidInterestMinor + input.interestMinor;
      const paidFees = schedule.paidFeesMinor + input.feesMinor;
      const paid = paidPrincipal >= schedule.principalMinor
        && paidInterest >= schedule.interestMinor && paidFees >= schedule.feesMinor;
      database().prepare(
        `UPDATE loan_schedule_entries SET paid_principal_minor = ?, paid_interest_minor = ?,
          paid_fees_minor = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      ).run(paidPrincipal, paidInterest, paidFees, paid ? "paid" : "partial", schedule.id);
    }
    rebuildLoanSchedule(accountId);
    const auditRecord = {
      ...input,
      cashAmountMinor: paymentTransfer.cashAmountMinor,
      cashCurrency: cashAccount.currency,
      liabilityAmountMinor: input.totalMinor,
      liabilityCurrency: loan.currency,
      cashAllocations,
      fxRateScaled: paymentTransfer.prepared.fxRateScaled ?? null,
      fxRateSource: paymentTransfer.prepared.fxRateSource ?? null,
      fxRateDate: paymentTransfer.prepared.fxRateDate ?? null,
      referenceFxRateScaled: paymentTransfer.prepared.referenceFxRateScaled ?? null,
      referenceFxRateDate: paymentTransfer.prepared.referenceFxRateDate ?? null,
    };
    audit(userId, "loan_payment", id, "create", undefined, auditRecord);
    return {
      paymentId: id,
      cashAmountMinor: paymentTransfer.cashAmountMinor,
      cashCurrency: cashAccount.currency,
      liabilityAmountMinor: input.totalMinor,
      liabilityCurrency: loan.currency,
      cashAllocations,
      account: liabilityAccountDetail(userId, accountId),
    };
  })();
}

export function undoLiabilityPayment(userId: string, paymentId: string) {
  const cardPayment = one<{
    id: string;
    accountId: string;
    statementId: string | null;
    amountMinor: number;
    sourceTransactionId: string;
    voidedAt: string | null;
  }>(
    `SELECT id, account_id AS accountId, statement_id AS statementId, amount_minor AS amountMinor,
            source_transaction_id AS sourceTransactionId, voided_at AS voidedAt
       FROM credit_card_payments WHERE id = ? AND user_id = ?`,
    [paymentId, userId],
  );
  if (cardPayment) {
    if (cardPayment.voidedAt) {
      throw liabilityError(409, "LIABILITY_PAYMENT_ALREADY_UNDONE", "This payment was already undone");
    }
    return database().transaction(() => {
      voidWorkflowTransaction(userId, cardPayment.sourceTransactionId);
      const now = new Date().toISOString();
      database().prepare("UPDATE credit_card_payments SET voided_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
        .run(now, paymentId);
      if (cardPayment.statementId) refreshCreditCardStatementPaymentState(userId, cardPayment.statementId);
      audit(userId, "credit_card_payment", paymentId, "undo", cardPayment);
      return { success: true, account: liabilityAccountDetail(userId, cardPayment.accountId) };
    })();
  }

  const loanPayment = one<{
    id: string;
    accountId: string;
    scheduleEntryId: string | null;
    principalMinor: number;
    interestMinor: number;
    feesMinor: number;
    sourcePrincipalTransactionId: string | null;
    interestTransactionId: string | null;
    feeTransactionId: string | null;
    voidedAt: string | null;
  }>(
    `SELECT id, loan_account_id AS accountId, schedule_entry_id AS scheduleEntryId,
            principal_minor AS principalMinor, interest_minor AS interestMinor, fees_minor AS feesMinor,
            source_principal_transaction_id AS sourcePrincipalTransactionId,
            interest_transaction_id AS interestTransactionId, fee_transaction_id AS feeTransactionId,
            voided_at AS voidedAt
       FROM loan_payments WHERE id = ? AND user_id = ?`,
    [paymentId, userId],
  );
  if (!loanPayment) throw liabilityError(404, "LIABILITY_PAYMENT_NOT_FOUND", "Liability payment not found");
  if (loanPayment.voidedAt) {
    throw liabilityError(409, "LIABILITY_PAYMENT_ALREADY_UNDONE", "This payment was already undone");
  }
  if (loanPayment.scheduleEntryId) {
    const laterActivePayment = one<{ id: string }>(
      `SELECT later_payment.id
         FROM loan_payments later_payment
         JOIN loan_schedule_entries later_entry ON later_entry.id = later_payment.schedule_entry_id
         JOIN loan_schedule_entries current_entry ON current_entry.id = ?
        WHERE later_payment.loan_account_id = ? AND later_payment.voided_at IS NULL
          AND later_entry.installment_number > current_entry.installment_number
        LIMIT 1`,
      [loanPayment.scheduleEntryId, loanPayment.accountId],
    );
    if (laterActivePayment) {
      throw liabilityError(409, "LIABILITY_UNDO_LATER_INSTALLMENTS_FIRST", "Undo later loan installments before undoing this payment");
    }
  }
  return database().transaction(() => {
    for (const transactionId of [loanPayment.sourcePrincipalTransactionId, loanPayment.interestTransactionId, loanPayment.feeTransactionId]) {
      if (transactionId) voidWorkflowTransaction(userId, transactionId);
    }
    const now = new Date().toISOString();
    database().prepare("UPDATE loan_payments SET voided_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(now, paymentId);
    if (loanPayment.scheduleEntryId) {
      const entry = one<{
        principal: number;
        interest: number;
        fees: number;
        paidPrincipal: number;
        paidInterest: number;
        paidFees: number;
      }>(
        `SELECT principal_minor AS principal, interest_minor AS interest, fees_minor AS fees,
                paid_principal_minor AS paidPrincipal, paid_interest_minor AS paidInterest,
                paid_fees_minor AS paidFees FROM loan_schedule_entries WHERE id = ?`,
        [loanPayment.scheduleEntryId],
      );
      if (entry) {
        const paidPrincipal = Math.max(0, entry.paidPrincipal - loanPayment.principalMinor);
        const paidInterest = Math.max(0, entry.paidInterest - loanPayment.interestMinor);
        const paidFees = Math.max(0, entry.paidFees - loanPayment.feesMinor);
        const any = paidPrincipal + paidInterest + paidFees > 0;
        database().prepare(
          `UPDATE loan_schedule_entries SET paid_principal_minor = ?, paid_interest_minor = ?,
            paid_fees_minor = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        ).run(paidPrincipal, paidInterest, paidFees, any ? "partial" : "projected", loanPayment.scheduleEntryId);
      }
    }
    rebuildLoanSchedule(loanPayment.accountId);
    audit(userId, "loan_payment", paymentId, "undo", loanPayment);
    return { success: true, account: liabilityAccountDetail(userId, loanPayment.accountId) };
  })();
}

export type LiabilityObligation = {
  id: string;
  plannedPaymentId: null;
  /** Compatibility fields containing only the user-authored account name. */
  name: string;
  title: string;
  type: "expense";
  direction: "expense";
  expectedAmountMinor: number;
  paidAmountMinor: number;
  dueDate: string;
  status: string;
  accountId: string | null;
  account: string | null;
  categoryId: string | null;
  category: string | null;
  merchant: null;
  note: string | null;
  recurrenceRuleId: null;
  frequency: null;
  interval: null;
  recurrenceEndDate: null;
  archivedAt: null;
  spendingNature: "fixed";
  spendingPriority: "essential";
  sourceType: "credit_card_statement" | "loan_schedule";
  liabilityAccountId: string;
  liabilityAccountName: string;
  cashFlowAmountMinor: number;
  spendingAmountMinor: number;
  plannedSpendingAmountMinor: number;
  principalAmountMinor: number;
  isEstimate: boolean;
};

export function listLiabilityObligations(userId: string, filters: { from?: string; to?: string; status?: string } = {}): LiabilityObligation[] {
  const today = getUserCalendarContext(userId).today;
  const whereDate = (column: "s.due_date" | "e.due_date", params: SqlValue[]) => {
    const clauses: string[] = [];
    if (filters.from) { clauses.push(`${column} >= ?`); params.push(filters.from); }
    if (filters.to) { clauses.push(`${column} <= ?`); params.push(filters.to); }
    return clauses;
  };
  const cardParams: SqlValue[] = [userId];
  const cardWhere = ["a.user_id = ?", "a.archived_at IS NULL", "COALESCE(p.generate_planned_payments, 1) = 1", ...whereDate("s.due_date", cardParams)];
  const statements = database().prepare(
    `SELECT s.id, a.id AS accountId, a.name AS account,
            s.due_date AS dueDate, s.statement_balance_minor AS statementBalanceMinor,
            s.minimum_due_minor AS minimumDueMinor, s.payments_applied_minor AS paymentsAppliedMinor,
            s.status, s.notes, COALESCE(p.payment_preference, 'full_statement') AS paymentPreference
       FROM credit_card_statements s JOIN accounts a ON a.id = s.account_id
       LEFT JOIN credit_card_profiles p ON p.account_id = a.id
      WHERE ${cardWhere.join(" AND ")} ORDER BY s.due_date`,
  ).all(...cardParams) as Array<{
    id: string; accountId: string; account: string; dueDate: string; statementBalanceMinor: number;
    minimumDueMinor: number; paymentsAppliedMinor: number; status: string; notes: string | null; paymentPreference: string;
  }>;
  const cards: LiabilityObligation[] = statements.map((row) => {
    const due = calculateCardStatementDue({
      statementBalanceMinor: row.statementBalanceMinor,
      minimumPaymentMinor: row.minimumDueMinor,
      paymentsSinceStatementMinor: row.paymentsAppliedMinor,
      dueDate: row.dueDate,
      asOfDate: today,
    });
    const expected = row.paymentPreference === "minimum" ? due.remainingMinimumMinor : due.remainingStatementMinor;
    const status = due.status === "paid" ? "paid" : due.status === "overdue" ? "overdue" : "scheduled";
    return {
      id: `card:${row.id}`, plannedPaymentId: null, name: row.account, title: row.account,
      type: "expense", direction: "expense", expectedAmountMinor: expected,
      paidAmountMinor: row.paymentsAppliedMinor, dueDate: row.dueDate, status,
      accountId: null, account: null, categoryId: null, category: null, merchant: null,
      note: row.notes, recurrenceRuleId: null, frequency: null, interval: null,
      recurrenceEndDate: null, archivedAt: null, spendingNature: "fixed", spendingPriority: "essential",
      sourceType: "credit_card_statement", liabilityAccountId: row.accountId, liabilityAccountName: row.account,
      cashFlowAmountMinor: expected, spendingAmountMinor: 0, plannedSpendingAmountMinor: 0,
      principalAmountMinor: expected, isEstimate: false,
    };
  });

  const loanParams: SqlValue[] = [userId];
  const loanWhere = ["a.user_id = ?", "a.archived_at IS NULL", "p.generate_planned_payments = 1", "e.status <> 'skipped'", ...whereDate("e.due_date", loanParams)];
  const entries = database().prepare(
    `SELECT e.id, a.id AS accountId, a.name AS account, e.due_date AS dueDate,
            e.principal_minor AS principalMinor, e.interest_minor AS interestMinor,
            e.fees_minor AS feesMinor, e.paid_principal_minor AS paidPrincipalMinor,
            e.paid_interest_minor AS paidInterestMinor, e.paid_fees_minor AS paidFeesMinor,
            e.status, e.is_estimate AS isEstimate, p.payment_account_id AS paymentAccountId,
            source.name AS sourceAccount, p.payment_frequency AS paymentFrequency,
            p.payment_interval_months AS paymentIntervalMonths,
            p.amortization_method AS amortizationMethod,
            p.regular_payment_minor AS regularPaymentMinor, p.balloon_minor AS balloonMinor
       FROM loan_schedule_entries e JOIN accounts a ON a.id = e.loan_account_id
       JOIN loan_profiles p ON p.account_id = a.id
       LEFT JOIN accounts source ON source.id = p.payment_account_id
      WHERE ${loanWhere.join(" AND ")} ORDER BY e.due_date`,
  ).all(...loanParams) as Array<{
    id: string; accountId: string; account: string; dueDate: string; principalMinor: number;
    interestMinor: number; feesMinor: number; paidPrincipalMinor: number; paidInterestMinor: number;
    paidFeesMinor: number; status: string; isEstimate: number; paymentAccountId: string | null; sourceAccount: string | null;
    paymentFrequency: string; paymentIntervalMonths: number; amortizationMethod: string;
    regularPaymentMinor: number | null; balloonMinor: number;
  }>;
  const loans: LiabilityObligation[] = entries.map((row) => {
    requireSupportedStoredLoanProfile(row);
    const principal = Math.max(0, row.principalMinor - row.paidPrincipalMinor);
    const spending = Math.max(0, row.interestMinor - row.paidInterestMinor) + Math.max(0, row.feesMinor - row.paidFeesMinor);
    const total = principal + spending;
    const status = total === 0 ? "paid" : row.dueDate < today ? "overdue" : row.status === "partial" ? "scheduled" : "planned";
    return {
      id: `loan:${row.id}`, plannedPaymentId: null, name: row.account, title: row.account,
      type: "expense", direction: "expense", expectedAmountMinor: total,
      paidAmountMinor: row.paidPrincipalMinor + row.paidInterestMinor + row.paidFeesMinor,
      dueDate: row.dueDate, status, accountId: row.paymentAccountId, account: row.sourceAccount,
      categoryId: null, category: null, merchant: null, note: null,
      recurrenceRuleId: null, frequency: null, interval: null, recurrenceEndDate: null, archivedAt: null,
      spendingNature: "fixed", spendingPriority: "essential", sourceType: "loan_schedule",
      liabilityAccountId: row.accountId, liabilityAccountName: row.account,
      cashFlowAmountMinor: total, spendingAmountMinor: spending,
      plannedSpendingAmountMinor: row.interestMinor + row.feesMinor,
      principalAmountMinor: principal, isEstimate: Boolean(row.isEstimate),
    };
  });
  const combined = [...cards, ...loans].filter((item) => !filters.status || item.status === filters.status);
  return combined.sort((left, right) => left.dueDate.localeCompare(right.dueDate)
    || left.liabilityAccountName.localeCompare(right.liabilityAccountName)
    || left.sourceType.localeCompare(right.sourceType));
}

export function liabilityAccountDetail(userId: string, accountId: string) {
  const account = ownedAccount(userId, accountId, undefined, { allowArchived: true });
  if (!new Set(["credit_card", "loan"]).has(account.type)) {
    throw liabilityError(422, "LIABILITY_ACCOUNT_TYPE_INVALID", "This account is not a liability");
  }
  if (account.type === "credit_card") {
    const today = getUserCalendarContext(userId).today;
    const profile = one<Record<string, unknown>>(
      `SELECT statement_day AS statementDay, due_day AS dueDay, grace_period_days AS gracePeriodDays,
              purchase_apr_bps AS purchaseAprBps, minimum_payment_mode AS minimumPaymentMode,
              minimum_payment_rate_bps AS minimumPaymentRateBps,
              minimum_payment_fixed_minor AS minimumPaymentFixedMinor,
              payment_preference AS paymentPreference,
              generate_planned_payments AS generatePlannedPayments
         FROM credit_card_profiles WHERE account_id = ?`, [accountId],
    ) ?? null;
    const statements = (database().prepare(
      `SELECT id, period_start AS periodStart, period_end AS periodEnd, closing_date AS closingDate,
              due_date AS dueDate, statement_balance_minor AS statementBalanceMinor,
              minimum_due_minor AS minimumDueMinor, payments_applied_minor AS paymentsAppliedMinor,
              status, source, notes FROM credit_card_statements WHERE account_id = ? ORDER BY closing_date DESC`,
    ).all(accountId) as Array<{
      id: string;
      periodStart: string;
      periodEnd: string;
      closingDate: string;
      dueDate: string;
      statementBalanceMinor: number;
      minimumDueMinor: number;
      paymentsAppliedMinor: number;
      status: string;
      source: string;
      notes: string | null;
    }>).map((statement) => ({
      ...statement,
      status: creditCardStatementDisplayStatus(statement, today),
    }));
    const payments = database().prepare(
      `SELECT p.id, p.payment_date AS paymentDate, p.amount_minor AS amountMinor,
              p.amount_minor AS liabilityAmountMinor, card.currency AS liabilityCurrency,
              ABS(source_transaction.amount_minor) AS cashAmountMinor,
              source_transaction.currency AS cashCurrency,
              card_transaction.fx_rate_scaled AS fxRateScaled,
              card_transaction.fx_rate_source AS fxRateSource,
              card_transaction.fx_rate_date AS fxRateDate,
              card_transaction.reference_fx_rate_scaled AS referenceFxRateScaled,
              card_transaction.reference_fx_rate_date AS referenceFxRateDate,
              p.statement_id AS statementId, p.voided_at AS voidedAt, a.name AS sourceAccount
         FROM credit_card_payments p
         JOIN accounts a ON a.id = p.source_account_id
         JOIN accounts card ON card.id = p.account_id
         JOIN transactions source_transaction ON source_transaction.id = p.source_transaction_id
         JOIN transactions card_transaction ON card_transaction.id = p.card_transaction_id
        WHERE p.account_id = ? AND p.user_id = ? ORDER BY p.payment_date DESC, p.created_at DESC`,
    ).all(accountId, userId);
    const limit = account.creditLimitMinor ?? 0;
    return {
      account,
      kind: "credit_card" as const,
      profile,
      metrics: calculateCreditCardMetrics({
        accountBalanceMinor: account.balanceMinor,
        creditLimitMinor: limit,
        pendingChargesMinor: Math.max(0, -account.pendingMinor),
        pendingCreditsMinor: Math.max(0, account.pendingMinor),
      }),
      statements,
      payments,
    };
  }
  const profile = one<Record<string, unknown>>(
    `SELECT p.original_principal_minor AS originalPrincipalMinor, p.origination_date AS originationDate,
            p.first_payment_date AS firstPaymentDate, p.maturity_date AS maturityDate,
            p.payment_account_id AS paymentAccountId, source.name AS paymentAccount,
            p.payment_frequency AS paymentFrequency, p.payment_interval_months AS paymentIntervalMonths,
            p.term_months AS termMonths, p.amortization_method AS amortizationMethod,
            p.regular_payment_minor AS regularPaymentMinor, p.balloon_minor AS balloonMinor,
            p.day_count_convention AS dayCountConvention, p.jurisdiction_code AS jurisdictionCode,
            p.interest_category_id AS interestCategoryId, p.fee_category_id AS feeCategoryId,
            p.generate_planned_payments AS generatePlannedPayments
       FROM loan_profiles p LEFT JOIN accounts source ON source.id = p.payment_account_id
      WHERE p.account_id = ?`, [accountId],
  ) ?? null;
  if (profile) {
    requireSupportedStoredLoanProfile({
      paymentFrequency: profile.paymentFrequency,
      paymentIntervalMonths: profile.paymentIntervalMonths,
      amortizationMethod: profile.amortizationMethod,
      regularPaymentMinor: profile.regularPaymentMinor,
      balloonMinor: profile.balloonMinor,
    });
  }
  const rates = database().prepare(
    `SELECT id, effective_from AS effectiveFrom, effective_to AS effectiveTo, rate_type AS rateType,
            fixed_rate_bps AS fixedRateBps, reference_index AS referenceIndex,
            reference_tenor_months AS referenceTenorMonths, reference_rate_bps AS referenceRateBps,
            margin_bps AS marginBps, reset_frequency_months AS resetFrequencyMonths,
            next_reset_date AS nextResetDate, observation_lag_months AS observationLagMonths,
            floor_rate_bps AS floorRateBps, cap_rate_bps AS capRateBps, notes
       FROM loan_rate_periods WHERE loan_account_id = ? ORDER BY effective_from DESC`,
  ).all(accountId);
  const schedule = database().prepare(
    `SELECT id, installment_number AS installmentNumber, due_date AS dueDate,
            opening_principal_minor AS openingPrincipalMinor, payment_minor AS paymentMinor,
            principal_minor AS principalMinor, interest_minor AS interestMinor, fees_minor AS feesMinor,
            closing_principal_minor AS closingPrincipalMinor, annual_rate_bps AS annualRateBps,
            status, paid_principal_minor AS paidPrincipalMinor,
            paid_interest_minor AS paidInterestMinor, paid_fees_minor AS paidFeesMinor,
            is_estimate AS isEstimate
       FROM loan_schedule_entries WHERE loan_account_id = ? ORDER BY installment_number`,
  ).all(accountId);
  const payments = database().prepare(
    `SELECT p.id, p.payment_date AS paymentDate, p.total_minor AS totalMinor,
            p.total_minor AS liabilityAmountMinor, loan.currency AS liabilityCurrency,
            p.principal_minor AS principalMinor, p.interest_minor AS interestMinor,
            p.fees_minor AS feesMinor, p.schedule_entry_id AS scheduleEntryId,
            COALESCE(ABS(principal_source.amount_minor), 0)
              + COALESCE(ABS(interest_transaction.amount_minor), 0)
              + COALESCE(ABS(fee_transaction.amount_minor), 0) AS cashAmountMinor,
            COALESCE(ABS(principal_source.amount_minor), 0) AS cashPrincipalMinor,
            COALESCE(ABS(interest_transaction.amount_minor), 0) AS cashInterestMinor,
            COALESCE(ABS(fee_transaction.amount_minor), 0) AS cashFeesMinor,
            a.currency AS cashCurrency, p.notes, p.voided_at AS voidedAt, a.name AS sourceAccount
       FROM loan_payments p
       JOIN accounts a ON a.id = p.source_account_id
       JOIN accounts loan ON loan.id = p.loan_account_id
       LEFT JOIN transactions principal_source ON principal_source.id = p.source_principal_transaction_id
       LEFT JOIN transactions interest_transaction ON interest_transaction.id = p.interest_transaction_id
       LEFT JOIN transactions fee_transaction ON fee_transaction.id = p.fee_transaction_id
      WHERE p.loan_account_id = ? AND p.user_id = ? ORDER BY p.payment_date DESC, p.created_at DESC`,
  ).all(accountId, userId);
  return {
    account,
    kind: "loan" as const,
    profile,
    rates,
    schedule,
    payments,
    metrics: {
      outstandingPrincipalMinor: Math.max(0, -account.balanceMinor),
      originalPrincipalMinor: Number(profile?.originalPrincipalMinor ?? Math.max(0, -account.openingBalanceMinor)),
      principalRepaidMinor: Math.max(0, Number(profile?.originalPrincipalMinor ?? 0) - Math.max(0, -account.balanceMinor)),
      nextInstallment: (schedule as Array<Record<string, unknown>>).find((item) => !["paid", "skipped"].includes(String(item.status))) ?? null,
    },
  };
}

export function enrichLiabilityAccounts(userId: string, accounts: ReturnType<typeof listAccounts>) {
  return accounts.map((account) => {
    if (account.type === "credit_card") {
      const limit = account.creditLimitMinor ?? 0;
      return {
        ...account,
        liabilityKind: "credit_card",
        creditMetrics: calculateCreditCardMetrics({
          accountBalanceMinor: account.balanceMinor,
          creditLimitMinor: limit,
          pendingChargesMinor: Math.max(0, -account.pendingMinor),
          pendingCreditsMinor: Math.max(0, account.pendingMinor),
        }),
      };
    }
    if (account.type === "loan") {
      const profile = one<{ originalPrincipalMinor: number }>(
        "SELECT original_principal_minor AS originalPrincipalMinor FROM loan_profiles WHERE account_id = ?",
        [account.id],
      );
      return {
        ...account,
        liabilityKind: "loan",
        loanMetrics: {
          outstandingPrincipalMinor: Math.max(0, -account.balanceMinor),
          originalPrincipalMinor: profile?.originalPrincipalMinor ?? Math.max(0, -account.openingBalanceMinor),
          principalRepaidMinor: Math.max(0, (profile?.originalPrincipalMinor ?? 0) - Math.max(0, -account.balanceMinor)),
        },
      };
    }
    return account;
  });
}

export function disburseLoan(
  userId: string,
  accountId: string,
  inputOrDestinationAccountId: LoanDisbursementInput | string,
  legacyAmountMinor?: number,
  legacyDate?: string,
) {
  const input: LoanDisbursementInput = typeof inputOrDestinationAccountId === "string"
    ? {
      destinationAccountId: inputOrDestinationAccountId,
      amountMinor: legacyAmountMinor ?? 0,
      date: legacyDate ?? "",
    }
    : inputOrDestinationAccountId;
  const loan = ownedAccount(userId, accountId, "loan");
  assertMinor(input.amountMinor, "Disbursement amount");
  assertDate(input.date, "disbursement date");
  const cashAccount = sourceCashAccount(userId, input.destinationAccountId);
  const crossCurrency = cashAccount.currency !== loan.currency;
  if (crossCurrency && input.cashAmountMinor == null) {
    throw liabilityError(422, "LIABILITY_DISBURSEMENT_CROSS_CURRENCY_CASH_AMOUNT_REQUIRED", "Cross-currency loan disbursements require an explicit cash-account amount");
  }
  const cashAmountMinor = input.cashAmountMinor ?? input.amountMinor;
  assertMinor(cashAmountMinor, "Cash-account amount");
  if (!crossCurrency && cashAmountMinor !== input.amountMinor) {
    throw liabilityError(422, "LIABILITY_DISBURSEMENT_SAME_CURRENCY_AMOUNT_MISMATCH", "Same-currency loan and cash disbursement amounts must match");
  }
  if (!crossCurrency && hasLiabilityFxFields(input)) {
    throw liabilityError(422, "LIABILITY_DISBURSEMENT_SAME_CURRENCY_FX_FORBIDDEN", "Same-currency loan disbursements do not need FX rate fields");
  }
  const prepared = validateTransferFxForPosting(
    loan.currency,
    cashAccount.currency,
    input.amountMinor,
    input.date,
    {
      destinationAmountMinor: cashAmountMinor,
      fxRateScaled: input.fxRateScaled,
      fxRateSource: input.fxRateSource,
      fxRateDate: input.fxRateDate,
      referenceFxRateScaled: input.referenceFxRateScaled,
      referenceFxRateDate: input.referenceFxRateDate,
    },
  );
  return database().transaction(() => {
    const result = createLiabilityTransaction(userId, {
      kind: "transfer",
      accountId,
      transferAccountId: input.destinationAccountId,
      amountMinor: input.amountMinor,
      destinationAmountMinor: cashAmountMinor,
      fxRateScaled: prepared.fxRateScaled,
      fxRateSource: prepared.fxRateSource,
      fxRateDate: prepared.fxRateDate,
      referenceFxRateScaled: prepared.referenceFxRateScaled,
      referenceFxRateDate: prepared.referenceFxRateDate,
      date: input.date,
      note: input.note ?? `Loan disbursement from ${loan.name}`,
      duplicateConfirmed: true,
    });
    if (one("SELECT account_id FROM loan_profiles WHERE account_id = ?", [accountId])) rebuildLoanSchedule(accountId);
    const auditRecord = {
      ...input,
      accountId,
      loanAmountMinor: input.amountMinor,
      loanCurrency: loan.currency,
      cashAmountMinor,
      cashCurrency: cashAccount.currency,
      fxRateScaled: prepared.fxRateScaled ?? null,
      fxRateSource: prepared.fxRateSource ?? null,
      fxRateDate: prepared.fxRateDate ?? null,
      referenceFxRateScaled: prepared.referenceFxRateScaled ?? null,
      referenceFxRateDate: prepared.referenceFxRateDate ?? null,
      transferGroupId: result.transferGroupId,
    };
    audit(userId, "loan_disbursement", result.transferGroupId ?? result.id, "create", undefined, auditRecord);
    return {
      transaction: result,
      loanAmountMinor: input.amountMinor,
      loanCurrency: loan.currency,
      cashAmountMinor,
      cashCurrency: cashAccount.currency,
      account: liabilityAccountDetail(userId, accountId),
    };
  })();
}
