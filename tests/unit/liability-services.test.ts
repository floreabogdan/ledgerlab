import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

type DatabaseModule = typeof import("@/db");
type LiabilityModule = typeof import("@/server/liabilities");
type InsightsModule = typeof import("@/server/insights");
type CoreModule = typeof import("@/server/core");

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

describe("liability posting and forecasting services", () => {
  let db: DatabaseModule;
  let liabilities: LiabilityModule;
  let insights: InsightsModule;
  let core: CoreModule;
  const originalDatabaseUrl = process.env.DATABASE_URL;

  function seedEurRate() {
    db.sqlite.prepare(
      `INSERT OR IGNORE INTO fx_rate_observations
        (id, rate_date, currency, published_rate_scaled, multiplier, source_url, fetched_at)
       VALUES ('liability-eur-2026-08-01', '2026-08-01', 'EUR', 500000000, 1,
               'https://www.bnr.ro/test-fixture', '2026-08-01T12:00:00.000Z')`,
    ).run();
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = ":memory:";
    vi.resetModules();
    delete (globalThis as typeof globalThis & { __ledgerLabConnection?: unknown }).__ledgerLabConnection;
    db = await import("@/db");
    liabilities = await import("@/server/liabilities");
    insights = await import("@/server/insights");
    core = await import("@/server/core");
    db.ensureDatabase();
    db.sqlite.prepare(
      `INSERT INTO users (id, email, normalized_email, password_hash, display_name, default_currency)
       VALUES ('owner', 'owner@example.test', 'owner@example.test', 'unused', 'Owner', 'RON')`,
    ).run();
    db.sqlite.prepare(
      `INSERT INTO accounts
        (id, user_id, name, type, currency, opening_balance_minor, opening_balance_date, credit_limit_minor)
       VALUES
        ('cash', 'owner', 'Main account', 'current', 'RON', 1000000, '2026-07-01', NULL),
        ('card', 'owner', 'Daily card', 'credit_card', 'RON', -500000, '2026-07-01', 500000),
        ('loan', 'owner', 'Home loan', 'loan', 'RON', -1200000, '2026-07-01', NULL)`,
    ).run();
    db.sqlite.prepare(
      `INSERT INTO categories (id, user_id, name, kind, spending_nature, spending_priority)
       VALUES
        ('interest', 'owner', 'Loan interest', 'expense', 'fixed', 'essential'),
        ('fees', 'owner', 'Bank fees', 'expense', 'fixed', 'essential')`,
    ).run();
  });

  afterAll(() => {
    db.sqlite.close();
    delete (globalThis as typeof globalThis & { __ledgerLabConnection?: unknown }).__ledgerLabConnection;
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  });

  it("posts card payments as transfers and can undo one payment group", () => {
    liabilities.saveCreditCardProfile("owner", "card", {
      creditLimitMinor: 500000,
      paymentPreference: "full_statement",
    });
    liabilities.createCreditCardStatement("owner", "card", {
      periodStart: "2026-07-01",
      periodEnd: "2026-07-30",
      closingDate: "2026-07-30",
      dueDate: "2026-08-10",
      statementBalanceMinor: 500000,
      minimumDueMinor: 50000,
    });
    const before = liabilities.listLiabilityObligations("owner", { from: "2026-08-01", to: "2026-08-31" });
    expect(before).toEqual([
      expect.objectContaining({
        sourceType: "credit_card_statement",
        cashFlowAmountMinor: 500000,
        spendingAmountMinor: 0,
        principalAmountMinor: 500000,
      }),
    ]);

    const statementId = String((liabilities.liabilityAccountDetail("owner", "card").statements as Array<{ id: string }>)[0].id);
    const payment = liabilities.recordCreditCardPayment("owner", "card", {
      statementId,
      sourceAccountId: "cash",
      date: "2026-08-01",
      amountMinor: 100000,
    });
    const balances = new Map(insights.accountsPayload("owner").accounts.map((account) => [account.id, account.balanceMinor]));
    expect(balances.get("cash")).toBe(900000);
    expect(balances.get("card")).toBe(-400000);
    expect(insights.statistics("owner", 3, { from: "2026-08-01", to: "2026-08-31" }).summary.spendingMinor).toBe(0);

    const cardTransaction = db.sqlite.prepare(
      "SELECT source_transaction_id AS id FROM credit_card_payments WHERE id = ?",
    ).get(payment.paymentId) as { id: string };
    expect(() => core.voidTransaction("owner", cardTransaction.id)).toThrow(/liability-payment undo/i);

    liabilities.undoLiabilityPayment("owner", payment.paymentId);
    const restored = new Map(insights.accountsPayload("owner").accounts.map((account) => [account.id, account.balanceMinor]));
    expect(restored.get("cash")).toBe(1000000);
    expect(restored.get("card")).toBe(-500000);
    expect(() => liabilities.undoLiabilityPayment("owner", payment.paymentId)).toThrow(/already undone/i);
  });

  it("recomputes statement allocation when undoing a capped card overpayment", () => {
    db.sqlite.prepare(
      `INSERT INTO accounts
        (id, user_id, name, type, currency, opening_balance_minor, opening_balance_date, credit_limit_minor)
       VALUES ('overpayment-card', 'owner', 'Overpayment card', 'credit_card', 'RON', -100000, '2026-08-01', 200000)`,
    ).run();
    liabilities.saveCreditCardProfile("owner", "overpayment-card", {
      creditLimitMinor: 200000,
      paymentPreference: "full_statement",
    });
    liabilities.createCreditCardStatement("owner", "overpayment-card", {
      periodStart: "2026-08-01",
      periodEnd: "2026-08-31",
      closingDate: "2026-08-31",
      dueDate: "2027-01-15",
      statementBalanceMinor: 100000,
      minimumDueMinor: 10000,
    });
    const statementId = String(
      (liabilities.liabilityAccountDetail("owner", "overpayment-card").statements as Array<{ id: string }>)[0].id,
    );
    const initialPayment = liabilities.recordCreditCardPayment("owner", "overpayment-card", {
      statementId,
      sourceAccountId: "cash",
      date: "2026-08-01",
      amountMinor: 80000,
    });
    const overpayment = liabilities.recordCreditCardPayment("owner", "overpayment-card", {
      statementId,
      sourceAccountId: "cash",
      date: "2026-08-01",
      amountMinor: 50000,
    });
    expect(db.sqlite.prepare(
      "SELECT payments_applied_minor AS applied, status FROM credit_card_statements WHERE id = ?",
    ).get(statementId)).toEqual({ applied: 100000, status: "paid" });

    liabilities.undoLiabilityPayment("owner", overpayment.paymentId);

    expect(db.sqlite.prepare(
      "SELECT payments_applied_minor AS applied, status FROM credit_card_statements WHERE id = ?",
    ).get(statementId)).toEqual({ applied: 80000, status: "open" });
    expect((liabilities.liabilityAccountDetail("owner", "overpayment-card").statements as Array<{ id: string; status: string }>)
      .find((statement) => statement.id === statementId)).toMatchObject({ status: "partial" });
    liabilities.undoLiabilityPayment("owner", initialPayment.paymentId);
  });

  it("derives overdue card-statement status even when persisted status is stale", () => {
    liabilities.createCreditCardStatement("owner", "card", {
      periodStart: "1999-12-01",
      periodEnd: "1999-12-31",
      closingDate: "1999-12-31",
      dueDate: "2000-01-15",
      statementBalanceMinor: 1_000,
      minimumDueMinor: 100,
    });
    db.sqlite.prepare(
      "UPDATE credit_card_statements SET status = 'open' WHERE account_id = 'card' AND closing_date = '1999-12-31'",
    ).run();
    expect((liabilities.liabilityAccountDetail("owner", "card").statements as Array<{ closingDate: string; status: string }>)
      .find((statement) => statement.closingDate === "1999-12-31")).toMatchObject({ status: "overdue" });
  });

  it("splits loan principal from spending and forecasts only liquid opening balances", () => {
    liabilities.saveLoanProfile("owner", "loan", {
      originalPrincipalMinor: 1200000,
      originationDate: "2026-07-01",
      firstPaymentDate: "2026-08-15",
      maturityDate: "2027-07-15",
      paymentAccountId: "cash",
      paymentFrequency: "monthly",
      paymentIntervalMonths: 1,
      termMonths: 12,
      amortizationMethod: "annuity",
      dayCountConvention: "actual_365",
      jurisdictionCode: "RO",
      interestCategoryId: "interest",
      feeCategoryId: "fees",
      rate: {
        rateType: "fixed",
        effectiveFrom: "2026-07-01",
        fixedRateBps: 1200,
      },
    });
    const detail = liabilities.liabilityAccountDetail("owner", "loan");
    const first = (detail.schedule as Array<{
      id: string;
      principalMinor: number;
      interestMinor: number;
      paymentMinor: number;
    }>)[0];
    expect(first.principalMinor + first.interestMinor).toBe(first.paymentMinor);

    const workspace = insights.planningWorkspace("owner", "2026-08");
    expect(workspace.expectedOpeningMinor).toBe(1000000);
    expect(workspace.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sourceType: "loan_schedule",
        cashFlowAmountMinor: first.paymentMinor,
        spendingAmountMinor: first.interestMinor,
        principalAmountMinor: first.principalMinor,
      }),
    ]));
    expect(workspace.expectedExpensesMinor).toBe(first.interestMinor);

    const totalMinor = first.paymentMinor + 500;
    core.setCategoryArchived("owner", "interest", true);
    core.setCategoryArchived("owner", "fees", true);
    const payment = liabilities.recordLoanPayment("owner", "loan", {
      scheduleEntryId: first.id,
      sourceAccountId: "cash",
      date: "2026-08-01",
      totalMinor: first.paymentMinor,
      principalMinor: first.principalMinor,
      interestMinor: first.interestMinor,
      feesMinor: 0,
    });
    const feePayment = liabilities.recordLoanPayment("owner", "loan", {
      sourceAccountId: "cash",
      date: "2026-08-01",
      totalMinor: 500,
      principalMinor: 0,
      interestMinor: 0,
      feesMinor: 500,
    });
    const balances = new Map(insights.accountsPayload("owner").accounts.map((account) => [account.id, account.balanceMinor]));
    expect(balances.get("cash")).toBe(1000000 - totalMinor);
    expect(balances.get("loan")).toBe(-1200000 + first.principalMinor);
    const stats = insights.statistics("owner", 3, { from: "2026-08-01", to: "2026-08-31" });
    expect(stats.summary.spendingMinor).toBe(first.interestMinor + 500);
    expect(stats.debt).toMatchObject({
      loanPaymentsMinor: totalMinor,
      principalRepaidMinor: first.principalMinor,
      interestFeesMinor: first.interestMinor + 500,
    });
    const loanTransaction = db.sqlite.prepare(
      "SELECT source_principal_transaction_id AS id FROM loan_payments WHERE id = ?",
    ).get(payment.paymentId) as { id: string };
    expect(() => core.voidTransaction("owner", loanTransaction.id)).toThrow(/liability-payment undo/i);

    const paidEntryBeforeReset = (liabilities.liabilityAccountDetail("owner", "loan").schedule as Array<Record<string, unknown>>)[0];
    const secondEntry = (liabilities.liabilityAccountDetail("owner", "loan").schedule as Array<{ dueDate: string }>)[1];
    liabilities.addLoanRatePeriod("owner", "loan", {
      rateType: "variable",
      effectiveFrom: secondEntry.dueDate,
      referenceIndex: "IRCC",
      referenceTenorMonths: 3,
      referenceRateBps: 550,
      marginBps: 200,
      resetFrequencyMonths: 3,
    });
    const afterReset = liabilities.liabilityAccountDetail("owner", "loan").schedule as Array<Record<string, unknown>>;
    expect(afterReset[0]).toMatchObject({
      id: paidEntryBeforeReset.id,
      status: "paid",
      annualRateBps: paidEntryBeforeReset.annualRateBps,
    });
    expect(afterReset[1]).toMatchObject({ annualRateBps: 750, isEstimate: 1 });

    liabilities.undoLiabilityPayment("owner", feePayment.paymentId);
    liabilities.undoLiabilityPayment("owner", payment.paymentId);
    const restored = new Map(insights.accountsPayload("owner").accounts.map((account) => [account.id, account.balanceMinor]));
    expect(restored.get("cash")).toBe(1000000);
    expect(restored.get("loan")).toBe(-1200000);
    core.setCategoryArchived("owner", "interest", false);
    core.setCategoryArchived("owner", "fees", false);
  });

  it("rejects future card and loan actuals and a future loan origination without partial writes", () => {
    const tomorrow = addDays(bucharestToday(), 1);
    const countsBefore = {
      transactions: (db.sqlite.prepare("SELECT COUNT(*) AS count FROM transactions").get() as { count: number }).count,
      cardPayments: (db.sqlite.prepare("SELECT COUNT(*) AS count FROM credit_card_payments").get() as { count: number }).count,
      loanPayments: (db.sqlite.prepare("SELECT COUNT(*) AS count FROM loan_payments").get() as { count: number }).count,
    };
    const profileBefore = db.sqlite.prepare(
      "SELECT origination_date AS originationDate FROM loan_profiles WHERE account_id = ?",
    ).get("loan");

    expect(() => liabilities.recordCreditCardPayment("owner", "card", {
      sourceAccountId: "cash",
      date: tomorrow,
      amountMinor: 1_337,
    })).toThrow(/transactions cannot be dated in the future/i);
    expect(() => liabilities.recordLoanPayment("owner", "loan", {
      sourceAccountId: "cash",
      date: tomorrow,
      totalMinor: 1_338,
      principalMinor: 1_338,
      interestMinor: 0,
      feesMinor: 0,
    })).toThrow(/transactions cannot be dated in the future/i);

    expect(() => liabilities.saveLoanProfile("owner", "loan", {
      originalPrincipalMinor: 1_200_000,
      originationDate: tomorrow,
      firstPaymentDate: addDays(tomorrow, 30),
      paymentAccountId: "cash",
      paymentFrequency: "monthly",
      paymentIntervalMonths: 1,
      termMonths: 12,
      amortizationMethod: "annuity",
      rate: { rateType: "fixed", effectiveFrom: tomorrow, fixedRateBps: 1_200 },
    })).toThrow(/origination date cannot be in the future/i);

    expect(db.sqlite.prepare("SELECT COUNT(*) AS count FROM transactions").get())
      .toEqual({ count: countsBefore.transactions });
    expect(db.sqlite.prepare("SELECT COUNT(*) AS count FROM credit_card_payments").get())
      .toEqual({ count: countsBefore.cardPayments });
    expect(db.sqlite.prepare("SELECT COUNT(*) AS count FROM loan_payments").get())
      .toEqual({ count: countsBefore.loanPayments });
    expect(db.sqlite.prepare(
      "SELECT origination_date AS originationDate FROM loan_profiles WHERE account_id = ?",
    ).get("loan")).toEqual(profileBefore);
  });

  it("rolls back invalid allocations and rejects incomplete cross-currency payments", () => {
    db.sqlite.prepare(
      `INSERT INTO accounts (id, user_id, name, type, currency, opening_balance_minor, opening_balance_date)
       VALUES ('eur', 'owner', 'EUR cash', 'current', 'EUR', 100000, '2026-07-01')`,
    ).run();
    const before = db.sqlite.prepare("SELECT COUNT(*) AS count FROM transactions").get() as { count: number };
    expect(() => liabilities.recordLoanPayment("owner", "loan", {
      sourceAccountId: "cash", date: "2026-08-15", totalMinor: 1000,
      principalMinor: 800, interestMinor: 150, feesMinor: 40,
    })).toThrow(/must equal/i);
    expect(() => liabilities.recordCreditCardPayment("owner", "card", {
      sourceAccountId: "eur", date: "2026-08-05", amountMinor: 1000,
    })).toThrow(/cross-currency.*explicit cash-account amount/i);
    expect(db.sqlite.prepare("SELECT COUNT(*) AS count FROM transactions").get()).toEqual(before);
  });

  it("posts a manual cross-currency card payment with both native amounts and BNR reference provenance", () => {
    seedEurRate();
    db.sqlite.prepare(
      `INSERT INTO accounts
        (id, user_id, name, type, currency, opening_balance_minor, opening_balance_date, credit_limit_minor)
       VALUES
        ('fx-card-cash', 'owner', 'EUR card cash', 'current', 'EUR', 20000, '2026-08-01', NULL),
        ('fx-card', 'owner', 'RON travel card', 'credit_card', 'RON', -100000, '2026-08-01', 200000)`,
    ).run();

    expect(() => liabilities.recordCreditCardPayment("owner", "fx-card", {
      sourceAccountId: "fx-card-cash",
      date: "2026-08-01",
      amountMinor: 52000,
      cashAmountMinor: 10000,
    })).toThrow(/verified FX rate/i);

    const payment = liabilities.recordCreditCardPayment("owner", "fx-card", {
      sourceAccountId: "fx-card-cash",
      date: "2026-08-01",
      amountMinor: 52000,
      cashAmountMinor: 10000,
      fxRateScaled: 520000000,
      fxRateSource: "manual",
      fxRateDate: "2026-08-01",
      referenceFxRateScaled: 500000000,
      referenceFxRateDate: "2026-08-01",
    });
    expect(payment).toMatchObject({
      cashAmountMinor: 10000,
      cashCurrency: "EUR",
      liabilityAmountMinor: 52000,
      liabilityCurrency: "RON",
    });
    const legs = db.sqlite.prepare(
      `SELECT account_id AS accountId, amount_minor AS amountMinor, currency,
              original_amount_minor AS originalAmountMinor, original_currency AS originalCurrency,
              fx_rate_scaled AS fxRateScaled, fx_rate_source AS fxRateSource,
              reference_fx_rate_scaled AS referenceFxRateScaled
         FROM transactions WHERE transfer_group_id = ? ORDER BY amount_minor`,
    ).all(payment.transferGroupId) as Array<Record<string, unknown>>;
    expect(legs).toEqual([
      expect.objectContaining({ accountId: "fx-card-cash", amountMinor: -10000, currency: "EUR" }),
      expect.objectContaining({
        accountId: "fx-card",
        amountMinor: 52000,
        currency: "RON",
        originalAmountMinor: 10000,
        originalCurrency: "EUR",
        fxRateScaled: 520000000,
        fxRateSource: "manual",
        referenceFxRateScaled: 500000000,
      }),
    ]);
    expect((liabilities.liabilityAccountDetail("owner", "fx-card").payments as Array<Record<string, unknown>>)[0])
      .toMatchObject({
        amountMinor: 52000,
        liabilityAmountMinor: 52000,
        liabilityCurrency: "RON",
        cashAmountMinor: 10000,
        cashCurrency: "EUR",
        fxRateSource: "manual",
      });

    const stats = insights.statistics("owner", 3, { from: "2026-08-01", to: "2026-08-31" });
    expect(stats.debt).toMatchObject({
      cardPaymentsMinor: 50_000,
      debtServiceMinor: 50_000,
    });

    liabilities.undoLiabilityPayment("owner", payment.paymentId);
    expect((db.sqlite.prepare(
      "SELECT opening_balance_minor + COALESCE(SUM(CASE WHEN t.voided_at IS NULL THEN t.amount_minor ELSE 0 END), 0) AS balance FROM accounts a LEFT JOIN transactions t ON t.account_id = a.id WHERE a.id = ?",
    ).get("fx-card-cash") as { balance: number }).balance).toBe(20000);
  });

  it("keeps cross-currency loan allocations in loan units and cash postings in cash units", () => {
    seedEurRate();
    db.sqlite.prepare(
      `INSERT INTO accounts
        (id, user_id, name, type, currency, opening_balance_minor, opening_balance_date)
       VALUES
        ('fx-loan-cash', 'owner', 'EUR loan cash', 'current', 'EUR', 50000, '2026-08-01'),
        ('fx-loan', 'owner', 'RON FX loan', 'loan', 'RON', -100000, '2026-08-01')`,
    ).run();
    liabilities.saveLoanProfile("owner", "fx-loan", {
      originalPrincipalMinor: 100000,
      originationDate: "2026-07-01",
      firstPaymentDate: "2026-09-01",
      paymentAccountId: "fx-loan-cash",
      termMonths: 12,
      interestCategoryId: "interest",
      feeCategoryId: "fees",
      rate: { rateType: "fixed", effectiveFrom: "2026-07-01", fixedRateBps: 700 },
    });

    const payment = liabilities.recordLoanPayment("owner", "fx-loan", {
      sourceAccountId: "fx-loan-cash",
      date: "2026-08-01",
      totalMinor: 50000,
      principalMinor: 40000,
      interestMinor: 8000,
      feesMinor: 2000,
      cashAmountMinor: 10000,
      fxRateScaled: 500000000,
      fxRateSource: "bnr",
      fxRateDate: "2026-08-01",
    });
    expect(payment).toMatchObject({
      cashAmountMinor: 10000,
      cashCurrency: "EUR",
      liabilityAmountMinor: 50000,
      liabilityCurrency: "RON",
      cashAllocations: { principalMinor: 7999, interestMinor: 1600, feesMinor: 401 },
    });
    const stored = db.sqlite.prepare(
      `SELECT source_principal_transaction_id AS principalSourceId,
              loan_principal_transaction_id AS principalLoanId,
              interest_transaction_id AS interestId, fee_transaction_id AS feeId,
              total_minor AS totalMinor, principal_minor AS principalMinor,
              interest_minor AS interestMinor, fees_minor AS feesMinor
         FROM loan_payments WHERE id = ?`,
    ).get(payment.paymentId) as Record<string, unknown>;
    expect(stored).toMatchObject({ totalMinor: 50000, principalMinor: 40000, interestMinor: 8000, feesMinor: 2000 });
    const transaction = (id: unknown) => db.sqlite.prepare(
      `SELECT amount_minor AS amountMinor, currency, original_amount_minor AS originalAmountMinor,
              original_currency AS originalCurrency, fx_rate_source AS fxRateSource,
              reference_fx_rate_scaled AS referenceFxRateScaled
         FROM transactions WHERE id = ?`,
    ).get(String(id)) as Record<string, unknown>;
    expect(transaction(stored.principalSourceId)).toMatchObject({ amountMinor: -7999, currency: "EUR" });
    expect(transaction(stored.principalLoanId)).toMatchObject({
      amountMinor: 40000,
      currency: "RON",
      originalAmountMinor: 7999,
      originalCurrency: "EUR",
      fxRateSource: "manual",
      referenceFxRateScaled: 500000000,
    });
    expect(transaction(stored.interestId)).toMatchObject({
      amountMinor: -1600,
      currency: "EUR",
      originalAmountMinor: 8000,
      originalCurrency: "RON",
      fxRateSource: "manual",
      referenceFxRateScaled: 20000000,
    });
    expect(transaction(stored.feeId)).toMatchObject({
      amountMinor: -401,
      currency: "EUR",
      originalAmountMinor: 2000,
      originalCurrency: "RON",
      fxRateSource: "manual",
      referenceFxRateScaled: 20000000,
    });
    const auditRecord = db.sqlite.prepare(
      "SELECT after FROM audit_logs WHERE entity_type = 'loan_payment' AND entity_id = ? AND action = 'create'",
    ).get(payment.paymentId) as { after: string };
    expect(JSON.parse(auditRecord.after)).toMatchObject({
      cashAmountMinor: 10000,
      cashCurrency: "EUR",
      liabilityAmountMinor: 50000,
      liabilityCurrency: "RON",
      cashAllocations: { principalMinor: 7999, interestMinor: 1600, feesMinor: 401 },
      fxRateSource: "bnr",
      fxRateScaled: 500000000,
    });
    expect((liabilities.liabilityAccountDetail("owner", "fx-loan").payments as Array<Record<string, unknown>>)[0])
      .toMatchObject({
        cashAmountMinor: 10000,
        cashPrincipalMinor: 7999,
        cashInterestMinor: 1600,
        cashFeesMinor: 401,
        cashCurrency: "EUR",
        liabilityAmountMinor: 50000,
        liabilityCurrency: "RON",
      });

    liabilities.undoLiabilityPayment("owner", payment.paymentId);
    expect((db.sqlite.prepare(
      "SELECT opening_balance_minor + COALESCE(SUM(CASE WHEN t.voided_at IS NULL THEN t.amount_minor ELSE 0 END), 0) AS balance FROM accounts a LEFT JOIN transactions t ON t.account_id = a.id WHERE a.id = ?",
    ).get("fx-loan-cash") as { balance: number }).balance).toBe(50000);
  });

  it("posts a cross-currency loan disbursement and preserves the legacy same-currency signature", () => {
    seedEurRate();
    db.sqlite.prepare(
      `INSERT INTO accounts
        (id, user_id, name, type, currency, opening_balance_minor, opening_balance_date)
       VALUES
        ('fx-disbursement-loan', 'owner', 'RON disbursement loan', 'loan', 'RON', 0, '2026-08-01'),
        ('fx-disbursement-cash', 'owner', 'EUR disbursement cash', 'current', 'EUR', 0, '2026-08-01'),
        ('legacy-disbursement-loan', 'owner', 'RON legacy loan', 'loan', 'RON', 0, '2026-08-01'),
        ('legacy-disbursement-cash', 'owner', 'RON legacy cash', 'current', 'RON', 0, '2026-08-01')`,
    ).run();
    expect(() => liabilities.disburseLoan("owner", "fx-disbursement-loan", {
      destinationAccountId: "fx-disbursement-cash",
      amountMinor: 50000,
      date: "2026-08-01",
    })).toThrow(/cross-currency.*explicit cash-account amount/i);

    const result = liabilities.disburseLoan("owner", "fx-disbursement-loan", {
      destinationAccountId: "fx-disbursement-cash",
      amountMinor: 50000,
      cashAmountMinor: 10000,
      date: "2026-08-01",
      fxRateScaled: 20000000,
      fxRateSource: "bnr",
      fxRateDate: "2026-08-01",
    });
    expect(result).toMatchObject({
      loanAmountMinor: 50000,
      loanCurrency: "RON",
      cashAmountMinor: 10000,
      cashCurrency: "EUR",
    });
    const legs = db.sqlite.prepare(
      `SELECT account_id AS accountId, amount_minor AS amountMinor, currency,
              original_amount_minor AS originalAmountMinor, original_currency AS originalCurrency,
              fx_rate_scaled AS fxRateScaled, fx_rate_source AS fxRateSource
         FROM transactions WHERE transfer_group_id = ? ORDER BY amount_minor`,
    ).all(result.transaction.transferGroupId) as Array<Record<string, unknown>>;
    expect(legs).toEqual([
      expect.objectContaining({ accountId: "fx-disbursement-loan", amountMinor: -50000, currency: "RON" }),
      expect.objectContaining({
        accountId: "fx-disbursement-cash",
        amountMinor: 10000,
        currency: "EUR",
        originalAmountMinor: 50000,
        originalCurrency: "RON",
        fxRateScaled: 20000000,
        fxRateSource: "bnr",
      }),
    ]);

    expect(() => liabilities.disburseLoan(
      "owner",
      "legacy-disbursement-loan",
      "legacy-disbursement-cash",
      1000,
      "2026-08-01",
    )).not.toThrow();
  });

  it("uses current outstanding principal for an existing partially repaid loan schedule", () => {
    db.sqlite.prepare(
      `INSERT INTO accounts (id, user_id, name, type, currency, opening_balance_minor, opening_balance_date)
       VALUES ('existing-loan', 'owner', 'Existing loan', 'loan', 'RON', -800000, '2026-07-01')`,
    ).run();
    liabilities.saveLoanProfile("owner", "existing-loan", {
      originalPrincipalMinor: 1200000,
      originationDate: "2025-07-01",
      firstPaymentDate: "2026-08-20",
      paymentAccountId: "cash",
      termMonths: 12,
      paymentIntervalMonths: 1,
      amortizationMethod: "annuity",
      rate: { rateType: "fixed", effectiveFrom: "2025-07-01", fixedRateBps: 800 },
    });
    const schedule = liabilities.liabilityAccountDetail("owner", "existing-loan").schedule as Array<{ openingPrincipalMinor: number }>;
    expect(schedule[0].openingPrincipalMinor).toBe(800000);
  });

  it("rebuilds future installments after an unscheduled principal payment", () => {
    db.sqlite.prepare(
      `INSERT INTO accounts (id, user_id, name, type, currency, opening_balance_minor, opening_balance_date)
       VALUES ('rescheduled-loan', 'owner', 'Rescheduled loan', 'loan', 'RON', -1200000, '2026-08-01')`,
    ).run();
    liabilities.saveLoanProfile("owner", "rescheduled-loan", {
      originalPrincipalMinor: 1200000,
      originationDate: "2026-08-01",
      firstPaymentDate: "2026-09-15",
      paymentAccountId: "cash",
      termMonths: 12,
      paymentIntervalMonths: 1,
      amortizationMethod: "annuity",
      rate: { rateType: "fixed", effectiveFrom: "2026-08-01", fixedRateBps: 1200 },
    });
    const before = liabilities.liabilityAccountDetail("owner", "rescheduled-loan").schedule as Array<{
      openingPrincipalMinor: number;
      paymentMinor: number;
    }>;
    expect(before[0].openingPrincipalMinor).toBe(1200000);

    liabilities.recordLoanPayment("owner", "rescheduled-loan", {
      sourceAccountId: "cash",
      date: "2026-08-01",
      totalMinor: 300000,
      principalMinor: 300000,
      interestMinor: 0,
      feesMinor: 0,
    });

    const after = liabilities.liabilityAccountDetail("owner", "rescheduled-loan").schedule as Array<{
      openingPrincipalMinor: number;
      paymentMinor: number;
    }>;
    expect(after[0].openingPrincipalMinor).toBe(900000);
    expect(after[0].paymentMinor).toBeLessThan(before[0].paymentMinor);
  });

  it("requires ordered installment allocation and caps each remaining bucket", () => {
    db.sqlite.prepare(
      `INSERT INTO accounts (id, user_id, name, type, currency, opening_balance_minor, opening_balance_date)
       VALUES ('ordered-loan', 'owner', 'Ordered loan', 'loan', 'RON', -600000, '2026-08-01')`,
    ).run();
    liabilities.saveLoanProfile("owner", "ordered-loan", {
      originalPrincipalMinor: 600000,
      originationDate: "2026-08-01",
      firstPaymentDate: "2026-09-15",
      paymentAccountId: "cash",
      termMonths: 6,
      paymentIntervalMonths: 1,
      amortizationMethod: "annuity",
      rate: { rateType: "fixed", effectiveFrom: "2026-08-01", fixedRateBps: 900 },
    });
    const schedule = liabilities.liabilityAccountDetail("owner", "ordered-loan").schedule as Array<{
      id: string;
      principalMinor: number;
      interestMinor: number;
      feesMinor: number;
    }>;
    const [first, second] = schedule;
    expect(() => liabilities.recordLoanPayment("owner", "ordered-loan", {
      scheduleEntryId: second.id,
      sourceAccountId: "cash",
      date: "2026-09-15",
      totalMinor: 1,
      principalMinor: 1,
      interestMinor: 0,
      feesMinor: 0,
    })).toThrow(/earliest outstanding installment/i);
    expect(() => liabilities.recordLoanPayment("owner", "ordered-loan", {
      scheduleEntryId: first.id,
      sourceAccountId: "cash",
      date: "2026-09-15",
      totalMinor: first.principalMinor + 1,
      principalMinor: first.principalMinor + 1,
      interestMinor: 0,
      feesMinor: 0,
    })).toThrow(/remaining principal/i);
    expect(() => liabilities.recordLoanPayment("owner", "ordered-loan", {
      scheduleEntryId: first.id,
      sourceAccountId: "cash",
      date: "2026-09-15",
      totalMinor: first.interestMinor + 1,
      principalMinor: 0,
      interestMinor: first.interestMinor + 1,
      feesMinor: 0,
    })).toThrow(/remaining interest/i);
    expect(() => liabilities.recordLoanPayment("owner", "ordered-loan", {
      scheduleEntryId: first.id,
      sourceAccountId: "cash",
      date: "2026-09-15",
      totalMinor: first.feesMinor + 1,
      principalMinor: 0,
      interestMinor: 0,
      feesMinor: first.feesMinor + 1,
    })).toThrow(/remaining fees/i);
  });

  it("preserves month-end anchors and requires reverse-order installment undo", () => {
    db.sqlite.prepare(
      `INSERT INTO accounts (id, user_id, name, type, currency, opening_balance_minor, opening_balance_date)
       VALUES
         ('anchor-cash', 'owner', 'Anchor cash', 'current', 'RON', 1000000, '2026-01-01'),
         ('anchor-loan', 'owner', 'Anchor loan', 'loan', 'RON', -400000, '2026-01-01')`,
    ).run();
    liabilities.saveLoanProfile("owner", "anchor-loan", {
      originalPrincipalMinor: 400000,
      originationDate: "2025-12-01",
      firstPaymentDate: "2026-01-31",
      paymentAccountId: "anchor-cash",
      termMonths: 4,
      paymentIntervalMonths: 1,
      amortizationMethod: "annuity",
      rate: { rateType: "fixed", effectiveFrom: "2025-12-01", fixedRateBps: 600 },
    });
    const initial = liabilities.liabilityAccountDetail("owner", "anchor-loan").schedule as Array<{
      id: string; dueDate: string; paymentMinor: number; principalMinor: number; interestMinor: number;
    }>;
    expect(initial.map((entry) => entry.dueDate)).toEqual([
      "2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30",
    ]);
    const firstPayment = liabilities.recordLoanPayment("owner", "anchor-loan", {
      scheduleEntryId: initial[0].id,
      sourceAccountId: "anchor-cash",
      date: initial[0].dueDate,
      totalMinor: initial[0].paymentMinor,
      principalMinor: initial[0].principalMinor,
      interestMinor: initial[0].interestMinor,
      feesMinor: 0,
    });
    const afterFirst = liabilities.liabilityAccountDetail("owner", "anchor-loan").schedule as typeof initial;
    expect(afterFirst.map((entry) => entry.dueDate)).toEqual([
      "2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30",
    ]);
    const secondPayment = liabilities.recordLoanPayment("owner", "anchor-loan", {
      scheduleEntryId: afterFirst[1].id,
      sourceAccountId: "anchor-cash",
      date: afterFirst[1].dueDate,
      totalMinor: afterFirst[1].paymentMinor,
      principalMinor: afterFirst[1].principalMinor,
      interestMinor: afterFirst[1].interestMinor,
      feesMinor: 0,
    });

    expect(() => liabilities.undoLiabilityPayment("owner", firstPayment.paymentId))
      .toThrow(/undo later loan installments/i);
    liabilities.undoLiabilityPayment("owner", secondPayment.paymentId);
    expect(() => liabilities.undoLiabilityPayment("owner", firstPayment.paymentId)).not.toThrow();
  });

  it("rejects unsupported schedule inputs before persisting a loan profile", () => {
    db.sqlite.prepare(
      `INSERT INTO accounts (id, user_id, name, type, currency, opening_balance_minor, opening_balance_date)
       VALUES ('validated-loan', 'owner', 'Validated loan', 'loan', 'RON', -600000, '2026-07-01')`,
    ).run();
    const base = {
      originalPrincipalMinor: 600000,
      originationDate: "2026-07-01",
      firstPaymentDate: "2026-09-30",
      paymentAccountId: "cash",
      paymentFrequency: "quarterly",
      paymentIntervalMonths: 3,
      termMonths: 12,
      amortizationMethod: "equal_principal",
      rate: { rateType: "fixed", effectiveFrom: "2026-07-01", fixedRateBps: 600 },
    };
    type Input = Parameters<typeof liabilities.saveLoanProfile>[2];
    const save = (overrides: Record<string, unknown>) => liabilities.saveLoanProfile(
      "owner",
      "validated-loan",
      { ...base, ...overrides } as unknown as Input,
    );

    expect(() => save({ amortizationMethod: "balloon" })).toThrow(/unsupported repayment schedule/i);
    expect(() => save({ amortizationMethod: "custom" })).toThrow(/unsupported repayment schedule/i);
    expect(() => save({ regularPaymentMinor: null })).toThrow(/remove regularPaymentMinor/i);
    expect(() => save({ balloonMinor: 0 })).toThrow(/remove balloonMinor/i);
    expect(() => save({ paymentIntervalMonths: 1 })).toThrow(/cadence does not match/i);
    expect(() => save({ paymentFrequency: "weekly" })).toThrow(/unsupported payment cadence/i);
    expect(db.sqlite.prepare("SELECT COUNT(*) AS count FROM loan_profiles WHERE account_id = ?").get("validated-loan"))
      .toEqual({ count: 0 });

    liabilities.saveLoanProfile("owner", "validated-loan", base as Input);
    const detail = liabilities.liabilityAccountDetail("owner", "validated-loan");
    expect((detail.schedule as Array<unknown>)).toHaveLength(4);
    expect(detail.profile).toMatchObject({
      paymentFrequency: "quarterly",
      paymentIntervalMonths: 3,
      amortizationMethod: "equal_principal",
      regularPaymentMinor: null,
      balloonMinor: 0,
    });
  });

  it("refuses misleading projections from unsupported restored loan profiles", () => {
    db.sqlite.prepare(
      `INSERT INTO accounts (id, user_id, name, type, currency, opening_balance_minor, opening_balance_date)
       VALUES ('legacy-loan', 'owner', 'Legacy loan', 'loan', 'RON', -300000, '2026-07-01')`,
    ).run();
    liabilities.saveLoanProfile("owner", "legacy-loan", {
      originalPrincipalMinor: 300000,
      originationDate: "2026-07-01",
      firstPaymentDate: "2026-09-15",
      paymentFrequency: "monthly",
      paymentIntervalMonths: 1,
      termMonths: 6,
      amortizationMethod: "annuity",
      rate: { rateType: "fixed", effectiveFrom: "2026-07-01", fixedRateBps: 500 },
    });
    const rateCount = () => (db.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM loan_rate_periods WHERE loan_account_id = ?",
    ).get("legacy-loan") as { count: number }).count;

    try {
      db.sqlite.prepare("UPDATE loan_profiles SET amortization_method = 'balloon' WHERE account_id = ?").run("legacy-loan");
      expect(() => liabilities.liabilityAccountDetail("owner", "legacy-loan"))
        .toThrow(/unsupported repayment schedule/i);
      expect(() => liabilities.listLiabilityObligations("owner", {}))
        .toThrow(/unsupported repayment schedule/i);
      const beforeRateCount = rateCount();
      expect(() => liabilities.addLoanRatePeriod("owner", "legacy-loan", {
        rateType: "fixed",
        effectiveFrom: "2027-01-01",
        fixedRateBps: 550,
      })).toThrow(/unsupported repayment schedule/i);
      expect(rateCount()).toBe(beforeRateCount);

      db.sqlite.prepare(
        "UPDATE loan_profiles SET amortization_method = 'annuity', regular_payment_minor = 1000 WHERE account_id = ?",
      ).run("legacy-loan");
      expect(() => liabilities.liabilityAccountDetail("owner", "legacy-loan"))
        .toThrow(/unsupported contractual fixed-payment/i);

      db.sqlite.prepare(
        "UPDATE loan_profiles SET regular_payment_minor = NULL, balloon_minor = 1000 WHERE account_id = ?",
      ).run("legacy-loan");
      expect(() => liabilities.liabilityAccountDetail("owner", "legacy-loan"))
        .toThrow(/unsupported balloon/i);

      db.sqlite.prepare(
        "UPDATE loan_profiles SET balloon_minor = 0, payment_frequency = 'quarterly', payment_interval_months = 1 WHERE account_id = ?",
      ).run("legacy-loan");
      expect(() => liabilities.liabilityAccountDetail("owner", "legacy-loan"))
        .toThrow(/cadence does not match/i);
    } finally {
      db.sqlite.prepare(
        `UPDATE loan_profiles
            SET amortization_method = 'annuity', regular_payment_minor = NULL, balloon_minor = 0,
                payment_frequency = 'monthly', payment_interval_months = 1
          WHERE account_id = ?`,
      ).run("legacy-loan");
    }
  });
});
