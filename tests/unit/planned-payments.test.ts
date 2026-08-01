import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { createMemoryDatabase, type LedgerDatabase } from "@/db";
import {
  accounts,
  plannedPaymentOccurrences,
  plannedPaymentTransactions,
  plannedPayments,
  transactions,
  users,
} from "@/db/schema";
import { payPlannedOccurrence, undoPlannedPayment } from "@/lib/domain/planned-payments";

describe("paying a planned occurrence", () => {
  let close: (() => void) | undefined;
  let database: LedgerDatabase;

  afterEach(() => close?.());

  function setup(): void {
    const memory = createMemoryDatabase();
    database = memory.db;
    close = () => memory.sqlite.close();
    const now = "2026-08-01T00:00:00.000Z";
    database.insert(users).values({
      id: "user",
      email: "unit@example.test",
      normalizedEmail: "unit@example.test",
      passwordHash: "not-used",
      displayName: "Unit",
      createdAt: now,
      updatedAt: now,
    }).run();
    database.insert(accounts).values({
      id: "account",
      userId: "user",
      name: "Current",
      type: "current",
      openingBalanceMinor: 100_000,
      openingBalanceDate: "2026-08-01",
      createdAt: now,
      updatedAt: now,
    }).run();
    database.insert(plannedPayments).values({
      id: "payment",
      userId: "user",
      title: "Electricity",
      direction: "expense",
      expectedAmountMinor: 10_000,
      dueDate: "2026-08-10",
      accountId: "account",
      createdAt: now,
      updatedAt: now,
    }).run();
    database.insert(plannedPaymentOccurrences).values({
      id: "occurrence",
      plannedPaymentId: "payment",
      dueDate: "2026-08-10",
      expectedAmountMinor: 10_000,
      status: "planned",
      createdAt: now,
      updatedAt: now,
    }).run();
  }

  it("creates linked actual rows, supports partial payment, completion and undo", () => {
    setup();
    const partial = payPlannedOccurrence(database, "user", "occurrence", {
      actualAmountMinor: 4_000,
      paymentDate: "2026-08-09",
      accountId: "account",
      transactionId: "tx-partial",
      now: new Date("2026-08-09T10:00:00Z"),
    });
    expect(partial.isPartial).toBe(true);
    expect(partial.transaction.amountMinor).toBe(-4_000);
    expect(database.select().from(plannedPaymentOccurrences).get()).toMatchObject({
      paidAmountMinor: 4_000,
      status: "scheduled",
    });

    const completed = payPlannedOccurrence(database, "user", "occurrence", {
      actualAmountMinor: 6_000,
      paymentDate: "2026-08-10",
      accountId: "account",
      transactionId: "tx-final",
      now: new Date("2026-08-10T10:00:00Z"),
    });
    expect(completed.isPartial).toBe(false);
    expect(database.select().from(plannedPaymentOccurrences).get()).toMatchObject({
      paidAmountMinor: 10_000,
      status: "paid",
      paidAt: "2026-08-10",
    });
    expect(database.select().from(transactions).all()).toHaveLength(2);
    expect(database.select().from(plannedPaymentTransactions).all()).toHaveLength(2);

    const undone = undoPlannedPayment(
      database,
      "user",
      "occurrence",
      "tx-final",
      new Date("2026-08-11T10:00:00Z"),
    );
    expect(undone).toMatchObject({ paidAmountMinor: 4_000, status: "scheduled", paidAt: null });
    expect(database.select().from(transactions).where(eq(transactions.id, "tx-final")).get()).toMatchObject({
      status: "void",
    });
    expect(database.select().from(plannedPaymentTransactions).all()).toHaveLength(1);
  });

  it("requires the selected account to belong to the user", () => {
    setup();
    expect(() =>
      payPlannedOccurrence(database, "other-user", "occurrence", {
        actualAmountMinor: 10_000,
        paymentDate: "2026-08-10",
        accountId: "account",
      }),
    ).toThrow(/not found/);
  });
});

