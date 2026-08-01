import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

type DatabaseModule = typeof import("@/db");
type InsightsModule = typeof import("@/server/insights");

describe("selected-range statistics and planning baselines", () => {
  let databaseModule: DatabaseModule;
  let insights: InsightsModule;
  const originalDatabaseUrl = process.env.DATABASE_URL;

  beforeAll(async () => {
    process.env.DATABASE_URL = ":memory:";
    vi.resetModules();
    delete (globalThis as typeof globalThis & { __ledgerLabConnection?: unknown })
      .__ledgerLabConnection;

    databaseModule = await import("@/db");
    insights = await import("@/server/insights");
    databaseModule.ensureDatabase();
    const sql = databaseModule.sqlite;

    sql.prepare(
      `INSERT INTO users (id, email, normalized_email, password_hash, display_name)
       VALUES ('range-user', 'range@example.test', 'range@example.test', 'unused', 'Range Test')`,
    ).run();
    sql.prepare(
      `INSERT INTO accounts
         (id, user_id, name, type, opening_balance_minor, opening_balance_date, archived_at)
       VALUES
         ('archived', 'range-user', 'Archived history', 'current', 100000, '2026-01-01', '2026-03-15T10:00:00.000Z'),
         ('active', 'range-user', 'Active current', 'current', 50000, '2026-01-01', NULL)`,
    ).run();
    sql.prepare(
      `INSERT INTO transactions
         (id, user_id, account_id, kind, status, amount_minor, occurred_at)
       VALUES
         ('income', 'range-user', 'archived', 'income', 'cleared', 50000, '2026-01-05'),
         ('expense', 'range-user', 'archived', 'expense', 'cleared', -10000, '2026-01-10'),
         ('adjustment', 'range-user', 'archived', 'adjustment', 'cleared', 90000, '2026-01-12'),
         ('before-opening', 'range-user', 'active', 'income', 'cleared', 100000, '2025-12-31'),
         ('active-expense', 'range-user', 'active', 'expense', 'cleared', -5000, '2026-01-20'),
         ('refund', 'range-user', 'archived', 'refund', 'cleared', 10000, '2026-02-10')`,
    ).run();
    sql.prepare(
      `INSERT INTO planned_payments
         (id, user_id, title, direction, expected_amount_minor, due_date, account_id)
       VALUES
         ('jan-plan', 'range-user', 'January plan', 'expense', 15000, '2026-01-10', 'active'),
         ('future-plan', 'range-user', 'Future plan', 'expense', 10000, '2099-08-10', 'active')`,
    ).run();
    sql.prepare(
      `INSERT INTO planned_payment_occurrences
         (id, planned_payment_id, due_date, expected_amount_minor, status)
       VALUES
         ('jan-occurrence', 'jan-plan', '2026-01-10', 15000, 'planned'),
         ('future-occurrence', 'future-plan', '2099-08-10', 10000, 'planned')`,
    ).run();
  });

  afterAll(() => {
    databaseModule.sqlite.close();
    delete (globalThis as typeof globalThis & { __ledgerLabConnection?: unknown })
      .__ledgerLabConnection;
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  });

  it("nets refunds across the exact range and excludes adjustments from cash flow", () => {
    const result = insights.statistics("range-user", 12, {
      from: "2026-01-01",
      to: "2026-02-28",
    });

    expect(result.summary).toMatchObject({
      incomeMinor: 50_000,
      spendingMinor: 5_000,
      netCashFlowMinor: 45_000,
    });
    expect(result.monthly).toEqual(expect.arrayContaining([
      expect.objectContaining({ month: "2026-01", spendingMinor: 15_000, partial: false }),
      expect.objectContaining({ month: "2026-02", spendingMinor: 0, partial: false }),
    ]));
    expect(result.summary.forecastSampleMonths).toBe(1);
    expect(result.summary.forecastAccuracy).toBe(100);
  });

  it("preserves an archived account in snapshots from before it was archived", () => {
    const result = insights.statistics("range-user", 12, {
      from: "2026-01-01",
      to: "2026-02-28",
    });

    expect(result.netWorthHistory).toEqual([
      expect.objectContaining({ date: "2026-01-31", netWorthMinor: 275_000 }),
      expect.objectContaining({ date: "2026-02-28", netWorthMinor: 285_000 }),
    ]);
  });

  it("does not grade plans whose selected month has not happened", () => {
    const result = insights.statistics("range-user", 12, {
      from: "2099-08-01",
      to: "2099-08-31",
    });

    expect(result.summary.forecastSampleMonths).toBe(0);
    expect(result.summary.forecastAccuracy).toBeNull();
    expect(result.summary.projectionApplicable).toBe(false);
    expect(result.summary.averageDailySpendingMinor).toBeNull();
    expect(result.summary.cashRunwayDays).toBeNull();
  });

  it("uses the month-opening actual balance and then honors saved opening scenarios", () => {
    const reconciled = insights.accountsPayload("range-user", {
      from: "2026-01-01",
      to: "2026-01-31",
    });
    expect(reconciled.accounts.find((account) => account.id === "active")).toMatchObject({
      currentBalanceMinor: 45_000,
    });

    const initial = insights.planningWorkspace("range-user", "2026-02");
    expect(initial.expectedOpeningMinor).toBe(45_000);
    expect(initial.accounts).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "active", expectedOpeningMinor: 45_000 }),
    ]));

    const saved = insights.savePlan("range-user", {
      month: "2026-02",
      openingBalances: [{ accountId: "active", amountMinor: 70_000 }],
    });
    expect(saved.expectedOpeningMinor).toBe(70_000);
    expect(saved.forecast).toMatchObject({ closingBalanceMinor: 70_000 });
    expect(saved.accounts).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "active", expectedOpeningMinor: 70_000 }),
    ]));
  });
});
