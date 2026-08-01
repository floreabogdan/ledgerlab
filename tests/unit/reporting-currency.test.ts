import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

type DatabaseModule = typeof import("@/db");
type FxModule = typeof import("@/server/fx");
type InsightsModule = typeof import("@/server/insights");
type ReportingModule = typeof import("@/server/reporting-currency");

describe("reporting-currency conversion", () => {
  let db: DatabaseModule;
  let fx: FxModule;
  let insights: InsightsModule;
  let reporting: ReportingModule;
  const originalDatabaseUrl = process.env.DATABASE_URL;

  beforeAll(async () => {
    process.env.DATABASE_URL = ":memory:";
    vi.resetModules();
    delete (globalThis as typeof globalThis & { __ledgerLabConnection?: unknown }).__ledgerLabConnection;
    db = await import("@/db");
    fx = await import("@/server/fx");
    reporting = await import("@/server/reporting-currency");
    insights = await import("@/server/insights");
    db.ensureDatabase();

    db.sqlite.prepare(
      `INSERT INTO users
        (id, email, normalized_email, password_hash, display_name, default_currency, time_zone)
       VALUES ('report-owner', 'report@example.test', 'report@example.test', 'unused', 'Report Owner', 'RON', 'Europe/Bucharest')`,
    ).run();
    db.sqlite.prepare(
      `INSERT INTO accounts
        (id, user_id, name, type, currency, opening_balance_minor, opening_balance_date)
       VALUES
        ('usd-cash', 'report-owner', 'USD cash', 'current', 'USD', 10000, '2026-01-01'),
        ('ron-cash', 'report-owner', 'RON cash', 'cash', 'RON', 10000, '2026-01-01')`,
    ).run();
    db.sqlite.prepare(
      `INSERT INTO categories (id, user_id, name, kind)
       VALUES ('report-category', 'report-owner', 'Reporting category', 'expense')`,
    ).run();
    db.sqlite.prepare(
      `INSERT INTO transactions
        (id, user_id, account_id, kind, status, amount_minor, currency, occurred_at, transfer_group_id)
       VALUES
        ('usd-income', 'report-owner', 'usd-cash', 'income', 'cleared', 2000, 'USD', '2026-01-02', NULL),
        ('usd-expense', 'report-owner', 'usd-cash', 'expense', 'cleared', -1000, 'USD', '2026-01-16', NULL),
        ('ron-expense', 'report-owner', 'ron-cash', 'expense', 'cleared', -1000, 'RON', '2026-01-16', NULL),
        ('transfer-source', 'report-owner', 'usd-cash', 'transfer', 'cleared', -1000, 'USD', '2026-01-16', 'transfer-group'),
        ('transfer-destination', 'report-owner', 'ron-cash', 'transfer', 'cleared', 4600, 'RON', '2026-01-16', 'transfer-group')`,
    ).run();
    db.sqlite.prepare(
      `INSERT INTO planned_payments
        (id, user_id, title, direction, expected_amount_minor, currency, due_date, account_id)
       VALUES ('usd-plan', 'report-owner', 'USD plan', 'expense', 500, 'USD', '2026-01-20', 'usd-cash')`,
    ).run();
    db.sqlite.prepare(
      `INSERT INTO planned_payment_occurrences
        (id, planned_payment_id, due_date, expected_amount_minor, status)
       VALUES ('usd-plan-occurrence', 'usd-plan', '2026-01-20', 500, 'planned')`,
    ).run();
    fx.persistBnrXml(
      `<?xml version="1.0" encoding="utf-8"?>
       <DataSet>
         <PublishingDate>2026-01-16</PublishingDate>
         <Cube date="2026-01-01"><Rate currency="USD">4.5000</Rate></Cube>
         <Cube date="2026-01-15"><Rate currency="USD">4.6000</Rate></Cube>
       </DataSet>`,
      "https://www.bnr.ro/reporting-test.xml",
      "2026-01-16T12:00:00.000Z",
    );
  });

  afterAll(() => {
    db.sqlite.close();
    delete (globalThis as typeof globalThis & { __ledgerLabConnection?: unknown }).__ledgerLabConnection;
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  });

  it("uses transaction-date rates, excludes transfers, and converts planned rows by due date", () => {
    const result = insights.statistics("report-owner", 1, { from: "2026-01-01", to: "2026-01-31" });

    expect(result.currency).toBe("RON");
    expect(result.summary).toMatchObject({
      incomeMinor: 9_000,
      spendingMinor: 5_600,
      netCashFlowMinor: 3_400,
    });
    expect(result.plannedVsActual).toEqual({
      plannedMinor: 2_300,
      actualMinor: 5_600,
      varianceMinor: -3_300,
    });
    expect(result.byAccount).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "usd-cash", amountMinor: 4_600 }),
      expect.objectContaining({ id: "ron-cash", amountMinor: 1_000 }),
    ]));
  });

  it("values account totals at the as-of rate while keeping native balances intact", () => {
    const payload = insights.accountsPayload("report-owner");
    const usd = payload.accounts.find((account) => account.id === "usd-cash");

    expect(usd).toMatchObject({
      balanceMinor: 10_000,
      currentBalanceMinor: 10_000,
      reportingBalanceMinor: 46_000,
      currency: "USD",
      reportingCurrency: "RON",
      reportingConversion: {
        fromCurrency: "USD",
        reportingCurrency: "RON",
        rateDate: "2026-01-15",
        isFallback: true,
      },
    });
  });

  it("re-expresses reports after a profile-currency change without rewriting ledger rows", () => {
    db.sqlite.prepare("UPDATE users SET default_currency = 'USD' WHERE id = 'report-owner'").run();
    const result = insights.statistics("report-owner", 1, { from: "2026-01-01", to: "2026-01-31" });

    expect(result.currency).toBe("USD");
    expect(result.summary.incomeMinor).toBe(2_000);
    expect(result.summary.spendingMinor).toBe(1_217);
    expect(db.sqlite.prepare("SELECT amount_minor FROM transactions WHERE id = 'ron-expense'").pluck().get()).toBe(-1_000);

    db.sqlite.prepare("UPDATE users SET default_currency = 'RON' WHERE id = 'report-owner'").run();
  });

  it("never raw-sums currencies when a persisted quote is unavailable", () => {
    expect(() => reporting.toReportingMinor(
      { amountMinor: 1_000, currency: "EUR", date: "2024-01-01" },
      "RON",
      "a test aggregate",
    )).toThrowError(expect.objectContaining({
      status: 422,
      details: expect.objectContaining({ code: "REPORTING_FX_RATE_UNAVAILABLE" }),
    }));
  });

  it("hydrates the annual pairs needed before synchronous report construction", async () => {
    const result = await reporting.hydrateReportingRates("report-owner", {
      from: "2026-01-01",
      to: "2026-01-15",
      asOfDate: "2026-01-15",
    });

    expect(result).toMatchObject({ reportingCurrency: "RON", requestedPairs: 1 });
    expect(result.hydratedPairs).toEqual([
      expect.objectContaining({
        fromCurrency: "USD",
        toCurrency: "RON",
        requestedDate: "2026-01-15",
        rateDate: "2026-01-15",
        cacheStatus: "cached",
      }),
    ]);
  });

  it("preserves budget and plan denominations when the profile currency changes", () => {
    insights.saveBudget("report-owner", {
      month: "2026-01",
      categoryId: "report-category",
      amountMinor: 10_000,
    });
    insights.savePlan("report-owner", {
      month: "2026-01",
      expectedIncomeMinor: 45_000,
    });
    db.sqlite.prepare("UPDATE users SET default_currency = 'USD' WHERE id = 'report-owner'").run();

    expect(insights.listBudgets("report-owner", "2026-01").budgets[0]).toMatchObject({
      amountMinor: 2_222,
      currency: "USD",
      nativeAmountMinor: 10_000,
      nativeCurrency: "RON",
    });
    expect(insights.planningWorkspace("report-owner", "2026-01").plan).toMatchObject({
      expectedIncomeMinor: 10_000,
      currency: "USD",
      nativeExpectedIncomeMinor: 45_000,
      nativeCurrency: "RON",
    });

    insights.saveBudget("report-owner", {
      month: "2026-01",
      categoryId: "report-category",
      amountMinor: 3_000,
    });
    insights.savePlan("report-owner", {
      month: "2026-01",
      expectedIncomeMinor: 11_000,
    });
    expect(db.sqlite.prepare(
      "SELECT amount_minor AS amountMinor, currency FROM budgets WHERE user_id = 'report-owner' AND month = '2026-01'",
    ).get()).toEqual({ amountMinor: 13_500, currency: "RON" });
    expect(db.sqlite.prepare(
      "SELECT expected_income_minor AS amountMinor, currency FROM month_plans WHERE user_id = 'report-owner' AND month = '2026-01'",
    ).get()).toEqual({ amountMinor: 49_500, currency: "RON" });

    db.sqlite.prepare("UPDATE users SET default_currency = 'RON' WHERE id = 'report-owner'").run();
  });

  it("converts cross-currency plan impacts into each account's native ledger", () => {
    db.sqlite.prepare(
      `INSERT INTO planned_payments
        (id, user_id, title, direction, expected_amount_minor, currency, due_date, account_id)
       VALUES ('ron-plan-to-usd', 'report-owner', 'RON bill from USD', 'expense', 4600, 'RON', '2026-09-10', 'usd-cash')`,
    ).run();
    db.sqlite.prepare(
      `INSERT INTO planned_payment_occurrences
        (id, planned_payment_id, due_date, expected_amount_minor, status)
       VALUES ('ron-plan-to-usd-occurrence', 'ron-plan-to-usd', '2026-09-10', 4600, 'planned')`,
    ).run();

    const workspace = insights.planningWorkspace("report-owner", "2026-09");
    expect(workspace.accounts.find((account) => account.id === "usd-cash")).toMatchObject({
      currency: "USD",
      expectedOpeningMinor: 10_000,
      forecastClosingMinor: 9_000,
      reportingExpectedOpeningMinor: 46_000,
      reportingForecastClosingMinor: 41_400,
      reportingCurrency: "RON",
    });
  });

  it("can copy a stored budget denomination without reinterpreting its minor units", () => {
    db.sqlite.prepare("UPDATE users SET default_currency = 'USD' WHERE id = 'report-owner'").run();

    insights.saveBudget("report-owner", {
      month: "2026-02",
      categoryId: "report-category",
      amountMinor: 10_000,
      amountCurrency: "RON",
    });

    expect(db.sqlite.prepare(
      "SELECT amount_minor AS amountMinor, currency FROM budgets WHERE user_id = 'report-owner' AND month = '2026-02'",
    ).get()).toEqual({ amountMinor: 10_000, currency: "RON" });
    expect(insights.listBudgets("report-owner", "2026-02").budgets[0]).toMatchObject({
      amountMinor: 2_174,
      currency: "USD",
      nativeAmountMinor: 10_000,
      nativeCurrency: "RON",
    });

    db.sqlite.prepare("UPDATE users SET default_currency = 'RON' WHERE id = 'report-owner'").run();
  });

  it("hydrates every intermediate annual feed needed by a multi-year account-history range", async () => {
    db.sqlite.prepare(
      `INSERT INTO accounts
        (id, user_id, name, type, currency, opening_balance_minor, opening_balance_date)
       VALUES ('dormant-usd-history', 'report-owner', 'Dormant USD history', 'savings', 'USD', 1000, '2021-01-01')`,
    ).run();
    const requestedYears: number[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const match = String(input).match(/nbrfxrates(\d{4})\.xml$/);
      const year = Number(match?.[1]);
      requestedYears.push(year);
      return new Response(
        `<?xml version="1.0" encoding="utf-8"?>
         <DataSet>
           <PublishingDate>${year}-12-31</PublishingDate>
           <Cube date="${year}-01-02"><Rate currency="USD">4.5000</Rate></Cube>
         </DataSet>`,
        { status: 200, headers: { "content-type": "application/xml" } },
      );
    }));

    try {
      const result = await reporting.hydrateReportingRates("report-owner", {
        from: "2022-01-01",
        to: "2026-01-15",
        asOfDate: "2026-01-15",
      });

      expect(requestedYears).toEqual([2022, 2023, 2024, 2025]);
      expect(result).toMatchObject({ reportingCurrency: "RON", requestedPairs: 5 });
      expect(result.hydratedPairs.map((pair) => pair.requestedDate)).toEqual([
        "2026-01-15",
        "2022-12-31",
        "2023-12-31",
        "2024-12-31",
        "2025-12-31",
      ]);
      expect(reporting.toReportingMinor(
        { amountMinor: 1_000, currency: "USD", date: "2024-06-01" },
        "RON",
      )).toBe(4_500);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
