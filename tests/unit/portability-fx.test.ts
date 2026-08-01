import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

type DatabaseModule = typeof import("@/db");
type PortabilityModule = typeof import("@/server/portability");
type CoreModule = typeof import("@/server/core");

describe("foreign-currency CSV portability", () => {
  let db: DatabaseModule;
  let portability: PortabilityModule;
  let core: CoreModule;
  const originalDatabaseUrl = process.env.DATABASE_URL;

  beforeAll(async () => {
    process.env.DATABASE_URL = ":memory:";
    vi.resetModules();
    delete (globalThis as typeof globalThis & { __ledgerLabConnection?: unknown }).__ledgerLabConnection;
    db = await import("@/db");
    core = await import("@/server/core");
    portability = await import("@/server/portability");
    db.ensureDatabase();
    db.sqlite.prepare(
      `INSERT INTO users
        (id, email, normalized_email, password_hash, display_name, default_currency)
       VALUES ('owner', 'owner@example.test', 'owner@example.test', 'unused', 'Owner', 'RON')`,
    ).run();
    db.sqlite.prepare(
      `INSERT INTO accounts
        (id, user_id, name, type, currency, opening_balance_minor, opening_balance_date)
       VALUES ('cash', 'owner', 'Main account', 'current', 'RON', 100000, '2025-08-01')`,
    ).run();
  });

  afterAll(() => {
    db.sqlite.close();
    delete (globalThis as typeof globalThis & { __ledgerLabConnection?: unknown }).__ledgerLabConnection;
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  });

  it("previews, posts, and exports both original and account amounts", () => {
    const csv = [
      "date,amount,merchant,original_amount,original_currency,fx_rate",
      "2025-08-03,-92.00,Phone provider,-20.00,USD,4.6",
    ].join("\n");
    const preview = portability.previewImport("owner", {
      accountId: "cash",
      csv,
      mapping: {
        date: "date",
        amount: "amount",
        merchant: "merchant",
        originalAmount: "original_amount",
        originalCurrency: "original_currency",
        exchangeRate: "fx_rate",
      },
    });

    expect(preview).toMatchObject({ validCount: 1, invalidCount: 0 });
    const row = preview.rows[0];
    expect(row).toMatchObject({
      amountMinor: -9_200,
      currency: "RON",
      originalAmountMinor: 2_000,
      originalCurrency: "USD",
      fxRateScaled: 460_000_000,
      fxRateSource: "manual",
      fxRateDate: "2025-08-03",
      valid: true,
    });

    portability.commitImport("owner", {
      accountId: "cash",
      rows: [{
        date: row.date!,
        amountMinor: row.amountMinor!,
        description: row.description,
        merchant: row.merchant,
        raw: row.raw,
        originalAmountMinor: row.originalAmountMinor,
        originalCurrency: row.originalCurrency,
        fxRateScaled: row.fxRateScaled,
        fxRateSource: row.fxRateSource,
        fxRateDate: row.fxRateDate,
      }],
    });

    expect(core.listAccounts("owner")[0].balanceMinor).toBe(90_800);
    expect(core.listTransactions("owner")[0]).toMatchObject({
      amountMinor: -9_200,
      currency: "RON",
      originalAmountMinor: 2_000,
      originalCurrency: "USD",
      fxRateScaled: 460_000_000,
      fxRateSource: "manual",
    });

    const csvExport = portability.exportData("owner", "csv").body;
    expect(csvExport).toContain("amount,currency,amount_minor,original_amount,original_currency,original_amount_minor");
    expect(csvExport).toContain("-92.00,RON,-9200,-20.00,USD,2000,4.6,460000000,100000000,manual");

    const jsonExport = JSON.parse(portability.exportData("owner", "json").body) as Record<string, unknown>;
    expect(jsonExport).toMatchObject({
      format: "ledgerlab-export-v2",
      fxRateScale: 100_000_000,
      profile: { defaultCurrency: "RON" },
    });
  });
});
