import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";

import { db, ensureDatabase, sqlite } from "../src/db";
import {
  accounts,
  categories,
  merchants,
  plannedPaymentOccurrences,
  plannedPayments,
  recurrenceRules,
  tags,
  transactions,
  users,
} from "../src/db/schema";
import { createUser } from "../src/lib/auth";

const DEMO_EMAIL = "demo@ledgerlab.local";
const DEMO_PASSWORD = process.env.DEMO_PASSWORD?.trim();

function isoDate(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

async function seed(): Promise<void> {
  if (!DEMO_PASSWORD || DEMO_PASSWORD.length < 10) {
    throw new Error("Set DEMO_PASSWORD to an explicit password of at least 10 characters before running db:seed.");
  }
  ensureDatabase();
  const existing = db.select({ id: users.id }).from(users).where(eq(users.normalizedEmail, DEMO_EMAIL)).get();
  if (existing) {
    console.log(`Demo data already exists for ${DEMO_EMAIL}; nothing changed.`);
    return;
  }

  const safeUser = await createUser(
    {
      email: DEMO_EMAIL,
      password: DEMO_PASSWORD,
      displayName: "LedgerLab Demo",
      currency: "USD",
      locale: "en-US",
      timeZone: "UTC",
    },
    db,
  );
  db.update(users).set({ demoDataEnabled: true }).where(eq(users.id, safeUser.id)).run();

  const now = new Date();
  const localDateParts = new Intl.DateTimeFormat("en-CA", {
    timeZone: safeUser.timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const year = Number(localDateParts.find((part) => part.type === "year")?.value);
  const month = Number(localDateParts.find((part) => part.type === "month")?.value);
  const start = isoDate(year, month, 1);
  const createdAt = now.toISOString();

  const currentId = randomUUID();
  const savingsId = randomUUID();
  const foodId = randomUUID();
  const salaryId = randomUUID();
  const housingId = randomUUID();
  const merchantId = randomUUID();
  db.insert(accounts)
    .values([
      {
        id: currentId,
        userId: safeUser.id,
        name: "Demo checking",
        type: "current",
        currency: safeUser.defaultCurrency,
        openingBalanceMinor: 425_000,
        openingBalanceDate: start,
        createdAt,
        updatedAt: createdAt,
      },
      {
        id: savingsId,
        userId: safeUser.id,
        name: "Demo savings",
        type: "savings",
        currency: safeUser.defaultCurrency,
        openingBalanceMinor: 1_250_000,
        openingBalanceDate: start,
        createdAt,
        updatedAt: createdAt,
      },
    ])
    .run();
  db.insert(categories)
    .values([
      { id: foodId, userId: safeUser.id, name: "Groceries", kind: "expense", spendingNature: "variable", spendingPriority: "essential", createdAt, updatedAt: createdAt },
      { id: salaryId, userId: safeUser.id, name: "Salary", kind: "income", createdAt, updatedAt: createdAt },
      { id: housingId, userId: safeUser.id, name: "Housing", kind: "expense", spendingNature: "fixed", spendingPriority: "essential", createdAt, updatedAt: createdAt },
    ])
    .run();
  db.insert(merchants)
    .values({ id: merchantId, userId: safeUser.id, name: "Demo Market", normalizedName: "demo market", defaultCategoryId: foodId, createdAt, updatedAt: createdAt })
    .run();
  db.insert(tags)
    .values({ id: randomUUID(), userId: safeUser.id, name: "demo", color: "#64748b", createdAt, updatedAt: createdAt })
    .run();

  db.insert(transactions)
    .values([
      {
        id: randomUUID(),
        userId: safeUser.id,
        accountId: currentId,
        categoryId: salaryId,
        kind: "income",
        status: "cleared",
        amountMinor: 720_000,
        currency: safeUser.defaultCurrency,
        occurredAt: isoDate(year, month, 5),
        merchantText: "Demo employer",
        createdAt,
        updatedAt: createdAt,
      },
      {
        id: randomUUID(),
        userId: safeUser.id,
        accountId: currentId,
        categoryId: foodId,
        merchantId,
        kind: "expense",
        status: "cleared",
        amountMinor: -18_450,
        currency: safeUser.defaultCurrency,
        occurredAt: isoDate(year, month, 8),
        createdAt,
        updatedAt: createdAt,
      },
    ])
    .run();

  const rentRuleId = randomUUID();
  const rentPaymentId = randomUUID();
  db.insert(recurrenceRules)
    .values({
      id: rentRuleId,
      userId: safeUser.id,
      frequency: "monthly",
      interval: 1,
      startDate: isoDate(year, month, 15),
      dayOfMonth: 15,
      adjustment: "clamp",
    })
    .run();
  db.insert(plannedPayments)
    .values({
      id: rentPaymentId,
      userId: safeUser.id,
      title: "Demo rent",
      direction: "expense",
      expectedAmountMinor: 220_000,
      currency: safeUser.defaultCurrency,
      dueDate: isoDate(year, month, 15),
      accountId: currentId,
      categoryId: housingId,
      recurrenceRuleId: rentRuleId,
      spendingNature: "fixed",
      spendingPriority: "essential",
      createdAt,
      updatedAt: createdAt,
    })
    .run();
  db.insert(plannedPaymentOccurrences)
    .values({
      id: randomUUID(),
      plannedPaymentId: rentPaymentId,
      dueDate: isoDate(year, month, 15),
      expectedAmountMinor: 220_000,
      status: "planned",
      generatedFromRule: true,
      createdAt,
      updatedAt: createdAt,
    })
    .run();

  console.log(`Optional demo workspace created for ${DEMO_EMAIL}.`);
  console.log("This user is isolated from real workspaces; db:migrate alone creates no demo data.");
}

seed()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => sqlite.close());
