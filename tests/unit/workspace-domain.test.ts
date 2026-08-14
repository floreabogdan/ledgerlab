import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { insertTestUser, workspaceContext } from "../helpers/workspace-fixtures";

type DatabaseModule = typeof import("@/db");
type CoreModule = typeof import("@/server/core");

describe("workspace-owned core domain", () => {
  let db: DatabaseModule;
  let core: CoreModule;
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const owner = workspaceContext("owner", "household", "owner");
  const member = workspaceContext("member", "household", "member");
  const outsider = workspaceContext("outsider");

  beforeAll(async () => {
    process.env.DATABASE_URL = ":memory:";
    vi.resetModules();
    delete (globalThis as typeof globalThis & { __ledgerLabConnection?: unknown }).__ledgerLabConnection;
    db = await import("@/db");
    core = await import("@/server/core");
    db.ensureDatabase();
    insertTestUser(db.sqlite, { id: "owner", currency: "RON" });
    insertTestUser(db.sqlite, { id: "member", currency: "EUR" });
    insertTestUser(db.sqlite, { id: "outsider", currency: "USD" });
    db.sqlite.prepare(
      `INSERT INTO workspaces
        (id, type, name, default_currency, time_zone, created_by_user_id)
       VALUES ('household', 'household', 'Our home', 'RON', 'Europe/Bucharest', 'owner')`,
    ).run();
    db.sqlite.prepare(
      `INSERT INTO workspace_members (workspace_id, user_id, role)
       VALUES ('household', 'owner', 'owner'), ('household', 'member', 'member')`,
    ).run();
  });

  afterAll(() => {
    db.sqlite.close();
    delete (globalThis as typeof globalThis & { __ledgerLabConnection?: unknown }).__ledgerLabConnection;
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  });

  it("shares descriptive accounts while audits preserve the acting member", () => {
    const account = core.createAccount(owner, {
      name: "Joint current",
      type: "current",
      currency: "RON",
      openingDate: "2025-01-01",
      holderLabel: "Joint",
    });
    expect(account).toMatchObject({ holderLabel: "Joint" });
    expect(core.listAccounts(member)).toEqual([
      expect.objectContaining({ id: account?.id, holderLabel: "Joint" }),
    ]);
    expect(core.listAccounts(outsider)).toEqual([]);

    core.updateAccount(member, account!.id, { holderLabel: "Owner + member" });
    expect(core.listAccounts(owner)[0]).toMatchObject({ holderLabel: "Owner + member" });
    expect(db.sqlite.prepare(
      `SELECT workspace_id AS workspaceId, actor_user_id AS actorUserId, action
         FROM audit_logs WHERE entity_type = 'account' ORDER BY rowid`,
    ).all()).toEqual([
      { workspaceId: "household", actorUserId: "owner", action: "create" },
      { workspaceId: "household", actorUserId: "member", action: "update" },
    ]);
  });

  it("denies cross-workspace accounts, categories, transfers, and edits atomically", () => {
    const sharedAccount = core.listAccounts(owner)[0]!;
    const secondShared = core.createAccount(owner, {
      name: "House savings",
      type: "savings",
      currency: "RON",
      openingDate: "2025-01-01",
    })!;
    const privateAccount = core.createAccount(outsider, {
      name: "Private cash",
      type: "cash",
      currency: "USD",
      openingDate: "2025-01-01",
    })!;
    const sharedCategory = core.createCategory(owner, { name: "Utilities", kind: "expense" })!;
    const privateCategory = core.createCategory(outsider, { name: "Private", kind: "expense" })!;

    expect(() => core.createCategory(owner, {
      name: "Leaked child",
      parentId: privateCategory.id,
      kind: "expense",
    })).toThrow(/parent category not found/i);
    expect(() => core.createTransaction(owner, {
      kind: "expense",
      accountId: privateAccount.id,
      amountMinor: 1_000,
      date: "2025-01-02",
    })).toThrow(/active account/i);
    expect(() => core.createTransaction(owner, {
      kind: "expense",
      accountId: sharedAccount.id,
      amountMinor: 1_000,
      date: "2025-01-02",
      splits: [{ categoryId: privateCategory.id, amountMinor: 1_000 }],
    })).toThrow(/active category/i);
    expect(() => core.createTransaction(owner, {
      kind: "transfer",
      accountId: sharedAccount.id,
      transferAccountId: privateAccount.id,
      amountMinor: 1_000,
      date: "2025-01-02",
    })).toThrow(/active account/i);

    const transaction = core.createTransaction(owner, {
      kind: "expense",
      accountId: sharedAccount.id,
      amountMinor: 1_000,
      date: "2025-01-03",
      categoryId: sharedCategory.id,
      merchant: "Power company",
      tags: ["home"],
      receiptReference: "invoice-1",
    });
    const updated = core.updateTransaction(member, transaction.id, {
      amountMinor: 1_250,
      note: "Adjusted together",
      duplicateConfirmed: true,
    });
    expect(updated.id).toBe(transaction.id);
    expect(core.listTransactions(owner).find((row) => row.id === transaction.id)).toMatchObject({
      amountMinor: -1_250,
      note: "Adjusted together",
      attachmentCount: 1,
    });
    expect(db.sqlite.prepare(
      "SELECT actor_user_id AS actorUserId FROM audit_logs WHERE entity_type = 'transaction' AND entity_id = ? AND action = 'update'",
    ).get(transaction.id)).toEqual({ actorUserId: "member" });

    const transfer = core.createTransaction(owner, {
      kind: "transfer",
      accountId: sharedAccount.id,
      transferAccountId: secondShared.id,
      amountMinor: 2_000,
      date: "2025-01-04",
      duplicateConfirmed: true,
    });
    expect(() => core.updateTransaction(member, transfer.id, {
      transferAccountId: privateAccount.id,
      amountMinor: 2_500,
      duplicateConfirmed: true,
    })).toThrow(/active account/i);
    expect(db.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM transactions WHERE workspace_id = 'household' AND transfer_group_id = ? AND voided_at IS NULL",
    ).get(transfer.transferGroupId)).toEqual({ count: 2 });
    const editedTransfer = core.updateTransaction(member, transfer.id, {
      amountMinor: 2_500,
      destinationAmountMinor: 2_500,
      duplicateConfirmed: true,
    });
    expect(editedTransfer).toMatchObject({
      id: transfer.id,
      peerId: transfer.peerId,
      transferGroupId: transfer.transferGroupId,
    });
    expect(db.sqlite.prepare(
      "SELECT amount_minor FROM transactions WHERE transfer_group_id = ? ORDER BY amount_minor",
    ).pluck().all(transfer.transferGroupId)).toEqual([-2_500, 2_500]);
    expect(core.listTransactions(outsider).some((row) => row.id === transaction.id)).toBe(false);
  });

  it("edits shared planned bills and makes payment retries idempotent", () => {
    const sharedAccount = core.listAccounts(owner).find((account) => account.name === "Joint current")!;
    const sharedCategory = core.listCategories(owner).find((category) => category.name === "Utilities")!;
    const privateAccount = core.listAccounts(outsider)[0]!;
    const privateCategory = core.listCategories(outsider)[0]!;
    const plan = core.createPlannedPayment(owner, {
      name: "Electricity",
      expectedAmountMinor: 10_000,
      currency: "RON",
      dueDate: "2025-02-10",
      accountId: sharedAccount.id,
      categoryId: sharedCategory.id,
    });
    core.updatePlannedPayment(member, plan.plannedPaymentId, {
      name: "Electricity and gas",
      expectedAmountMinor: 11_000,
    });
    expect(() => core.updatePlannedPayment(member, plan.plannedPaymentId, {
      categoryId: privateCategory.id,
    })).toThrow(/active category/i);
    expect(() => core.payPlannedOccurrence(member, plan.id, {
      accountId: privateAccount.id,
      amountMinor: 11_000,
      date: "2025-02-09",
      idempotencyKey: "member-click-1",
    })).toThrow(/active account/i);

    const first = core.payPlannedOccurrence(member, plan.id, {
      accountId: sharedAccount.id,
      amountMinor: 11_000,
      date: "2025-02-09",
      idempotencyKey: "member-click-1",
    });
    const retry = core.payPlannedOccurrence(owner, plan.id, {
      accountId: sharedAccount.id,
      amountMinor: 11_000,
      date: "2025-02-09",
      idempotencyKey: "member-click-1",
    });
    expect(retry).toMatchObject({ transactionId: first.transactionId, idempotent: true });
    expect(db.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM planned_payment_transactions WHERE occurrence_id = ?",
    ).get(plan.id)).toEqual({ count: 1 });
    expect(db.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM transactions WHERE planned_occurrence_id = ? AND voided_at IS NULL",
    ).get(plan.id)).toEqual({ count: 1 });
    expect(core.listPlannedPayments(owner, { includeArchived: true }).find((row) => row.id === plan.id))
      .toMatchObject({
        title: "Electricity and gas",
        expectedAmountMinor: 11_000,
        linkedTransactionId: first.transactionId,
        status: "paid",
      });
    expect(db.sqlite.prepare(
      "SELECT actor_user_id AS actorUserId FROM audit_logs WHERE entity_type = 'planned_occurrence' AND entity_id = ? AND action = 'pay'",
    ).get(plan.id)).toEqual({ actorUserId: "member" });
  });
});
