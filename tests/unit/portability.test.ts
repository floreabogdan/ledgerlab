import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type DatabaseModule = typeof import("@/db");
type CoreModule = typeof import("@/server/core");
type PortabilityModule = typeof import("@/server/portability");

let db: DatabaseModule;
let core: CoreModule;
let portability: PortabilityModule;
const originalDatabaseUrl = process.env.DATABASE_URL;
const ownerEmail = "owner@example.test";

function insertOwner(connection: BetterSqlite3.Database, id: string, email = ownerEmail) {
  connection.prepare(
    `INSERT INTO users (id, email, normalized_email, password_hash, display_name, default_currency)
     VALUES (?, ?, ?, 'unused', 'Owner', 'RON')`,
  ).run(id, email, email.trim().toLowerCase());
}

function backupEnvelope(connection: BetterSqlite3.Database) {
  const buffer = connection.serialize();
  return JSON.stringify({
    format: "ledgerlab-sqlite-v1",
    owner: ownerEmail,
    checksum: createHash("sha256").update(buffer).digest("hex"),
    database: buffer.toString("base64"),
  });
}

function stagedDatabaseFiles() {
  const directory = path.join(process.cwd(), "data", "restore-staging");
  if (!existsSync(directory)) return new Set<string>();
  return new Set(readdirSync(directory).filter((file) => file.endsWith(".db")));
}

beforeEach(async () => {
  process.env.DATABASE_URL = ":memory:";
  vi.resetModules();
  delete (globalThis as typeof globalThis & { __ledgerLabConnection?: unknown }).__ledgerLabConnection;
  db = await import("@/db");
  core = await import("@/server/core");
  portability = await import("@/server/portability");
  db.ensureDatabase();
  insertOwner(db.sqlite, "current-owner");
  db.sqlite.prepare(
    `INSERT INTO accounts
      (id, user_id, name, type, currency, opening_balance_minor, opening_balance_date)
     VALUES ('current-account', 'current-owner', 'Current account', 'current', 'RON', 100000, '2025-01-01')`,
  ).run();
});

afterEach(() => {
  db.sqlite.close();
  delete (globalThis as typeof globalThis & { __ledgerLabConnection?: unknown }).__ledgerLabConnection;
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
});

describe("CSV import safety", () => {
  it("rolls back the batch and every created record after an unexpected row failure", () => {
    expect(() => portability.commitImport("current-owner", {
      accountId: "current-account",
      rows: [{
        date: "2025-02-01",
        amountMinor: -1_000,
        merchant: "Rollback merchant",
        raw: { unsupported: 1n } as unknown as Record<string, string>,
      }],
    })).toThrow();

    expect(db.sqlite.prepare("SELECT COUNT(*) FROM import_batches").pluck().get()).toBe(0);
    expect(db.sqlite.prepare("SELECT COUNT(*) FROM import_records").pluck().get()).toBe(0);
    expect(db.sqlite.prepare("SELECT COUNT(*) FROM transactions").pluck().get()).toBe(0);
    expect(db.sqlite.prepare("SELECT COUNT(*) FROM merchants").pluck().get()).toBe(0);
    expect(db.sqlite.prepare("SELECT COUNT(*) FROM audit_logs").pluck().get()).toBe(0);
  });

  it("records impossible calendar dates and foreign categories as invalid without posting", () => {
    insertOwner(db.sqlite, "other-owner", "other@example.test");
    db.sqlite.prepare(
      "INSERT INTO categories (id, user_id, name, kind) VALUES ('other-category', 'other-owner', 'Private', 'expense')",
    ).run();

    const result = portability.commitImport("current-owner", {
      accountId: "current-account",
      rows: [{ date: "2025-02-30", amountMinor: -100, merchant: "Bad date" }, {
        date: "2025-02-01",
        amountMinor: -200,
        merchant: "Wrong category",
        categoryId: "other-category",
      }],
    });

    expect(result).toMatchObject({ importedRows: 0, invalidRows: 2 });
    expect(db.sqlite.prepare("SELECT COUNT(*) FROM transactions").pluck().get()).toBe(0);
    const records = db.sqlite.prepare(
      "SELECT status, validation_errors AS validationErrors FROM import_records ORDER BY row_number",
    ).all() as Array<{ status: string; validationErrors: string }>;
    expect(records.map((record) => record.status)).toEqual(["invalid", "invalid"]);
    expect(records[0].validationErrors).toContain("Invalid date or amount");
    expect(records[1].validationErrors).toContain("belongs to this profile");
  });

  it("can intentionally import a duplicate external id without violating its unique index", () => {
    const row = {
      date: "2025-02-01",
      amountMinor: -1_000,
      merchant: "Card purchase",
      externalId: "bank-row-1",
    };
    portability.commitImport("current-owner", { accountId: "current-account", rows: [row] });
    const forced = portability.commitImport("current-owner", {
      accountId: "current-account",
      rows: [row],
      duplicateStrategy: "import",
    });

    expect(forced).toMatchObject({ importedRows: 1, duplicateRows: 0, invalidRows: 0 });
    expect(db.sqlite.prepare("SELECT COUNT(*) FROM transactions").pluck().get()).toBe(2);
    expect(db.sqlite.prepare("SELECT COUNT(external_id) FROM transactions").pluck().get()).toBe(1);
    expect(db.sqlite.prepare(
      "SELECT COUNT(*) FROM import_records WHERE duplicate_of_transaction_id IS NOT NULL",
    ).pluck().get()).toBe(1);
  });

  it("rejects rather than silently dropping rows beyond the 10,000-row limit", () => {
    const lines = ["date,amount", ...Array.from({ length: 10_001 }, (_, index) => `2025-02-01,-${index + 1}.00`)];
    expect(() => portability.previewImport("current-owner", {
      accountId: "current-account",
      csv: lines.join("\n"),
    })).toThrow(/limited to 10,000 rows/i);
  });

  it("rejects CSV payloads above the advertised 20 MB limit before parsing", () => {
    const oversized = "x".repeat(20 * 1024 * 1024 + 1);
    expect(() => portability.previewImport("current-owner", { csv: oversized }))
      .toThrow(/smaller than 20 MB/i);
  });

  it("uses one-based row numbers when importing a headerless CSV", () => {
    const preview = portability.previewImport("current-owner", {
      accountId: "current-account",
      csv: "2025-02-01,-12.34",
      hasHeader: false,
      mapping: { date: "0", amount: "1" },
    });
    expect(preview.rows[0]).toMatchObject({ rowNumber: 1, date: "2025-02-01", amountMinor: -1_234, valid: true });
  });

  it("rejects ambiguous numeric dates until the importer chooses a format", () => {
    const input = {
      accountId: "current-account",
      csv: "date,amount\n03/04/2026,-12.34",
    };
    const automatic = portability.previewImport("current-owner", input);
    expect(automatic.rows[0]).toMatchObject({ date: null, valid: false });
    expect(automatic.rows[0].validationErrors).toContain(
      "Ambiguous date; choose DD/MM/YYYY or MM/DD/YYYY before importing",
    );

    expect(portability.previewImport("current-owner", {
      ...input,
      options: { dateFormat: "MM/dd/yyyy" },
    }).rows[0]).toMatchObject({ date: "2026-03-04", valid: true });
    expect(portability.previewImport("current-owner", {
      ...input,
      options: { dateFormat: "dd/MM/yyyy" },
    }).rows[0]).toMatchObject({ date: "2026-04-03", valid: true });
  });

  it("honors an explicitly selected decimal separator", () => {
    const csv = "date,amount\n2026-03-04,\"-1.234,56\"";
    const preview = portability.previewImport("current-owner", {
      accountId: "current-account",
      csv,
      options: { decimalSeparator: "," },
    });
    expect(preview.rows[0]).toMatchObject({ amountMinor: -123_456, valid: true });

    const malformedGrouping = portability.previewImport("current-owner", {
      accountId: "current-account",
      csv: "date,amount\n2026-03-04,\"12,34\"",
      options: { decimalSeparator: "." },
    });
    expect(malformedGrouping.rows[0]).toMatchObject({ amountMinor: null, valid: false });
  });
});

describe("portable exports", () => {
  it("neutralizes spreadsheet formulas in text cells without changing signed amount fields", () => {
    const dangerousPrefixes = ["=2+2", "+2+2", "-2+2", "@SUM(A:A)", "\t=2+2", "\r=2+2"];
    dangerousPrefixes.forEach((note, index) => {
      core.createTransaction("current-owner", {
        kind: "expense",
        accountId: "current-account",
        amountMinor: 1_000 + index,
        date: "2025-02-01",
        merchant: `Safe merchant ${index}`,
        note,
        tags: index < 4 ? [note] : undefined,
      });
    });

    const csv = portability.exportData("current-owner", "csv").body;
    for (const dangerous of dangerousPrefixes) expect(csv).toContain(`'${dangerous}`);
    expect(csv).toContain("-10.00,RON,-1000");
    expect(csv).not.toContain("'-10.00,RON");
  });

  it("includes every user-owned relationship table and detailed CSV columns", () => {
    db.sqlite.prepare(
      "INSERT INTO balance_snapshots (id, account_id, snapshot_date, balance_minor) VALUES ('snapshot', 'current-account', '2025-02-01', 99000)",
    ).run();
    db.sqlite.prepare(
      "INSERT INTO categories (id, user_id, name, kind) VALUES ('food', 'current-owner', 'Food', 'expense')",
    ).run();
    db.sqlite.prepare(
      "INSERT INTO tags (id, user_id, name) VALUES ('travel', 'current-owner', 'travel')",
    ).run();
    const transaction = core.createTransaction("current-owner", {
      kind: "expense",
      accountId: "current-account",
      amountMinor: 1_000,
      date: "2025-02-01",
      categoryId: "food",
      merchant: "=2+2",
      externalId: "bank-ref-42",
      tags: ["travel"],
      receiptReference: "receipt-42",
      splits: [{ categoryId: "food", amountMinor: 1_000, note: "full split" }],
    });

    const json = JSON.parse(portability.exportData("current-owner", "json").body) as {
      data: Record<string, unknown[]>;
      rowCounts: Record<string, number>;
    };
    const expectedTables = [
      "accounts", "balance_snapshots", "categories", "merchants", "tags", "transactions",
      "transaction_splits", "transaction_tags", "recurrence_rules", "planned_payments",
      "planned_payment_occurrences", "planned_payment_transactions", "budgets", "month_plans",
      "month_plan_accounts", "month_plan_items", "plan_scenarios", "scenario_adjustments",
      "attachments", "import_batches", "import_records", "audit_logs", "credit_card_profiles",
      "credit_card_statements", "credit_card_payments", "loan_profiles", "loan_rate_periods",
      "loan_schedule_entries", "loan_payments",
    ];
    expect(Object.keys(json.data)).toEqual(expectedTables);
    expect(json.rowCounts).toMatchObject({
      accounts: 1,
      balance_snapshots: 1,
      transactions: 1,
      transaction_splits: 1,
      transaction_tags: 1,
      attachments: 1,
    });
    expect(json.data.transactions).toEqual(expect.arrayContaining([expect.objectContaining({ id: transaction.id })]));

    const csv = portability.exportData("current-owner", "csv").body;
    expect(csv).toContain("reference_fx_rate,reference_fx_rate_scaled");
    expect(csv).toContain("account_id,category_id,transfer_group_id,transfer_peer_id,attachment_reference,planned_occurrence_id,external_id,splits_json");
    expect(csv).toContain("receipt-42");
    expect(csv).toContain("bank-ref-42");
    expect(csv).toContain("'=2+2");
    expect(csv).toContain("full split");

    const preview = portability.previewImport("current-owner", { csv, accountId: "current-account" });
    expect(preview.mapping.externalId).toBe("external_id");
  });
});

describe("full backup restore safety", () => {
  it("restores a legacy pre-liability backup through shared columns and removes its staging file", () => {
    const legacy = new BetterSqlite3(":memory:");
    try {
      const migration = readFileSync(path.join(process.cwd(), "drizzle", "0000_dizzy_exodus.sql"), "utf8");
      for (const statement of migration.split("--> statement-breakpoint").map((part) => part.trim()).filter(Boolean)) {
        legacy.exec(statement);
      }
      insertOwner(legacy, "legacy-owner");
      legacy.prepare(
        `INSERT INTO accounts
          (id, user_id, name, type, currency, opening_balance_minor, opening_balance_date)
         VALUES ('legacy-account', 'legacy-owner', 'Legacy account', 'current', 'RON', 42000, '2024-01-01')`,
      ).run();
      const beforeFiles = stagedDatabaseFiles();
      const result = portability.restoreBackup("current-owner", {
        backup: backupEnvelope(legacy),
        confirmation: "RESTORE",
      });
      const afterFiles = stagedDatabaseFiles();

      expect(result.success).toBe(true);
      expect(db.sqlite.prepare("SELECT id FROM accounts").pluck().all()).toEqual(["legacy-account"]);
      expect(db.sqlite.prepare("SELECT COUNT(*) FROM fx_rate_observations").pluck().get()).toBe(0);
      expect([...afterFiles].filter((file) => !beforeFiles.has(file))).toEqual([]);
    } finally {
      legacy.close();
    }
  });

  it("rejects a different owner before changing the current database", () => {
    const source = db.createMemoryDatabase();
    try {
      insertOwner(source.sqlite, "someone-else", "someone-else@example.test");
      expect(() => portability.restoreBackup("current-owner", {
        backup: backupEnvelope(source.sqlite),
        confirmation: "RESTORE",
      })).toThrow(/different local owner/i);
      expect(db.sqlite.prepare("SELECT id FROM accounts").pluck().all()).toEqual(["current-account"]);
    } finally {
      source.sqlite.close();
    }
  });

  it("rejects broken source relationships before changing the current database", () => {
    const source = db.createMemoryDatabase();
    try {
      insertOwner(source.sqlite, "backup-owner");
      source.sqlite.pragma("foreign_keys = OFF");
      source.sqlite.prepare(
        `INSERT INTO transactions
          (id, user_id, account_id, kind, status, amount_minor, currency, occurred_at)
         VALUES ('broken-transaction', 'backup-owner', 'missing-account', 'expense', 'cleared', -100, 'RON', '2025-02-01')`,
      ).run();
      source.sqlite.pragma("foreign_keys = ON");

      expect(() => portability.restoreBackup("current-owner", {
        backup: backupEnvelope(source.sqlite),
        confirmation: "RESTORE",
      })).toThrow(/broken relationships/i);
      expect(db.sqlite.prepare("SELECT id FROM accounts").pluck().all()).toEqual(["current-account"]);
    } finally {
      source.sqlite.close();
    }
  });

  it("restores mixed account currencies without relabelling native balances", () => {
    const source = db.createMemoryDatabase();
    try {
      insertOwner(source.sqlite, "backup-owner");
      source.sqlite.prepare(
        `INSERT INTO accounts
          (id, user_id, name, type, currency, opening_balance_minor, opening_balance_date)
         VALUES ('foreign-ledger', 'backup-owner', 'Foreign ledger', 'current', 'EUR', 10000, '2025-01-01')`,
      ).run();

      expect(portability.restoreBackup("current-owner", {
        backup: backupEnvelope(source.sqlite),
        confirmation: "RESTORE",
      })).toMatchObject({ success: true });
      expect(db.sqlite.prepare("SELECT id, currency FROM accounts ORDER BY id").all()).toEqual([
        { id: "foreign-ledger", currency: "EUR" },
      ]);
    } finally {
      source.sqlite.close();
    }
  });

  it("rejects a posted currency that does not match its account ledger", () => {
    const source = db.createMemoryDatabase();
    try {
      insertOwner(source.sqlite, "backup-owner");
      source.sqlite.prepare(
        `INSERT INTO accounts
          (id, user_id, name, type, currency, opening_balance_minor, opening_balance_date)
         VALUES ('eur-account', 'backup-owner', 'EUR account', 'current', 'EUR', 10000, '2025-01-01')`,
      ).run();
      source.sqlite.prepare(
        `INSERT INTO transactions
          (id, user_id, account_id, kind, status, amount_minor, currency, occurred_at)
         VALUES ('mismatched-posting', 'backup-owner', 'eur-account', 'expense', 'cleared', -100, 'RON', '2025-02-01')`,
      ).run();

      expect(() => portability.restoreBackup("current-owner", {
        backup: backupEnvelope(source.sqlite),
        confirmation: "RESTORE",
      })).toThrow(/does not match its account ledger/i);
      expect(db.sqlite.prepare("SELECT id FROM accounts").pluck().all()).toEqual(["current-account"]);
    } finally {
      source.sqlite.close();
    }
  });

  it("rejects unsupported restored currencies before replacing the current ledger", () => {
    const source = db.createMemoryDatabase();
    try {
      insertOwner(source.sqlite, "backup-owner");
      source.sqlite.prepare(
        `INSERT INTO accounts
          (id, user_id, name, type, currency, opening_balance_minor, opening_balance_date)
         VALUES ('unsupported-account', 'backup-owner', 'Unsupported account', 'current', 'ZZZ', 10000, '2025-01-01')`,
      ).run();

      expect(() => portability.restoreBackup("current-owner", {
        backup: backupEnvelope(source.sqlite),
        confirmation: "RESTORE",
      })).toThrow(/unsupported or non-canonical accounts? currency/i);
      expect(db.sqlite.prepare("SELECT id FROM accounts").pluck().all()).toEqual(["current-account"]);
    } finally {
      source.sqlite.close();
    }
  });

  it("rejects foreign transaction metadata that does not reconcile to the native posting", () => {
    const source = db.createMemoryDatabase();
    try {
      insertOwner(source.sqlite, "backup-owner");
      source.sqlite.prepare(
        `INSERT INTO accounts
          (id, user_id, name, type, currency, opening_balance_minor, opening_balance_date)
         VALUES ('ron-account', 'backup-owner', 'RON account', 'current', 'RON', 100000, '2025-01-01')`,
      ).run();
      source.sqlite.prepare(
        `INSERT INTO transactions
          (id, user_id, account_id, kind, status, amount_minor, currency, occurred_at,
           original_amount_minor, original_currency, fx_rate_scaled, fx_rate_source, fx_rate_date)
         VALUES ('bad-fx', 'backup-owner', 'ron-account', 'expense', 'cleared', -46000, 'RON', '2025-02-01',
                 10000, 'USD', 450000000, 'manual', '2025-02-01')`,
      ).run();

      expect(() => portability.restoreBackup("current-owner", {
        backup: backupEnvelope(source.sqlite),
        confirmation: "RESTORE",
      })).toThrow(/do not reconcile/i);
      expect(db.sqlite.prepare("SELECT id FROM accounts").pluck().all()).toEqual(["current-account"]);
    } finally {
      source.sqlite.close();
    }
  });

  it("rejects a cross-currency transfer whose native legs disagree with its FX rate", () => {
    const source = db.createMemoryDatabase();
    try {
      insertOwner(source.sqlite, "backup-owner");
      source.sqlite.prepare(
        `INSERT INTO accounts
          (id, user_id, name, type, currency, opening_balance_minor, opening_balance_date)
         VALUES
          ('ron-account', 'backup-owner', 'RON account', 'current', 'RON', 100000, '2025-01-01'),
          ('eur-account', 'backup-owner', 'EUR account', 'current', 'EUR', 0, '2025-01-01')`,
      ).run();
      source.sqlite.pragma("foreign_keys = OFF");
      source.sqlite.prepare(
        `INSERT INTO transactions
          (id, user_id, account_id, kind, status, amount_minor, currency, occurred_at,
           transfer_group_id, transfer_peer_id)
         VALUES ('bad-transfer-source', 'backup-owner', 'ron-account', 'transfer', 'cleared', -50000, 'RON', '2025-02-01',
                 'bad-transfer-group', 'bad-transfer-destination')`,
      ).run();
      source.sqlite.prepare(
        `INSERT INTO transactions
          (id, user_id, account_id, kind, status, amount_minor, currency, occurred_at,
           transfer_group_id, transfer_peer_id, original_amount_minor, original_currency,
           fx_rate_scaled, fx_rate_source, fx_rate_date)
         VALUES ('bad-transfer-destination', 'backup-owner', 'eur-account', 'transfer', 'cleared', 9999, 'EUR', '2025-02-01',
                 'bad-transfer-group', 'bad-transfer-source', 50000, 'RON', 20000000, 'manual', '2025-02-01')`,
      ).run();
      source.sqlite.pragma("foreign_keys = ON");

      expect(() => portability.restoreBackup("current-owner", {
        backup: backupEnvelope(source.sqlite),
        confirmation: "RESTORE",
      })).toThrow(/transfer group .* does not reconcile/i);
      expect(db.sqlite.prepare("SELECT id FROM accounts").pluck().all()).toEqual(["current-account"]);
    } finally {
      source.sqlite.close();
    }
  });

  it("rejects checksum tampering before writing a staging database", () => {
    const backup = portability.createBackup("current-owner");
    const beforeFiles = stagedDatabaseFiles();
    expect(() => portability.restoreBackup("current-owner", {
      backup: JSON.stringify({ ...backup, checksum: "0".repeat(64) }),
      confirmation: "RESTORE",
    })).toThrow(/checksum/i);
    expect(db.sqlite.prepare("SELECT id FROM accounts").pluck().all()).toEqual(["current-account"]);
    expect(stagedDatabaseFiles()).toEqual(beforeFiles);
  });
});
