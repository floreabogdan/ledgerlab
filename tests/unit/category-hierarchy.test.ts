import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

type AuthModule = typeof import("@/lib/auth");
type CoreModule = typeof import("@/server/core");
type DatabaseModule = typeof import("@/db");
type RouteModule = typeof import("@/app/api/[...path]/route");

const originalDatabaseUrl = process.env.DATABASE_URL;

let auth: AuthModule;
let core: CoreModule;
let db: DatabaseModule;
let route: RouteModule;
let ownerToken: string;
let otherToken: string;

function routeContext(...segments: string[]) {
  return { params: Promise.resolve({ path: segments }) };
}

function categoryRequest(body: Record<string, unknown>, token = ownerToken) {
  return route.POST(
    new NextRequest("http://localhost:3000/api/categories", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: `ledgerlab_session=${token}`,
        origin: "http://localhost:3000",
      },
      body: JSON.stringify(body),
    }),
    routeContext("categories"),
  );
}

beforeEach(async () => {
  process.env.DATABASE_URL = ":memory:";
  vi.resetModules();
  delete (globalThis as typeof globalThis & { __ledgerLabConnection?: unknown }).__ledgerLabConnection;

  db = await import("@/db");
  auth = await import("@/lib/auth");
  core = await import("@/server/core");
  route = await import("@/app/api/[...path]/route");
  db.ensureDatabase();
  db.sqlite.prepare(
    `INSERT INTO users (id, email, normalized_email, password_hash, display_name, default_currency)
     VALUES
       ('owner', 'owner@example.test', 'owner@example.test', 'unused', 'Owner', 'USD'),
       ('other', 'other@example.test', 'other@example.test', 'unused', 'Other', 'USD')`,
  ).run();
  db.sqlite.prepare(
    `INSERT INTO accounts
       (id, user_id, name, type, currency, opening_balance_minor, opening_balance_date)
     VALUES ('account', 'owner', 'Current', 'current', 'USD', 0, '2026-01-01')`,
  ).run();
  ownerToken = auth.createSession("owner").token;
  otherToken = auth.createSession("other").token;
});

afterEach(() => {
  db.sqlite.close();
  delete (globalThis as typeof globalThis & { __ledgerLabConnection?: unknown }).__ledgerLabConnection;
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
});

describe("category hierarchy", () => {
  it("supports deep trees with deterministic depth-first ordering and path metadata", () => {
    const work = core.createCategory("owner", { name: "Work", kind: "income" })!;
    const home = core.createCategory("owner", { name: "Home", kind: "expense" })!;
    const repairs = core.createCategory("owner", { name: "Repairs", parentId: home.id, kind: "expense" })!;
    const appliances = core.createCategory("owner", { name: "Appliances", parentId: home.id, kind: "expense" })!;
    const kitchen = core.createCategory("owner", { name: "Kitchen", parentId: appliances.id, kind: "expense" })!;
    const coffee = core.createCategory("owner", { name: "Coffee machine", parentId: kitchen.id, kind: "expense" })!;

    const categories = core.listCategories("owner");
    expect(categories.map((category) => category.id)).toEqual([
      home.id,
      appliances.id,
      kitchen.id,
      coffee.id,
      repairs.id,
      work.id,
    ]);
    expect(categories.find((category) => category.id === coffee.id)).toMatchObject({
      parentId: kitchen.id,
      parentName: "Kitchen",
      depth: 3,
      path: "Home › Appliances › Kitchen › Coffee machine",
      ancestorIds: [home.id, appliances.id, kitchen.id],
      hasChildren: false,
    });
    expect(categories.find((category) => category.id === home.id)).toMatchObject({
      depth: 0,
      path: "Home",
      ancestorIds: [],
      hasChildren: true,
    });
  });

  it("edits and moves subtrees while preventing cycles, foreign parents, duplicates, and incompatible kinds", () => {
    const home = core.createCategory("owner", { name: "Home", kind: "expense" })!;
    const repairs = core.createCategory("owner", { name: "Repairs", parentId: home.id, kind: "expense" })!;
    const plumbing = core.createCategory("owner", { name: "Plumbing", parentId: repairs.id, kind: "expense" })!;
    const salary = core.createCategory("owner", { name: "Salary", kind: "income" })!;
    const foreign = core.createCategory("other", { name: "Private", kind: "expense" })!;

    expect(() => core.updateCategory("owner", home.id, { parentId: plumbing.id })).toThrow(/descendants/i);
    expect(() => core.updateCategory("owner", repairs.id, { parentId: foreign.id })).toThrow(/parent category not found/i);
    expect(() => core.updateCategory("owner", repairs.id, { parentId: salary.id })).toThrow(/cannot be nested/i);
    expect(() => core.updateCategory("other", repairs.id, { name: "Stolen" })).toThrow(/not found/i);
    expect(() => core.updateCategory("owner", home.id, { kind: "income" })).toThrow(/incompatible subcategories/i);

    const moved = core.updateCategory("owner", repairs.id, { name: "Maintenance", parentId: null });
    expect(moved).toMatchObject({ name: "Maintenance", parentId: null, depth: 0, path: "Maintenance" });
    expect(core.listCategories("owner").find((category) => category.id === plumbing.id)).toMatchObject({
      depth: 1,
      path: "Maintenance › Plumbing",
      ancestorIds: [repairs.id],
    });
    expect(() => core.createCategory("owner", { name: "maintenance", kind: "expense" })).toThrow(/already exists/i);
  });

  it("enforces archive and restore integrity across every descendant and ancestor", () => {
    const root = core.createCategory("owner", { name: "Root", kind: "expense" })!;
    const child = core.createCategory("owner", { name: "Child", parentId: root.id, kind: "expense" })!;
    const grandchild = core.createCategory("owner", { name: "Grandchild", parentId: child.id, kind: "expense" })!;

    expect(() => core.setCategoryArchived("owner", root.id, true)).toThrow(/active subcategories/i);
    expect(() => core.setCategoryArchived("owner", child.id, true)).toThrow(/active subcategories/i);
    core.setCategoryArchived("owner", grandchild.id, true);
    core.setCategoryArchived("owner", child.id, true);
    core.setCategoryArchived("owner", root.id, true);

    expect(() => core.setCategoryArchived("owner", grandchild.id, false)).toThrow(/parent categories/i);
    core.setCategoryArchived("owner", root.id, false);
    expect(() => core.setCategoryArchived("owner", grandchild.id, false)).toThrow(/parent categories/i);
    core.setCategoryArchived("owner", child.id, false);
    core.setCategoryArchived("owner", grandchild.id, false);
    expect(core.listCategories("owner")).toHaveLength(3);
  });

  it("rejects transaction and planned-payment category kinds that do not match their direction", () => {
    const expenses = core.createCategory("owner", { name: "Expenses", kind: "expense" })!;
    const income = core.createCategory("owner", { name: "Income", kind: "income" })!;
    const both = core.createCategory("owner", { name: "Shared", kind: "both" })!;

    expect(() => core.createTransaction("owner", {
      kind: "income",
      accountId: "account",
      amountMinor: 1_000,
      date: "2026-07-01",
      categoryId: expenses.id,
    })).toThrow(/income category/i);
    expect(() => core.createTransaction("owner", {
      kind: "expense",
      accountId: "account",
      amountMinor: 1_000,
      date: "2026-07-01",
      categoryId: income.id,
    })).toThrow(/expense category/i);
    expect(() => core.createTransaction("owner", {
      kind: "transfer",
      accountId: "account",
      transferAccountId: "account",
      amountMinor: 1_000,
      date: "2026-07-01",
      categoryId: both.id,
    })).toThrow(/transfer accounts must be different|transfers cannot be assigned/i);
    expect(() => core.createPlannedPayment("owner", {
      name: "Salary",
      expectedAmountMinor: 10_000,
      dueDate: "2026-08-10",
      type: "income",
      categoryId: expenses.id,
    })).toThrow(/income category/i);

    expect(core.createTransaction("owner", {
      kind: "income",
      accountId: "account",
      amountMinor: 1_000,
      date: "2026-07-01",
      categoryId: both.id,
    })).toMatchObject({ id: expect.any(String) });
  });

  it("creates and edits nested categories through the authenticated API", async () => {
    const rootResponse = await categoryRequest({
      action: "create",
      name: "Money",
      kind: "both",
      spendingNature: "variable",
      spendingPriority: "discretionary",
      color: "#2563eb",
    });
    expect(rootResponse.status).toBe(201);
    const root = (await rootResponse.json() as { category: { id: string } }).category;

    const childResponse = await categoryRequest({
      action: "create",
      name: "Freelance",
      parentId: root.id,
      kind: "income",
      spendingNature: "variable",
      spendingPriority: "discretionary",
      color: "#14b8a6",
    });
    expect(childResponse.status).toBe(201);
    const child = (await childResponse.json() as { category: { id: string; depth: number; path: string } }).category;
    expect(child).toMatchObject({ depth: 1, path: "Money › Freelance" });

    const updateResponse = await categoryRequest({
      action: "update",
      id: child.id,
      name: "Consulting",
      color: "#7c3aed",
    });
    expect(updateResponse.status).toBe(200);
    await expect(updateResponse.json()).resolves.toMatchObject({
      category: { id: child.id, name: "Consulting", path: "Money › Consulting", color: "#7c3aed" },
    });

    const cycleResponse = await categoryRequest({ action: "update", id: root.id, parentId: child.id });
    expect(cycleResponse.status).toBe(422);
    const invalidColorResponse = await categoryRequest({ action: "update", id: child.id, color: "blue" });
    expect(invalidColorResponse.status).toBe(422);
    const foreignResponse = await categoryRequest({ action: "update", id: child.id, name: "No access" }, otherToken);
    expect(foreignResponse.status).toBe(404);
  });
});
