import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { insertTestUser } from "../helpers/workspace-fixtures";

type DatabaseModule = typeof import("@/db");
type AuthModule = typeof import("@/lib/auth");
type RouteModule = typeof import("@/app/api/[...path]/route");
type WorkspaceModule = typeof import("@/server/workspaces");

const SHARED_MARKER = "SHARED_VISIBLE";
const PRIVATE_MARKER = "PRIVATE_SECRET";
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const originalEnvironment = {
  databaseUrl: process.env.DATABASE_URL,
  attachmentsDirectory: process.env.ATTACHMENTS_DIR,
};

let db: DatabaseModule;
let auth: AuthModule;
let route: RouteModule;
let workspaces: WorkspaceModule;
let storageDirectory: string;
let ownerToken: string;
let memberSharedToken: string;
let memberSharedSessionId: string;
let memberPrivateToken: string;

function restoreVariable(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function routeContext(segments: string[]) {
  return { params: Promise.resolve({ path: segments }) };
}

async function api(
  token: string,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  resource: string,
  body?: unknown,
) {
  const url = new URL(`/api/${resource}`, "http://localhost:3000");
  const segments = url.pathname.slice("/api/".length).split("/").filter(Boolean).map(decodeURIComponent);
  const request = new NextRequest(url, {
    method,
    headers: {
      Accept: "application/json",
      cookie: `${auth.SESSION_COOKIE_NAME}=${token}`,
      origin: "http://localhost:3000",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (method === "GET") return route.GET(request, routeContext(segments));
  if (method === "DELETE") return route.DELETE(request, routeContext(segments));
  if (method === "PATCH") return route.PATCH(request, routeContext(segments));
  return route.POST(request, routeContext(segments));
}

async function upload(
  token: string,
  resource: string,
  fileName: string,
  content = PNG,
) {
  const url = new URL(`/api/${resource}`, "http://localhost:3000");
  url.searchParams.set("filename", fileName);
  const segments = url.pathname.slice("/api/".length).split("/").filter(Boolean).map(decodeURIComponent);
  return route.POST(new NextRequest(url, {
    method: "POST",
    headers: {
      cookie: `${auth.SESSION_COOKIE_NAME}=${token}`,
      origin: "http://localhost:3000",
      "content-type": "image/png",
    },
    body: new Blob([Uint8Array.from(content)]),
  }), routeContext(segments));
}

async function streamingRequest(
  token: string,
  resource: string,
  contentType: string,
  content: Uint8Array,
  onBodyRead: () => void,
) {
  const url = new URL(`/api/${resource}`, "http://localhost:3000");
  const segments = url.pathname.slice("/api/".length).split("/").filter(Boolean).map(decodeURIComponent);
  let sent = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent) return;
      sent = true;
      onBodyRead();
      controller.enqueue(content);
      controller.close();
    },
  }, { highWaterMark: 0 });
  return route.POST(new NextRequest(url, {
    method: "POST",
    headers: {
      cookie: `${auth.SESSION_COOKIE_NAME}=${token}`,
      origin: "http://localhost:3000",
      "content-type": contentType,
    },
    body,
  }), routeContext(segments));
}

function streamingJson(
  token: string,
  resource: string,
  body: unknown,
  onBodyRead: () => void,
) {
  return streamingRequest(
    token,
    resource,
    "application/json",
    new TextEncoder().encode(JSON.stringify(body)),
    onBodyRead,
  );
}

async function responseText(response: Response) {
  return response.clone().text();
}

async function expectDenied(response: Response) {
  expect(response.status).toBeGreaterThanOrEqual(400);
  expect(response.status).toBeLessThan(500);
  expect(await responseText(response)).not.toContain(PRIVATE_MARKER);
}

function transactionBody(accountId: string, categoryId: string, marker: string) {
  return {
    kind: "expense",
    status: "cleared",
    accountId,
    amountMinor: 1_111,
    date: "2026-08-13",
    categoryId,
    merchant: `${marker} route merchant`,
    note: `${marker} route transaction`,
    duplicateConfirmed: true,
  };
}

function plannedBody(accountId: string, categoryId: string, marker: string) {
  return {
    title: `${marker} route bill`,
    direction: "expense",
    expectedAmountMinor: 2_222,
    currency: "USD",
    dueDate: "2026-09-15",
    accountId,
    categoryId,
    note: `${marker} planned route`,
    status: "planned",
  };
}

function seedWorkspaceData() {
  db.sqlite.exec(`
    INSERT INTO workspaces
      (id, type, name, default_currency, time_zone, created_by_user_id)
    VALUES ('shared-workspace', 'household', '${SHARED_MARKER} workspace', 'USD', 'UTC', 'owner');
    INSERT INTO workspace_members (workspace_id, user_id, role)
    VALUES
      ('shared-workspace', 'owner', 'owner'),
      ('shared-workspace', 'member', 'member');

    INSERT INTO accounts
      (id, workspace_id, name, type, currency, opening_balance_minor, opening_balance_date)
    VALUES
      ('shared-current', 'shared-workspace', '${SHARED_MARKER} current', 'current', 'USD', 100000, '2026-01-01'),
      ('shared-spare', 'shared-workspace', '${SHARED_MARKER} spare', 'savings', 'USD', 0, '2026-01-01'),
      ('shared-card', 'shared-workspace', '${SHARED_MARKER} card', 'credit_card', 'USD', -5000, '2026-01-01'),
      ('private-current', 'member', '${PRIVATE_MARKER} current', 'current', 'USD', 900000, '2026-01-01'),
      ('private-card', 'member', '${PRIVATE_MARKER} card', 'credit_card', 'USD', -99000, '2026-01-01');
    INSERT INTO credit_card_profiles (account_id, statement_day, due_day)
    VALUES ('shared-card', 20, 10), ('private-card', 21, 11);

    INSERT INTO categories
      (id, workspace_id, name, kind, spending_nature, spending_priority, display_order)
    VALUES
      ('shared-category', 'shared-workspace', '${SHARED_MARKER} category', 'expense', 'fixed', 'essential', 1),
      ('shared-empty-category', 'shared-workspace', '${SHARED_MARKER} empty category', 'expense', 'variable', 'discretionary', 2),
      ('private-category', 'member', '${PRIVATE_MARKER} category', 'expense', 'fixed', 'essential', 1);
    INSERT INTO tags (id, workspace_id, name, color)
    VALUES
      ('shared-tag', 'shared-workspace', '${SHARED_MARKER} tag', '#123456'),
      ('private-tag', 'member', '${PRIVATE_MARKER} tag', '#654321');
    INSERT INTO merchants (id, workspace_id, name, normalized_name, default_category_id)
    VALUES
      ('shared-merchant', 'shared-workspace', '${SHARED_MARKER} merchant', 'shared_visible merchant', 'shared-category'),
      ('private-merchant', 'member', '${PRIVATE_MARKER} merchant', 'private_secret merchant', 'private-category');

    INSERT INTO transactions
      (id, workspace_id, account_id, category_id, merchant_id, kind, status,
       amount_minor, currency, occurred_at, merchant_text, notes)
    VALUES
      ('shared-transaction', 'shared-workspace', 'shared-current', 'shared-category', 'shared-merchant',
       'expense', 'cleared', -1234, 'USD', '2026-08-01', '${SHARED_MARKER} transaction', '${SHARED_MARKER} note'),
      ('shared-pending', 'shared-workspace', 'shared-current', 'shared-category', NULL,
       'expense', 'pending', -2222, 'USD', '2026-08-02', '${SHARED_MARKER} pending', NULL),
      ('private-transaction', 'member', 'private-current', 'private-category', 'private-merchant',
       'expense', 'cleared', -88888, 'USD', '2026-08-01', '${PRIVATE_MARKER} transaction', '${PRIVATE_MARKER} note'),
      ('private-pending', 'member', 'private-current', 'private-category', NULL,
       'expense', 'pending', -77777, 'USD', '2026-08-02', '${PRIVATE_MARKER} pending', NULL);
    INSERT INTO transaction_tags (transaction_id, tag_id)
    VALUES ('shared-transaction', 'shared-tag'), ('private-transaction', 'private-tag');

    INSERT INTO planned_payments
      (id, workspace_id, title, direction, expected_amount_minor, currency, due_date,
       account_id, category_id, merchant_id, spending_nature, spending_priority)
    VALUES
      ('shared-payment', 'shared-workspace', '${SHARED_MARKER} bill', 'expense', 3300, 'USD',
       '2026-08-20', 'shared-current', 'shared-category', 'shared-merchant', 'fixed', 'essential'),
      ('private-payment', 'member', '${PRIVATE_MARKER} bill', 'expense', 4400, 'USD',
       '2026-08-20', 'private-current', 'private-category', 'private-merchant', 'fixed', 'essential');
    INSERT INTO planned_payment_occurrences
      (id, planned_payment_id, due_date, expected_amount_minor, status)
    VALUES
      ('shared-occurrence', 'shared-payment', '2026-08-20', 3300, 'planned'),
      ('shared-skip-occurrence', 'shared-payment', '2026-08-21', 3300, 'planned'),
      ('private-occurrence', 'private-payment', '2026-08-20', 4400, 'planned');

    INSERT INTO budgets (id, workspace_id, month, currency, category_id, amount_minor)
    VALUES
      ('shared-budget', 'shared-workspace', '2026-08', 'USD', 'shared-category', 50000),
      ('private-budget', 'member', '2026-08', 'USD', 'private-category', 60000);
    INSERT INTO month_plans
      (id, workspace_id, month, currency, name, status, expected_income_minor)
    VALUES
      ('shared-month-plan', 'shared-workspace', '2026-08', 'USD', '${SHARED_MARKER} plan', 'active', 100000),
      ('private-month-plan', 'member', '2026-08', 'USD', '${PRIVATE_MARKER} plan', 'active', 900000);
    INSERT INTO month_plan_accounts (id, month_plan_id, account_id, expected_opening_minor)
    VALUES
      ('shared-plan-account', 'shared-month-plan', 'shared-current', 100000),
      ('private-plan-account', 'private-month-plan', 'private-current', 900000);

    INSERT INTO attachments
      (id, workspace_id, transaction_id, file_name, external_reference)
    VALUES
      ('shared-reference', 'shared-workspace', 'shared-transaction', '${SHARED_MARKER}.pdf', 'shared-reference'),
      ('private-reference', 'member', 'private-transaction', '${PRIVATE_MARKER}.pdf', 'private-reference');
  `);
}

beforeEach(async () => {
  storageDirectory = mkdtempSync(path.join(tmpdir(), "ledgerlab-workspace-auth-"));
  process.env.DATABASE_URL = ":memory:";
  process.env.ATTACHMENTS_DIR = storageDirectory;
  vi.resetModules();
  delete (globalThis as typeof globalThis & { __ledgerLabConnection?: unknown }).__ledgerLabConnection;

  db = await import("@/db");
  auth = await import("@/lib/auth");
  workspaces = await import("@/server/workspaces");
  route = await import("@/app/api/[...path]/route");
  db.ensureDatabase();
  insertTestUser(db.sqlite, {
    id: "owner",
    email: "owner@example.test",
    displayName: "Owner",
    isInstallationAdmin: true,
  });
  insertTestUser(db.sqlite, {
    id: "member",
    email: "member@example.test",
    displayName: "Member",
  });
  seedWorkspaceData();

  const owner = auth.createSession("owner");
  workspaces.activateWorkspace("owner", owner.sessionId, "shared-workspace");
  ownerToken = owner.token;
  const memberShared = auth.createSession("member");
  workspaces.activateWorkspace("member", memberShared.sessionId, "shared-workspace");
  memberSharedToken = memberShared.token;
  memberSharedSessionId = memberShared.sessionId;
  memberPrivateToken = auth.createSession("member").token;
});

afterEach(() => {
  db.sqlite.close();
  delete (globalThis as typeof globalThis & { __ledgerLabConnection?: unknown }).__ledgerLabConnection;
  rmSync(storageDirectory, { recursive: true, force: true });
  restoreVariable("DATABASE_URL", originalEnvironment.databaseUrl);
  restoreVariable("ATTACHMENTS_DIR", originalEnvironment.attachmentsDirectory);
});

describe("authenticated workspace API authorization matrix", () => {
  it("scopes every collection/report family to the active workspace for both owner and member", async () => {
    const markerEndpoints = [
      "accounts?from=2026-08-01&to=2026-08-31",
      "categories",
      "tags",
      "merchants",
      "transactions?from=2026-08-01&to=2026-08-31",
      "planned?from=2026-08-01&to=2026-08-31",
      "budgets?month=2026-08",
      "plans?month=2026-08",
      "export?format=json",
      "export?format=csv",
    ];
    for (const token of [ownerToken, memberSharedToken]) {
      for (const endpoint of markerEndpoints) {
        const response = await api(token, "GET", endpoint);
        expect(response.status, endpoint).toBe(200);
        const text = await responseText(response);
        expect(text, endpoint).toContain(SHARED_MARKER);
        expect(text, endpoint).not.toContain(PRIVATE_MARKER);
      }
      for (const endpoint of [
        "dashboard?from=2026-08-01&to=2026-08-31",
        "liabilities?from=2026-08-01&to=2026-08-31",
        "statistics?from=2026-08-01&to=2026-08-31&months=3",
        "settings",
      ]) {
        const response = await api(token, "GET", endpoint);
        expect(response.status, endpoint).toBe(200);
        expect(await responseText(response), endpoint).not.toContain(PRIVATE_MARKER);
      }
    }

    const ownerWorkspaces = await api(ownerToken, "GET", "workspaces");
    expect(ownerWorkspaces.status).toBe(200);
    const ownerPayload = await ownerWorkspaces.json() as { activeWorkspace: { id: string }; workspaces: Array<{ id: string }> };
    expect(ownerPayload.activeWorkspace.id).toBe("shared-workspace");
    expect(ownerPayload.workspaces.map((workspace) => workspace.id)).toEqual(["owner", "shared-workspace"]);
    const memberWorkspaces = await api(memberSharedToken, "GET", "workspaces");
    expect(memberWorkspaces.status).toBe(200);
    const memberPayload = await memberWorkspaces.json() as { activeWorkspace: { id: string }; workspaces: Array<{ id: string }> };
    expect(memberPayload.activeWorkspace.id).toBe("shared-workspace");
    expect(memberPayload.workspaces.map((workspace) => workspace.id)).toEqual(["member", "shared-workspace"]);

    const privateAccounts = await api(memberPrivateToken, "GET", "accounts");
    expect(privateAccounts.status).toBe(200);
    const privateText = await responseText(privateAccounts);
    expect(privateText).toContain(PRIVATE_MARKER);
    expect(privateText).not.toContain(SHARED_MARKER);

    expect((await api(memberSharedToken, "POST", "workspaces/member/activate", {})).status).toBe(200);
    const switchedPrivateAccounts = await api(memberSharedToken, "GET", "accounts");
    expect(await responseText(switchedPrivateAccounts)).toContain(PRIVATE_MARKER);
    expect((await api(memberSharedToken, "POST", "workspaces/shared-workspace/activate", {})).status).toBe(200);

    for (const endpoint of [
      "transactions?account=private-current",
      "transactions?category=private-category",
      "transactions?tag=PRIVATE_SECRET",
      "transactions?merchant=PRIVATE_SECRET",
    ]) {
      const response = await api(memberSharedToken, "GET", endpoint);
      expect(response.status, endpoint).toBe(200);
      expect(await responseText(response), endpoint).not.toContain(PRIVATE_MARKER);
    }
    await expectDenied(await api(
      memberSharedToken,
      "GET",
      "transactions?account=private-current&minMinor=1",
    ));

    await expectDenied(await api(ownerToken, "POST", "workspaces/member/activate", {}));
    const ownerAfterDeniedSwitch = await api(ownerToken, "GET", "workspaces");
    expect(ownerAfterDeniedSwitch.status).toBe(200);
    expect((await ownerAfterDeniedSwitch.json() as { activeWorkspace: { id: string } }).activeWorkspace.id)
      .toBe("shared-workspace");

    for (const token of [ownerToken, memberSharedToken]) {
      const management = await api(token, "GET", "workspaces/current");
      expect(management.status).toBe(200);
      const text = await responseText(management);
      expect(text).toContain(SHARED_MARKER);
      expect(text).not.toContain(PRIVATE_MARKER);
    }
  });

  it("allows same-workspace attachment access while hiding transaction, planned-bill, and attachment ids", async () => {
    const ownTransactionList = await api(memberSharedToken, "GET", "transactions/shared-transaction/attachments");
    expect(ownTransactionList.status).toBe(200);
    expect(await responseText(ownTransactionList)).toContain(`${SHARED_MARKER}.pdf`);
    await expectDenied(await api(memberSharedToken, "GET", "transactions/private-transaction/attachments"));

    const ownPlannedList = await api(memberSharedToken, "GET", "planned/shared-payment/attachments");
    expect(ownPlannedList.status).toBe(200);
    await expectDenied(await api(memberSharedToken, "GET", "planned/private-payment/attachments"));

    const uploaded = await upload(memberSharedToken, "transactions/shared-transaction/attachments", "shared.png");
    expect(uploaded.status).toBe(201);
    const uploadedBody = await uploaded.json() as { attachment: { id: string } };
    const stored = db.sqlite.prepare(
      "SELECT storage_path AS storagePath FROM attachments WHERE id = ?",
    ).get(uploadedBody.attachment.id) as { storagePath: string };
    expect(existsSync(path.join(storageDirectory, stored.storagePath))).toBe(true);

    const ownerDownload = await api(ownerToken, "GET", `attachments/${uploadedBody.attachment.id}/download`);
    expect(ownerDownload.status).toBe(200);
    expect(Buffer.from(await ownerDownload.arrayBuffer())).toEqual(PNG);
    await expectDenied(await api(ownerToken, "GET", "attachments/private-reference/download"));
    await expectDenied(await upload(memberSharedToken, "transactions/private-transaction/attachments", "blocked.png"));

    const plannedUpload = await upload(memberSharedToken, "planned/shared-payment/attachments", "invoice.png");
    expect(plannedUpload.status).toBe(201);
    await expectDenied(await upload(memberSharedToken, "planned/private-payment/attachments", "blocked-invoice.png"));

    await expectDenied(await api(ownerToken, "DELETE", "attachments/private-reference"));
    expect(db.sqlite.prepare("SELECT 1 FROM attachments WHERE id = 'private-reference'").get()).toBeTruthy();
    const ownDelete = await api(ownerToken, "DELETE", `attachments/${uploadedBody.attachment.id}`);
    expect(ownDelete.status).toBe(200);
    expect(db.sqlite.prepare("SELECT 1 FROM attachments WHERE id = ?").get(uploadedBody.attachment.id)).toBeUndefined();
  });

  it("rejects foreign identifiers across accounts, metadata, transactions, and planned bills without mutation", async () => {
    const ownArchive = await api(memberSharedToken, "POST", "accounts", {
      action: "archive",
      id: "shared-spare",
    });
    expect(ownArchive.status).toBe(200);
    expect(db.sqlite.prepare("SELECT archived_at FROM accounts WHERE id = 'shared-spare'").pluck().get()).toBeTruthy();
    expect((await api(memberSharedToken, "POST", "accounts", {
      action: "restore",
      id: "shared-spare",
    })).status).toBe(200);
    await expectDenied(await api(memberSharedToken, "POST", "accounts", {
      action: "archive",
      id: "private-current",
    }));
    expect(db.sqlite.prepare("SELECT archived_at FROM accounts WHERE id = 'private-current'").pluck().get()).toBeNull();

    expect((await api(memberSharedToken, "POST", "tags", {
      action: "update",
      id: "shared-tag",
      name: `${SHARED_MARKER} renamed tag`,
      color: "#123456",
    })).status).toBe(200);
    await expectDenied(await api(memberSharedToken, "POST", "tags", {
      action: "update",
      id: "private-tag",
      name: "stolen",
      color: "#123456",
    }));
    await expectDenied(await api(memberSharedToken, "POST", "merchants", {
      action: "update",
      id: "private-merchant",
      name: "stolen",
    }));
    await expectDenied(await api(memberSharedToken, "POST", "categories", {
      action: "archive",
      id: "private-category",
    }));
    expect(db.sqlite.prepare("SELECT name FROM tags WHERE id = 'private-tag'").pluck().get())
      .toBe(`${PRIVATE_MARKER} tag`);
    expect(db.sqlite.prepare("SELECT name FROM merchants WHERE id = 'private-merchant'").pluck().get())
      .toBe(`${PRIVATE_MARKER} merchant`);

    expect((await api(memberSharedToken, "POST", "categories", {
      action: "archive",
      id: "shared-empty-category",
    })).status).toBe(200);
    expect((await api(memberSharedToken, "POST", "categories", {
      action: "restore",
      id: "shared-empty-category",
    })).status).toBe(200);
    await expectDenied(await api(memberSharedToken, "POST", "categories", {
      action: "update",
      id: "shared-empty-category",
      name: `${SHARED_MARKER} still isolated`,
      parentId: "private-category",
    }));
    expect(db.sqlite.prepare(
      "SELECT parent_id FROM categories WHERE id = 'shared-empty-category'",
    ).pluck().get()).toBeNull();

    expect((await api(memberSharedToken, "POST", "merchants", {
      action: "update",
      id: "shared-merchant",
      name: `${SHARED_MARKER} renamed merchant`,
      defaultCategoryId: "shared-category",
    })).status).toBe(200);
    await expectDenied(await api(memberSharedToken, "POST", "merchants", {
      action: "update",
      id: "shared-merchant",
      name: "cross category must not persist",
      defaultCategoryId: "private-category",
    }));
    expect(db.sqlite.prepare("SELECT name FROM merchants WHERE id = 'shared-merchant'").pluck().get())
      .toBe(`${SHARED_MARKER} renamed merchant`);

    const ownCreate = await api(
      memberSharedToken,
      "POST",
      "transactions",
      transactionBody("shared-current", "shared-category", SHARED_MARKER),
    );
    expect(ownCreate.status).toBe(201);
    const sharedTransactionCount = db.sqlite.prepare(
      "SELECT COUNT(*) FROM transactions WHERE workspace_id = 'shared-workspace'",
    ).pluck().get();
    await expectDenied(await api(
      memberSharedToken,
      "POST",
      "transactions",
      transactionBody("private-current", "shared-category", PRIVATE_MARKER),
    ));
    await expectDenied(await api(
      memberSharedToken,
      "POST",
      "transactions",
      transactionBody("shared-current", "private-category", PRIVATE_MARKER),
    ));
    await expectDenied(await api(memberSharedToken, "POST", "transactions", {
      ...transactionBody("shared-current", "shared-category", PRIVATE_MARKER),
      categoryId: null,
      splits: [{ categoryId: "private-category", amountMinor: 1_111 }],
    }));
    await expectDenied(await api(memberSharedToken, "POST", "transactions", {
      kind: "transfer",
      status: "cleared",
      accountId: "shared-current",
      transferAccountId: "private-current",
      amountMinor: 500,
      destinationAmountMinor: 500,
      date: "2026-08-13",
      duplicateConfirmed: true,
    }));
    expect(db.sqlite.prepare(
      "SELECT COUNT(*) FROM transactions WHERE workspace_id = 'shared-workspace'",
    ).pluck().get()).toBe(sharedTransactionCount);

    const ownUpdate = await api(
      memberSharedToken,
      "POST",
      "transactions/shared-transaction/update",
      transactionBody("shared-current", "shared-category", SHARED_MARKER),
    );
    expect(ownUpdate.status).toBe(200);
    const privateAmount = db.sqlite.prepare(
      "SELECT amount_minor FROM transactions WHERE id = 'private-transaction'",
    ).pluck().get();
    await expectDenied(await api(
      memberSharedToken,
      "POST",
      "transactions/private-transaction/update",
      transactionBody("shared-current", "shared-category", SHARED_MARKER),
    ));
    expect(db.sqlite.prepare(
      "SELECT amount_minor FROM transactions WHERE id = 'private-transaction'",
    ).pluck().get()).toBe(privateAmount);

    expect((await api(memberSharedToken, "POST", "transactions/shared-pending/clear", {})).status).toBe(200);
    await expectDenied(await api(memberSharedToken, "POST", "transactions/private-pending/clear", {}));
    await expectDenied(await api(memberSharedToken, "DELETE", "transactions/private-transaction"));
    expect(db.sqlite.prepare("SELECT status FROM transactions WHERE id = 'private-pending'").pluck().get()).toBe("pending");
    expect(db.sqlite.prepare("SELECT voided_at FROM transactions WHERE id = 'private-transaction'").pluck().get()).toBeNull();

    const ownPlannedCreate = await api(
      memberSharedToken,
      "POST",
      "planned",
      plannedBody("shared-current", "shared-category", SHARED_MARKER),
    );
    expect(ownPlannedCreate.status).toBe(201);
    const sharedPlannedCount = db.sqlite.prepare(
      "SELECT COUNT(*) FROM planned_payments WHERE workspace_id = 'shared-workspace'",
    ).pluck().get();
    await expectDenied(await api(
      memberSharedToken,
      "POST",
      "planned",
      plannedBody("private-current", "shared-category", PRIVATE_MARKER),
    ));
    await expectDenied(await api(
      memberSharedToken,
      "POST",
      "planned",
      plannedBody("shared-current", "private-category", PRIVATE_MARKER),
    ));
    expect(db.sqlite.prepare(
      "SELECT COUNT(*) FROM planned_payments WHERE workspace_id = 'shared-workspace'",
    ).pluck().get()).toBe(sharedPlannedCount);

    expect((await api(
      memberSharedToken,
      "POST",
      "planned/shared-payment/update",
      {
        ...plannedBody("shared-current", "shared-category", SHARED_MARKER),
        expectedAmountMinor: 3_300,
        dueDate: "2026-08-20",
      },
    )).status).toBe(200);
    const privatePlannedTitle = db.sqlite.prepare(
      "SELECT title FROM planned_payments WHERE id = 'private-payment'",
    ).pluck().get();
    await expectDenied(await api(
      memberSharedToken,
      "POST",
      "planned/private-payment/update",
      {
        ...plannedBody("shared-current", "shared-category", SHARED_MARKER),
        dueDate: "2026-08-20",
      },
    ));
    expect(db.sqlite.prepare(
      "SELECT title FROM planned_payments WHERE id = 'private-payment'",
    ).pluck().get()).toBe(privatePlannedTitle);

    const plannedPayBody = {
      amountMinor: 3_300,
      date: "2026-08-13",
      accountId: "shared-current",
      partial: false,
    };
    await expectDenied(await api(
      memberSharedToken,
      "POST",
      "planned/private-occurrence/pay",
      plannedPayBody,
    ));
    await expectDenied(await api(memberSharedToken, "POST", "planned/shared-occurrence/pay", {
      ...plannedPayBody,
      accountId: "private-current",
    }));
    const ownPlannedPay = await api(
      memberSharedToken,
      "POST",
      "planned/shared-occurrence/pay",
      plannedPayBody,
    );
    expect(ownPlannedPay.status, await responseText(ownPlannedPay)).toBe(200);

    expect((await api(memberSharedToken, "POST", "planned/shared-skip-occurrence/skip", {
      reason: "same workspace",
    })).status).toBe(200);
    await expectDenied(await api(memberSharedToken, "POST", "planned/private-occurrence/skip", {
      reason: "cross workspace",
    }));
    await expectDenied(await api(memberSharedToken, "POST", "planned/private-payment/archive", {}));
    expect(db.sqlite.prepare("SELECT status FROM planned_payment_occurrences WHERE id = 'private-occurrence'").pluck().get())
      .toBe("planned");
    expect(db.sqlite.prepare("SELECT archived_at FROM planned_payments WHERE id = 'private-payment'").pluck().get())
      .toBeNull();
  });

  it("enforces workspace ids in budgets, plans, liabilities, and import preview/commit", async () => {
    const ownBudget = await api(memberSharedToken, "POST", "budgets", {
      month: "2026-09",
      categoryId: "shared-category",
      amountMinor: 12345,
      rollover: false,
    });
    expect(ownBudget.status).toBe(200);
    await expectDenied(await api(memberSharedToken, "POST", "budgets", {
      month: "2026-09",
      categoryId: "private-category",
      amountMinor: 99999,
      rollover: false,
    }));
    expect(db.sqlite.prepare(
      "SELECT 1 FROM budgets WHERE workspace_id = 'member' AND month = '2026-09'",
    ).get()).toBeUndefined();

    const ownPlan = await api(memberSharedToken, "POST", "plans", {
      action: "save-assumptions",
      month: "2026-09",
      name: `${SHARED_MARKER} September`,
      openingBalances: [{ accountId: "shared-current", amountMinor: 100000 }],
    });
    expect(ownPlan.status).toBe(200);
    await expectDenied(await api(memberSharedToken, "POST", "plans", {
      action: "save-assumptions",
      month: "2026-10",
      openingBalances: [{ accountId: "private-current", amountMinor: 900000 }],
    }));
    expect(db.sqlite.prepare(
      "SELECT 1 FROM month_plans WHERE workspace_id = 'shared-workspace' AND month = '2026-10'",
    ).get()).toBeUndefined();

    const ownLiability = await api(memberSharedToken, "GET", "liabilities/shared-card");
    expect(ownLiability.status).toBe(200);
    expect(await responseText(ownLiability)).toContain(`${SHARED_MARKER} card`);
    await expectDenied(await api(memberSharedToken, "GET", "liabilities/private-card"));
    const profileBody = {
      creditLimitMinor: 500000,
      statementDay: 20,
      dueDay: 10,
      minimumPaymentMode: "manual",
      paymentPreference: "full_statement",
      generatePlannedPayments: true,
    };
    expect((await api(memberSharedToken, "POST", "liabilities/shared-card/card-profile", profileBody)).status).toBe(200);
    await expectDenied(await api(memberSharedToken, "POST", "liabilities/private-card/card-profile", profileBody));
    expect(db.sqlite.prepare("SELECT statement_day FROM credit_card_profiles WHERE account_id = 'private-card'").pluck().get())
      .toBe(21);

    const statementBody = {
      periodStart: "2026-07-01",
      periodEnd: "2026-07-31",
      closingDate: "2026-07-31",
      dueDate: "2026-08-31",
      statementBalanceMinor: 5_000,
      minimumDueMinor: 500,
      source: "manual",
    };
    const ownStatement = await api(
      memberSharedToken,
      "POST",
      "liabilities/shared-card/statements",
      statementBody,
    );
    expect(ownStatement.status).toBe(201);
    const statementPayload = await ownStatement.json() as { statements: Array<{ id: string }> };
    const statementId = statementPayload.statements[0]!.id;
    await expectDenied(await api(
      memberSharedToken,
      "POST",
      "liabilities/private-card/statements",
      statementBody,
    ));

    const cardPaymentBody = {
      kind: "card_payment",
      statementId,
      sourceAccountId: "shared-current",
      date: "2026-08-13",
      amountMinor: 1_000,
    };
    await expectDenied(await api(memberSharedToken, "POST", "liabilities/shared-card/payments", {
      ...cardPaymentBody,
      sourceAccountId: "private-current",
    }));
    await expectDenied(await api(
      memberSharedToken,
      "POST",
      "liabilities/private-card/payments",
      cardPaymentBody,
    ));
    const ownCardPayment = await api(
      memberSharedToken,
      "POST",
      "liabilities/shared-card/payments",
      cardPaymentBody,
    );
    expect(ownCardPayment.status).toBe(201);
    const paymentId = (await ownCardPayment.json() as { paymentId: string }).paymentId;
    await expectDenied(await api(memberPrivateToken, "POST", `liabilities/payments/${paymentId}/undo`, {}));
    expect(db.sqlite.prepare(
      "SELECT voided_at FROM credit_card_payments WHERE id = ?",
    ).pluck().get(paymentId)).toBeNull();
    expect((await api(
      memberSharedToken,
      "POST",
      `liabilities/payments/${paymentId}/undo`,
      {},
    )).status).toBe(200);

    const previewBody = {
      csv: `Date,Amount,Description\n2026-08-11,-12.34,${SHARED_MARKER} import\n`,
      mapping: { Date: "date", Amount: "amount", Description: "description" },
      hasHeader: true,
      accountId: "shared-current",
    };
    const ownPreview = await api(memberSharedToken, "POST", "import/preview", previewBody);
    expect(ownPreview.status).toBe(200);
    await expectDenied(await api(memberSharedToken, "POST", "import/preview", {
      ...previewBody,
      accountId: "private-current",
    }));

    const commitBody = {
      accountId: "shared-current",
      rows: [{
        date: "2026-08-12",
        amountMinor: -5678,
        description: `${SHARED_MARKER} committed import`,
      }],
      duplicateStrategy: "skip",
      fileName: "shared.csv",
    };
    const ownCommit = await api(memberSharedToken, "POST", "import/commit", commitBody);
    expect(ownCommit.status).toBe(200);
    const privateCount = db.sqlite.prepare(
      "SELECT COUNT(*) FROM transactions WHERE workspace_id = 'member'",
    ).pluck().get();
    await expectDenied(await api(memberSharedToken, "POST", "import/commit", {
      ...commitBody,
      accountId: "private-current",
      fileName: "blocked.csv",
    }));
    expect(db.sqlite.prepare(
      "SELECT COUNT(*) FROM transactions WHERE workspace_id = 'member'",
    ).pluck().get()).toBe(privateCount);

    const memberPreferences = {
      action: "preferences",
      displayName: "Member",
      currency: "USD",
      locale: "en-US",
      timeZone: "UTC",
      uiLanguage: "en",
      compactTables: true,
    };
    expect((await api(memberSharedToken, "POST", "settings", memberPreferences)).status).toBe(200);
    await expectDenied(await api(memberSharedToken, "POST", "settings", {
      ...memberPreferences,
      workspaceCurrency: "EUR",
    }));
    expect(db.sqlite.prepare(
      "SELECT default_currency FROM workspaces WHERE id = 'shared-workspace'",
    ).pluck().get()).toBe("USD");
  });

  it("rejects a non-administrator restore before consuming its large request body", async () => {
    let bodyRead = false;
    const response = await streamingJson(memberSharedToken, "backup", {
      backup: "must-not-be-read",
      confirmation: "RESTORE",
    }, () => {
      bodyRead = true;
    });

    expect(response.status).toBe(403);
    expect(await responseText(response)).toContain("INSTALLATION_ADMIN_REQUIRED");
    expect(bodyRead).toBe(false);
  });

  it("invalidates JSON mutations when membership or owner role changes during body parsing", async () => {
    const removedMember = await streamingJson(memberSharedToken, "accounts", {
      name: "RACE_BLOCKED_MEMBER_ACCOUNT",
      type: "current",
      currency: "USD",
      openingDate: "2026-01-01",
    }, () => {
      workspaces.removeWorkspaceMember({
        actorUserId: "owner",
        workspaceId: "shared-workspace",
        role: "owner",
      }, "member");
    });
    expect(removedMember.status, await responseText(removedMember)).toBe(409);
    expect(db.sqlite.prepare(
      "SELECT 1 FROM accounts WHERE name = 'RACE_BLOCKED_MEMBER_ACCOUNT'",
    ).get()).toBeUndefined();

    db.sqlite.prepare(
      "INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ('shared-workspace', 'member', 'owner')",
    ).run();
    const demotedOwner = await streamingJson(ownerToken, "settings", {
      action: "preferences",
      displayName: "Owner",
      workspaceCurrency: "EUR",
      workspaceTimeZone: "UTC",
      locale: "en-US",
      uiLanguage: "en",
      compactTables: true,
    }, () => {
      db.sqlite.prepare(
        "UPDATE workspace_members SET role = 'member' WHERE workspace_id = 'shared-workspace' AND user_id = 'owner'",
      ).run();
    });
    expect(demotedOwner.status, await responseText(demotedOwner)).toBe(409);
    expect(db.sqlite.prepare(
      "SELECT default_currency FROM workspaces WHERE id = 'shared-workspace'",
    ).pluck().get()).toBe("USD");
  });

  it("rechecks membership inside an attachment write after streaming completes", async () => {
    const response = await streamingRequest(
      memberSharedToken,
      "transactions/shared-transaction/attachments?filename=race.png",
      "image/png",
      PNG,
      () => {
        workspaces.removeWorkspaceMember({
          actorUserId: "owner",
          workspaceId: "shared-workspace",
          role: "owner",
        }, "member");
      },
    );

    expect(response.status, await responseText(response)).toBe(409);
    expect(db.sqlite.prepare(
      "SELECT 1 FROM attachments WHERE file_name = 'race.png'",
    ).get()).toBeUndefined();
  });

  it("rejects an attachment write when the session switches workspaces during streaming", async () => {
    const response = await streamingRequest(
      memberSharedToken,
      "transactions/shared-transaction/attachments?filename=switched.png",
      "image/png",
      PNG,
      () => {
        workspaces.activateWorkspace("member", memberSharedSessionId, "member");
      },
    );

    expect(response.status, await responseText(response)).toBe(409);
    expect(db.sqlite.prepare(
      "SELECT 1 FROM attachments WHERE file_name = 'switched.png'",
    ).get()).toBeUndefined();
  });

  it("keeps personal settings out of workspace activity and emits a redacted workspace-settings event", async () => {
    expect((await api(memberSharedToken, "POST", "settings", {
      action: "preferences",
      displayName: "Private display name",
      locale: "ro-RO",
      uiLanguage: "ro",
      compactTables: false,
    })).status).toBe(200);
    expect((await api(memberSharedToken, "POST", "settings", {
      action: "reminders",
      dueSoon: false,
      overdue: true,
      budgetWarnings: false,
      daysBefore: 17,
    })).status).toBe(200);
    expect((await api(ownerToken, "POST", "settings", {
      action: "preferences",
      displayName: "Owner",
      locale: "en-US",
      uiLanguage: "en",
      compactTables: true,
      workspaceCurrency: "EUR",
      workspaceTimeZone: "Europe/Bucharest",
    })).status).toBe(200);

    const privateRows = db.sqlite.prepare(
      "SELECT workspace_id AS workspaceId FROM audit_logs WHERE entity_type = 'user_settings'",
    ).all() as Array<{ workspaceId: string | null }>;
    expect(privateRows).toHaveLength(3);
    expect(privateRows.every((row) => row.workspaceId === null)).toBe(true);
    const sharedEvent = db.sqlite.prepare(
      "SELECT actor_user_id AS actorUserId, before, after FROM audit_logs WHERE workspace_id = 'shared-workspace' AND entity_type = 'workspace_settings'",
    ).get() as { actorUserId: string; before: string; after: string };
    expect(sharedEvent).toEqual({
      actorUserId: "owner",
      before: JSON.stringify({ defaultCurrency: "USD", timeZone: "UTC" }),
      after: JSON.stringify({ defaultCurrency: "EUR", timeZone: "Europe/Bucharest" }),
    });
    expect(`${sharedEvent.before}${sharedEvent.after}`).not.toContain("Owner");
    expect(`${sharedEvent.before}${sharedEvent.after}`).not.toContain("en-US");

    const management = await api(memberSharedToken, "GET", "workspaces/current");
    expect(management.status).toBe(200);
    const managementText = await responseText(management);
    expect(managementText).toContain("workspace_settings");
    expect(managementText).not.toContain('"entityType":"user_settings"');
    expect(managementText).not.toContain("ro-RO");
  });
});
