import { z } from "zod";
import {
  ACCOUNT_TYPES,
  RECURRENCE_FREQUENCIES,
  TRANSACTION_KINDS,
  TRANSACTION_STATUSES,
} from "@/lib/constants";
import {
  DEFAULT_CURRENCY,
  DEFAULT_LOCALE,
  DEFAULT_TIME_ZONE,
  isSupportedCurrency,
} from "@/lib/currencies";

const idInput = z.string().trim().min(1).max(100);
export const dateKeyInput = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date in YYYY-MM-DD format")
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, "Choose a real calendar date");
export const monthKeyInput = z.string()
  .regex(/^\d{4}-\d{2}$/, "Use a month in YYYY-MM format")
  .refine((value) => {
    const parsed = new Date(`${value}-01T00:00:00.000Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 7) === value;
  }, "Choose a real calendar month");
const id = idInput;
const dateKey = dateKeyInput;
const monthKey = monthKeyInput;
const minor = z.number().int().safe();
const positiveMinor = minor.positive();

const currencyCodeInput = z.string()
  .trim()
  .regex(/^[A-Za-z]{3}$/, "Use a three-letter ISO 4217 currency code")
  .transform((value) => value.toUpperCase())
  .refine(isSupportedCurrency, "Choose a supported ISO 4217 currency");

const localeInput = z.string().trim().min(2).max(35).refine((value) => {
  try {
    void new Intl.Locale(value);
    return true;
  } catch {
    return false;
  }
}, "Choose a valid locale");

const timeZoneInput = z.string().trim().min(1).max(100).refine((value) => {
  try {
    void new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}, "Choose a valid IANA time zone");

export const registerInput = z.object({
  name: z.string().trim().min(2).max(80),
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(10).max(128),
  currency: currencyCodeInput.default(DEFAULT_CURRENCY),
  locale: localeInput.default(DEFAULT_LOCALE),
  timeZone: timeZoneInput.default(DEFAULT_TIME_ZONE),
});

export const loginInput = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(1).max(128),
});

export const accountInput = z.object({
  name: z.string().trim().min(1).max(80),
  type: z.enum(ACCOUNT_TYPES),
  customType: z.string().trim().max(60).optional().nullable(),
  currency: currencyCodeInput,
  openingBalanceMinor: minor.default(0),
  openingDate: dateKey,
  creditLimitMinor: minor.nonnegative().optional().nullable(),
  institution: z.string().trim().max(120).optional().nullable(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#2563eb"),
}).superRefine((value, context) => {
  if (value.type === "custom" && !value.customType?.trim()) {
    context.addIssue({ code: "custom", path: ["customType"], message: "Describe the custom account type" });
  }
});

const nullableDateKey = dateKey.optional().nullable();
const nullableId = id.optional().nullable();
const nullableNonNegativeMinor = minor.nonnegative().optional().nullable();
const basisPoints = z.number().int().min(-100_000).max(1_000_000);

export const creditCardProfileInput = z.object({
  creditLimitMinor: minor.nonnegative(),
  statementDay: z.number().int().min(1).max(31).optional().nullable(),
  dueDay: z.number().int().min(1).max(31).optional().nullable(),
  gracePeriodDays: z.number().int().min(0).max(180).optional().nullable(),
  purchaseAprBps: basisPoints.nonnegative().optional().nullable(),
  minimumPaymentMode: z.enum(["manual", "percentage", "fixed"]).default("manual"),
  minimumPaymentRateBps: basisPoints.nonnegative().optional().nullable(),
  minimumPaymentFixedMinor: nullableNonNegativeMinor,
  paymentPreference: z.enum(["full_statement", "minimum", "custom"]).default("full_statement"),
  generatePlannedPayments: z.boolean().default(true),
});

const fixedLoanRateInput = z.object({
  rateType: z.literal("fixed"),
  effectiveFrom: dateKey,
  effectiveTo: nullableDateKey,
  fixedRateBps: basisPoints.nonnegative(),
  notes: z.string().trim().max(500).optional().nullable(),
}).superRefine((value, context) => {
  if (value.effectiveTo && value.effectiveTo < value.effectiveFrom) {
    context.addIssue({ code: "custom", path: ["effectiveTo"], message: "The rate period cannot end before it starts" });
  }
});

const variableLoanRateInput = z.object({
  rateType: z.literal("variable"),
  effectiveFrom: dateKey,
  effectiveTo: nullableDateKey,
  referenceIndex: z.string().trim().min(1).max(80),
  referenceTenorMonths: z.number().int().min(1).max(120),
  referenceRateBps: basisPoints,
  marginBps: basisPoints.default(0),
  resetFrequencyMonths: z.number().int().min(1).max(120),
  nextResetDate: nullableDateKey,
  observationLagMonths: z.number().int().min(0).max(120).default(0),
  floorRateBps: basisPoints.optional().nullable(),
  capRateBps: basisPoints.optional().nullable(),
  notes: z.string().trim().max(500).optional().nullable(),
}).superRefine((value, context) => {
  if (value.effectiveTo && value.effectiveTo < value.effectiveFrom) {
    context.addIssue({ code: "custom", path: ["effectiveTo"], message: "The rate period cannot end before it starts" });
  }
  if (value.floorRateBps != null && value.capRateBps != null && value.floorRateBps > value.capRateBps) {
    context.addIssue({ code: "custom", path: ["capRateBps"], message: "The rate cap cannot be below the floor" });
  }
});

export const loanRateInput = z.discriminatedUnion("rateType", [fixedLoanRateInput, variableLoanRateInput]);

function unsupportedLoanScheduleField(message: string) {
  return z.custom<never>((value) => value === undefined, { message }).optional();
}

export const loanProfileInput = z.object({
  originalPrincipalMinor: positiveMinor,
  originationDate: dateKey,
  firstPaymentDate: dateKey,
  maturityDate: nullableDateKey,
  paymentAccountId: nullableId,
  paymentFrequency: z.enum(["monthly", "quarterly", "yearly", "custom"]).default("monthly"),
  paymentIntervalMonths: z.number().int().min(1).max(120).default(1),
  termMonths: z.number().int().min(1).max(1200),
  amortizationMethod: z.enum(["annuity", "equal_principal", "interest_only"]).default("annuity"),
  regularPaymentMinor: unsupportedLoanScheduleField("Contractual fixed-payment schedules are not supported yet; remove this field"),
  balloonMinor: unsupportedLoanScheduleField("Explicit balloon schedules are not supported yet; remove this field"),
  dayCountConvention: z.enum(["actual_365", "actual_360", "30_360"]).default("actual_365"),
  jurisdictionCode: z.string().trim().max(8).optional().nullable(),
  interestCategoryId: nullableId,
  feeCategoryId: nullableId,
  generatePlannedPayments: z.boolean().default(true),
  rate: loanRateInput,
}).superRefine((value, context) => {
  const canonicalInterval = value.paymentFrequency === "monthly"
    ? 1
    : value.paymentFrequency === "quarterly"
      ? 3
      : value.paymentFrequency === "yearly" ? 12 : null;
  if (canonicalInterval !== null && value.paymentIntervalMonths !== canonicalInterval) {
    context.addIssue({
      code: "custom",
      path: ["paymentIntervalMonths"],
      message: `${value.paymentFrequency} payments require an interval of ${canonicalInterval} month${canonicalInterval === 1 ? "" : "s"}`,
    });
  }
});

export const creditCardStatementInput = z.object({
  periodStart: dateKey,
  periodEnd: dateKey,
  closingDate: dateKey,
  dueDate: dateKey,
  statementBalanceMinor: positiveMinor,
  minimumDueMinor: minor.nonnegative().default(0),
  source: z.enum(["manual", "imported"]).default("manual"),
  notes: z.string().trim().max(500).optional().nullable(),
}).superRefine((value, context) => {
  if (value.periodEnd < value.periodStart) context.addIssue({ code: "custom", path: ["periodEnd"], message: "The period cannot end before it starts" });
  if (value.closingDate < value.periodEnd) context.addIssue({ code: "custom", path: ["closingDate"], message: "The closing date cannot precede the statement period end" });
  if (value.dueDate < value.closingDate) context.addIssue({ code: "custom", path: ["dueDate"], message: "The due date cannot precede the closing date" });
  if (value.minimumDueMinor > value.statementBalanceMinor) context.addIssue({ code: "custom", path: ["minimumDueMinor"], message: "Minimum due cannot exceed the statement balance" });
});

const liabilityFxFields = {
  cashAmountMinor: positiveMinor.optional().nullable(),
  fxRateScaled: positiveMinor.optional().nullable(),
  fxRateSource: z.enum(["bnr", "manual"]).optional().nullable(),
  fxRateDate: nullableDateKey,
  referenceFxRateScaled: positiveMinor.optional().nullable(),
  referenceFxRateDate: nullableDateKey,
};

export const creditCardPaymentInput = z.object({
  statementId: nullableId,
  sourceAccountId: id,
  date: dateKey,
  amountMinor: positiveMinor,
  note: z.string().trim().max(500).optional().nullable(),
  ...liabilityFxFields,
});

export const loanPaymentInput = z.object({
  scheduleEntryId: nullableId,
  sourceAccountId: id,
  date: dateKey,
  totalMinor: positiveMinor,
  principalMinor: minor.nonnegative(),
  interestMinor: minor.nonnegative(),
  feesMinor: minor.nonnegative().default(0),
  note: z.string().trim().max(500).optional().nullable(),
  ...liabilityFxFields,
}).superRefine((value, context) => {
  if (BigInt(value.principalMinor) + BigInt(value.interestMinor) + BigInt(value.feesMinor) !== BigInt(value.totalMinor)) {
    context.addIssue({ code: "custom", path: ["totalMinor"], message: "Principal, interest, and fees must equal the total payment" });
  }
});

export const loanDisbursementInput = z.object({
  destinationAccountId: id,
  date: dateKey,
  amountMinor: positiveMinor,
  note: z.string().trim().max(500).optional().nullable(),
  ...liabilityFxFields,
});

const categoryKindInput = z.enum(["income", "expense", "both"]);
const categorySpendingNatureInput = z.enum(["fixed", "variable"]);
const categorySpendingPriorityInput = z.enum(["essential", "discretionary"]);
const categoryClassificationInput = z.enum(["fixed", "variable", "essential", "discretionary"]);
const categoryColorInput = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use a six-digit hex colour");

export const categoryInput = z.object({
  name: z.string().trim().min(1).max(80),
  parentId: id.optional().nullable(),
  kind: categoryKindInput.default("expense"),
  spendingNature: categorySpendingNatureInput.default("variable"),
  spendingPriority: categorySpendingPriorityInput.default("discretionary"),
  classification: categoryClassificationInput.optional(),
  color: categoryColorInput.default("#718096"),
});

export const categoryUpdateInput = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  parentId: id.optional().nullable(),
  kind: categoryKindInput.optional(),
  spendingNature: categorySpendingNatureInput.nullable().optional(),
  spendingPriority: categorySpendingPriorityInput.nullable().optional(),
  classification: categoryClassificationInput.optional(),
  color: categoryColorInput.optional(),
}).refine((value) => Object.values(value).some((item) => item !== undefined), {
  message: "Provide at least one category field to update",
});

const splitInput = z.object({
  categoryId: id,
  amountMinor: minor,
  note: z.string().trim().max(240).optional().nullable(),
});

export const transactionInput = z
  .object({
    kind: z.enum(TRANSACTION_KINDS),
    status: z.enum(TRANSACTION_STATUSES).default("cleared"),
    accountId: id,
    transferAccountId: id.optional().nullable(),
    amountMinor: positiveMinor,
    destinationAmountMinor: positiveMinor.optional().nullable(),
    originalAmountMinor: positiveMinor.optional().nullable(),
    originalCurrency: currencyCodeInput.optional().nullable(),
    fxRateScaled: positiveMinor.optional().nullable(),
    fxRateSource: z.enum(["bnr", "manual"]).optional().nullable(),
    fxRateDate: nullableDateKey,
    referenceFxRateScaled: positiveMinor.optional().nullable(),
    referenceFxRateDate: nullableDateKey,
    date: dateKey,
    categoryId: id.optional().nullable(),
    merchant: z.string().trim().max(120).optional().nullable(),
    note: z.string().trim().max(500).optional().nullable(),
    tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
    splits: z.array(splitInput).max(30).default([]),
    receiptReference: z.string().trim().max(500).optional().nullable(),
    duplicateConfirmed: z.boolean().default(false),
    adjustmentSign: z.union([z.literal(-1), z.literal(1)]).optional(),
  })
  .superRefine((value, context) => {
    const hasOriginalAmount = value.originalAmountMinor !== undefined && value.originalAmountMinor !== null;
    const hasOriginalCurrency = value.originalCurrency !== undefined && value.originalCurrency !== null;
    const hasAppliedRate = value.fxRateScaled !== undefined && value.fxRateScaled !== null;
    const hasAppliedSource = value.fxRateSource !== undefined && value.fxRateSource !== null;
    const hasAppliedDate = value.fxRateDate !== undefined && value.fxRateDate !== null;
    const hasReferenceRate = value.referenceFxRateScaled !== undefined && value.referenceFxRateScaled !== null;
    const hasReferenceDate = value.referenceFxRateDate !== undefined && value.referenceFxRateDate !== null;
    if (value.kind === "transfer") {
      if (hasOriginalAmount || hasOriginalCurrency) {
        context.addIssue({
          code: "custom",
          path: ["originalCurrency"],
          message: "Transfer source currency and amount are inferred from the source account",
        });
      }
      if (hasAppliedRate && !hasAppliedSource) {
        context.addIssue({
          code: "custom",
          path: ["fxRateSource"],
          message: "Choose the source of the transfer exchange rate",
        });
      }
      if (hasAppliedDate && !hasAppliedSource) {
        context.addIssue({ code: "custom", path: ["fxRateSource"], message: "Choose the source of the transfer exchange rate" });
      }
      if (hasReferenceRate !== hasReferenceDate) {
        context.addIssue({
          code: "custom",
          path: hasReferenceRate ? ["referenceFxRateDate"] : ["referenceFxRateScaled"],
          message: "Provide both the reference BNR rate and its rate date",
        });
      }
      if (value.fxRateSource === "bnr" && (hasReferenceRate || hasReferenceDate)) {
        context.addIssue({
          code: "custom",
          path: ["referenceFxRateScaled"],
          message: "A BNR transfer rate does not need a separate BNR reference rate",
        });
      }
      if (!value.transferAccountId) {
        context.addIssue({ code: "custom", path: ["transferAccountId"], message: "Choose a destination account" });
      }
      if (value.transferAccountId === value.accountId) {
        context.addIssue({ code: "custom", path: ["transferAccountId"], message: "Choose a different account" });
      }
      if (value.splits.length) {
        context.addIssue({ code: "custom", path: ["splits"], message: "Transfers cannot be split across categories" });
      }
      return;
    }
    if (value.destinationAmountMinor !== undefined && value.destinationAmountMinor !== null) {
      context.addIssue({
        code: "custom",
        path: ["destinationAmountMinor"],
        message: "A destination amount is only valid for transfers",
      });
    }
    if (hasOriginalAmount !== hasOriginalCurrency) {
      context.addIssue({
        code: "custom",
        path: hasOriginalAmount ? ["originalCurrency"] : ["originalAmountMinor"],
        message: "Provide both the original amount and original currency",
      });
    }
    if (hasReferenceRate !== hasReferenceDate) {
      context.addIssue({
        code: "custom",
        path: hasReferenceRate ? ["referenceFxRateDate"] : ["referenceFxRateScaled"],
        message: "Provide both the reference BNR rate and its rate date",
      });
    }
    if (!hasOriginalAmount && [value.fxRateScaled, value.fxRateSource, value.fxRateDate, value.referenceFxRateScaled, value.referenceFxRateDate]
      .some((item) => item !== undefined && item !== null)) {
      context.addIssue({
        code: "custom",
        path: ["originalAmountMinor"],
        message: "FX rate fields require an original amount and original currency",
      });
    }
    if (value.splits.length) {
      const total = value.splits.reduce((sum, split) => sum + BigInt(Math.abs(split.amountMinor)), 0n);
      if (total !== BigInt(value.amountMinor)) {
        context.addIssue({ code: "custom", path: ["splits"], message: "Split amounts must add up to the transaction amount" });
      }
    }
  });

export const plannedInput = z.object({
  name: z.string().trim().min(1).max(120),
  expectedAmountMinor: positiveMinor,
  currency: currencyCodeInput.optional(),
  dueDate: dateKey,
  type: z.enum(["expense", "income"]).default("expense"),
  categoryId: id.optional().nullable(),
  accountId: id.optional().nullable(),
  merchant: z.string().trim().max(120).optional().nullable(),
  note: z.string().trim().max(500).optional().nullable(),
  status: z.enum(["planned", "scheduled"]).default("planned"),
  recurrence: z
    .object({
      frequency: z.enum(RECURRENCE_FREQUENCIES),
      interval: z.number().int().min(1).max(24).default(1),
      endDate: dateKey.optional().nullable(),
    })
    .optional()
    .nullable(),
}).superRefine((value, context) => {
  if (value.recurrence?.endDate && value.recurrence.endDate < value.dueDate) {
    context.addIssue({ code: "custom", path: ["recurrence", "endDate"], message: "The recurrence cannot end before its first payment" });
  }
});

export const profilePreferencesInput = z.object({
  displayName: z.string().trim().min(2).max(80),
  currency: currencyCodeInput,
  locale: localeInput.default(DEFAULT_LOCALE),
  timeZone: timeZoneInput.default(DEFAULT_TIME_ZONE),
  compactTables: z.boolean().default(true),
});

export const reminderSettingsInput = z.object({
  dueSoon: z.boolean().default(true),
  overdue: z.boolean().default(true),
  budgetWarnings: z.boolean().default(true),
  daysBefore: z.number().int().min(1).max(30).default(3),
});

export const passwordChangeInput = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: z.string().min(10).max(128),
}).refine((value) => value.currentPassword !== value.newPassword, {
  path: ["newPassword"],
  message: "Choose a new password that differs from the current password",
});

export const plannedPayInput = z.object({
  amountMinor: positiveMinor,
  appliedAmountMinor: positiveMinor.optional(),
  date: dateKey,
  accountId: id,
  fxRateScaled: positiveMinor.optional().nullable(),
  fxRateSource: z.enum(["bnr", "manual"]).optional().nullable(),
  fxRateDate: nullableDateKey,
  referenceFxRateScaled: positiveMinor.optional().nullable(),
  referenceFxRateDate: nullableDateKey,
  partial: z.boolean().default(false),
  note: z.string().trim().max(500).optional().nullable(),
}).superRefine((value, context) => {
  const hasReferenceRate = value.referenceFxRateScaled != null;
  const hasReferenceDate = value.referenceFxRateDate != null;
  if (hasReferenceRate !== hasReferenceDate) {
    context.addIssue({
      code: "custom",
      path: hasReferenceRate ? ["referenceFxRateDate"] : ["referenceFxRateScaled"],
      message: "Provide both the reference BNR rate and its rate date",
    });
  }
  if (value.fxRateScaled != null && !value.fxRateSource) {
    context.addIssue({ code: "custom", path: ["fxRateSource"], message: "Choose the source of the exchange rate" });
  }
  if (value.fxRateDate != null && !value.fxRateSource) {
    context.addIssue({ code: "custom", path: ["fxRateSource"], message: "Choose the source of the exchange rate" });
  }
});

export const plannedSkipInput = z.object({ reason: z.string().trim().max(240).optional().nullable() });

export const budgetInput = z.object({
  month: monthKey,
  categoryId: id,
  amountMinor: positiveMinor,
  rollover: z.boolean().default(false),
});

export const importPreviewInput = z.object({
  csv: z.string().min(1).max(20 * 1024 * 1024),
  mapping: z.record(z.string(), z.string()).optional(),
  hasHeader: z.boolean().default(true),
  options: z.object({
    dateFormat: z.enum(["auto", "yyyy-MM-dd", "dd.MM.yyyy", "dd/MM/yyyy", "MM/dd/yyyy"]).default("auto"),
    decimalSeparator: z.enum(["auto", ",", "."]).default("auto"),
  }).optional(),
});

export const importCommitInput = z.object({
  accountId: id,
  rows: z.array(
    z.object({
      date: dateKey,
      amountMinor: minor.refine((value) => value !== 0, "Amount cannot be zero"),
      description: z.string().trim().max(500).default(""),
      merchant: z.string().trim().max(120).optional().nullable(),
      categoryId: id.optional().nullable(),
      externalId: z.string().trim().max(200).optional().nullable(),
      duplicate: z.boolean().optional(),
      originalAmountMinor: positiveMinor.optional().nullable(),
      originalCurrency: currencyCodeInput.optional().nullable(),
      fxRateScaled: positiveMinor.optional().nullable(),
      fxRateSource: z.literal("manual").optional().nullable(),
      fxRateDate: dateKey.optional().nullable(),
    }),
  ).min(1).max(10_000),
  duplicateStrategy: z.enum(["skip", "import"]).default("skip"),
});

export const restoreInput = z.object({
  backup: z.string().min(1),
  confirmation: z.literal("RESTORE"),
});
