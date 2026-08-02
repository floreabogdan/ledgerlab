import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { UI_LANGUAGE_COOKIE_NAME } from "@/i18n/language";

type DatabaseModule = typeof import("@/db");
type AuthModule = typeof import("@/lib/auth");
type CoreModule = typeof import("@/server/core");
type RouteModule = typeof import("@/app/api/[...path]/route");

function bucharestToday() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Bucharest",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function addDays(dateKey: string, amount: number) {
  const date = new Date(`${dateKey}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

describe("production backend integrity boundaries", () => {
  let db: DatabaseModule;
  let auth: AuthModule;
  let core: CoreModule;
  let route: RouteModule;
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalRegistrationMode = process.env.REGISTRATION_MODE;

  beforeAll(async () => {
    process.env.DATABASE_URL = ":memory:";
    process.env.REGISTRATION_MODE = "open";
    vi.resetModules();
    delete (globalThis as typeof globalThis & { __ledgerLabConnection?: unknown }).__ledgerLabConnection;
    db = await import("@/db");
    auth = await import("@/lib/auth");
    core = await import("@/server/core");
    route = await import("@/app/api/[...path]/route");
    db.ensureDatabase();

    db.sqlite.prepare(
      `INSERT INTO users (id, email, normalized_email, password_hash, display_name, default_currency, locale, time_zone)
       VALUES
         ('owner', 'owner@example.test', 'owner@example.test', 'unused', 'Owner', 'RON', 'ro-RO', 'Europe/Bucharest'),
         ('other', 'other@example.test', 'other@example.test', 'unused', 'Other', 'RON', 'ro-RO', 'Europe/Bucharest')`,
    ).run();
    db.sqlite.prepare(
      `INSERT INTO accounts (id, user_id, name, type, currency, opening_balance_minor, opening_balance_date)
       VALUES
         ('owner-account', 'owner', 'Owner current', 'current', 'RON', 100000, '2026-07-01'),
         ('owner-savings', 'owner', 'Owner savings', 'savings', 'RON', 50000, '2026-07-01'),
         ('owner-loan', 'owner', 'Owner loan', 'loan', 'RON', -500000, '2026-07-01'),
         ('owner-card', 'owner', 'Owner card', 'credit_card', 'RON', -50000, '2026-07-01'),
         ('other-account', 'other', 'Other current', 'current', 'RON', 100000, '2026-07-01')`,
    ).run();
    db.sqlite.prepare(
      `INSERT INTO categories (id, user_id, name, kind, spending_nature, spending_priority)
       VALUES
         ('owner-category', 'owner', 'Owner expense', 'expense', 'variable', 'essential'),
         ('owner-split-category', 'owner', 'Owner split expense', 'expense', 'variable', 'essential'),
         ('owner-workflow-category', 'owner', 'Workflow expense', 'expense', 'fixed', 'essential'),
         ('other-category', 'other', 'Other private expense', 'expense', 'variable', 'essential')`,
    ).run();
  });

  afterAll(() => {
    db.sqlite.close();
    delete (globalThis as typeof globalThis & { __ledgerLabConnection?: unknown }).__ledgerLabConnection;
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
    if (originalRegistrationMode === undefined) delete process.env.REGISTRATION_MODE;
    else process.env.REGISTRATION_MODE = originalRegistrationMode;
  });

  it("serves the global currency catalog without requiring a session", async () => {
    const response = await route.GET(
      new NextRequest("http://localhost:3000/api/currencies?locale=en-US"),
      { params: Promise.resolve({ path: ["currencies"] }) },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      defaultCurrency: "USD",
      commonCurrencyCodes: expect.arrayContaining(["USD", "EUR", "GBP"]),
      currencies: expect.arrayContaining([
        expect.objectContaining({ code: "USD", name: "US Dollar", common: true }),
        expect.objectContaining({ code: "RON", common: true }),
      ]),
    });
  });

  it("reports and enforces the self-hosted registration policy", async () => {
    process.env.REGISTRATION_MODE = "first-user";
    try {
      const statusResponse = await route.GET(
        new NextRequest("http://localhost:3000/api/auth/registration"),
        { params: Promise.resolve({ path: ["auth", "registration"] }) },
      );
      expect(statusResponse.status).toBe(200);
      await expect(statusResponse.json()).resolves.toEqual({ mode: "first-user", available: false });

      const registerResponse = await route.POST(
        new NextRequest("http://localhost:3000/api/auth/register", {
          method: "POST",
          headers: { "content-type": "application/json", origin: "http://localhost:3000" },
          body: JSON.stringify({
            name: "Blocked user",
            email: "blocked@example.test",
            password: "LongEnoughPassword!42",
            currency: "USD",
            locale: "en-US",
            timeZone: "UTC",
          }),
        }),
        { params: Promise.resolve({ path: ["auth", "register"] }) },
      );
      expect(registerResponse.status).toBe(403);
      await expect(registerResponse.json()).resolves.toEqual({
        error: { code: "REGISTRATION_CLOSED" },
      });
    } finally {
      process.env.REGISTRATION_MODE = "open";
    }
  });

  it("throttles repeated login guesses and returns a retry window", async () => {
    const request = () => route.POST(
      new NextRequest("http://localhost:3000/api/auth/login", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://localhost:3000",
          "x-forwarded-for": "192.0.2.99",
        },
        body: JSON.stringify({ email: "rate-limited@example.test", password: "WrongPassword!42" }),
      }),
      { params: Promise.resolve({ path: ["auth", "login"] }) },
    );

    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect((await request()).status).toBe(401);
    }
    const blocked = await request();
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
    await expect(blocked.json()).resolves.toMatchObject({
      error: {
        code: "RATE_LIMITED",
        params: { retryAfterSeconds: expect.any(Number) },
      },
    });
  });

  it("registers a workspace with the user's selected currency and regional settings", async () => {
    const response = await route.POST(
      new NextRequest("http://localhost:3000/api/auth/register", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost:3000" },
        body: JSON.stringify({
          name: "International User",
          email: "international@example.test",
          password: "LongEnoughPassword!42",
          currency: "EUR",
          locale: "fr-FR",
          timeZone: "Europe/Paris",
          uiLanguage: "en",
        }),
      }),
      { params: Promise.resolve({ path: ["auth", "register"] }) },
    );
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      user: {
        defaultCurrency: "EUR",
        locale: "fr-FR",
        timeZone: "Europe/Paris",
        uiLanguage: "en",
      },
    });
    expect(response.headers.get("set-cookie")).toContain(UI_LANGUAGE_COOKIE_NAME);
    const stored = db.sqlite.prepare(
      "SELECT id, default_currency AS currency, locale, time_zone AS timeZone, ui_language AS uiLanguage FROM users WHERE normalized_email = ?",
    ).get("international@example.test") as { id: string; currency: string; locale: string; timeZone: string; uiLanguage: string };
    expect(stored).toMatchObject({
      currency: "EUR",
      locale: "fr-FR",
      timeZone: "Europe/Paris",
      uiLanguage: "en",
    });

    const planned = core.createPlannedPayment(stored.id, {
      name: "Localized recurring payment",
      expectedAmountMinor: 2_500,
      dueDate: "2026-09-01",
      recurrence: { frequency: "monthly", interval: 1 },
    });
    expect(planned.currency).toBe("EUR");
    expect(db.sqlite.prepare(
      `SELECT r.time_zone AS timeZone
         FROM recurrence_rules r
         JOIN planned_payments p ON p.recurrence_rule_id = r.id
        WHERE p.id = ?`,
    ).get(planned.plannedPaymentId)).toEqual({ timeZone: "Europe/Paris" });
  });

  it("creates a native foreign-currency account and posts an explicit cross-currency transfer", async () => {
    db.sqlite.prepare(
      `INSERT INTO users (id, email, normalized_email, password_hash, display_name, default_currency, locale, time_zone)
       VALUES ('currency-api-owner', 'currency-api@example.test', 'currency-api@example.test', 'unused', 'Currency API', 'RON', 'en-US', 'Europe/Bucharest')`,
    ).run();
    db.sqlite.prepare(
      `INSERT INTO accounts (id, user_id, name, type, currency, opening_balance_minor, opening_balance_date)
       VALUES ('currency-api-ron', 'currency-api-owner', 'RON source', 'current', 'RON', 100000, '2026-07-01')`,
    ).run();
    const session = auth.createSession("currency-api-owner", {}, db.db);
    const headers = {
      "content-type": "application/json",
      cookie: `${auth.SESSION_COOKIE_NAME}=${session.token}`,
      origin: "http://localhost:3000",
    };
    const accountResponse = await route.POST(
      new NextRequest("http://localhost:3000/api/accounts", {
        method: "POST",
        headers,
        body: JSON.stringify({
          name: "Owner EUR account",
          type: "savings",
          currency: "EUR",
          openingBalanceMinor: 0,
          openingDate: "2026-07-01",
        }),
      }),
      { params: Promise.resolve({ path: ["accounts"] }) },
    );
    expect(accountResponse.status).toBe(201);
    const accountPayload = await accountResponse.json() as { account: { id: string; currency: string } };
    expect(accountPayload.account.currency).toBe("EUR");

    const transferResponse = await route.POST(
      new NextRequest("http://localhost:3000/api/transactions", {
        method: "POST",
        headers,
        body: JSON.stringify({
          kind: "transfer",
          accountId: "currency-api-ron",
          transferAccountId: accountPayload.account.id,
          amountMinor: 1_000,
          destinationAmountMinor: 200,
          fxRateScaled: 20_000_000,
          fxRateSource: "manual",
          fxRateDate: "2026-07-20",
          date: "2026-07-20",
        }),
      }),
      { params: Promise.resolve({ path: ["transactions"] }) },
    );
    expect(transferResponse.status).toBe(201);
    const transferPayload = await transferResponse.json() as { transaction: { transferGroupId: string } };
    expect(db.sqlite.prepare(
      `SELECT amount_minor AS amountMinor, currency, original_amount_minor AS originalAmountMinor,
              original_currency AS originalCurrency, fx_rate_scaled AS fxRateScaled
         FROM transactions WHERE transfer_group_id = ? ORDER BY amount_minor`,
    ).all(transferPayload.transaction.transferGroupId)).toEqual([
      { amountMinor: -1_000, currency: "RON", originalAmountMinor: null, originalCurrency: null, fxRateScaled: null },
      { amountMinor: 200, currency: "EUR", originalAmountMinor: 1_000, originalCurrency: "RON", fxRateScaled: 20_000_000 },
    ]);
  });

  it("pays and undoes a foreign-currency planned occurrence through the API", async () => {
    db.sqlite.prepare(
      `INSERT INTO users (id, email, normalized_email, password_hash, display_name, default_currency, locale, time_zone)
       VALUES ('planned-fx-owner', 'planned-fx@example.test', 'planned-fx@example.test', 'unused', 'Planned FX', 'RON', 'en-US', 'Europe/Bucharest')`,
    ).run();
    db.sqlite.prepare(
      `INSERT INTO accounts (id, user_id, name, type, currency, opening_balance_minor, opening_balance_date)
       VALUES ('planned-fx-ron', 'planned-fx-owner', 'RON current', 'current', 'RON', 100000, '2026-07-01')`,
    ).run();
    const session = auth.createSession("planned-fx-owner", {}, db.db);
    const headers = {
      "content-type": "application/json",
      cookie: `${auth.SESSION_COOKIE_NAME}=${session.token}`,
      origin: "http://localhost:3000",
    };
    const createResponse = await route.POST(
      new NextRequest("http://localhost:3000/api/planned", {
        method: "POST",
        headers,
        body: JSON.stringify({
          title: "USD subscription",
          expectedAmountMinor: 2_000,
          currency: "USD",
          dueDate: "2026-08-10",
          direction: "expense",
          accountId: "planned-fx-ron",
        }),
      }),
      { params: Promise.resolve({ path: ["planned"] }) },
    );
    expect(createResponse.status).toBe(201);
    const created = await createResponse.json() as { occurrence: { id: string; plannedPaymentId: string; currency: string } };
    expect(created.occurrence.currency).toBe("USD");

    const payResponse = await route.POST(
      new NextRequest(`http://localhost:3000/api/planned/${created.occurrence.id}/pay`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          accountId: "planned-fx-ron",
          amountMinor: 4_600,
          appliedAmountMinor: 1_000,
          date: "2026-07-21",
          partial: true,
          fxRateScaled: 460_000_000,
          fxRateSource: "manual",
          fxRateDate: "2026-07-21",
        }),
      }),
      { params: Promise.resolve({ path: ["planned", created.occurrence.id, "pay"] }) },
    );
    expect(payResponse.status).toBe(200);
    const paid = await payResponse.json() as { result: { transactionId: string; status: string; paidAmountMinor: number } };
    expect(paid.result).toMatchObject({ status: "scheduled", paidAmountMinor: 1_000 });
    expect(db.sqlite.prepare(
      `SELECT amount_minor AS amountMinor, currency, original_amount_minor AS originalAmountMinor,
              original_currency AS originalCurrency, fx_rate_scaled AS fxRateScaled, notes AS note
         FROM transactions WHERE id = ?`,
    ).get(paid.result.transactionId)).toEqual({
      amountMinor: -4_600,
      currency: "RON",
      originalAmountMinor: 1_000,
      originalCurrency: "USD",
      fxRateScaled: 460_000_000,
      note: "USD subscription",
    });
    expect(core.listTransactions("planned-fx-owner", { search: "USD subscription" }))
      .toEqual([expect.objectContaining({ id: paid.result.transactionId, note: "USD subscription" })]);
    expect(db.sqlite.prepare(
      `SELECT o.paid_amount_minor AS paidAmountMinor, link.applied_amount_minor AS appliedAmountMinor
         FROM planned_payment_occurrences o
         JOIN planned_payment_transactions link ON link.occurrence_id = o.id
        WHERE o.id = ?`,
    ).get(created.occurrence.id)).toEqual({ paidAmountMinor: 1_000, appliedAmountMinor: 1_000 });

    const undoResponse = await route.POST(
      new NextRequest(`http://localhost:3000/api/planned/${created.occurrence.id}/undo`, {
        method: "POST",
        headers,
        body: JSON.stringify({}),
      }),
      { params: Promise.resolve({ path: ["planned", created.occurrence.id, "undo"] }) },
    );
    expect(undoResponse.status).toBe(200);
    expect(db.sqlite.prepare(
      "SELECT paid_amount_minor AS paidAmountMinor, status FROM planned_payment_occurrences WHERE id = ?",
    ).get(created.occurrence.id)).toEqual({ paidAmountMinor: 0, status: "planned" });
    expect(db.sqlite.prepare("SELECT status FROM transactions WHERE id = ?").get(paid.result.transactionId))
      .toEqual({ status: "void" });
  });

  it("uses each workspace time zone for calendar-day write guards", () => {
    db.sqlite.prepare(
      `INSERT INTO users (id, email, normalized_email, password_hash, display_name, default_currency, locale, time_zone)
       VALUES
         ('west-user', 'west@example.test', 'west@example.test', 'unused', 'West', 'USD', 'en-US', 'America/Los_Angeles'),
         ('east-user', 'east@example.test', 'east@example.test', 'unused', 'East', 'USD', 'en-US', 'Europe/Bucharest')`,
    ).run();

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T01:00:00.000Z"));
    try {
      expect(() => core.createAccount("west-user", {
        name: "Future in Los Angeles",
        type: "current",
        currency: "USD",
        openingBalanceMinor: 0,
        openingDate: "2026-08-01",
      })).toThrow(/future/i);

      expect(core.createAccount("east-user", {
        name: "Already today in Bucharest",
        type: "current",
        currency: "USD",
        openingBalanceMinor: 0,
        openingDate: "2026-08-01",
      })).toMatchObject({ openingDate: "2026-08-01" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects another user's category on primary and split transaction writes", () => {
    expect(() => core.createTransaction("owner", {
      kind: "expense",
      accountId: "owner-account",
      categoryId: "other-category",
      amountMinor: 1_000,
      date: "2026-08-01",
    })).toThrow(/belongs to your profile/i);

    expect(() => core.createTransaction("owner", {
      kind: "expense",
      accountId: "owner-account",
      amountMinor: 1_000,
      date: "2026-07-02",
      splits: [
        { categoryId: "owner-category", amountMinor: 500 },
        { categoryId: "other-category", amountMinor: 500 },
      ],
    })).toThrow(/belongs to your profile/i);

    expect(db.sqlite.prepare("SELECT COUNT(*) AS count FROM transactions WHERE user_id = 'owner'").get())
      .toEqual({ count: 0 });
  });

  it("does not let skipping erase the state of a partially paid occurrence", () => {
    const occurrence = core.createPlannedPayment("owner", {
      name: "Part-paid bill",
      expectedAmountMinor: 2_000,
      dueDate: "2026-08-10",
      type: "expense",
      accountId: "owner-account",
      categoryId: "owner-category",
    });
    core.payPlannedOccurrence("owner", occurrence.id, {
      amountMinor: 750,
      date: "2026-08-01",
      accountId: "owner-account",
      partial: true,
    });

    const linkedTransaction = db.sqlite.prepare(
      "SELECT transaction_id AS id FROM planned_payment_transactions WHERE occurrence_id = ?",
    ).get(occurrence.id) as { id: string };
    expect(() => core.voidTransaction("owner", linkedTransaction.id)).toThrow(/planned-payment undo/i);

    expect(() => core.skipPlannedOccurrence("owner", occurrence.id, "Skip the rest"))
      .toThrow(/undo recorded payments/i);
    expect(db.sqlite.prepare(
      "SELECT status, paid_amount_minor AS paidAmountMinor FROM planned_payment_occurrences WHERE id = ?",
    ).get(occurrence.id)).toEqual({ status: "scheduled", paidAmountMinor: 750 });
    expect(db.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM planned_payment_transactions WHERE occurrence_id = ?",
    ).get(occurrence.id)).toEqual({ count: 1 });
  });

  it("exposes external IDs without exposing another user's transactions", () => {
    const created = core.createTransaction("owner", {
      kind: "expense",
      accountId: "owner-account",
      categoryId: "owner-category",
      amountMinor: 1_200,
      date: "2026-07-11",
      externalId: "bank-row-42",
    });
    expect(core.listTransactions("owner").find((row) => row.id === created.id)).toMatchObject({
      externalId: "bank-row-42",
      accountId: "owner-account",
    });
    expect(core.listTransactions("other")).toEqual([]);
  });

  it("finds split transactions through either assigned split category", () => {
    const created = core.createTransaction("owner", {
      kind: "expense",
      accountId: "owner-account",
      amountMinor: 1_000,
      date: "2026-07-12",
      splits: [
        { categoryId: "owner-category", amountMinor: 400 },
        { categoryId: "owner-split-category", amountMinor: 600 },
      ],
    });

    expect(core.listTransactions("owner", { categoryId: "owner-split-category" }).map((row) => row.id))
      .toContain(created.id);
    expect(core.listTransactionPage("owner", { search: "Owner split expense" }).transactions.map((row) => row.id))
      .toContain(created.id);
  });

  it("rejects generic transfers that bypass liability allocation workflows", () => {
    for (const [accountId, transferAccountId] of [
      ["owner-account", "owner-loan"],
      ["owner-account", "owner-card"],
      ["owner-loan", "owner-account"],
    ]) {
      expect(() => core.createTransaction("owner", {
        kind: "transfer",
        accountId,
        transferAccountId,
        amountMinor: 1_000,
        date: "2026-07-13",
      })).toThrow(/dedicated loan or credit-card workflow/i);
    }
    for (const accountId of ["owner-loan", "owner-card"]) {
      expect(() => core.createTransaction("owner", {
        kind: "adjustment",
        accountId,
        amountMinor: 1_000,
        adjustmentSign: 1,
        date: "2026-07-13",
      })).toThrow(/dedicated loan or credit-card workflow/i);
    }
  });

  it("paginates filtered transactions with totals over the complete result set", async () => {
    for (const transaction of [
      { kind: "income" as const, amountMinor: 5_000 },
      { kind: "expense" as const, amountMinor: 2_000 },
      { kind: "refund" as const, amountMinor: 300 },
    ]) {
      core.createTransaction("owner", {
        ...transaction,
        accountId: "owner-account",
        date: "2026-07-14",
      });
    }
    const page = core.listTransactionPage("owner", {
      from: "2026-07-14",
      to: "2026-07-14",
      limit: 1,
      offset: 1,
    });
    expect(page).toMatchObject({
      total: 3,
      limit: 1,
      offset: 1,
      summary: { clearedCount: 3, incomeMinor: 5_000, netSpendingMinor: 1_700 },
    });
    expect(page.transactions).toHaveLength(1);

    const session = auth.createSession("owner", {}, db.db);
    const response = await route.GET(
      new NextRequest("http://localhost:3000/api/transactions?from=2026-07-14&to=2026-07-14&limit=1&offset=1", {
        headers: { cookie: `${auth.SESSION_COOKIE_NAME}=${session.token}` },
      }),
      { params: Promise.resolve({ path: ["transactions"] }) },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      total: 3,
      limit: 1,
      offset: 1,
      summary: { clearedCount: 3, incomeMinor: 5_000, netSpendingMinor: 1_700 },
    });
  });

  it("requires one owned account before applying native-currency amount filters", async () => {
    expect(() => core.listTransactionPage("owner", { minMinor: 100 }))
      .toThrow(/choose one account before filtering by amount/i);
    expect(() => core.listTransactionPage("owner", { accountId: "other-account", maxMinor: 10_000 }))
      .toThrow(/belongs to your profile/i);

    expect(core.listTransactionPage("owner", {
      accountId: "owner-account",
      minMinor: 100,
    })).toMatchObject({ summary: { currency: "RON" } });

    const session = auth.createSession("owner", {}, db.db);
    const response = await route.GET(
      new NextRequest("http://localhost:3000/api/transactions?minMinor=100", {
        headers: { cookie: `${auth.SESSION_COOKIE_NAME}=${session.token}` },
      }),
      { params: Promise.resolve({ path: ["transactions"] }) },
    );
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "TRANSACTION_AMOUNT_FILTER_ACCOUNT_REQUIRED" },
    });
  });

  it("clears both pending transfer legs atomically and enforces ownership", async () => {
    const pending = core.createTransaction("owner", {
      kind: "transfer",
      status: "pending",
      accountId: "owner-account",
      transferAccountId: "owner-savings",
      amountMinor: 2_000,
      date: "2026-08-01",
    });
    expect(() => core.clearPendingTransaction("other", pending.id)).toThrow(/not found/i);
    const session = auth.createSession("owner", {}, db.db);
    const response = await route.POST(
      new NextRequest(`http://localhost:3000/api/transactions/${pending.id}/clear`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: `${auth.SESSION_COOKIE_NAME}=${session.token}`,
          origin: "http://localhost:3000",
        },
        body: JSON.stringify({}),
      }),
      { params: Promise.resolve({ path: ["transactions", pending.id, "clear"] }) },
    );
    expect(response.status).toBe(200);
    expect(db.sqlite.prepare(
      "SELECT status FROM transactions WHERE transfer_group_id = ? ORDER BY id",
    ).all(pending.transferGroupId)).toEqual([{ status: "cleared" }, { status: "cleared" }]);
  });

  it("rejects future transactions across direct and planned-payment posting paths", () => {
    const tomorrow = addDays(bucharestToday(), 1);
    const transactionCount = db.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM transactions WHERE user_id = ?",
    ).get("owner") as { count: number };

    expect(() => core.createTransaction("owner", {
      kind: "expense",
      accountId: "owner-account",
      amountMinor: 8_701,
      date: tomorrow,
    })).toThrow(/transactions cannot be dated in the future.*planned payments/i);

    expect(() => core.createTransaction("owner", {
      kind: "expense",
      status: "pending",
      accountId: "owner-account",
      amountMinor: 8_702,
      date: tomorrow,
    })).toThrow(/transactions cannot be dated in the future.*planned payments/i);

    const occurrence = core.createPlannedPayment("owner", {
      name: "Tomorrow's guarded payment",
      expectedAmountMinor: 8_703,
      dueDate: tomorrow,
      accountId: "owner-account",
    });
    expect(() => core.payPlannedOccurrence("owner", occurrence.id, {
      amountMinor: 8_703,
      date: tomorrow,
      accountId: "owner-account",
    })).toThrow(/transactions cannot be dated in the future.*planned payments/i);
    expect(db.sqlite.prepare(
      "SELECT paid_amount_minor AS paidAmountMinor, paid_at AS paidAt FROM planned_payment_occurrences WHERE id = ?",
    ).get(occurrence.id)).toEqual({ paidAmountMinor: 0, paidAt: null });
    expect(db.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM planned_payment_transactions WHERE occurrence_id = ?",
    ).get(occurrence.id)).toEqual({ count: 0 });
    expect(db.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM transactions WHERE user_id = ?",
    ).get("owner")).toEqual({ count: transactionCount.count });
  });

  it("does not clear a future pending transaction restored from legacy data", () => {
    const tomorrow = addDays(bucharestToday(), 1);
    db.sqlite.prepare(
      `INSERT INTO transactions
        (id, user_id, account_id, kind, status, amount_minor, currency, occurred_at)
       VALUES ('legacy-future-pending', 'owner', 'owner-account', 'expense', 'pending', -8704, 'RON', ?)`,
    ).run(tomorrow);

    expect(() => core.clearPendingTransaction("owner", "legacy-future-pending"))
      .toThrow(/cannot be cleared before/i);
    expect(db.sqlite.prepare("SELECT status FROM transactions WHERE id = ?").get("legacy-future-pending"))
      .toEqual({ status: "pending" });
  });

  it("rejects future opening dates when creating or updating an account", () => {
    const tomorrow = addDays(bucharestToday(), 1);
    expect(() => core.createAccount("owner", {
      name: "Future opening account",
      type: "cash",
      openingDate: tomorrow,
    })).toThrow(/opening date cannot be in the future/i);
    expect(db.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM accounts WHERE user_id = ? AND name = ?",
    ).get("owner", "Future opening account")).toEqual({ count: 0 });

    expect(() => core.updateAccount("owner", "owner-account", { openingDate: tomorrow }))
      .toThrow(/opening date cannot be in the future/i);
    expect(db.sqlite.prepare(
      "SELECT opening_balance_date AS openingDate FROM accounts WHERE id = ?",
    ).get("owner-account")).toEqual({ openingDate: "2026-07-01" });
  });

  it("returns voided transactions only when explicitly requested", () => {
    const created = core.createTransaction("owner", {
      kind: "expense",
      accountId: "owner-account",
      amountMinor: 444,
      date: "2026-07-16",
    });
    core.voidTransaction("owner", created.id);

    expect(core.listTransactionPage("owner", { from: "2026-07-16", to: "2026-07-16" }).total).toBe(0);
    const voided = core.listTransactionPage("owner", {
      from: "2026-07-16",
      to: "2026-07-16",
      status: "void",
    });
    expect(voided.total).toBe(1);
    expect(voided.transactions).toEqual([expect.objectContaining({ id: created.id, status: "void" })]);
  });

  it("materializes a requested occurrence beyond 600 on the first list call", () => {
    const created = core.createPlannedPayment("owner", {
      name: "Long-running daily plan",
      expectedAmountMinor: 100,
      dueDate: "2024-01-01",
      recurrence: { frequency: "daily" },
    });
    db.sqlite.prepare(
      "UPDATE recurrence_rules SET occurrence_count = 605 WHERE id = (SELECT recurrence_rule_id FROM planned_payments WHERE id = ?)",
    ).run(created.plannedPaymentId);

    expect(core.listPlannedPayments("owner", { from: "2025-08-27", to: "2025-08-27" }))
      .toEqual([expect.objectContaining({ plannedPaymentId: created.plannedPaymentId, dueDate: "2025-08-27" })]);
    expect(db.sqlite.prepare(
      "SELECT COUNT(*) AS count, MAX(due_date) AS latest FROM planned_payment_occurrences WHERE planned_payment_id = ?",
    ).get(created.plannedPaymentId)).toEqual({ count: 605, latest: "2025-08-27" });
    core.materializePlannedOccurrences("owner", "2030-12-31");
    expect(db.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM planned_payment_occurrences WHERE planned_payment_id = ?",
    ).get(created.plannedPaymentId)).toEqual({ count: 605 });
  });

  it("preserves archived owned metadata for a planned-payment workflow only", () => {
    const created = core.createPlannedPayment("owner", {
      name: "Archived metadata plan",
      expectedAmountMinor: 900,
      dueDate: "2026-08-20",
      accountId: "owner-account",
      categoryId: "owner-workflow-category",
      merchant: "Archived workflow merchant",
      recurrence: { frequency: "daily", endDate: "2026-08-21" },
    });
    const merchant = db.sqlite.prepare(
      "SELECT merchant_id AS merchantId FROM planned_payments WHERE id = ?",
    ).get(created.plannedPaymentId) as { merchantId: string };
    core.setCategoryArchived("owner", "owner-workflow-category", true);
    core.setMerchantArchived("owner", merchant.merchantId, true);
    core.materializePlannedOccurrences("owner", "2026-08-21");
    const occurrence = db.sqlite.prepare(
      "SELECT id FROM planned_payment_occurrences WHERE planned_payment_id = ? AND due_date = '2026-08-21'",
    ).get(created.plannedPaymentId) as { id: string };

    const paid = core.payPlannedOccurrence("owner", occurrence.id, {
      amountMinor: 900,
      date: "2026-08-01",
      accountId: "owner-account",
    });
    expect(db.sqlite.prepare(
      "SELECT category_id AS categoryId, merchant_id AS merchantId FROM transactions WHERE id = ?",
    ).get(paid.transactionId)).toEqual({
      categoryId: "owner-workflow-category",
      merchantId: merchant.merchantId,
    });
    expect(core.listPlannedPayments("owner", { from: "2026-08-21", to: "2026-08-21" }))
      .toEqual([expect.objectContaining({
        plannedPaymentId: created.plannedPaymentId,
        spendingNature: "fixed",
        spendingPriority: "essential",
      })]);
    expect(() => core.createTransaction("owner", {
      kind: "expense",
      accountId: "owner-account",
      categoryId: "owner-workflow-category",
      amountMinor: 100,
      date: "2026-07-22",
    })).toThrow(/active category/i);
  });

  it("cancels an unpaid planned occurrence through the API and undo restores it", async () => {
    const occurrence = core.createPlannedPayment("owner", {
      name: "Cancelable plan",
      expectedAmountMinor: 700,
      dueDate: "2026-08-23",
      accountId: "owner-account",
    });
    const session = auth.createSession("owner", {}, db.db);
    const response = await route.POST(
      new NextRequest(`http://localhost:3000/api/planned/${occurrence.id}/cancel`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: `${auth.SESSION_COOKIE_NAME}=${session.token}`,
          origin: "http://localhost:3000",
        },
        body: JSON.stringify({ reason: "No longer needed" }),
      }),
      { params: Promise.resolve({ path: ["planned", occurrence.id, "cancel"] }) },
    );
    expect(response.status).toBe(200);
    expect(db.sqlite.prepare(
      "SELECT status, cancelled_at AS cancelledAt FROM planned_payment_occurrences WHERE id = ?",
    ).get(occurrence.id)).toEqual({ status: "cancelled", cancelledAt: expect.any(String) });
    expect(() => core.payPlannedOccurrence("owner", occurrence.id, {
      amountMinor: 700,
      date: "2026-08-01",
      accountId: "owner-account",
    })).toThrow(/cancelled payment cannot be paid/i);

    core.undoPlannedOccurrence("owner", occurrence.id);
    expect(db.sqlite.prepare(
      "SELECT status, skipped_at AS skippedAt, cancelled_at AS cancelledAt FROM planned_payment_occurrences WHERE id = ?",
    ).get(occurrence.id)).toEqual({ status: "planned", skippedAt: null, cancelledAt: null });
  });

  it("treats malformed cookies and corrupted session timestamps as unauthenticated", () => {
    expect(auth.readSessionToken("ledgerlab_session=%E0%A4%A")).toBeNull();
    const issuedAt = new Date("2026-08-01T00:00:00.000Z");
    const session = auth.createSession("owner", {}, db.db, issuedAt);
    db.sqlite.prepare("UPDATE sessions SET expires_at = 'not-a-date' WHERE id = ?").run(session.sessionId);

    expect(auth.validateSessionToken(session.token, db.db, issuedAt)).toBeNull();
    expect(db.sqlite.prepare("SELECT COUNT(*) AS count FROM sessions WHERE id = ?").get(session.sessionId))
      .toEqual({ count: 0 });
  });

  it("preserves the interface-language cookie on sign-out", async () => {
    const session = auth.createSession("owner", {}, db.db);
    const response = await route.POST(
      new NextRequest("http://localhost:3000/api/auth/logout", {
        method: "POST",
        headers: {
          cookie: `${auth.SESSION_COOKIE_NAME}=${session.token}; ${UI_LANGUAGE_COOKIE_NAME}=en`,
          origin: "http://localhost:3000",
        },
      }),
      { params: Promise.resolve({ path: ["auth", "logout"] }) },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain(`${auth.SESSION_COOKIE_NAME}=`);
    expect(response.headers.get("set-cookie")).not.toContain(`${UI_LANGUAGE_COOKIE_NAME}=`);
  });

  it("changes reporting currency without relabeling accountless planned payments or budgets", async () => {
    db.sqlite.prepare(
      `INSERT INTO users (id, email, normalized_email, password_hash, display_name, default_currency)
       VALUES
         ('plan-currency-lock', 'plan-lock@example.test', 'plan-lock@example.test', 'unused', 'Plan Lock', 'RON'),
         ('budget-currency-lock', 'budget-lock@example.test', 'budget-lock@example.test', 'unused', 'Budget Lock', 'RON')`,
    ).run();
    db.sqlite.prepare(
      `INSERT INTO categories (id, user_id, name, kind)
       VALUES ('budget-lock-category', 'budget-currency-lock', 'Budget category', 'expense')`,
    ).run();
    const planned = core.createPlannedPayment("plan-currency-lock", {
      name: "Accountless plan",
      expectedAmountMinor: 1_000,
      dueDate: "2026-09-01",
    });
    db.sqlite.prepare(
      `INSERT INTO budgets (id, user_id, month, category_id, amount_minor, currency)
       VALUES ('budget-lock-row', 'budget-currency-lock', '2026-09', 'budget-lock-category', 1000, 'RON')`,
    ).run();

    for (const userId of ["plan-currency-lock", "budget-currency-lock"]) {
      const session = auth.createSession(userId, {}, db.db);
      const response = await route.POST(
        new NextRequest("http://localhost:3000/api/settings", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            cookie: `${auth.SESSION_COOKIE_NAME}=${session.token}`,
            origin: "http://localhost:3000",
          },
          body: JSON.stringify({
            action: "preferences",
            displayName: "Currency Lock",
            currency: "EUR",
            locale: "en-RO",
            timeZone: "Europe/Bucharest",
            compactTables: true,
          }),
        }),
        { params: Promise.resolve({ path: ["settings"] }) },
      );
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        user: { defaultCurrency: "EUR" },
      });
      expect(db.sqlite.prepare("SELECT default_currency AS currency FROM users WHERE id = ?").get(userId))
        .toEqual({ currency: "EUR" });
    }

    expect(db.sqlite.prepare("SELECT currency FROM planned_payments WHERE id = ?").get(planned.plannedPaymentId))
      .toEqual({ currency: "RON" });
    expect(db.sqlite.prepare("SELECT currency FROM budgets WHERE id = 'budget-lock-row'").get())
      .toEqual({ currency: "RON" });
  });

  it("returns workspace currency from planned and budget API payloads", async () => {
    db.sqlite.prepare("UPDATE users SET default_currency = 'EUR' WHERE id = 'owner'").run();
    db.sqlite.prepare("UPDATE accounts SET currency = 'EUR' WHERE user_id = 'owner'").run();
    // This fixture is checking response envelopes rather than FX conversion.
    // Keep its directly relabelled legacy rows internally consistent; profile
    // changes in production never rewrite these native denominations.
    db.sqlite.prepare("UPDATE transactions SET currency = 'EUR' WHERE user_id = 'owner'").run();
    db.sqlite.prepare("UPDATE budgets SET currency = 'EUR' WHERE user_id = 'owner'").run();
    const eurPlan = core.createPlannedPayment("owner", {
      name: "EUR plan",
      expectedAmountMinor: 2_500,
      dueDate: "2026-08-20",
      accountId: "owner-account",
      categoryId: "owner-category",
    });
    expect(eurPlan.currency).toBe("EUR");
    expect(db.sqlite.prepare("SELECT currency FROM planned_payments WHERE id = ?").get(eurPlan.plannedPaymentId))
      .toEqual({ currency: "EUR" });
    expect(core.listPlannedPayments("owner", { from: "2026-08-20", to: "2026-08-20" }))
      .toEqual(expect.arrayContaining([expect.objectContaining({ plannedPaymentId: eurPlan.plannedPaymentId, currency: "EUR" })]));
    const session = auth.createSession("owner", {}, db.db);
    const headers = { cookie: `${auth.SESSION_COOKIE_NAME}=${session.token}` };

    const plannedResponse = await route.GET(
      new NextRequest("http://localhost:3000/api/planned?from=2026-08-01&to=2026-08-31", { headers }),
      { params: Promise.resolve({ path: ["planned"] }) },
    );
    expect(plannedResponse.status).toBe(200);
    await expect(plannedResponse.json()).resolves.toMatchObject({ currency: "EUR" });

    const budgetResponse = await route.GET(
      new NextRequest("http://localhost:3000/api/budgets?month=2026-08", { headers }),
      { params: Promise.resolve({ path: ["budgets"] }) },
    );
    expect(budgetResponse.status).toBe(200);
    await expect(budgetResponse.json()).resolves.toMatchObject({ currency: "EUR", month: "2026-08" });
    expect(budgetResponse.headers.get("cache-control")).toBe("private, no-store");

    const transactionResponse = await route.GET(
      new NextRequest("http://localhost:3000/api/transactions", { headers }),
      { params: Promise.resolve({ path: ["transactions"] }) },
    );
    expect(transactionResponse.status).toBe(200);
    await expect(transactionResponse.json()).resolves.toMatchObject({ currency: "EUR" });
  }, 15_000);

  it("rejects malformed and cross-site origins without surfacing a 500", async () => {
    for (const origin of ["not a URL", "https://evil.example"]) {
      const response = await route.POST(
        new NextRequest("http://localhost:3000/api/tags", {
          method: "POST",
          headers: { "content-type": "application/json", origin },
          body: JSON.stringify({ name: "Never created" }),
        }),
        { params: Promise.resolve({ path: ["tags"] }) },
      );
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({ error: { code: "CROSS_ORIGIN_FORBIDDEN" } });
    }
    expect(db.sqlite.prepare("SELECT COUNT(*) AS count FROM tags WHERE user_id = 'owner'").get())
      .toEqual({ count: 0 });
  });

  it("rejects oversized JSON before parsing or mutating data", async () => {
    const oversizedAuthBody = JSON.stringify({
      email: `${"a".repeat(70 * 1024)}@example.test`,
      password: "LongEnoughPassword!42",
      name: "Never created",
    });
    const streamedResponse = await route.POST(
      new NextRequest("http://localhost:3000/api/auth/register", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost:3000" },
        body: oversizedAuthBody,
      }),
      { params: Promise.resolve({ path: ["auth", "register"] }) },
    );
    expect(streamedResponse.status).toBe(413);

    const session = auth.createSession("owner", {}, db.db);
    const declaredResponse = await route.POST(
      new NextRequest("http://localhost:3000/api/tags", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(2 * 1024 * 1024 + 1),
          cookie: `${auth.SESSION_COOKIE_NAME}=${session.token}`,
          origin: "http://localhost:3000",
        },
        body: JSON.stringify({ name: "Never created by oversized request" }),
      }),
      { params: Promise.resolve({ path: ["tags"] }) },
    );
    expect(declaredResponse.status).toBe(413);
    expect(db.sqlite.prepare("SELECT COUNT(*) AS count FROM tags WHERE user_id = 'owner'").get())
      .toEqual({ count: 0 });
  });
});
