import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import BetterSqlite3 from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, describe, expect, it } from "vitest";

import { schema } from "@/db/schema";

const migrationsFolder = path.resolve(process.cwd(), "drizzle");
const journal = JSON.parse(
  readFileSync(path.join(migrationsFolder, "meta", "_journal.json"), "utf8"),
) as { entries: Array<{ tag: string; when: number }> };

function migrationStatements(tag: string): string[] {
  return readFileSync(path.join(migrationsFolder, `${tag}.sql`), "utf8")
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

function legacyDatabase(): BetterSqlite3.Database {
  const connection = new BetterSqlite3(":memory:");
  connection.pragma("foreign_keys = ON");
  for (const entry of journal.entries.slice(0, 5)) {
    for (const statement of migrationStatements(entry.tag)) connection.exec(statement);
  }
  connection.exec(`CREATE TABLE __drizzle_migrations (
    id SERIAL PRIMARY KEY,
    hash text NOT NULL,
    created_at numeric
  )`);
  const legacyEntry = journal.entries[4]!;
  const legacySql = readFileSync(path.join(migrationsFolder, `${legacyEntry.tag}.sql`));
  connection.prepare(
    "INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)",
  ).run(createHash("sha256").update(legacySql).digest("hex"), legacyEntry.when);
  return connection;
}

function migrateLegacy(connection: BetterSqlite3.Database): void {
  connection.pragma("foreign_keys = OFF");
  try {
    migrate(drizzle(connection, { schema }), { migrationsFolder });
    const violations = connection.pragma("foreign_key_check") as unknown[];
    if (violations.length) throw new Error(`Migration left ${violations.length} foreign-key violation(s).`);
  } finally {
    connection.pragma("foreign_keys = ON");
  }
}

function hasTable(connection: BetterSqlite3.Database, name: string): boolean {
  return Boolean(connection.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(name));
}

describe("household workspace migration", () => {
  const connections: BetterSqlite3.Database[] = [];
  afterEach(() => {
    while (connections.length) connections.pop()!.close();
  });

  function legacy(): BetterSqlite3.Database {
    const connection = legacyDatabase();
    connections.push(connection);
    return connection;
  }

  it("migrates an empty database and leaves all foreign keys valid", () => {
    const connection = legacy();
    migrateLegacy(connection);

    expect(connection.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(connection.pragma("foreign_key_check")).toEqual([]);
    expect(connection.prepare("SELECT count(*) FROM workspaces").pluck().get()).toBe(0);
    expect(connection.prepare("SELECT count(*) FROM workspace_members").pluck().get()).toBe(0);
    expect(connection.prepare("SELECT count(*) FROM workspace_invitations").pluck().get()).toBe(0);
  });

  it("backfills one private personal workspace without rewriting financial history", () => {
    const connection = legacy();
    connection.exec(`
      INSERT INTO users
        (id, email, normalized_email, password_hash, display_name, ui_language,
         default_currency, locale, time_zone, created_at, updated_at)
      VALUES
        ('owner', 'owner@example.test', 'owner@example.test', 'unused', 'Owner', 'ro',
         'RON', 'ro-RO', 'Europe/Bucharest', '2020-01-01', '2020-01-02'),
        ('former', 'former@example.test', 'former@example.test', 'unused', 'Former', 'en',
         'EUR', 'en-US', 'UTC', '2020-02-01', '2020-02-02');
      INSERT INTO sessions
        (id, user_id, token_hash, expires_at, last_seen_at, user_agent, ip_address, created_at)
      VALUES ('session', 'owner', 'digest', '2099-01-01', '2020-01-01', 'agent', '192.0.2.1', '2020-01-01');
      INSERT INTO accounts
        (id, user_id, name, type, currency, opening_balance_minor, opening_balance_date,
         credit_limit_minor, institution, color, icon, display_order, created_at, updated_at)
      VALUES
        ('cash', 'owner', 'Cash', 'current', 'RON', 123456, '2020-01-01', NULL,
         'Bank', '#123456', 'wallet', 4, '2020-01-01', '2020-01-02'),
        ('card', 'owner', 'Card', 'credit_card', 'RON', -10000, '2020-01-01', 500000,
         'Bank', '#654321', 'card', 5, '2020-01-01', '2020-01-02'),
        ('loan', 'owner', 'Loan', 'loan', 'RON', -1000000, '2020-01-01', NULL,
         'Bank', '#abcdef', 'loan', 6, '2020-01-01', '2020-01-02');
      INSERT INTO balance_snapshots (id, account_id, snapshot_date, balance_minor, source, created_at)
      VALUES ('snapshot', 'cash', '2020-01-31', 120000, 'manual', '2020-02-01');
      INSERT INTO categories
        (id, user_id, parent_id, name, kind, spending_nature, spending_priority, color, icon,
         display_order, created_at, updated_at)
      VALUES
        ('category', 'owner', NULL, 'Utilities', 'expense', 'fixed', 'essential', '#111111',
         'bolt', 3, '2020-01-01', '2020-01-02'),
        ('child-category', 'owner', 'category', 'Power', 'expense', 'fixed', 'essential',
         '#222222', 'power', 4, '2020-01-01', '2020-01-02');
      INSERT INTO merchants
        (id, user_id, name, normalized_name, default_category_id, notes, created_at, updated_at)
      VALUES ('merchant', 'owner', 'Power Co', 'power co', 'child-category', 'kept', '2020-01-01', '2020-01-02');
      INSERT INTO tags (id, user_id, name, color, created_at, updated_at)
      VALUES ('tag', 'owner', 'Shared', '#333333', '2020-01-01', '2020-01-02');
      INSERT INTO transactions
        (id, user_id, account_id, category_id, merchant_id, kind, status, amount_minor,
         currency, original_amount_minor, original_currency, fx_rate_scaled, fx_rate_source,
         fx_rate_date, reference_fx_rate_scaled, reference_fx_rate_date, occurred_at,
         merchant_text, notes, transfer_group_id, transfer_peer_id, duplicate_fingerprint,
         is_split, created_at, updated_at)
      VALUES
        ('expense', 'owner', 'cash', 'child-category', 'merchant', 'expense', 'cleared', -2500,
         'RON', -500, 'EUR', 500000000, 'manual', '2020-01-10', 499000000, '2020-01-09',
         '2020-01-10', 'POWER CO', 'invoice 1', NULL, NULL, 'fingerprint', true,
         '2020-01-10', '2020-01-11'),
        ('transfer-out', 'owner', 'cash', NULL, NULL, 'transfer', 'cleared', -10000, 'RON',
         NULL, NULL, NULL, NULL, NULL, NULL, NULL, '2020-01-12', NULL, NULL,
         'transfer-group', 'transfer-in', NULL, false, '2020-01-12', '2020-01-12'),
        ('transfer-in', 'owner', 'card', NULL, NULL, 'transfer', 'cleared', 10000, 'RON',
         NULL, NULL, NULL, NULL, NULL, NULL, NULL, '2020-01-12', NULL, NULL,
         'transfer-group', 'transfer-out', NULL, false, '2020-01-12', '2020-01-12');
      INSERT INTO transaction_splits (id, transaction_id, category_id, amount_minor, notes, display_order)
      VALUES ('split', 'expense', 'child-category', -2500, 'whole', 0);
      INSERT INTO transaction_tags (transaction_id, tag_id) VALUES ('expense', 'tag');
      INSERT INTO recurrence_rules
        (id, user_id, frequency, interval, start_date, end_date, occurrence_count, days_of_week,
         day_of_month, month_of_year, adjustment, time_zone, created_at)
      VALUES ('rule', 'owner', 'monthly', 1, '2020-02-01', '2021-02-01', 12, '[1]', 1, 2,
              'clamp', 'Europe/Bucharest', '2020-01-01');
      INSERT INTO planned_payments
        (id, user_id, title, direction, expected_amount_minor, currency, due_date, account_id,
         category_id, merchant_id, recurrence_rule_id, notes, spending_nature, spending_priority,
         active, created_at, updated_at)
      VALUES ('planned', 'owner', 'Power bill', 'expense', 2500, 'RON', '2020-02-01', 'cash',
              'child-category', 'merchant', 'rule', 'keep', 'fixed', 'essential', true,
              '2020-01-01', '2020-01-02');
      INSERT INTO planned_payment_occurrences
        (id, planned_payment_id, due_date, expected_amount_minor, paid_amount_minor, status, created_at, updated_at)
      VALUES ('occurrence', 'planned', '2020-02-01', 2500, 2500, 'paid', '2020-01-01', '2020-02-01');
      INSERT INTO planned_payment_transactions (occurrence_id, transaction_id, applied_amount_minor, created_at)
      VALUES ('occurrence', 'expense', 2500, '2020-02-01');
      INSERT INTO credit_card_profiles (account_id, statement_day, due_day, purchase_apr_bps)
      VALUES ('card', 20, 10, 1800);
      INSERT INTO credit_card_statements
        (id, account_id, period_start, period_end, closing_date, due_date,
         statement_balance_minor, minimum_due_minor, payments_applied_minor, status)
      VALUES ('statement', 'card', '2020-01-01', '2020-01-31', '2020-01-31', '2020-02-10',
              10000, 1000, 10000, 'paid');
      INSERT INTO credit_card_payments
        (id, user_id, account_id, source_account_id, statement_id, payment_date, amount_minor,
         transfer_group_id, source_transaction_id, card_transaction_id, created_at, updated_at)
      VALUES ('card-payment', 'owner', 'card', 'cash', 'statement', '2020-02-01', 10000,
              'transfer-group', 'transfer-out', 'transfer-in', '2020-02-01', '2020-02-01');
      INSERT INTO loan_profiles
        (account_id, original_principal_minor, origination_date, first_payment_date, term_months,
         regular_payment_minor, interest_category_id, fee_category_id)
      VALUES ('loan', 1000000, '2020-01-01', '2020-02-01', 12, 90000, 'category', 'child-category');
      INSERT INTO loan_rate_periods
        (id, loan_account_id, effective_from, rate_type, fixed_rate_bps, margin_bps, created_at, updated_at)
      VALUES ('rate', 'loan', '2020-01-01', 'fixed', 500, 0, '2020-01-01', '2020-01-02');
      INSERT INTO loan_schedule_entries
        (id, loan_account_id, installment_number, due_date, opening_principal_minor, payment_minor,
         principal_minor, interest_minor, closing_principal_minor, annual_rate_bps)
      VALUES ('installment', 'loan', 1, '2020-02-01', 1000000, 90000, 85000, 5000, 915000, 500);
      INSERT INTO loan_payments
        (id, user_id, loan_account_id, source_account_id, schedule_entry_id, payment_date,
         total_minor, principal_minor, interest_minor, fees_minor, notes, created_at, updated_at)
      VALUES ('loan-payment', 'owner', 'loan', 'cash', 'installment', '2020-02-01',
              90000, 85000, 5000, 0, 'keep', '2020-02-01', '2020-02-01');
      INSERT INTO budgets
        (id, user_id, month, currency, category_id, amount_minor, rollover, notes, created_at, updated_at)
      VALUES ('budget', 'owner', '2020-02', 'RON', 'child-category', 50000, true, 'keep',
              '2020-01-01', '2020-01-02');
      INSERT INTO month_plans
        (id, user_id, month, currency, name, status, expected_income_minor,
         discretionary_target_minor, notes, created_at, updated_at)
      VALUES ('plan', 'owner', '2020-02', 'RON', 'February', 'active', 100000, 10000,
              'keep', '2020-01-01', '2020-01-02');
      INSERT INTO month_plan_accounts
        (id, month_plan_id, account_id, expected_opening_minor, expected_closing_minor)
      VALUES ('plan-account', 'plan', 'cash', 123456, 130000);
      INSERT INTO month_plan_items
        (id, month_plan_id, planned_payment_id, occurrence_id, account_id, category_id,
         title, direction, amount_minor, expected_date, spending_nature, spending_priority, source)
      VALUES ('plan-item', 'plan', 'planned', 'occurrence', 'cash', 'child-category',
              'Power bill', 'expense', 2500, '2020-02-01', 'fixed', 'essential', 'recurring');
      INSERT INTO plan_scenarios (id, month_plan_id, name, is_baseline, notes)
      VALUES ('scenario', 'plan', 'Baseline', true, 'keep');
      INSERT INTO scenario_adjustments
        (id, scenario_id, month_plan_item_id, account_id, title, amount_delta_minor, replacement_date, excluded)
      VALUES ('adjustment', 'scenario', 'plan-item', 'cash', 'Adjusted', 100, '2020-02-02', false);
      INSERT INTO attachments
        (id, user_id, transaction_id, file_name, storage_path, external_reference,
         mime_type, size_bytes, sha256, created_at)
      VALUES ('receipt', 'owner', 'expense', 'receipt.pdf', 'path', 'external',
              'application/pdf', 1234, 'abc', '2020-01-10');
      INSERT INTO import_batches
        (id, user_id, account_id, file_name, status, column_mapping, total_rows,
         imported_rows, duplicate_rows, invalid_rows, errors, created_at, completed_at)
      VALUES ('batch', 'owner', 'cash', 'bank.csv', 'imported', '{}', 1, 1, 0, 0,
              '[]', '2020-01-10', '2020-01-10');
      INSERT INTO import_records
        (id, batch_id, row_number, raw_data, status, transaction_id, validation_errors)
      VALUES ('record', 'batch', 1, '{}', 'imported', 'expense', '[]');
      INSERT INTO audit_logs
        (id, user_id, entity_type, entity_id, action, before, after, metadata, created_at)
      VALUES
        ('audit', 'owner', 'transaction', 'expense', 'create', '{"old":1}', '{"new":2}',
         '{"source":"test"}', '2020-01-10'),
        ('orphan-audit', 'former', 'user', 'former', 'delete', NULL, NULL, NULL, '2020-02-10');
      DELETE FROM users WHERE id = 'former';
    `);

    migrateLegacy(connection);

    expect(connection.pragma("foreign_key_check")).toEqual([]);
    expect(connection.prepare("SELECT * FROM workspaces").get()).toMatchObject({
      id: "owner",
      type: "personal",
      default_currency: "RON",
      time_zone: "Europe/Bucharest",
      created_by_user_id: "owner",
    });
    expect(connection.prepare("SELECT * FROM workspace_members").get()).toMatchObject({
      workspace_id: "owner",
      user_id: "owner",
      role: "owner",
    });
    expect(connection.prepare("SELECT active_workspace_id FROM sessions").pluck().get()).toBe("owner");
    expect(connection.prepare("SELECT is_installation_admin FROM users").pluck().get()).toBe(1);

    const rootTables = [
      "accounts", "categories", "merchants", "tags", "transactions", "recurrence_rules",
      "planned_payments", "credit_card_payments", "loan_payments", "budgets", "month_plans",
      "attachments", "import_batches",
    ];
    for (const table of rootTables) {
      expect(connection.prepare(`SELECT DISTINCT workspace_id FROM ${table}`).pluck().all(), table)
        .toEqual(["owner"]);
      const columns = connection.pragma(`table_info(${table})`) as Array<{ name: string; notnull: number }>;
      expect(columns.find((column) => column.name === "workspace_id")?.notnull, table).toBe(1);
      expect(columns.some((column) => column.name === "user_id"), table).toBe(false);
    }

    expect(connection.prepare(`SELECT opening_balance_minor, institution, color, icon, display_order
      FROM accounts WHERE id = 'cash'`).get()).toEqual({
      opening_balance_minor: 123456,
      institution: "Bank",
      color: "#123456",
      icon: "wallet",
      display_order: 4,
    });
    expect(connection.prepare(`SELECT amount_minor, original_amount_minor, original_currency,
      fx_rate_scaled, fx_rate_date, reference_fx_rate_scaled, reference_fx_rate_date,
      notes, duplicate_fingerprint FROM transactions WHERE id = 'expense'`).get()).toEqual({
      amount_minor: -2500,
      original_amount_minor: -500,
      original_currency: "EUR",
      fx_rate_scaled: 500000000,
      fx_rate_date: "2020-01-10",
      reference_fx_rate_scaled: 499000000,
      reference_fx_rate_date: "2020-01-09",
      notes: "invoice 1",
      duplicate_fingerprint: "fingerprint",
    });
    expect(connection.prepare("SELECT transfer_peer_id FROM transactions WHERE id = 'transfer-out'").pluck().get())
      .toBe("transfer-in");
    expect(connection.prepare("SELECT transaction_id FROM planned_payment_transactions").pluck().get())
      .toBe("expense");
    expect(connection.prepare("SELECT storage_path, size_bytes, sha256 FROM attachments").get())
      .toEqual({ storage_path: "path", size_bytes: 1234, sha256: "abc" });
    expect(connection.prepare("SELECT before, after, metadata FROM audit_logs WHERE id = 'audit'").get())
      .toEqual({ before: '{"old":1}', after: '{"new":2}', metadata: '{"source":"test"}' });
    expect(connection.prepare(
      "SELECT workspace_id, actor_user_id FROM audit_logs WHERE id = 'orphan-audit'",
    ).get()).toEqual({ workspace_id: null, actor_user_id: null });
    expect(connection.prepare("SELECT count(*) FROM transaction_splits").pluck().get()).toBe(1);
    expect(connection.prepare("SELECT count(*) FROM transaction_tags").pluck().get()).toBe(1);
    expect(connection.prepare("SELECT count(*) FROM month_plan_items").pluck().get()).toBe(1);
    expect(connection.prepare("SELECT count(*) FROM import_records").pluck().get()).toBe(1);
  });

  it("enforces personal membership, household ownership, invitations, and user deletion safety", () => {
    const connection = legacy();
    migrateLegacy(connection);
    connection.exec(`
      INSERT INTO users (id, email, normalized_email, password_hash, display_name)
      VALUES
        ('personal-owner', 'personal@example.test', 'personal@example.test', 'unused', 'Personal'),
        ('owner', 'owner@example.test', 'owner@example.test', 'unused', 'Owner'),
        ('member', 'member@example.test', 'member@example.test', 'unused', 'Member');
      INSERT INTO workspaces (id, type, name, created_by_user_id)
      VALUES
        ('personal-owner', 'personal', 'Personal', 'personal-owner'),
        ('household', 'household', 'Household', 'owner');
      INSERT INTO workspace_members (workspace_id, user_id, role)
      VALUES
        ('personal-owner', 'personal-owner', 'owner'),
        ('household', 'owner', 'owner'),
        ('household', 'member', 'member');
      INSERT INTO accounts
        (id, workspace_id, name, type, opening_balance_date)
      VALUES
        ('private-account', 'personal-owner', 'Private', 'current', '2020-01-01'),
        ('shared-account', 'household', 'Shared', 'current', '2020-01-01');
    `);

    expect(() => connection.prepare(
      "INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ('personal-owner', 'member', 'member')",
    ).run()).toThrow(/personal workspace membership is immutable/i);
    expect(() => connection.prepare(
      `INSERT INTO workspace_invitations
       (id, workspace_id, normalized_email, token_hash, expires_at, created_by_user_id)
       VALUES ('invite', 'personal-owner', 'member@example.test', 'hash', '2099-01-01', 'personal-owner')`,
    ).run()).toThrow(/personal workspaces cannot issue invitations/i);
    expect(() => connection.prepare(
      "UPDATE workspace_members SET role = 'member' WHERE workspace_id = 'household' AND user_id = 'owner'",
    ).run()).toThrow(/workspace must retain an owner/i);
    expect(() => connection.prepare("DELETE FROM users WHERE id = 'owner'").run())
      .toThrow(/workspace must retain an owner/i);

    connection.prepare("DELETE FROM users WHERE id = 'member'").run();
    expect(connection.prepare("SELECT name FROM workspaces WHERE id = 'household'").pluck().get())
      .toBe("Household");
    expect(connection.prepare("SELECT name FROM accounts WHERE id = 'shared-account'").pluck().get())
      .toBe("Shared");

    connection.prepare("DELETE FROM users WHERE id = 'personal-owner'").run();
    expect(connection.prepare("SELECT 1 FROM workspaces WHERE id = 'personal-owner'").get()).toBeUndefined();
    expect(connection.prepare("SELECT 1 FROM accounts WHERE id = 'private-account'").get()).toBeUndefined();
    expect(connection.pragma("foreign_key_check")).toEqual([]);
  });

  it("rolls the entire migration back when its final integrity guard finds corruption", () => {
    const connection = legacy();
    connection.pragma("foreign_keys = OFF");
    connection.prepare(`INSERT INTO balance_snapshots
      (id, account_id, snapshot_date, balance_minor) VALUES ('broken', 'missing', '2020-01-01', 1)`).run();
    connection.pragma("foreign_keys = ON");

    expect(() => migrateLegacy(connection)).toThrow(/__migration_fk_guard/i);
    expect(hasTable(connection, "workspaces")).toBe(false);
    const accountColumns = connection.pragma("table_info(accounts)") as Array<{ name: string }>;
    expect(accountColumns.some((column) => column.name === "user_id")).toBe(true);
    expect(accountColumns.some((column) => column.name === "workspace_id")).toBe(false);
    expect(connection.prepare("SELECT count(*) FROM __drizzle_migrations").pluck().get()).toBe(1);
  });

  it("rolls back when a legacy child points at another user's financial root", () => {
    const connection = legacy();
    connection.exec(`
      INSERT INTO users (id, email, normalized_email, password_hash, display_name)
      VALUES
        ('alice', 'alice@example.test', 'alice@example.test', 'unused', 'Alice'),
        ('bob', 'bob@example.test', 'bob@example.test', 'unused', 'Bob');
      INSERT INTO accounts
        (id, user_id, name, type, currency, opening_balance_minor, opening_balance_date)
      VALUES
        ('alice-account', 'alice', 'Alice account', 'current', 'USD', 0, '2026-01-01'),
        ('bob-account', 'bob', 'Bob account', 'current', 'USD', 0, '2026-01-01');
      INSERT INTO transactions
        (id, user_id, account_id, kind, status, amount_minor, currency, occurred_at)
      VALUES
        ('cross-user-transaction', 'alice', 'bob-account', 'expense', 'cleared', -100, 'USD', '2026-01-02');
    `);

    expect(() => migrateLegacy(connection)).toThrow(/__migration_fk_guard/i);
    expect(hasTable(connection, "workspaces")).toBe(false);
    expect(connection.prepare(
      "SELECT user_id, account_id FROM transactions WHERE id = 'cross-user-transaction'",
    ).get()).toEqual({ user_id: "alice", account_id: "bob-account" });
    expect(connection.prepare("SELECT count(*) FROM __drizzle_migrations").pluck().get()).toBe(1);
  });
});
