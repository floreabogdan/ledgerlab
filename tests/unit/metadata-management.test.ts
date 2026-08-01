import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

type DatabaseModule = typeof import("@/db");
type CoreModule = typeof import("@/server/core");

describe("category, tag, and merchant management", () => {
  let databaseModule: DatabaseModule;
  let core: CoreModule;
  const originalDatabaseUrl = process.env.DATABASE_URL;

  beforeAll(async () => {
    process.env.DATABASE_URL = ":memory:";
    vi.resetModules();
    delete (globalThis as typeof globalThis & { __ledgerLabConnection?: unknown }).__ledgerLabConnection;

    databaseModule = await import("@/db");
    core = await import("@/server/core");
    databaseModule.ensureDatabase();
    const sql = databaseModule.sqlite;

    sql.prepare(
      `INSERT INTO users (id, email, normalized_email, password_hash, display_name)
       VALUES
         ('owner', 'owner@example.test', 'owner@example.test', 'unused', 'Owner'),
         ('other', 'other@example.test', 'other@example.test', 'unused', 'Other')`,
    ).run();
    sql.prepare(
      `INSERT INTO accounts (id, user_id, name, type, opening_balance_minor, opening_balance_date)
       VALUES ('account', 'owner', 'Current', 'current', 100000, '2026-07-01')`,
    ).run();
    sql.prepare(
      `INSERT INTO categories (id, user_id, parent_id, name, kind, spending_nature, spending_priority)
       VALUES
         ('parent', 'owner', NULL, 'Home', 'expense', 'fixed', 'essential'),
         ('child', 'owner', 'parent', 'Repairs', 'expense', 'variable', 'essential'),
         ('expense-category', 'owner', NULL, 'Shopping', 'expense', 'variable', 'discretionary'),
         ('other-category', 'other', NULL, 'Private', 'expense', 'variable', 'discretionary')`,
    ).run();
    sql.prepare(
      `INSERT INTO tags (id, user_id, name, color)
       VALUES ('tag', 'owner', 'Reimbursable', '#2563eb'), ('other-tag', 'other', 'Private', '#2563eb')`,
    ).run();
    sql.prepare(
      `INSERT INTO merchants (id, user_id, name, normalized_name)
       VALUES ('merchant', 'owner', 'Old Shop', 'old shop'), ('other-merchant', 'other', 'Private Shop', 'private shop')`,
    ).run();
    sql.prepare(
      `INSERT INTO transactions
         (id, user_id, account_id, merchant_id, kind, status, amount_minor, occurred_at)
       VALUES ('historical', 'owner', 'account', 'merchant', 'expense', 'cleared', -1000, '2026-07-10')`,
    ).run();
    sql.prepare("INSERT INTO transaction_tags (transaction_id, tag_id) VALUES ('historical', 'tag')").run();
  });

  afterAll(() => {
    databaseModule.sqlite.close();
    delete (globalThis as typeof globalThis & { __ledgerLabConnection?: unknown }).__ledgerLabConnection;
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  });

  it("rejects archiving a parent until its active subcategories are archived", () => {
    expect(() => core.setCategoryArchived("owner", "parent", true)).toThrow(/active subcategories/i);
    expect(() => core.setCategoryArchived("other", "child", true)).toThrow(/not found/i);

    core.setCategoryArchived("owner", "child", true);
    core.setCategoryArchived("owner", "parent", true);
    expect(core.listCategories("owner")).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "parent" }),
      expect.objectContaining({ id: "child" }),
    ]));
    expect(core.listCategories("owner", true)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "parent", archivedAt: expect.any(String) }),
      expect.objectContaining({ id: "child", archivedAt: expect.any(String) }),
    ]));

    core.setCategoryArchived("owner", "parent", false);
    core.setCategoryArchived("owner", "child", false);
  });

  it("rejects comma-separated tag names consistently across managed and transaction entry", () => {
    expect(() => core.createTag("owner", { name: "Home, urgent" })).toThrow(/commas separate tags/i);
    expect(() => core.updateTag("owner", "tag", { name: "Home, urgent" })).toThrow(/commas separate tags/i);
    expect(() => core.createTransaction("owner", {
      kind: "expense",
      accountId: "account",
      amountMinor: 500,
      date: "2026-07-10",
      tags: ["Home, urgent"],
    })).toThrow(/commas separate tags/i);
  });

  it("keeps archived tag links in history and blocks reusing the tag on new entries", () => {
    expect(core.listTags("owner")).toEqual([
      expect.objectContaining({ id: "tag", usageCount: 1 }),
    ]);
    expect(() => core.setTagArchived("other", "tag", true)).toThrow(/not found/i);
    core.setTagArchived("owner", "tag", true);

    expect(core.listTags("owner")).toEqual([]);
    expect(core.listTags("owner", true)).toEqual([
      expect.objectContaining({ id: "tag", usageCount: 1, archivedAt: expect.any(String) }),
    ]);
    expect(() => core.createTransaction("owner", {
      kind: "expense",
      accountId: "account",
      amountMinor: 1200,
      date: "2026-07-11",
      tags: ["Reimbursable"],
    })).toThrow(/archived/i);
    expect(databaseModule.sqlite.prepare("SELECT COUNT(*) AS count FROM transaction_tags WHERE tag_id = 'tag'").get()).toEqual({ count: 1 });
  });

  it("preserves merchant history, enforces ownership, and applies an active default category", () => {
    expect(() => core.updateMerchant("other", "merchant", { name: "Wrong owner" })).toThrow(/not found/i);
    const updated = core.updateMerchant("owner", "merchant", {
      name: "Blue Market",
      defaultCategoryId: "expense-category",
    });
    expect(updated).toMatchObject({ name: "Blue Market", defaultCategoryId: "expense-category", transactionCount: 1 });

    const created = core.createTransaction("owner", {
      kind: "expense",
      accountId: "account",
      amountMinor: 2500,
      date: "2026-07-12",
      merchant: "Blue Market",
    });
    const createdRow = databaseModule.sqlite
      .prepare("SELECT category_id AS categoryId FROM transactions WHERE id = ?")
      .get(created.id) as { categoryId: string | null };
    expect(createdRow.categoryId).toBe("expense-category");

    core.setMerchantArchived("owner", "merchant", true);
    expect(core.listMerchants("owner")).toEqual([]);
    expect(core.listMerchants("owner", true)).toEqual([
      expect.objectContaining({ id: "merchant", name: "Blue Market", transactionCount: 2, archivedAt: expect.any(String) }),
    ]);
    expect(() => core.createTransaction("owner", {
      kind: "expense",
      accountId: "account",
      amountMinor: 3000,
      date: "2026-07-13",
      merchant: "Blue Market",
    })).toThrow(/archived/i);
    expect(databaseModule.sqlite.prepare("SELECT COUNT(*) AS count FROM transactions WHERE merchant_id = 'merchant'").get()).toEqual({ count: 2 });
  });
});
