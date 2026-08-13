import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

type DatabaseModule = typeof import("@/db");
type AuthModule = typeof import("@/lib/auth");
type CoreModule = typeof import("@/server/core");
type RouteModule = typeof import("@/app/api/[...path]/route");

let db: DatabaseModule;
let auth: AuthModule;
let core: CoreModule;
let route: RouteModule;
const originalDatabaseUrl = process.env.DATABASE_URL;
const originalRegistrationMode = process.env.REGISTRATION_MODE;

const ROMANIAN_DEFAULT_CATEGORY_NAMES = [
  "Salariu",
  "Alte venituri",
  "Locuință",
  "Utilități",
  "Alimente",
  "Transport",
  "Sănătate",
  "Educație",
  "Mese în oraș",
  "Cumpărături",
  "Divertisment",
  "Călătorii",
] as const;

const ENGLISH_DEFAULT_CATEGORY_NAMES = [
  "Salary",
  "Other income",
  "Housing",
  "Utilities",
  "Groceries",
  "Transport",
  "Health",
  "Education",
  "Dining",
  "Shopping",
  "Entertainment",
  "Travel",
] as const;

beforeAll(async () => {
  process.env.DATABASE_URL = ":memory:";
  process.env.REGISTRATION_MODE = "open";
  vi.resetModules();
  delete (globalThis as typeof globalThis & { __ledgerLabConnection?: unknown })
    .__ledgerLabConnection;

  db = await import("@/db");
  auth = await import("@/lib/auth");
  core = await import("@/server/core");
  route = await import("@/app/api/[...path]/route");
  db.ensureDatabase();
});

afterAll(() => {
  db.sqlite.close();
  delete (globalThis as typeof globalThis & { __ledgerLabConnection?: unknown })
    .__ledgerLabConnection;
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
  if (originalRegistrationMode === undefined) delete process.env.REGISTRATION_MODE;
  else process.env.REGISTRATION_MODE = originalRegistrationMode;
});

async function register(input: {
  name: string;
  email: string;
  uiLanguage: "en" | "ro";
}) {
  const response = await route.POST(
    new NextRequest("http://localhost:3000/api/auth/register", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://localhost:3000",
      },
      body: JSON.stringify({
        ...input,
        password: "LocalizedPassword!42",
        currency: "RON",
        locale: "ro-RO",
        timeZone: "Europe/Bucharest",
      }),
    }),
    { params: Promise.resolve({ path: ["auth", "register"] }) },
  );
  expect(response.status).toBe(201);
  const body = await response.json() as { user: { id: string; uiLanguage: string } };
  return body.user;
}

function categoryRows(userId: string) {
  return db.sqlite.prepare(
    `SELECT id, name, kind, spending_nature AS nature,
            spending_priority AS priority, color, display_order AS displayOrder
       FROM categories
      WHERE user_id = ?
      ORDER BY display_order, name`,
  ).all(userId) as Array<{
    id: string;
    name: string;
    kind: string;
    nature: string | null;
    priority: string | null;
    color: string;
    displayOrder: number;
  }>;
}

describe("localized workspace defaults", () => {
  it("creates Romanian default categories for a Romanian registration", async () => {
    const user = await register({
      name: "Utilizator român",
      email: "romanian-defaults@example.test",
      uiLanguage: "ro",
    });

    const categories = categoryRows(user.id);
    expect(user.uiLanguage).toBe("ro");
    expect(categories.map((category) => category.name))
      .toEqual(ROMANIAN_DEFAULT_CATEGORY_NAMES);
    expect(categories.map((category) => ({
      kind: category.kind,
      nature: category.nature,
      priority: category.priority,
      color: category.color,
      displayOrder: category.displayOrder,
    }))).toEqual([
      { kind: "income", nature: null, priority: null, color: "#24735c", displayOrder: 0 },
      { kind: "income", nature: null, priority: null, color: "#3d8b73", displayOrder: 1 },
      { kind: "expense", nature: "fixed", priority: "essential", color: "#7656a5", displayOrder: 2 },
      { kind: "expense", nature: "fixed", priority: "essential", color: "#4f6f8f", displayOrder: 3 },
      { kind: "expense", nature: "variable", priority: "essential", color: "#d0803f", displayOrder: 4 },
      { kind: "expense", nature: "variable", priority: "essential", color: "#3f7f91", displayOrder: 5 },
      { kind: "expense", nature: "variable", priority: "essential", color: "#b45364", displayOrder: 6 },
      { kind: "expense", nature: "variable", priority: "essential", color: "#5369a5", displayOrder: 7 },
      { kind: "expense", nature: "variable", priority: "discretionary", color: "#d05f54", displayOrder: 8 },
      { kind: "expense", nature: "variable", priority: "discretionary", color: "#a85f91", displayOrder: 9 },
      { kind: "expense", nature: "variable", priority: "discretionary", color: "#85724a", displayOrder: 10 },
      { kind: "expense", nature: "variable", priority: "discretionary", color: "#487c74", displayOrder: 11 },
    ]);
  });

  it("switches interface language without renaming stored financial data", async () => {
    const user = await register({
      name: "English Owner",
      email: "language-switch@example.test",
      uiLanguage: "en",
    });
    const initialCategories = categoryRows(user.id);
    expect(initialCategories.map((category) => category.name))
      .toEqual(ENGLISH_DEFAULT_CATEGORY_NAMES);

    const groceries = initialCategories.find((category) => category.name === "Groceries");
    expect(groceries).toBeDefined();
    const account = core.createAccount(user.id, {
      name: "Everyday account",
      type: "current",
      currency: "RON",
      openingBalanceMinor: 100_000,
      openingDate: "2026-07-01",
    });
    expect(account).toBeDefined();
    const transaction = core.createTransaction(user.id, {
      kind: "expense",
      accountId: account!.id,
      categoryId: groceries!.id,
      amountMinor: 12_345,
      date: "2026-08-01",
      note: "User-authored grocery note",
    });
    const accountSnapshot = db.sqlite.prepare(
      `SELECT id, name, type, currency,
              opening_balance_minor AS openingBalanceMinor,
              opening_balance_date AS openingBalanceDate
         FROM accounts
        WHERE id = ? AND user_id = ?`,
    ).get(account!.id, user.id);
    const transactionSnapshot = db.sqlite.prepare(
      `SELECT id, account_id AS accountId, category_id AS categoryId,
              amount_minor AS amountMinor, notes AS note
         FROM transactions
        WHERE id = ? AND user_id = ?`,
    ).get(transaction.id, user.id);

    const session = auth.createSession(user.id, {}, db.db);
    const saveLanguage = async (uiLanguage: "en" | "ro") => {
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
            displayName: "English Owner",
            currency: "RON",
            locale: "ro-RO",
            timeZone: "Europe/Bucharest",
            uiLanguage,
            compactTables: true,
          }),
        }),
        { params: Promise.resolve({ path: ["settings"] }) },
      );
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        user: { uiLanguage },
      });
    };

    await saveLanguage("ro");
    expect(categoryRows(user.id)).toEqual(initialCategories);
    expect(db.sqlite.prepare(
      `SELECT id, name, type, currency,
              opening_balance_minor AS openingBalanceMinor,
              opening_balance_date AS openingBalanceDate
         FROM accounts
        WHERE id = ? AND user_id = ?`,
    ).get(account!.id, user.id)).toEqual(accountSnapshot);
    expect(db.sqlite.prepare(
      `SELECT id, account_id AS accountId, category_id AS categoryId,
              amount_minor AS amountMinor, notes AS note
         FROM transactions
        WHERE id = ? AND user_id = ?`,
    ).get(transaction.id, user.id)).toEqual(transactionSnapshot);
    expect(transactionSnapshot).toMatchObject({
      accountId: account!.id,
      categoryId: groceries!.id,
      amountMinor: -12_345,
      note: "User-authored grocery note",
    });

    await saveLanguage("en");
    expect(categoryRows(user.id)).toEqual(initialCategories);
    expect(db.sqlite.prepare(
      `SELECT id, name, type, currency,
              opening_balance_minor AS openingBalanceMinor,
              opening_balance_date AS openingBalanceDate
         FROM accounts
        WHERE id = ? AND user_id = ?`,
    ).get(account!.id, user.id)).toEqual(accountSnapshot);
    expect(db.sqlite.prepare(
      `SELECT id, account_id AS accountId, category_id AS categoryId,
              amount_minor AS amountMinor, notes AS note
         FROM transactions
        WHERE id = ? AND user_id = ?`,
    ).get(transaction.id, user.id)).toEqual(transactionSnapshot);
    expect(db.sqlite.prepare(
      "SELECT ui_language AS uiLanguage FROM users WHERE id = ?",
    ).get(user.id)).toEqual({ uiLanguage: "en" });
  });
});
