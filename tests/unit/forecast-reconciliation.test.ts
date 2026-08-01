import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

type DatabaseModule = typeof import("@/db");
type CoreModule = typeof import("@/server/core");
type InsightsModule = typeof import("@/server/insights");
type FormatModule = typeof import("@/lib/format");

function shiftMonth(month: string, amount: number) {
  const [year, value] = month.split("-").map(Number);
  const date = new Date(Date.UTC(year, value - 1 + amount, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

describe("production monthly cash forecast reconciliation", () => {
  let db: DatabaseModule;
  let core: CoreModule;
  let insights: InsightsModule;
  let format: FormatModule;
  const originalDatabaseUrl = process.env.DATABASE_URL;

  beforeAll(async () => {
    process.env.DATABASE_URL = ":memory:";
    vi.resetModules();
    delete (globalThis as typeof globalThis & { __ledgerLabConnection?: unknown }).__ledgerLabConnection;
    db = await import("@/db");
    core = await import("@/server/core");
    insights = await import("@/server/insights");
    format = await import("@/lib/format");
    db.ensureDatabase();
    db.sqlite.prepare(
      `INSERT INTO users (id, email, normalized_email, password_hash, display_name, default_currency)
       VALUES
         ('past-user', 'past@example.test', 'past@example.test', 'unused', 'Past', 'RON'),
         ('future-user', 'future@example.test', 'future@example.test', 'unused', 'Future', 'RON')`,
    ).run();
  });

  afterAll(() => {
    db.sqlite.close();
    delete (globalThis as typeof globalThis & { __ledgerLabConnection?: unknown }).__ledgerLabConnection;
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  });

  it("adds cleared historical cash activity and excludes still-unpaid old obligations", () => {
    const pastMonth = shiftMonth(format.monthKey(), -1);
    db.sqlite.prepare(
      `INSERT INTO accounts (id, user_id, name, type, currency, opening_balance_minor, opening_balance_date)
       VALUES ('past-cash', 'past-user', 'Past cash', 'current', 'RON', 100000, ?)`,
    ).run(`${pastMonth}-01`);
    core.createTransaction("past-user", {
      kind: "expense", accountId: "past-cash", amountMinor: 20_000, date: `${pastMonth}-10`,
    });
    core.createTransaction("past-user", {
      kind: "income", accountId: "past-cash", amountMinor: 5_000, date: `${pastMonth}-11`,
    });
    core.createPlannedPayment("past-user", {
      name: "Unpaid old plan", expectedAmountMinor: 30_000, dueDate: `${pastMonth}-20`,
      type: "expense", accountId: "past-cash",
    });

    const workspace = insights.planningWorkspace("past-user", pastMonth);
    expect(workspace).toMatchObject({
      expectedOpeningMinor: 100_000,
      actualCashActivityMinor: -15_000,
      forecastClosingMinor: 85_000,
      lowestCashPointMinor: 80_000,
      outstandingCashOutflowMinor: 0,
      actual: { netCashFlowMinor: -15_000 },
    });
    expect(workspace.accounts).toEqual([
      expect.objectContaining({ id: "past-cash", expectedOpeningMinor: 100_000, forecastClosingMinor: 85_000 }),
    ]);
  });

  it("counts non-liquid planned income once on its account and never as cash", () => {
    const futureMonth = shiftMonth(format.monthKey(), 1);
    const openingDate = `${format.monthKey()}-01`;
    db.sqlite.prepare(
      `INSERT INTO accounts (id, user_id, name, type, currency, opening_balance_minor, opening_balance_date)
       VALUES
         ('future-cash', 'future-user', 'Future cash', 'current', 'RON', 100000, ?),
         ('future-investment', 'future-user', 'Future investment', 'investment', 'RON', 50000, ?)`,
    ).run(openingDate, openingDate);
    core.createPlannedPayment("future-user", {
      name: "Salary", expectedAmountMinor: 40_000, dueDate: `${futureMonth}-10`,
      type: "income", accountId: "future-cash",
    });
    core.createPlannedPayment("future-user", {
      name: "Investment distribution", expectedAmountMinor: 10_000, dueDate: `${futureMonth}-12`,
      type: "income", accountId: "future-investment",
    });
    core.createPlannedPayment("future-user", {
      name: "Rent", expectedAmountMinor: 30_000, dueDate: `${futureMonth}-15`,
      type: "expense", accountId: "future-cash",
    });

    const workspace = insights.planningWorkspace("future-user", futureMonth);
    expect(workspace).toMatchObject({
      expectedOpeningMinor: 100_000,
      outstandingIncomeMinor: 50_000,
      outstandingCashInflowMinor: 40_000,
      outstandingCashOutflowMinor: 30_000,
      forecastClosingMinor: 110_000,
    });
    expect(workspace.accounts).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "future-cash", forecastClosingMinor: 110_000 }),
      expect.objectContaining({ id: "future-investment", forecastClosingMinor: 60_000 }),
    ]));
  });
});
