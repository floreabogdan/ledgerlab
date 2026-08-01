import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

type DatabaseModule = typeof import("@/db");
type CoreModule = typeof import("@/server/core");
type FxModule = typeof import("@/server/fx");
type CrossRateObservation = Exclude<Parameters<FxModule["crossRateScaled"]>[0], "RON" | null>;

let db: DatabaseModule;
let core: CoreModule;
let fx: FxModule;
const originalDatabaseUrl = process.env.DATABASE_URL;
const networkFetch = vi.fn(() => Promise.reject(new Error("Unit tests must not call the live BNR feed")));

beforeAll(async () => {
  process.env.DATABASE_URL = ":memory:";
  vi.stubGlobal("fetch", networkFetch);
  vi.resetModules();
  delete (globalThis as typeof globalThis & { __ledgerLabConnection?: unknown }).__ledgerLabConnection;
  vi.unstubAllGlobals();
  db = await import("@/db");
  fx = await import("@/server/fx");
  core = await import("@/server/core");
  db.ensureDatabase();
  db.sqlite.prepare(
    `INSERT INTO users (id, email, normalized_email, password_hash, display_name)
     VALUES ('fx-owner', 'fx-owner@example.test', 'fx-owner@example.test', 'unused', 'FX Owner')`,
  ).run();
  db.sqlite.prepare(
    `INSERT INTO accounts
      (id, user_id, name, type, currency, opening_balance_minor, opening_balance_date)
     VALUES ('ron-current', 'fx-owner', 'RON current', 'current', 'RON', 100000, '2025-07-01')`,
  ).run();
  fx.persistBnrXml(
    `<?xml version="1.0" encoding="utf-8"?>
     <DataSet>
       <PublishingDate>2025-08-01</PublishingDate>
       <Cube date="2025-07-31">
         <Rate currency="USD">4.5000</Rate>
         <Rate currency="EUR">5.0000</Rate>
       </Cube>
       <Cube date="2025-08-01">
         <Rate currency="USD">4.6000</Rate>
         <Rate currency="HUF" multiplier="100">1.1600</Rate>
       </Cube>
     </DataSet>`,
    "https://www.bnr.ro/fx-test-fixture.xml",
    new Date().toISOString(),
  );
});

afterAll(() => {
  db.sqlite.close();
  delete (globalThis as typeof globalThis & { __ledgerLabConnection?: unknown }).__ledgerLabConnection;
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
});

function bnrObservation(rate: string, multiplier = 1): CrossRateObservation {
  return {
    publishedRateScaled: fx.parseRateDecimalToScaled(rate),
    multiplier,
  } as CrossRateObservation;
}

describe("FX scaled-rate parsing and normalization", () => {
  it("parses decimal quotes into the shared integer scale", () => {
    expect(fx.FX_RATE_SCALE).toBe(100_000_000);
    expect(fx.parseRateDecimalToScaled("4.6000")).toBe(460_000_000);
    expect(fx.parseRateDecimalToScaled("0.028514")).toBe(2_851_400);
  });

  it("normalizes BNR quotes published for 100 currency units", () => {
    const publishedForOneHundredHuf = fx.parseRateDecimalToScaled("1.1600");
    expect(fx.normalizeBnrRateScaled(publishedForOneHundredHuf, 100)).toBe(1_160_000);

    const ronPerHuf = fx.normalizeBnrRateScaled(publishedForOneHundredHuf, 100);
    expect(fx.convertMinorAtRate(10_000, ronPerHuf, 2, 2)).toBe(116);
  });
});

describe("FX cross rates", () => {
  it("treats RON and a missing observation as the identity quote", () => {
    expect(fx.crossRateScaled("RON", "RON")).toBe(fx.FX_RATE_SCALE);
    expect(fx.crossRateScaled(null, "RON")).toBe(fx.FX_RATE_SCALE);
    expect(fx.crossRateScaled("RON", null)).toBe(fx.FX_RATE_SCALE);
  });

  it("derives direct, inverse, and non-RON cross rates", () => {
    const usd = bnrObservation("4.6000");
    const eur = bnrObservation("5.0000");
    expect(fx.crossRateScaled(usd, "RON")).toBe(460_000_000);
    expect(fx.crossRateScaled("RON", usd)).toBe(21_739_130);
    expect(fx.crossRateScaled(usd, eur)).toBe(92_000_000);
  });
});

describe("minor-unit FX conversion", () => {
  it("books USD 20.00 paid from RON as RON 92.00 at 4.6000", () => {
    const rate = fx.parseRateDecimalToScaled("4.6000");
    expect(fx.convertMinorAtRate(2_000, rate, 2, 2)).toBe(9_200);
  });

  it("rounds exact half-minor results away from zero", () => {
    const oneAndAHalf = fx.parseRateDecimalToScaled("1.5");
    expect(fx.convertMinorAtRate(1, oneAndAHalf, 2, 2)).toBe(2);
    expect(fx.convertMinorAtRate(-1, oneAndAHalf, 2, 2)).toBe(-2);
  });

  it("honors ISO minor-unit digits when converting JPY to RON", () => {
    expect(fx.currencyMinorUnitDigits("JPY")).toBe(0);
    expect(fx.currencyMinorUnitDigits("RON")).toBe(2);
    expect(fx.currencyMinorUnitDigits("KWD")).toBe(3);

    const ronPerJpy = fx.parseRateDecimalToScaled("0.028514");
    expect(fx.convertMinorAtRate(100, ronPerJpy, 0, 2)).toBe(285);
  });
});

describe("persisted BNR resolution and transaction preparation", () => {
  it("falls back from Sunday to the latest prior observation without looking ahead", () => {
    const quote = fx.findPersistedBnrQuote("2025-08-03", "USD", "RON");
    expect(quote).toMatchObject({
      requestedDate: "2025-08-03",
      rateDate: "2025-08-01",
      fromCurrency: "USD",
      toCurrency: "RON",
      rateScaled: 460_000_000,
      rateScale: 100_000_000,
      source: "bnr",
      isFallback: true,
      fallbackDays: 2,
      fromMinorUnitDigits: 2,
      toMinorUnitDigits: 2,
    });
    expect(quote?.sourceUrls).toEqual(["https://www.bnr.ro/fx-test-fixture.xml"]);
  });

  it("uses the latest date common to both currencies for a cross quote", () => {
    const quote = fx.findPersistedBnrQuote("2025-08-01", "USD", "EUR");
    expect(quote).toMatchObject({
      rateDate: "2025-07-31",
      rateScaled: 90_000_000,
      isFallback: true,
      fallbackDays: 1,
    });
  });

  it("prepares and validates the persisted BNR snapshot used for posting", async () => {
    const prepared = await fx.prepareTransactionFx(
      "fx-owner",
      "ron-current",
      "expense",
      9_200,
      "2025-08-03",
      { originalAmountMinor: 2_000, originalCurrency: "usd", fxRateSource: "bnr" },
    );
    expect(prepared).toEqual({
      originalAmountMinor: 2_000,
      originalCurrency: "USD",
      fxRateScaled: 460_000_000,
      fxRateSource: "bnr",
      fxRateDate: "2025-08-01",
    });

    expect(() => fx.validateTransactionFxForPosting(
      "RON",
      "expense",
      9_200,
      "2025-08-03",
      prepared,
    )).not.toThrow();
  });

  it("keeps a manual rate and the official BNR reference as separate snapshots", async () => {
    const prepared = await fx.prepareTransactionFx(
      "fx-owner",
      "ron-current",
      "expense",
      9_000,
      "2025-08-03",
      {
        originalAmountMinor: 2_000,
        originalCurrency: "USD",
        fxRateScaled: 450_000_000,
        fxRateSource: "manual",
        fxRateDate: "2025-08-03",
        referenceFxRateScaled: 460_000_000,
        referenceFxRateDate: "2025-08-01",
      },
    );
    expect(prepared).toEqual({
      originalAmountMinor: 2_000,
      originalCurrency: "USD",
      fxRateScaled: 450_000_000,
      fxRateSource: "manual",
      fxRateDate: "2025-08-03",
      referenceFxRateScaled: 460_000_000,
      referenceFxRateDate: "2025-08-01",
    });
  });

  it("rejects a posted account amount that does not reconcile to the persisted rate", async () => {
    await expect(fx.prepareTransactionFx(
      "fx-owner",
      "ron-current",
      "expense",
      9_100,
      "2025-08-03",
      { originalAmountMinor: 2_000, originalCurrency: "USD", fxRateSource: "bnr" },
    )).rejects.toThrow(/does not match/i);
  });

  it("persists both BNR and manual FX snapshots through the ledger writer", async () => {
    const bnrFx = await fx.prepareTransactionFx(
      "fx-owner",
      "ron-current",
      "expense",
      9_200,
      "2025-08-03",
      { originalAmountMinor: 2_000, originalCurrency: "USD", fxRateSource: "bnr" },
    );
    const bnrTransaction = core.createTransaction("fx-owner", {
      kind: "expense",
      accountId: "ron-current",
      amountMinor: 9_200,
      date: "2025-08-03",
      merchant: "BNR-priced purchase",
      ...bnrFx,
    });

    const manualFx = await fx.prepareTransactionFx(
      "fx-owner",
      "ron-current",
      "expense",
      9_000,
      "2025-08-03",
      {
        originalAmountMinor: 2_000,
        originalCurrency: "USD",
        fxRateScaled: 450_000_000,
        fxRateSource: "manual",
        fxRateDate: "2025-08-03",
        referenceFxRateScaled: 460_000_000,
        referenceFxRateDate: "2025-08-01",
      },
    );
    const manualTransaction = core.createTransaction("fx-owner", {
      kind: "expense",
      accountId: "ron-current",
      amountMinor: 9_000,
      date: "2025-08-03",
      merchant: "Manual-rate purchase",
      ...manualFx,
    });

    const persisted = new Map(core.listTransactions("fx-owner").map((item) => [item.id, item]));
    expect(persisted.get(bnrTransaction.id)).toMatchObject({
      amountMinor: -9_200,
      currency: "RON",
      originalAmountMinor: 2_000,
      originalCurrency: "USD",
      fxRateScaled: 460_000_000,
      fxRateSource: "bnr",
      fxRateDate: "2025-08-01",
      referenceFxRateScaled: null,
      referenceFxRateDate: null,
    });
    expect(persisted.get(manualTransaction.id)).toMatchObject({
      amountMinor: -9_000,
      currency: "RON",
      originalAmountMinor: 2_000,
      originalCurrency: "USD",
      fxRateScaled: 450_000_000,
      fxRateSource: "manual",
      fxRateDate: "2025-08-03",
      referenceFxRateScaled: 460_000_000,
      referenceFxRateDate: "2025-08-01",
    });

    const account = core.listAccounts("fx-owner").find((item) => item.id === "ron-current");
    expect(account?.balanceMinor).toBe(81_800);
    expect(networkFetch).not.toHaveBeenCalled();
  });

  it("creates an account in a currency different from the reporting currency", () => {
    const account = core.createAccount("fx-owner", {
      name: "EUR savings",
      type: "savings",
      currency: "EUR",
      openingBalanceMinor: 0,
      openingDate: "2025-07-01",
    });
    expect(account).toMatchObject({ name: "EUR savings", currency: "EUR", balanceMinor: 0 });
  });

  it("posts a cross-currency transfer as two native account amounts with FX on the destination leg", async () => {
    const euro = core.listAccounts("fx-owner").find((account) => account.currency === "EUR")
      ?? core.createAccount("fx-owner", {
        name: "EUR transfer account",
        type: "savings",
        currency: "EUR",
        openingBalanceMinor: 0,
        openingDate: "2025-07-01",
      });
    if (!euro) throw new Error("EUR account was not created");
    const sourceBefore = core.listAccounts("fx-owner").find((account) => account.id === "ron-current")?.balanceMinor ?? 0;
    const destinationBefore = core.listAccounts("fx-owner").find((account) => account.id === euro.id)?.balanceMinor ?? 0;
    const prepared = await fx.prepareTransferFx(
      "fx-owner",
      "ron-current",
      euro.id,
      50_000,
      "2025-07-31",
      { fxRateSource: "bnr" },
    );
    expect(prepared).toEqual({
      destinationAmountMinor: 10_000,
      fxRateScaled: 20_000_000,
      fxRateSource: "bnr",
      fxRateDate: "2025-07-31",
    });

    const transfer = core.createTransaction("fx-owner", {
      kind: "transfer",
      accountId: "ron-current",
      transferAccountId: euro.id,
      amountMinor: 50_000,
      date: "2025-07-31",
      duplicateConfirmed: true,
      ...prepared,
    });
    const rows = db.sqlite.prepare(
      `SELECT account_id AS accountId, amount_minor AS amountMinor, currency,
              original_amount_minor AS originalAmountMinor, original_currency AS originalCurrency,
              fx_rate_scaled AS fxRateScaled, fx_rate_source AS fxRateSource, fx_rate_date AS fxRateDate
         FROM transactions WHERE transfer_group_id = ? ORDER BY amount_minor`,
    ).all(transfer.transferGroupId) as Array<Record<string, unknown>>;
    expect(rows).toEqual([
      expect.objectContaining({
        accountId: "ron-current",
        amountMinor: -50_000,
        currency: "RON",
        originalAmountMinor: null,
        fxRateScaled: null,
      }),
      expect.objectContaining({
        accountId: euro.id,
        amountMinor: 10_000,
        currency: "EUR",
        originalAmountMinor: 50_000,
        originalCurrency: "RON",
        fxRateScaled: 20_000_000,
        fxRateSource: "bnr",
        fxRateDate: "2025-07-31",
      }),
    ]);
    expect(core.listAccounts("fx-owner").find((account) => account.id === "ron-current")?.balanceMinor)
      .toBe(sourceBefore - 50_000);
    expect(core.listAccounts("fx-owner").find((account) => account.id === euro.id)?.balanceMinor)
      .toBe(destinationBefore + 10_000);
  });

  it("rejects a cross-currency transfer whose explicit destination amount disagrees with the rate", async () => {
    const euro = core.listAccounts("fx-owner").find((account) => account.currency === "EUR");
    if (!euro) throw new Error("EUR account was not created");
    await expect(fx.prepareTransferFx(
      "fx-owner",
      "ron-current",
      euro.id,
      50_000,
      "2025-07-31",
      { destinationAmountMinor: 9_999, fxRateSource: "bnr" },
    )).rejects.toThrow(/destination amount/i);
  });

  it("converts transaction-page totals to reporting currency and marks uncached totals unavailable", () => {
    const euro = core.listAccounts("fx-owner").find((account) => account.currency === "EUR");
    if (!euro) throw new Error("EUR account was not created");
    core.createTransaction("fx-owner", {
      kind: "income",
      accountId: euro.id,
      amountMinor: 9_000,
      date: "2025-07-31",
      duplicateConfirmed: true,
    });
    expect(core.listTransactionPage("fx-owner", { from: "2025-07-31", to: "2025-07-31" }).summary)
      .toMatchObject({
        currency: "USD",
        monetaryTotalsAvailable: true,
        incomeMinor: 10_000,
        netSpendingMinor: 0,
      });

    core.createTransaction("fx-owner", {
      kind: "income",
      accountId: euro.id,
      amountMinor: 1_000,
      date: "2025-07-01",
      duplicateConfirmed: true,
    });
    expect(core.listTransactionPage("fx-owner", { from: "2025-07-01", to: "2025-07-01" }).summary)
      .toMatchObject({
        currency: "USD",
        monetaryTotalsAvailable: false,
        incomeMinor: null,
        netSpendingMinor: null,
        missingFx: ["2025-07-01:EUR/USD"],
      });
  });

  it("settles and undoes a USD planned payment from a RON account using planned-currency progress", async () => {
    const nativeDefault = core.createPlannedPayment("fx-owner", {
      name: "RON account-native plan",
      expectedAmountMinor: 1_000,
      dueDate: "2025-08-09",
      accountId: "ron-current",
    });
    expect(nativeDefault.currency).toBe("RON");
    const plan = core.createPlannedPayment("fx-owner", {
      name: "USD phone bill",
      expectedAmountMinor: 4_000,
      currency: "USD",
      dueDate: "2025-08-10",
      type: "expense",
      accountId: "ron-current",
    });
    const balanceBefore = core.listAccounts("fx-owner").find((account) => account.id === "ron-current")?.balanceMinor ?? 0;
    const prepared = await core.preparePlannedOccurrencePayment("fx-owner", plan.id, {
      amountMinor: 9_200,
      appliedAmountMinor: 2_000,
      accountId: "ron-current",
      date: "2025-08-03",
      partial: true,
      fxRateSource: "bnr",
    });
    expect(prepared).toMatchObject({
      amountMinor: 9_200,
      appliedAmountMinor: 2_000,
      originalAmountMinor: 2_000,
      originalCurrency: "USD",
      fxRateScaled: 460_000_000,
      fxRateSource: "bnr",
      fxRateDate: "2025-08-01",
    });
    const paid = core.payPlannedOccurrence("fx-owner", plan.id, prepared);
    expect(paid).toMatchObject({
      status: "scheduled",
      paidAmountMinor: 2_000,
      appliedAmountMinor: 2_000,
      plannedCurrency: "USD",
      accountAmountMinor: 9_200,
      accountCurrency: "RON",
    });
    expect(db.sqlite.prepare(
      `SELECT amount_minor AS amountMinor, currency, original_amount_minor AS originalAmountMinor,
              original_currency AS originalCurrency, fx_rate_scaled AS fxRateScaled,
              fx_rate_source AS fxRateSource, fx_rate_date AS fxRateDate
         FROM transactions WHERE id = ?`,
    ).get(paid.transactionId)).toEqual({
      amountMinor: -9_200,
      currency: "RON",
      originalAmountMinor: 2_000,
      originalCurrency: "USD",
      fxRateScaled: 460_000_000,
      fxRateSource: "bnr",
      fxRateDate: "2025-08-01",
    });
    expect(db.sqlite.prepare(
      `SELECT o.paid_amount_minor AS paidAmountMinor, o.status,
              link.applied_amount_minor AS appliedAmountMinor
         FROM planned_payment_occurrences o
         JOIN planned_payment_transactions link ON link.occurrence_id = o.id
        WHERE o.id = ?`,
    ).get(plan.id)).toEqual({ paidAmountMinor: 2_000, status: "scheduled", appliedAmountMinor: 2_000 });
    expect(core.listAccounts("fx-owner").find((account) => account.id === "ron-current")?.balanceMinor)
      .toBe(balanceBefore - 9_200);

    expect(core.undoPlannedOccurrence("fx-owner", plan.id)).toMatchObject({ success: true, voidedTransactions: 1 });
    expect(db.sqlite.prepare(
      "SELECT paid_amount_minor AS paidAmountMinor, status FROM planned_payment_occurrences WHERE id = ?",
    ).get(plan.id)).toEqual({ paidAmountMinor: 0, status: "planned" });
    expect(db.sqlite.prepare("SELECT status FROM transactions WHERE id = ?").get(paid.transactionId))
      .toEqual({ status: "void" });
    expect(db.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM planned_payment_transactions WHERE occurrence_id = ?",
    ).get(plan.id)).toEqual({ count: 0 });
    expect(core.listAccounts("fx-owner").find((account) => account.id === "ron-current")?.balanceMinor)
      .toBe(balanceBefore);
  });
});
