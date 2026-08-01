import { randomUUID } from "node:crypto";

import { DEFAULT_CURRENCY } from "@/lib/currencies";
import { currencyMinorUnitDigits } from "@/lib/domain/currency";

import type { AccountType, TransactionKind, TransactionStatus } from "@/db/schema";

import { datePart } from "./dates";
import { addMinor, assertMinorUnits } from "./money";

export type LedgerAccount = {
  id: string;
  openingBalanceMinor: number;
  openingBalanceDate: string;
  type?: AccountType;
  archivedAt?: string | null;
};

export type LedgerTransaction = {
  id?: string;
  accountId: string;
  kind: TransactionKind;
  status?: TransactionStatus;
  amountMinor: number;
  occurredAt: string;
  transferGroupId?: string | null;
  transferPeerId?: string | null;
  currency?: string;
  originalAmountMinor?: number | null;
  originalCurrency?: string | null;
  fxRateScaled?: number | null;
  fxRateSource?: "bnr" | "manual" | null;
  fxRateDate?: string | null;
  referenceFxRateScaled?: number | null;
  referenceFxRateDate?: string | null;
  voidedAt?: string | null;
};

export type BalanceOptions = {
  throughDate?: string;
  includePending?: boolean;
};

function affectsBalance(transaction: LedgerTransaction, options: BalanceOptions): boolean {
  if (transaction.status === "void" || transaction.voidedAt) return false;
  if (!options.includePending && transaction.status === "pending") return false;
  return !options.throughDate || datePart(transaction.occurredAt) <= options.throughDate;
}

export function calculateAccountBalance(
  account: LedgerAccount,
  transactions: readonly LedgerTransaction[],
  options: BalanceOptions = {},
): number {
  assertMinorUnits(account.openingBalanceMinor, "openingBalanceMinor");
  const changes = transactions
    .filter((transaction) => transaction.accountId === account.id && affectsBalance(transaction, options))
    .filter((transaction) => datePart(transaction.occurredAt) >= account.openingBalanceDate)
    .map((transaction) => {
      assertMinorUnits(transaction.amountMinor);
      return transaction.amountMinor;
    });
  return addMinor(account.openingBalanceMinor, ...changes);
}

export function reconcileBalances(
  accounts: readonly LedgerAccount[],
  transactions: readonly LedgerTransaction[],
  options: BalanceOptions = {},
): Map<string, number> {
  return new Map(accounts.map((account) => [account.id, calculateAccountBalance(account, transactions, options)]));
}

export function totalNetWorth(
  accounts: readonly LedgerAccount[],
  transactions: readonly LedgerTransaction[],
  options: BalanceOptions = {},
): number {
  return addMinor(...reconcileBalances(accounts, transactions, options).values());
}

function validateTransactionSign(kind: TransactionKind, amountMinor: number): void {
  assertMinorUnits(amountMinor);
  if ((kind === "income" || kind === "refund") && amountMinor <= 0) {
    throw new RangeError(`${kind} transactions must have a positive amount.`);
  }
  if (kind === "expense" && amountMinor >= 0) {
    throw new RangeError("Expense transactions must have a negative amount.");
  }
  if (kind === "transfer" && amountMinor === 0) {
    throw new RangeError("Transfer amount cannot be zero.");
  }
}

export type TransferInput = {
  userId: string;
  sourceAccountId: string;
  destinationAccountId: string;
  amountMinor: number;
  destinationAmountMinor?: number;
  occurredAt: string;
  currency?: string;
  sourceCurrency?: string;
  destinationCurrency?: string;
  fxRateScaled?: number;
  fxRateSource?: "bnr" | "manual";
  fxRateDate?: string;
  referenceFxRateScaled?: number | null;
  referenceFxRateDate?: string | null;
  notes?: string | null;
  status?: Exclude<TransactionStatus, "void">;
};

export type TransferLeg = {
  id: string;
  userId: string;
  accountId: string;
  kind: "transfer";
  status: Exclude<TransactionStatus, "void">;
  amountMinor: number;
  currency: string;
  occurredAt: string;
  notes: string | null;
  transferGroupId: string;
  transferPeerId: string;
  originalAmountMinor?: number;
  originalCurrency?: string;
  fxRateScaled?: number;
  fxRateSource?: "bnr" | "manual";
  fxRateDate?: string;
  referenceFxRateScaled?: number | null;
  referenceFxRateDate?: string | null;
};

/** Creates the two balance-changing legs of a transfer. Neither leg is cash-flow income/spend. */
export function createTransferPair(input: TransferInput): [TransferLeg, TransferLeg] {
  if (input.sourceAccountId === input.destinationAccountId) {
    throw new RangeError("Source and destination accounts must be different.");
  }
  assertMinorUnits(input.amountMinor);
  if (input.amountMinor <= 0) throw new RangeError("Transfer amount must be positive.");
  datePart(input.occurredAt);
  const sourceCurrency = (input.sourceCurrency ?? input.currency ?? DEFAULT_CURRENCY).toUpperCase();
  const destinationCurrency = (input.destinationCurrency ?? sourceCurrency).toUpperCase();
  const destinationAmountMinor = input.destinationAmountMinor ?? input.amountMinor;
  assertMinorUnits(destinationAmountMinor, "destinationAmountMinor");
  if (destinationAmountMinor <= 0) throw new RangeError("Destination transfer amount must be positive.");
  if (sourceCurrency === destinationCurrency && destinationAmountMinor !== input.amountMinor) {
    throw new RangeError("Same-currency transfer amounts must match.");
  }
  if (sourceCurrency !== destinationCurrency && (
    !input.fxRateScaled || !input.fxRateSource || !input.fxRateDate
  )) {
    throw new RangeError("Cross-currency transfers require an exchange rate, source, and rate date.");
  }
  if (sourceCurrency !== destinationCurrency) {
    assertMinorUnits(input.fxRateScaled as number, "fxRateScaled");
    if ((input.fxRateScaled as number) <= 0) throw new RangeError("Transfer exchange rate must be positive.");
    datePart(input.fxRateDate as string);
    if (convertedTransferAmount(input.amountMinor, input.fxRateScaled as number, sourceCurrency, destinationCurrency) !== destinationAmountMinor) {
      throw new RangeError("The destination amount does not match the transfer exchange rate.");
    }
    if ((input.referenceFxRateScaled == null) !== (input.referenceFxRateDate == null)) {
      throw new RangeError("Reference exchange-rate value and date must be provided together.");
    }
    if (input.fxRateSource === "bnr" && input.referenceFxRateScaled != null) {
      throw new RangeError("A BNR transfer rate cannot carry a second BNR reference rate.");
    }
    if (input.referenceFxRateScaled != null && input.referenceFxRateDate) {
      assertMinorUnits(input.referenceFxRateScaled, "referenceFxRateScaled");
      if (input.referenceFxRateScaled <= 0) throw new RangeError("Reference exchange rate must be positive.");
      datePart(input.referenceFxRateDate);
    }
  }

  const groupId = randomUUID();
  const sourceId = randomUUID();
  const destinationId = randomUUID();
  const shared = {
    userId: input.userId,
    kind: "transfer" as const,
    status: input.status ?? "cleared",
    occurredAt: input.occurredAt,
    notes: input.notes ?? null,
    transferGroupId: groupId,
  };
  return [
    {
      ...shared,
      id: sourceId,
      accountId: input.sourceAccountId,
      amountMinor: -input.amountMinor,
      currency: sourceCurrency,
      transferPeerId: destinationId,
    },
    {
      ...shared,
      id: destinationId,
      accountId: input.destinationAccountId,
      amountMinor: destinationAmountMinor,
      currency: destinationCurrency,
      transferPeerId: sourceId,
      ...(sourceCurrency === destinationCurrency ? {} : {
        originalAmountMinor: input.amountMinor,
        originalCurrency: sourceCurrency,
        fxRateScaled: input.fxRateScaled,
        fxRateSource: input.fxRateSource,
        fxRateDate: input.fxRateDate,
        referenceFxRateScaled: input.referenceFxRateScaled,
        referenceFxRateDate: input.referenceFxRateDate,
      }),
    },
  ];
}

const FX_RATE_SCALE = 100_000_000n;

function convertedTransferAmount(
  amountMinor: number,
  rateScaled: number,
  fromCurrency: string,
  toCurrency: string,
) {
  const numerator = BigInt(amountMinor)
    * BigInt(rateScaled)
    * 10n ** BigInt(currencyMinorUnitDigits(toCurrency));
  const denominator = FX_RATE_SCALE * 10n ** BigInt(currencyMinorUnitDigits(fromCurrency));
  let result = numerator / denominator;
  if ((numerator % denominator) * 2n >= denominator) result += 1n;
  const numeric = Number(result);
  if (!Number.isSafeInteger(numeric)) throw new Error("Converted transfer amount exceeds the safe integer range.");
  return numeric;
}

export function assertValidTransferPair(pair: readonly LedgerTransaction[]): void {
  if (pair.length !== 2) throw new Error("A transfer must contain exactly two legs.");
  const source = pair.find((leg) => leg.amountMinor < 0);
  const destination = pair.find((leg) => leg.amountMinor > 0);
  if (
    !source ||
    !destination ||
    source.kind !== "transfer" ||
    destination.kind !== "transfer" ||
    !source.transferGroupId ||
    source.transferGroupId !== destination.transferGroupId ||
    source.accountId === destination.accountId ||
    (source.transferPeerId != null && source.transferPeerId !== destination.id) ||
    (destination.transferPeerId != null && destination.transferPeerId !== source.id)
  ) {
    throw new Error("Transfer legs do not reconcile.");
  }
  const sourceCurrency = source.currency ?? DEFAULT_CURRENCY;
  const destinationCurrency = destination.currency ?? sourceCurrency;
  if (sourceCurrency === destinationCurrency) {
    const hasFxMetadata = [source, destination].some((leg) => (
      leg.originalAmountMinor != null || leg.originalCurrency != null || leg.fxRateScaled != null
      || leg.fxRateSource != null || leg.fxRateDate != null || leg.referenceFxRateScaled != null
      || leg.referenceFxRateDate != null
    ));
    if (source.amountMinor + destination.amountMinor !== 0 || hasFxMetadata) {
      throw new Error("Same-currency transfer legs do not reconcile.");
    }
    return;
  }
  if (
    source.originalAmountMinor != null ||
    source.originalCurrency != null ||
    source.fxRateScaled != null ||
    source.fxRateSource != null ||
    source.fxRateDate != null ||
    source.referenceFxRateScaled != null ||
    source.referenceFxRateDate != null ||
    destination.originalAmountMinor !== Math.abs(source.amountMinor) ||
    destination.originalCurrency !== sourceCurrency ||
    !destination.fxRateScaled ||
    !destination.fxRateSource ||
    !destination.fxRateDate ||
    convertedTransferAmount(
      Math.abs(source.amountMinor),
      destination.fxRateScaled,
      sourceCurrency,
      destinationCurrency,
    ) !== destination.amountMinor ||
    (destination.fxRateSource === "bnr" && (
      destination.referenceFxRateScaled != null || destination.referenceFxRateDate != null
    )) ||
    ((destination.referenceFxRateScaled == null) !== (destination.referenceFxRateDate == null))
  ) {
    throw new Error("Cross-currency transfer legs do not reconcile.");
  }
}

export type CashFlowSummary = {
  incomeMinor: number;
  grossSpendingMinor: number;
  refundsMinor: number;
  spendingMinor: number;
  netCashFlowMinor: number;
  savingsRateBasisPoints: number | null;
};

/** Actual-only cash-flow totals. Transfers, adjustments, pending and void rows are excluded. */
export function summarizeActualCashFlow(transactions: readonly LedgerTransaction[]): CashFlowSummary {
  let incomeMinor = 0;
  let grossSpendingMinor = 0;
  let refundsMinor = 0;
  for (const transaction of transactions) {
    if (!affectsBalance(transaction, {}) || transaction.kind === "transfer" || transaction.kind === "adjustment") continue;
    validateTransactionSign(transaction.kind, transaction.amountMinor);
    if (transaction.kind === "income") incomeMinor = addMinor(incomeMinor, transaction.amountMinor);
    if (transaction.kind === "expense") grossSpendingMinor = addMinor(grossSpendingMinor, -transaction.amountMinor);
    if (transaction.kind === "refund") refundsMinor = addMinor(refundsMinor, transaction.amountMinor);
  }
  const spendingMinor = Math.max(0, addMinor(grossSpendingMinor, -refundsMinor));
  const netCashFlowMinor = addMinor(incomeMinor, -spendingMinor);
  const savingsRateBasisPoints =
    incomeMinor > 0 ? Math.round((netCashFlowMinor * 10_000) / incomeMinor) : null;
  return { incomeMinor, grossSpendingMinor, refundsMinor, spendingMinor, netCashFlowMinor, savingsRateBasisPoints };
}
