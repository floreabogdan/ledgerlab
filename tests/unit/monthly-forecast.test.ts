import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

type DatabaseModule = typeof import("@/db");
type InsightsModule = typeof import("@/server/insights");

describe("monthly forecast canonical inputs", () => {
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
       VALUES
         ('forecast-user', 'forecast@example.test', 'forecast@example.test', 'unused', 'Forecast Test'),
         ('other-user', 'other@example.test', 'other@example.test', 'unused', 'Other Test')`,
    ).run();
    sql.prepare(
      `INSERT INTO accounts
         (id, user_id, name, type, opening_balance_minor, opening_balance_date)
       VALUES
         ('current', 'forecast-user', 'Current', 'current', 100000, '2026-08-01'),
         ('foreign-account', 'other-user', 'Foreign', 'current', 1, '2026-08-01')`,
    ).run();
    sql.prepare(
      `INSERT INTO month_plans
         (id, user_id, month, name, expected_income_minor)
       VALUES ('aug-plan', 'forecast-user', '2026-08', 'Legacy plan', 999999)`,
    ).run();
    sql.prepare(
      `INSERT INTO month_plan_accounts
         (id, month_plan_id, account_id, expected_opening_minor)
       VALUES ('aug-opening', 'aug-plan', 'current', 120000)`,
    ).run();
    sql.prepare(
      `INSERT INTO month_plan_items
         (id, month_plan_id, account_id, title, direction, amount_minor, expected_date, source)
       VALUES ('legacy-line', 'aug-plan', 'current', 'Legacy manual expense', 'expense', 88888, '2026-08-08', 'manual')`,
    ).run();
    sql.prepare(
      `INSERT INTO planned_payments
         (id, user_id, title, direction, expected_amount_minor, due_date, account_id)
       VALUES
         ('rent', 'forecast-user', 'Rent', 'expense', 40000, '2026-08-10', 'current'),
         ('salary', 'forecast-user', 'Salary', 'income', 200000, '2026-08-15', 'current'),
         ('partial', 'forecast-user', 'Part-paid bill', 'expense', 30000, '2026-08-20', 'current'),
         ('settled', 'forecast-user', 'Settled bill', 'expense', 5000, '2026-08-22', 'current'),
         ('september', 'forecast-user', 'September bill', 'expense', 25000, '2026-09-12', 'current')`,
    ).run();
    sql.prepare(
      `INSERT INTO planned_payment_occurrences
         (id, planned_payment_id, due_date, expected_amount_minor, paid_amount_minor, status)
       VALUES
         ('rent-occ', 'rent', '2026-08-10', 40000, 0, 'planned'),
         ('salary-occ', 'salary', '2026-08-15', 200000, 0, 'planned'),
         ('partial-occ', 'partial', '2026-08-20', 30000, 10000, 'scheduled'),
         ('settled-occ', 'settled', '2026-08-22', 5000, 1000, 'paid'),
         ('september-occ', 'september', '2026-09-12', 25000, 0, 'planned')`,
    ).run();
  });

  afterAll(() => {
    databaseModule.sqlite.close();
    delete (globalThis as typeof globalThis & { __ledgerLabConnection?: unknown })
      .__ledgerLabConnection;
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  });

  it("always uses occurrences despite legacy monthly items and projects only unpaid residuals", () => {
    const result = insights.planningWorkspace("forecast-user", "2026-08");

    expect(result.items.map((item) => item.id)).toEqual([
      "rent-occ",
      "salary-occ",
      "partial-occ",
      "settled-occ",
    ]);
    expect(result.items).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "legacy-line" }),
    ]));
    expect(result).toMatchObject({
      expectedOpeningMinor: 120000,
      expectedIncomeMinor: 200000,
      expectedExpensesMinor: 75000,
      outstandingIncomeMinor: 200000,
      outstandingExpensesMinor: 60000,
      forecastClosingMinor: 260000,
      plannedVsActual: { plannedMinor: 75000 },
    });
    expect(result.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "partial-occ", amountMinor: 30000, paidAmountMinor: 10000, outstandingAmountMinor: 20000 }),
      expect.objectContaining({ id: "settled-occ", amountMinor: 5000, outstandingAmountMinor: 0, status: "paid" }),
    ]));
  });

  it("keeps opening assumptions and hypothetical scenarios separate from canonical lines", () => {
    const scenario = insights.savePlan("forecast-user", {
      action: "save-scenario",
      month: "2026-08",
      scenarioName: "Working scenario",
      items: [{
        title: "What-if holiday",
        direction: "expense",
        amountMinor: 12345,
        expectedDate: "2026-08-25",
        accountId: "current",
        spendingNature: "variable",
        spendingPriority: "discretionary",
      }],
    });

    expect(scenario.forecastClosingMinor).toBe(260000);
    expect(scenario.plan.scenarioLines).toEqual([
      expect.objectContaining({ title: "What-if holiday", amountMinor: 12345 }),
    ]);
    expect(scenario.items).toHaveLength(4);
    expect(databaseModule.sqlite.prepare("SELECT COUNT(*) AS count FROM transactions WHERE user_id = 'forecast-user'").get()).toEqual({ count: 0 });
    expect(databaseModule.sqlite.prepare("SELECT COUNT(*) AS count FROM planned_payments WHERE user_id = 'forecast-user'").get()).toEqual({ count: 5 });

    const saved = insights.savePlan("forecast-user", {
      action: "save-assumptions",
      month: "2026-08",
      openingBalances: [{ accountId: "current", amountMinor: 150000 }],
      items: [{
        title: "Ignored legacy replacement",
        direction: "expense",
        amountMinor: 99999,
        expectedDate: "2026-08-28",
      }],
    });

    expect(saved.expectedOpeningMinor).toBe(150000);
    expect(saved.forecastClosingMinor).toBe(290000);
    expect(saved.items).toHaveLength(4);
    expect(databaseModule.sqlite.prepare("SELECT id FROM month_plan_items WHERE month_plan_id = 'aug-plan'").all()).toEqual([
      expect.objectContaining({ id: "legacy-line" }),
    ]);

    expect(() => insights.savePlan("forecast-user", {
      action: "save-assumptions",
      month: "2026-08",
      openingBalances: [{ accountId: "foreign-account", amountMinor: 1 }],
    })).toThrow("belongs to your profile");
    expect(insights.planningWorkspace("forecast-user", "2026-08").expectedOpeningMinor).toBe(150000);
  });

  it("copies assumptions and scenarios without copying obligations or legacy plan items", () => {
    const copied = insights.savePlan("forecast-user", {
      action: "copy-assumptions",
      month: "2026-09",
      copyFromMonth: "2026-08",
    });

    expect(copied.expectedOpeningMinor).toBe(150000);
    expect(copied.items).toEqual([
      expect.objectContaining({ id: "september-occ", amountMinor: 25000 }),
    ]);
    expect(copied.plan.scenarioLines).toEqual([
      expect.objectContaining({ title: "What-if holiday", expectedDate: "2026-09-25" }),
    ]);
    const targetPlan = databaseModule.sqlite
      .prepare("SELECT id FROM month_plans WHERE user_id = 'forecast-user' AND month = '2026-09'")
      .get() as { id: string };
    expect(databaseModule.sqlite.prepare("SELECT id FROM month_plan_items WHERE month_plan_id = ?").all(targetPlan.id)).toEqual([]);
  });
});
