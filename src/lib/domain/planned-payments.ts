import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";

import type { LedgerDatabase } from "@/db";
import {
  accounts,
  auditLogs,
  plannedPaymentOccurrences,
  plannedPaymentTransactions,
  plannedPayments,
  transactions,
  type PlannedPayment,
  type PlannedPaymentOccurrence,
  type PlannedStatus,
} from "@/db/schema";

import { datePart } from "./dates";
import { assertMinorUnits } from "./money";

export type PayOccurrenceInput = {
  actualAmountMinor: number;
  paymentDate: string;
  accountId: string;
  notes?: string | null;
  transactionId?: string;
  now?: Date;
};

export type PlannedPaymentResult = {
  occurrenceUpdate: {
    paidAmountMinor: number;
    status: PlannedStatus;
    statusBeforePayment: PlannedStatus;
    paidAt: string | null;
    updatedAt: string;
  };
  transaction: typeof transactions.$inferInsert;
  link: typeof plannedPaymentTransactions.$inferInsert;
  isPartial: boolean;
};

/** Pure state transition used by the DB service and unit tests. */
function markPlannedPaymentPaid(
  payment: PlannedPayment,
  occurrence: PlannedPaymentOccurrence,
  input: PayOccurrenceInput,
): PlannedPaymentResult {
  if (["skipped", "cancelled"].includes(occurrence.status)) {
    throw new Error(`Cannot pay a ${occurrence.status} occurrence. Undo that status first.`);
  }
  assertMinorUnits(input.actualAmountMinor, "actualAmountMinor");
  if (input.actualAmountMinor <= 0) throw new RangeError("Actual payment amount must be positive.");
  if (!input.accountId) throw new RangeError("An account is required.");
  datePart(input.paymentDate);

  const now = input.now ?? new Date();
  const timestamp = now.toISOString();
  const paidAmountMinor = occurrence.paidAmountMinor + input.actualAmountMinor;
  assertMinorUnits(paidAmountMinor, "paidAmountMinor");
  const isPartial = paidAmountMinor < occurrence.expectedAmountMinor;
  const status: PlannedStatus = isPartial
    ? occurrence.status === "planned"
      ? "scheduled"
      : occurrence.status
    : "paid";
  const transactionId = input.transactionId ?? randomUUID();
  const signedAmount = payment.direction === "expense" ? -input.actualAmountMinor : input.actualAmountMinor;

  return {
    occurrenceUpdate: {
      paidAmountMinor,
      status,
      statusBeforePayment: occurrence.statusBeforePayment ?? occurrence.status,
      paidAt: status === "paid" ? input.paymentDate : null,
      updatedAt: timestamp,
    },
    transaction: {
      id: transactionId,
      userId: payment.userId,
      accountId: input.accountId,
      categoryId: payment.categoryId,
      merchantId: payment.merchantId,
      kind: payment.direction,
      status: "cleared",
      amountMinor: signedAmount,
      currency: payment.currency,
      occurredAt: input.paymentDate,
      merchantText: payment.title,
      notes: input.notes ?? payment.notes,
      plannedOccurrenceId: occurrence.id,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    link: {
      occurrenceId: occurrence.id,
      transactionId,
      appliedAmountMinor: input.actualAmountMinor,
      createdAt: timestamp,
    },
    isPartial,
  };
}

/** Atomically validates ownership, inserts the actual transaction and links it to the occurrence. */
export function payPlannedOccurrence(
  database: LedgerDatabase,
  userId: string,
  occurrenceId: string,
  input: PayOccurrenceInput,
): PlannedPaymentResult {
  return database.transaction((tx) => {
    const row = tx
      .select({ payment: plannedPayments, occurrence: plannedPaymentOccurrences })
      .from(plannedPaymentOccurrences)
      .innerJoin(plannedPayments, eq(plannedPaymentOccurrences.plannedPaymentId, plannedPayments.id))
      .where(and(eq(plannedPaymentOccurrences.id, occurrenceId), eq(plannedPayments.userId, userId)))
      .get();
    if (!row) throw new Error("Planned payment occurrence not found.");

    const account = tx
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(eq(accounts.id, input.accountId), eq(accounts.userId, userId)))
      .get();
    if (!account) throw new Error("Payment account not found.");

    const result = markPlannedPaymentPaid(row.payment, row.occurrence, input);
    tx.insert(transactions).values(result.transaction).run();
    tx.insert(plannedPaymentTransactions).values(result.link).run();
    tx.update(plannedPaymentOccurrences)
      .set(result.occurrenceUpdate)
      .where(eq(plannedPaymentOccurrences.id, occurrenceId))
      .run();
    tx.insert(auditLogs)
      .values({
        id: randomUUID(),
        userId,
        entityType: "planned_payment_occurrence",
        entityId: occurrenceId,
        action: result.isPartial ? "partially_paid" : "paid",
        before: row.occurrence,
        after: result.occurrenceUpdate,
        metadata: { transactionId: result.transaction.id },
      })
      .run();
    return result;
  });
}

export type UndoPaymentResult = {
  paidAmountMinor: number;
  status: PlannedStatus;
  paidAt: string | null;
  updatedAt: string;
};

export function undoPlannedPayment(
  database: LedgerDatabase,
  userId: string,
  occurrenceId: string,
  transactionId: string,
  now = new Date(),
): UndoPaymentResult {
  return database.transaction((tx) => {
    const row = tx
      .select({ occurrence: plannedPaymentOccurrences, payment: plannedPayments, link: plannedPaymentTransactions })
      .from(plannedPaymentTransactions)
      .innerJoin(plannedPaymentOccurrences, eq(plannedPaymentTransactions.occurrenceId, plannedPaymentOccurrences.id))
      .innerJoin(plannedPayments, eq(plannedPaymentOccurrences.plannedPaymentId, plannedPayments.id))
      .where(
        and(
          eq(plannedPaymentTransactions.occurrenceId, occurrenceId),
          eq(plannedPaymentTransactions.transactionId, transactionId),
          eq(plannedPayments.userId, userId),
        ),
      )
      .get();
    if (!row) throw new Error("Linked payment transaction not found.");

    const remainingPaid = Math.max(0, row.occurrence.paidAmountMinor - row.link.appliedAmountMinor);
    const update: UndoPaymentResult = {
      paidAmountMinor: remainingPaid,
      status:
        remainingPaid === 0
          ? row.occurrence.statusBeforePayment ?? "planned"
          : remainingPaid >= row.occurrence.expectedAmountMinor
            ? "paid"
            : "scheduled",
      paidAt: remainingPaid >= row.occurrence.expectedAmountMinor ? row.occurrence.paidAt : null,
      updatedAt: now.toISOString(),
    };
    tx.update(transactions)
      .set({ status: "void", voidedAt: now.toISOString(), updatedAt: now.toISOString() })
      .where(eq(transactions.id, transactionId))
      .run();
    tx.delete(plannedPaymentTransactions)
      .where(
        and(
          eq(plannedPaymentTransactions.occurrenceId, occurrenceId),
          eq(plannedPaymentTransactions.transactionId, transactionId),
        ),
      )
      .run();
    tx.update(plannedPaymentOccurrences).set(update).where(eq(plannedPaymentOccurrences.id, occurrenceId)).run();
    tx.insert(auditLogs)
      .values({
        id: randomUUID(),
        userId,
        entityType: "planned_payment_occurrence",
        entityId: occurrenceId,
        action: "payment_undone",
        before: row.occurrence,
        after: update,
        metadata: { transactionId },
      })
      .run();
    return update;
  });
}
