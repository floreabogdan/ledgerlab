import { expect, test } from "@playwright/test";

const PASSWORD = "LedgerLab-Household-E2E-2026!";

function uniqueValue(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function testAddress() {
  return `2001:db8:${Array.from({ length: 4 }, () => Math.floor(Math.random() * 0x10000).toString(16)).join(":")}`;
}

async function registerOwner(page: import("@playwright/test").Page, email: string) {
  await page.context().setExtraHTTPHeaders({ "x-forwarded-for": testAddress() });
  await page.goto("/register");
  await page.getByLabel("Name").fill("Household owner");
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel(/^Password/).fill(PASSWORD);
  await page.getByLabel(/^Confirm password/).fill(PASSWORD);
  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect(page).toHaveURL(/\/$/);
}

type ApiResult<T = Record<string, unknown>> = { status: number; body: T };

async function apiJson<T = Record<string, unknown>>(
  page: import("@playwright/test").Page,
  path: string,
  method = "GET",
  body?: Record<string, unknown>,
  headers?: Record<string, string>,
): Promise<ApiResult<T>> {
  const result = await page.evaluate(async ({ requestPath, requestMethod, requestBody, requestHeaders }) => {
    const response = await fetch(requestPath, {
      method: requestMethod,
      headers: {
        Accept: "application/json",
        ...(requestBody ? { "Content-Type": "application/json" } : {}),
        ...requestHeaders,
      },
      body: requestBody ? JSON.stringify(requestBody) : undefined,
    });
    return {
      status: response.status,
      body: await response.json().catch(() => ({})),
    };
  }, { requestPath: path, requestMethod: method, requestBody: body, requestHeaders: headers });
  if (result.status >= 400) {
    throw new Error(`${method} ${path} failed (${result.status}): ${JSON.stringify(result.body)}`);
  }
  return result as ApiResult<T>;
}

function records(value: unknown, key: string) {
  if (!value || typeof value !== "object") return [];
  const list = (value as Record<string, unknown>)[key];
  return Array.isArray(list) ? list as Array<Record<string, unknown>> : [];
}

test("creates a household, accepts a single-use invite, switches workspace, and removes a member", async ({
  page,
  browser,
  baseURL,
}) => {
  const suffix = uniqueValue("household");
  const ownerEmail = `owner-${suffix}@ledgerlab.test`;
  const inviteeEmail = `member-${suffix}@ledgerlab.test`;
  const householdName = `Shared home ${suffix}`;
  const inviteeName = `Invited partner ${suffix}`;

  await registerOwner(page, ownerEmail);
  await page.goto("/workspaces");
  await expect(page.getByRole("heading", { name: "Workspaces", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Create household" }).first().click();
  const createDialog = page.getByRole("dialog", { name: "Create a household workspace" });
  await createDialog.getByLabel("Household name").fill(householdName);
  await createDialog.getByRole("button", { name: "Create household" }).click();
  await expect(page).toHaveURL(/\/workspaces$/);
  await expect(page.getByRole("heading", { name: householdName, exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Invite someone" }).click();
  const inviteDialog = page.getByRole("dialog", { name: "Invite a household member" });
  await inviteDialog.getByLabel("Email address").fill(inviteeEmail);
  await inviteDialog.getByLabel("Role").selectOption("member");
  await inviteDialog.getByRole("button", { name: "Create invitation" }).click();
  const inviteLink = await page.locator("code").textContent();
  expect(inviteLink).toMatch(/^https?:\/\/.*\/invite\/[A-Za-z0-9_-]{43}$/);

  const inviteeContext = await browser.newContext({
    baseURL,
    locale: "en-US",
    timezoneId: "America/New_York",
    extraHTTPHeaders: { "x-forwarded-for": testAddress() },
  });
  try {
    const inviteePage = await inviteeContext.newPage();
    await inviteePage.goto(inviteLink!);
    await expect(inviteePage.getByRole("heading", { name: `Join ${householdName}` })).toBeVisible();
    await inviteePage.getByRole("button", { name: "Create an account" }).click();
    await inviteePage.getByLabel("Name").fill(inviteeName);
    await inviteePage.getByLabel("Email address").fill(inviteeEmail);
    await inviteePage.getByLabel(/^Password/).fill(PASSWORD);
    await inviteePage.getByLabel(/^Confirm password/).fill(PASSWORD);
    await inviteePage.getByRole("button", { name: "Create account & accept" }).click();
    await expect(inviteePage).toHaveURL(/\/$/);
    await expect(inviteePage.getByRole("button", {
      name: `Open workspace menu for ${householdName}`,
    })).toBeVisible();

    await inviteePage.getByRole("button", {
      name: `Open workspace menu for ${householdName}`,
    }).click();
    await inviteePage.getByRole("menuitemradio", { name: new RegExp(`^${inviteeName}`) }).click();
    await expect(inviteePage.getByRole("button", {
      name: `Open workspace menu for ${inviteeName}`,
    })).toBeVisible();

    const privateAccountName = `Private savings ${suffix}`;
    const today = new Date().toISOString().slice(0, 10);
    const privateAccount = await apiJson<{ account: Record<string, unknown> }>(inviteePage, "/api/accounts", "POST", {
      name: privateAccountName,
      type: "current_account",
      currency: "RON",
      openingBalanceMinor: 50_000,
      openingDate: today,
      color: "#2563eb",
    });
    expect(privateAccount.status).toBe(201);

    await inviteePage.getByRole("button", {
      name: `Open workspace menu for ${inviteeName}`,
    }).click();
    await inviteePage.getByRole("menuitemradio", { name: new RegExp(`^${householdName}`) }).click();
    await expect(inviteePage.getByRole("button", {
      name: `Open workspace menu for ${householdName}`,
    })).toBeVisible();

    const sharedAccountName = `Joint utilities ${suffix}`;
    const sharedBillName = `Electricity ${suffix}`;
    const accountResult = await apiJson<{ account: Record<string, unknown> }>(page, "/api/accounts", "POST", {
      name: sharedAccountName,
      type: "current_account",
      currency: "RON",
      openingBalanceMinor: 100_000,
      openingDate: today,
      institution: "Household bank",
      holderLabel: "Joint",
      color: "#2563eb",
    });
    const accountId = String(accountResult.body.account.id);
    expect(accountResult.status).toBe(201);

    const plannedResult = await apiJson<{ occurrence: Record<string, unknown> }>(page, "/api/planned", "POST", {
      name: sharedBillName,
      direction: "expense",
      expectedAmountMinor: 12_345,
      currency: "RON",
      dueDate: today,
      accountId,
      status: "planned",
      notes: "Shared utility bill",
      recurrence: null,
    });
    const occurrenceId = String(plannedResult.body.occurrence.id);
    const plannedPaymentId = String(plannedResult.body.occurrence.plannedPaymentId);
    expect(plannedResult.status).toBe(201);

    const invoiceUpload = await page.evaluate(async ({ paymentId }) => {
      const content = new TextEncoder().encode("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF\n");
      const response = await fetch(`/api/planned/${encodeURIComponent(paymentId)}/attachments?filename=utility-invoice.pdf`, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/pdf" },
        body: content,
      });
      return { status: response.status, body: await response.json().catch(() => ({})) };
    }, { paymentId: plannedPaymentId });
    expect(invoiceUpload.status).toBe(201);

    const memberAccounts = await apiJson<Record<string, unknown>>(inviteePage, "/api/accounts");
    expect(records(memberAccounts.body, "accounts").map((item) => item.name)).toContain(sharedAccountName);
    expect(records(memberAccounts.body, "accounts").map((item) => item.name)).not.toContain(privateAccountName);
    const ownerAccounts = await apiJson<Record<string, unknown>>(page, "/api/accounts");
    expect(records(ownerAccounts.body, "accounts").map((item) => item.name)).not.toContain(privateAccountName);

    await inviteePage.goto(new URL("/planned", inviteePage.url()).toString());
    await expect(inviteePage.getByText(sharedBillName, { exact: true }).first()).toBeVisible();
    await inviteePage.getByRole("button", { name: "Manage invoices (1)" }).click();
    const invoiceDialog = inviteePage.getByRole("dialog", { name: "Invoice documents" });
    await expect(invoiceDialog.getByText("utility-invoice.pdf", { exact: true })).toBeVisible();
    await invoiceDialog.getByRole("button", { name: "Close", exact: true }).click();

    const idempotencyKey = `household-payment-${suffix}`;
    const paymentBody = {
      amountMinor: 12_345,
      appliedAmountMinor: 12_345,
      date: today,
      accountId,
      partial: false,
    };
    const [ownerPayment, memberPayment] = await Promise.all([
      apiJson<{ result: Record<string, unknown> }>(page, `/api/planned/${encodeURIComponent(occurrenceId)}/pay`, "POST", paymentBody, { "Idempotency-Key": idempotencyKey }),
      apiJson<{ result: Record<string, unknown> }>(inviteePage, `/api/planned/${encodeURIComponent(occurrenceId)}/pay`, "POST", paymentBody, { "Idempotency-Key": idempotencyKey }),
    ]);
    expect(ownerPayment.body.result.transactionId).toBe(memberPayment.body.result.transactionId);

    for (const sessionPage of [page, inviteePage]) {
      const planned = await apiJson<Record<string, unknown>>(sessionPage, `/api/planned?from=${today}&to=${today}`);
      const shared = records(planned.body, "occurrences").find((item) => item.name === sharedBillName);
      expect(shared).toMatchObject({ status: "paid", attachmentCount: 1 });
      expect(shared?.linkedTransactionId).toBe(ownerPayment.body.result.transactionId);
      const transactions = await apiJson<Record<string, unknown>>(sessionPage, `/api/transactions?from=${today}&to=${today}`);
      const linked = records(transactions.body, "transactions").filter((item) => item.id === ownerPayment.body.result.transactionId);
      expect(linked).toHaveLength(1);
    }

    await apiJson(inviteePage, "/api/settings/preferences", "POST", {
      displayName: inviteeName,
      locale: "ro-RO",
      uiLanguage: "ro",
      compactTables: true,
    });
    await inviteePage.goto(new URL("/planned", inviteePage.url()).toString());
    await expect(inviteePage.getByRole("heading", { name: "Plăți planificate", exact: true })).toBeVisible();
    await expect(inviteePage.getByRole("tab", { name: /Plătite1/ })).toBeVisible();
    const romanianShared = await apiJson<Record<string, unknown>>(inviteePage, `/api/planned?from=${today}&to=${today}`);
    expect(records(romanianShared.body, "occurrences").find((item) => item.name === sharedBillName)).toMatchObject({ status: "paid" });
    await page.goto("/planned");
    await expect(page.getByRole("heading", { name: "Planned payments", exact: true })).toBeVisible();
    await expect(page.getByRole("tab", { name: /Paid1/ })).toBeVisible();
    const englishShared = await apiJson<Record<string, unknown>>(page, `/api/planned?from=${today}&to=${today}`);
    expect(records(englishShared.body, "occurrences").find((item) => item.name === sharedBillName)).toMatchObject({ status: "paid" });

    await inviteePage.goto(new URL("/workspaces", inviteLink!).toString());
    await expect(inviteePage.getByText(inviteeEmail, { exact: true })).toBeVisible();
    await expect(inviteePage.getByRole("button", { name: "Invită pe cineva" })).toHaveCount(0);

    await page.goto("/workspaces");
    const membersTable = page.getByRole("region", { name: "Household members" }).getByRole("table");
    const memberRow = membersTable.getByRole("row").filter({ hasText: inviteeEmail });
    await expect(memberRow).toBeVisible();
    const activityTable = page.getByRole("region", { name: "Household activity" }).getByRole("table");
    await expect(activityTable.getByText(inviteeName, { exact: true }).first()).toBeVisible();
    page.once("dialog", (dialog) => dialog.accept());
    await memberRow.getByRole("button", { name: "Remove" }).click();
    await expect(membersTable.getByRole("row").filter({ hasText: inviteeEmail })).toHaveCount(0);

    const afterRemoval = await apiJson<Record<string, unknown>>(inviteePage, "/api/accounts");
    expect(records(afterRemoval.body, "accounts").map((item) => item.name)).toContain(privateAccountName);
    expect(records(afterRemoval.body, "accounts").map((item) => item.name)).not.toContain(sharedAccountName);
  } finally {
    await inviteeContext.close();
  }
});
