import { expect, test, type Locator, type Page } from "@playwright/test";

const PASSWORD = "LedgerLab-E2E-2026!";

function uniqueEmail(prefix: string) {
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}-${nonce}@ledgerlab.test`;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isoDateOffset(days: number) {
  return offsetDateKey(workspaceDateKey(), days);
}

function workspaceDateKey() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "America/New_York",
  }).formatToParts(new Date());
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function offsetDateKey(dateKey: string, days: number) {
  const date = new Date(`${dateKey}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function monthStartDateKey(dateKey: string) {
  return `${dateKey.slice(0, 7)}-01`;
}

function monthOffsetDateKey(dateKey: string, monthOffset: number, day = 5) {
  const [year, month] = dateKey.split("-").map(Number);
  const target = new Date(Date.UTC(year, month - 1 + monthOffset, day));
  return target.toISOString().slice(0, 10);
}

function customRangeLabel(dateKey: string) {
  const date = new Date(`${dateKey}T00:00:00Z`);
  const dayMonth = new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(date);
  const dayMonthYear = new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
  return `${dayMonth} – ${dayMonthYear}`;
}

async function navigate(page: Page, path: string) {
  await page.goto(path, { waitUntil: "networkidle" });
}

async function selectDesktopDateRange(page: Page, quickPick: string) {
  const topbar = page.locator(".app-topbar");
  const trigger = topbar.getByRole("button", { name: /^Date range:/ });
  await expect(trigger).toBeVisible();
  await trigger.click();

  const picker = page.getByRole("dialog", { name: "Choose date range" });
  await expect(picker).toBeVisible();
  await picker.getByRole("button", { name: quickPick, exact: true }).click();
  await expect(picker).toBeHidden();
}

async function register(page: Page, prefix: string) {
  const email = uniqueEmail(prefix);
  await navigate(page, "/register");
  await page.getByRole("button", { name: "Show", exact: true }).click();
  await expect(page.getByRole("button", { name: "Hide", exact: true })).toBeVisible();
  await page.getByLabel("Name").fill("LedgerLab E2E");
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel(/^Password/).fill(PASSWORD);
  await page.getByLabel(/^Confirm password/).fill(PASSWORD);
  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { name: "Your money, today" })).toBeVisible();
  return email;
}

async function openCombobox(combobox: Locator) {
  await expect(combobox).toHaveAttribute("role", "combobox");
  if (await combobox.getAttribute("aria-expanded") !== "true") {
    await combobox.click();
  }
  await expect(combobox).toHaveAttribute("aria-expanded", "true");

  const listboxId = await combobox.getAttribute("aria-controls");
  if (!listboxId) throw new Error("Open combobox has no aria-controls target");

  const listbox = combobox.page().locator(`[id=${JSON.stringify(listboxId)}][role="listbox"]`);
  await expect(listbox).toBeVisible();
  return listbox;
}

async function selectComboboxValue(combobox: Locator, value: string) {
  const listbox = await openCombobox(combobox);
  let option = listbox.locator(`[role="option"][data-value=${JSON.stringify(value)}]`);
  if (await option.count() === 0) {
    option = listbox.getByRole("option", { name: new RegExp(`^${escapeRegExp(value)},(?:\\s|$)`) });
  }
  await expect(option).toHaveCount(1);
  await option.click();
  await expect(combobox).toHaveAttribute("aria-expanded", "false");
}

async function selectNamedOption(combobox: Locator, optionText: string) {
  const listbox = await openCombobox(combobox);
  const option = listbox.getByRole("option", {
    name: new RegExp(`^${escapeRegExp(optionText)}(?:\\s|$)`, "i"),
  });
  await expect(option).toHaveCount(1);
  await option.click();
  await expect(combobox).toHaveAttribute("aria-expanded", "false");
}

async function createAccount(
  page: Page,
  account: { name: string; type: "current_account" | "savings" | "cash"; openingBalance: string; currency?: string },
) {
  if (new URL(page.url()).pathname !== "/accounts") {
    await navigate(page, "/accounts");
  }
  await expect(page.getByRole("heading", { name: "Accounts", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Add account" }).first().click();

  const dialog = page.getByRole("dialog", { name: "Add account" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel(/^Account name/).fill(account.name);
  await selectComboboxValue(dialog.getByLabel(/^Account type/), account.type);
  if (account.currency) {
    await selectComboboxValue(dialog.getByLabel(/^Currency/), account.currency);
  }
  await dialog.getByLabel(/^Opening balance/).fill(account.openingBalance);
  await dialog.getByLabel(/^Balance date/).fill(isoDateOffset(0));
  await dialog.getByRole("button", { name: "Create account" }).click();

  await expect(dialog).toBeHidden();
  await expect(page.getByText(account.name, { exact: true })).toBeVisible();
}

type TransactionDetails = {
  kind: "Income" | "Expense" | "Transfer";
  account: string;
  amount: string;
  merchant?: string;
  category?: string;
  toAccount?: string;
  currency?: string;
};

async function addTransaction(page: Page, transaction: TransactionDetails) {
  if (new URL(page.url()).pathname !== "/transactions") {
    await navigate(page, "/transactions");
  }
  await expect(page.getByRole("heading", { name: "Transactions" })).toBeVisible();
  await page.getByRole("button", { name: "Add transaction" }).first().click();

  const dialog = page.getByRole("dialog", { name: "Add transaction" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: transaction.kind, exact: true }).click();
  await dialog.getByLabel(/^Date/).fill(isoDateOffset(0));

  const accountSelect = dialog.getByLabel(transaction.kind === "Transfer" ? /^From account/ : /^Account/);
  await selectNamedOption(accountSelect, transaction.account);
  if (transaction.kind === "Transfer") {
    await selectNamedOption(dialog.getByLabel(/^To account/), transaction.toAccount ?? "");
  } else {
    await dialog.getByLabel(/^Merchant or source/).fill(transaction.merchant ?? "");
    if (transaction.category) {
      await selectNamedOption(dialog.getByLabel(/^Category/), transaction.category);
    }
  }
  await dialog.getByLabel(new RegExp(`^Amount \\(${transaction.currency ?? "USD"}\\)`)).fill(transaction.amount);
  await dialog.getByRole("button", { name: "Save transaction" }).click();
  await expect(dialog).toBeHidden();
}

function metric(page: Page, label: string) {
  return page.getByText(label, { exact: true }).locator("..").locator("..");
}

function accountCard(page: Page, name: string) {
  return page.locator("article").filter({ has: page.getByText(name, { exact: true }) });
}

async function expectNoHorizontalWindowScroll(page: Page) {
  await expect.poll(() => page.evaluate(() => {
    window.scrollTo(document.documentElement.scrollWidth, window.scrollY);
    return window.scrollX;
  })).toBe(0);
}

async function expectReorganizedDesktopNavigation(page: Page) {
  const sidebar = page.locator(".app-sidebar");
  await expect(sidebar.getByText("Manage", { exact: true })).toBeVisible();

  const managementPages = [
    { label: "Accounts", path: "/accounts", heading: "Accounts" },
    { label: "Categories", path: "/categories", heading: "Categories" },
    { label: "Tags", path: "/tags", heading: "Tags" },
    { label: "Merchants", path: "/merchants", heading: "Merchants" },
    { label: "Import transactions", path: "/import", heading: "Import transactions" },
  ];

  for (const destination of managementPages) {
    const link = sidebar.getByRole("link", { name: destination.label, exact: true });
    await expect(link).toHaveAttribute("href", destination.path);
    await link.click();
    await expect(page).toHaveURL(new RegExp(`${destination.path}$`));
    await expect(page.getByRole("heading", { name: destination.heading, exact: true })).toBeVisible();
  }

  await expect(sidebar.getByRole("link", { name: "Profile settings", exact: true })).toHaveCount(0);
  await expect(sidebar.getByRole("link", { name: "Data & backups", exact: true })).toHaveCount(0);

  const forecastLink = sidebar.getByRole("link", { name: "Monthly forecast", exact: true });
  await expect(forecastLink).toHaveAttribute("href", "/planning");
  await forecastLink.click();
  await expect(page).toHaveURL(/\/planning$/);
  await expect(page.getByRole("heading", { name: "Monthly forecast", exact: true })).toBeVisible();

  await sidebar.getByRole("link", { name: "Dashboard", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
}

test.describe("complete desktop finance workflow", () => {
  test.skip(({ isMobile }) => Boolean(isMobile), "The complete workflow runs in the desktop project.");

  test("registers, reconciles accounts and transfers, pays a future plan, and reports actual statistics", async ({ page }) => {
    test.setTimeout(120_000);

    const email = await register(page, "desktop");
    const desktopTopbar = page.locator(".app-topbar");
    await expect(desktopTopbar.getByRole("link", { name: "Add transaction" })).toHaveCount(0);
    await expectReorganizedDesktopNavigation(page);

    const accountTrigger = desktopTopbar.getByRole("button", {
      name: "Open account menu for LedgerLab E2E",
    });
    await accountTrigger.click();
    const accountMenu = page.getByRole("menu", { name: "User account" });
    await expect(accountMenu).toBeVisible();
    await expect(accountMenu.getByText("LedgerLab E2E", { exact: true })).toBeVisible();
    await expect(accountMenu.getByText(email, { exact: true })).toBeVisible();
    await expect(accountMenu.getByRole("menuitem", { name: "Profile settings" })).toBeVisible();
    await expect(accountMenu.getByRole("menuitem", { name: "Data & backups" })).toBeVisible();
    await expect(accountMenu.getByRole("menuitem", { name: "Sign out" })).toBeVisible();

    await accountMenu.getByRole("menuitem", { name: "Profile settings" }).click();
    await expect(page).toHaveURL(/\/settings$/);
    await expect(page.getByRole("heading", { name: "Profile settings", exact: true })).toBeVisible();

    await accountTrigger.click();
    await expect(accountMenu).toBeVisible();
    await accountMenu.getByRole("menuitem", { name: "Data & backups" }).click();
    await expect(page).toHaveURL(/\/import-export$/);
    await expect(page.getByRole("heading", { name: "Data & backups", exact: true })).toBeVisible();

    await navigate(page, "/");

    const today = workspaceDateKey();
    const customLabel = customRangeLabel(today);
    const rangeTrigger = desktopTopbar.getByRole("button", { name: /^Date range:/ });
    await rangeTrigger.click();
    let rangeDialog = page.getByRole("dialog", { name: "Choose date range" });
    const thisMonth = rangeDialog.getByRole("button", { name: "This month", exact: true });
    await expect(thisMonth).toHaveAttribute("aria-pressed", "true");

    await rangeDialog.getByLabel("Start date").fill(offsetDateKey(today, 1));
    await rangeDialog.getByLabel("End date").fill(today);
    await rangeDialog.getByRole("button", { name: "Apply range" }).click();
    await expect(rangeDialog.getByRole("alert")).toHaveText(
      "The start date must be on or before the end date.",
    );

    await rangeDialog.getByLabel("Start date").fill(today);
    await rangeDialog.getByLabel("End date").fill(today);
    await rangeDialog.getByRole("button", { name: "Apply range" }).click();
    await expect(rangeDialog).toBeHidden();
    await expect(rangeTrigger).toContainText(customLabel);

    await page.getByRole("link", { name: "Accounts", exact: true }).click();
    await expect(page).toHaveURL(/\/accounts$/);
    await expect(page.getByRole("heading", { name: "Accounts", exact: true })).toBeVisible();
    const persistedRangeTrigger = page
      .locator(".app-topbar")
      .getByRole("button", { name: /^Date range:/ });
    await expect(persistedRangeTrigger).toContainText(customLabel);

    await persistedRangeTrigger.click();
    rangeDialog = page.getByRole("dialog", { name: "Choose date range" });
    await rangeDialog.getByRole("button", { name: "This month", exact: true }).click();
    await expect(rangeDialog).toBeHidden();

    await createAccount(page, {
      name: "Everyday Current",
      type: "current_account",
      openingBalance: "1000.00",
    });
    await createAccount(page, {
      name: "Rainy Day Savings",
      type: "savings",
      openingBalance: "200.00",
    });

    await addTransaction(page, {
      kind: "Income",
      account: "Everyday Current",
      amount: "5000.00",
      merchant: "E2E Employer",
      category: "Salary",
    });
    await addTransaction(page, {
      kind: "Expense",
      account: "Everyday Current",
      amount: "250.00",
      merchant: "E2E Grocer",
      category: "Groceries",
    });

    await page.getByRole("button", { name: "Add transaction" }).first().click();
    let transactionDialog = page.getByRole("dialog", { name: "Add transaction" });
    await transactionDialog.getByRole("button", { name: "Adjustment", exact: true }).click();
    await transactionDialog.getByLabel(/^Date/).fill(isoDateOffset(0));
    await selectComboboxValue(transactionDialog.getByLabel(/^Status/), "pending");
    await selectNamedOption(transactionDialog.getByLabel(/^Account/), "Everyday Current");
    await transactionDialog.getByLabel(/^Merchant or source/).fill("E2E pending correction");
    await transactionDialog.getByLabel(/^Signed amount/).fill("-10.00");
    await transactionDialog.getByRole("button", { name: "Save transaction" }).click();
    await expect(transactionDialog).toBeHidden();

    const transactionTable = page.getByRole("region", { name: "Transactions" });
    const correctionRow = transactionTable.getByRole("row").filter({ hasText: "E2E pending correction" });
    await correctionRow.getByRole("button", { name: "Duplicate transaction" }).click();
    transactionDialog = page.getByRole("dialog", { name: "Duplicate transaction" });
    await expect(transactionDialog.getByLabel(/^Signed amount/)).toHaveValue("-10.00");
    const duplicateConfirmation = transactionDialog.getByLabel(/I reviewed this possible duplicate/);
    await expect(duplicateConfirmation).not.toBeChecked();
    await expect(transactionDialog.getByRole("button", { name: "Save transaction" })).toBeDisabled();
    await transactionDialog.getByRole("button", { name: "Cancel" }).click();

    await page.getByRole("button", { name: "Add transaction" }).first().click();
    transactionDialog = page.getByRole("dialog", { name: "Add transaction" });
    await transactionDialog.getByRole("button", { name: "Expense", exact: true }).click();
    await transactionDialog.getByLabel(/^Date/).fill(isoDateOffset(0));
    await selectComboboxValue(transactionDialog.getByLabel(/^Status/), "pending");
    await selectNamedOption(transactionDialog.getByLabel(/^Account/), "Everyday Current");
    await transactionDialog.getByLabel(/^Merchant or source/).fill("E2E pending split");
    await transactionDialog.getByLabel(/^Amount \(USD\)/).fill("30.00");
    await transactionDialog.getByLabel("Split across categories").check();
    await selectNamedOption(transactionDialog.getByLabel("Category 1"), "Groceries");
    await selectNamedOption(transactionDialog.getByLabel("Category 2"), "Utilities");
    const splitAmounts = transactionDialog.getByLabel("Amount (USD)");
    await splitAmounts.nth(1).fill("10.00");
    await splitAmounts.nth(2).fill("20.00");
    await transactionDialog.getByRole("button", { name: "Save transaction" }).click();
    await expect(transactionDialog).toBeHidden();

    const splitRow = transactionTable.getByRole("row").filter({ hasText: "E2E pending split" });
    await expect(splitRow).toContainText("2-way split");
    await splitRow.getByRole("button", { name: "Duplicate transaction" }).click();
    transactionDialog = page.getByRole("dialog", { name: "Duplicate transaction" });
    await expect(transactionDialog.getByLabel("Split across categories")).toBeChecked();
    await expect(transactionDialog.getByLabel("Category 1")).toContainText("Groceries");
    await expect(transactionDialog.getByLabel("Category 2")).toContainText("Utilities");
    await expect(transactionDialog.getByLabel("Amount (USD)").nth(1)).toHaveValue("10.00");
    await expect(transactionDialog.getByLabel("Amount (USD)").nth(2)).toHaveValue("20.00");
    await transactionDialog.getByRole("button", { name: "Cancel" }).click();

    await addTransaction(page, {
      kind: "Transfer",
      account: "Everyday Current",
      toAccount: "Rainy Day Savings",
      amount: "125.00",
    });

    await expect(transactionTable.getByRole("row").filter({ hasText: "E2E Employer" })).toHaveCount(1);
    await expect(transactionTable.getByRole("row").filter({ hasText: "E2E Grocer" })).toHaveCount(1);
    await expect(transactionTable.getByRole("row").filter({ hasText: "Internal transfer" })).toHaveCount(2);

    await navigate(page, "/accounts");
    await expect(accountCard(page, "Everyday Current")).toContainText("5,625.00");
    await expect(accountCard(page, "Rainy Day Savings")).toContainText("325.00");

    await navigate(page, "/statistics");
    await expect(page.getByRole("heading", { name: "Statistics" })).toBeVisible();
    await expect(metric(page, "Actual income")).toContainText("5,000.00");
    await expect(metric(page, "Actual expenses")).toContainText("250.00");
    await expect(metric(page, "Net cash flow")).toContainText("4,750.00");

    await navigate(page, "/planned");
    await expect(page.getByRole("heading", { name: "Planned payments" })).toBeVisible();
    await selectDesktopDateRange(page, "Next month");
    await page.getByRole("button", { name: "Plan payment" }).first().click();

    const planDialog = page.getByRole("dialog", { name: "Plan a payment" });
    await planDialog.getByLabel(/^Payment name/).fill("Future electricity E2E");
    await planDialog.getByLabel(/^Expected amount/).fill("300.00");
    await planDialog.getByLabel(/^Due date/).fill(monthOffsetDateKey(workspaceDateKey(), 1));
    await selectNamedOption(planDialog.getByLabel(/^Expected account/), "Everyday Current");
    await selectNamedOption(planDialog.getByLabel(/^Category/), "Utilities");
    await planDialog.getByRole("button", { name: "Create planned payment" }).click();
    await expect(planDialog).toBeHidden();

    const plannedTable = page.getByRole("region", { name: "Planned payment occurrences" });
    const plannedRow = plannedTable.getByRole("row").filter({ hasText: "Future electricity E2E" });
    await expect(plannedRow).toHaveCount(1);
    await expect(plannedRow).toContainText("planned");
    await expect(plannedRow).toContainText("300.00");
    await plannedRow.getByRole("button", { name: "Mark paid" }).click();

    const payDialog = page.getByRole("dialog", { name: "Record actual payment" });
    await payDialog.getByLabel(/^Amount applied to plan/).fill("312.34");
    await payDialog.getByLabel(/^Payment date/).fill(isoDateOffset(0));
    await selectNamedOption(payDialog.getByLabel(/^Paid from account/), "Everyday Current");
    await payDialog.getByRole("button", { name: "Mark paid" }).click();
    await expect(payDialog).toBeHidden();

    await page.getByRole("tab", { name: /^Paid/ }).click();
    const paidRow = page
      .getByRole("region", { name: "Planned payment occurrences" })
      .getByRole("row")
      .filter({ hasText: "Future electricity E2E" });
    await expect(paidRow).toContainText("paid");
    await expect(paidRow).toContainText("312.34");

    await selectDesktopDateRange(page, "This month");
    await navigate(page, "/transactions");
    const linkedActual = page
      .getByRole("region", { name: "Transactions" })
      .getByRole("row")
      .filter({ hasText: "312.34" });
    await expect(linkedActual).toHaveCount(1);
    await expect(linkedActual).toContainText("Utilities");
    await expect(linkedActual).toContainText("Everyday Current");

    await navigate(page, "/statistics");
    await expect(metric(page, "Actual income")).toContainText("5,000.00");
    await expect(metric(page, "Actual expenses")).toContainText("562.34");
    await expect(metric(page, "Net cash flow")).toContainText("4,437.66");
    await page.getByRole("tab", { name: "Forecast & runway" }).click();
    await expect(page.getByRole("heading", { name: "Planned versus actual spending" })).toBeVisible();
  });

  test("tracks a fully-used card and an indexed loan without counting debt payments as new spending", async ({ page }) => {
    test.setTimeout(120_000);

    await register(page, "liabilities");
    await createAccount(page, {
      name: "Debt Payment Current",
      type: "current_account",
      openingBalance: "25000.00",
    });

    await page.getByRole("button", { name: "Add account" }).first().click();
    let accountDialog = page.getByRole("dialog", { name: "Add account" });
    await selectComboboxValue(accountDialog.getByLabel(/^Account type/), "credit_card");
    await accountDialog.getByLabel(/^Credit card name/).fill("Fully Used Card");
    await accountDialog.getByLabel(/^Credit limit/).fill("5000.00");
    await selectComboboxValue(accountDialog.getByLabel("Opening amount represents"), "available");
    await accountDialog.getByLabel(/^Available credit/).fill("0.00");
    await expect(accountDialog.getByText("Opening debt LedgerLab will record").locator("..")).toContainText("5,000.00");
    await accountDialog.getByLabel("Advanced card setup", { exact: true }).click();
    await accountDialog.getByLabel("Statement day").fill("15");
    await accountDialog.getByLabel("Payment due day").fill("5");
    await accountDialog.getByRole("button", { name: "Create account" }).click();
    await expect(accountDialog).toBeHidden();

    const card = accountCard(page, "Fully Used Card");
    await expect(card).toContainText("5,000.00");
    await expect(card).toContainText("Available");
    await expect(card).toContainText("0.00");
    await expect(card).toContainText("100.0% used");
    await card.getByRole("button", { name: "Manage debt", exact: true }).last().click();

    await expect(page).toHaveURL(/\/accounts\/[^/]+$/);
    await expect(page.getByRole("heading", { name: "Fully Used Card", exact: true })).toBeVisible();
    await expect(metric(page, "Outstanding")).toContainText("5,000.00");
    await expect(metric(page, "Available credit")).toContainText("0.00");
    await expect(metric(page, "Utilization")).toContainText("100.0%");

    await page.getByRole("button", { name: "Add statement" }).click();
    const statementDialog = page.getByRole("dialog", { name: "Add card statement" });
    const today = workspaceDateKey();
    await statementDialog.getByLabel("Period start").fill(monthStartDateKey(today));
    await statementDialog.getByLabel("Period end").fill(today);
    await statementDialog.getByLabel("Closing date").fill(today);
    await statementDialog.getByLabel("Payment due").fill(offsetDateKey(today, 14));
    await statementDialog.getByLabel("Statement balance").fill("5000.00");
    await statementDialog.getByLabel("Minimum due").fill("250.00");
    await statementDialog.getByRole("button", { name: "Save statement" }).click();
    await expect(statementDialog).toBeHidden();

    const statements = page.getByRole("region", { name: "Credit-card statements" });
    const statementRow = statements.locator("tbody tr").first();
    await expect(statementRow).toContainText("5,000.00");
    await expect(statementRow).toContainText("250.00");
    await statementRow.getByRole("button", { name: "Pay", exact: true }).click();

    const cardPaymentDialog = page.getByRole("dialog", { name: "Record card payment" });
    await selectNamedOption(cardPaymentDialog.getByLabel("Pay from"), "Debt Payment Current");
    await cardPaymentDialog.getByLabel(/^Amount \(USD\)/).fill("500.00");
    await cardPaymentDialog.getByRole("button", { name: "Post payment" }).click();
    await expect(cardPaymentDialog).toBeHidden();

    await expect(metric(page, "Outstanding")).toContainText("4,500.00");
    await expect(metric(page, "Available credit")).toContainText("500.00");
    await expect(metric(page, "Utilization")).toContainText("90.0%");
    await expect(statementRow).toContainText("4,500.00");
    const cardPaymentRow = page
      .getByRole("region", { name: "Credit-card payment history" })
      .locator("tbody tr")
      .first();
    await expect(cardPaymentRow).toContainText("Debt Payment Current");
    await expect(cardPaymentRow).toContainText("500.00");
    await expect(cardPaymentRow).toContainText("Linked");
    await expect(cardPaymentRow).toContainText("posted");

    await navigate(page, "/accounts");
    await page.getByRole("button", { name: "Add account" }).first().click();
    accountDialog = page.getByRole("dialog", { name: "Add account" });
    await selectComboboxValue(accountDialog.getByLabel(/^Account type/), "loan");
    await accountDialog.getByLabel(/^Loan name/).fill("IRCC Three-Month Loan");
    await accountDialog.getByLabel(/^Principal outstanding/).fill("12000.00");
    await accountDialog.getByLabel(/^Original \/ schedule principal/).fill("12000.00");
    await accountDialog.getByLabel("Origination date").fill(today);
    await accountDialog.getByLabel("First payment date").fill(today);
    await accountDialog.getByLabel("Term (months)").fill("12");
    await accountDialog.getByLabel("Advanced loan setup", { exact: true }).click();
    await selectNamedOption(accountDialog.getByLabel("Payment account"), "Debt Payment Current");
    await selectComboboxValue(accountDialog.getByLabel("Rate type"), "variable");
    await accountDialog.getByLabel("Reference index").fill("IRCC");
    await accountDialog.getByLabel("Index tenor (months)").fill("3");
    await accountDialog.getByLabel("Current index rate (%)").fill("5.55");
    await accountDialog.getByLabel("Lender margin (%)").fill("2.45");
    await accountDialog.getByLabel("Rate resets every (months)").fill("3");
    await accountDialog.getByLabel("Jurisdiction code").fill("RO");
    await accountDialog.getByRole("button", { name: "Create account" }).click();
    await expect(accountDialog).toBeHidden();

    const loan = accountCard(page, "IRCC Three-Month Loan");
    await expect(loan).toContainText("12,000.00");
    await loan.getByRole("button", { name: "Manage debt", exact: true }).last().click();

    await expect(page.getByRole("heading", { name: "IRCC Three-Month Loan", exact: true })).toBeVisible();
    await expect(metric(page, "Outstanding principal")).toContainText("12,000.00");
    const rates = page.getByRole("region", { name: "Loan interest-rate periods" });
    await expect(rates.locator("tbody tr").first()).toContainText("IRCC 3M");
    await expect(rates.locator("tbody tr").first()).toContainText("8%");

    const schedule = page.getByRole("region", { name: "Loan repayment schedule" });
    const firstInstallment = schedule.locator("tbody tr").first();
    await expect(firstInstallment).toContainText("projected");
    await expect(firstInstallment).toContainText("estimate");
    await firstInstallment.getByRole("button", { name: "Pay", exact: true }).click();

    const loanPaymentDialog = page.getByRole("dialog", { name: /Record installment/ });
    await expect(loanPaymentDialog.getByLabel("Pay from")).toContainText("Debt Payment Current");
    const principalValue = Number((await loanPaymentDialog.getByLabel("Principal").inputValue()).replace(",", "."));
    const interestValue = Number((await loanPaymentDialog.getByLabel("Interest").inputValue()).replace(",", "."));
    expect(principalValue).toBeGreaterThan(0);
    expect(interestValue).toBeGreaterThan(0);
    await expect(loanPaymentDialog.getByText(/^Total lender allocation/).locator("..")).not.toContainText("0.00");
    await loanPaymentDialog.getByRole("button", { name: "Post payment" }).click();
    await expect(loanPaymentDialog).toBeHidden();

    await expect(firstInstallment).toContainText("paid");
    const loanPaymentRow = page
      .getByRole("region", { name: "Loan payment history" })
      .locator("tbody tr")
      .first();
    await expect(loanPaymentRow).toContainText("Debt Payment Current");
    await expect(loanPaymentRow).toContainText("posted");
    await expect(loanPaymentRow.locator("td").nth(3)).not.toHaveText(/^0\.00/);
    await expect(loanPaymentRow.locator("td").nth(4)).not.toHaveText(/^0\.00/);

    await navigate(page, "/statistics");
    await page.getByRole("tab", { name: "Debt", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Debt service over time" })).toBeVisible();
    await expect(page.getByText("Credit-card payments", { exact: true }).locator("..")).toContainText("500.00");
    await expect(page.getByText("Loan payments", { exact: true }).locator("..")).not.toContainText("0.00");
    const liabilitySummary = page.getByRole("region", { name: "Liability account summary" });
    const cardSummary = liabilitySummary.getByRole("row").filter({ hasText: "Fully Used Card" });
    await expect(cardSummary).toContainText("4,500.00");
    await expect(cardSummary).toContainText("500.00");
    await expect(cardSummary).toContainText("90%");
    const loanSummary = liabilitySummary.getByRole("row").filter({ hasText: "IRCC Three-Month Loan" });
    await expect(loanSummary).toContainText("Loan");
    await expect(loanSummary.locator("td").nth(2)).not.toContainText("12,000.00");
    await expect(loanSummary.locator("td").nth(3)).toContainText("12,000.00");
    await expect(page.getByText(/not guaranteed financial, legal, tax, or lending advice/)).toBeVisible();
  });
});

test.describe("custom select keyboard workflow", () => {
  test.skip(({ isMobile }) => Boolean(isMobile), "Keyboard interactions run in the desktop project.");

  test("supports navigation, typeahead, dismissal, and portaled-search tab order", async ({ page }) => {
    await register(page, "select-keyboard");

    await navigate(page, "/accounts");
    await page.getByRole("button", { name: "Add account" }).first().click();
    const accountDialog = page.getByRole("dialog", { name: "Add account" });
    const accountType = accountDialog.getByRole("combobox", { name: /^Account type/ });

    await accountType.focus();
    await accountType.press("ArrowDown");
    await expect(accountType).toHaveAttribute("aria-expanded", "true");
    await accountType.press("ArrowDown");
    await accountType.press("Enter");
    await expect(accountType).toContainText("Savings");
    await expect(accountType).toBeFocused();

    await accountType.press("i");
    await expect(accountType).toContainText("Investment");

    await accountType.press("Enter");
    await expect(accountType).toHaveAttribute("aria-expanded", "true");
    await accountType.press("Escape");
    await expect(accountType).toHaveAttribute("aria-expanded", "false");
    await expect(accountType).toBeFocused();
    await accountDialog.getByRole("button", { name: "Cancel" }).click();
    await expect(accountDialog).toBeHidden();

    await navigate(page, "/import");
    await page.locator('input[type="file"]').setInputFiles({
      name: "keyboard-mapping.csv",
      mimeType: "text/csv",
      buffer: Buffer.from("Unmapped Alpha,Unmapped Beta\nfirst,second\n"),
    });

    const firstMapping = page.getByRole("combobox", { name: "Map Unmapped Alpha" });
    const secondMapping = page.getByRole("combobox", { name: "Map Unmapped Beta" });
    await expect(firstMapping).toBeVisible();
    await firstMapping.focus();
    await firstMapping.press("Enter");

    let mappingListbox = await openCombobox(firstMapping);
    await expect(mappingListbox.getByRole("option")).toHaveCount(13);
    let mappingSearch = page.getByRole("searchbox", { name: "Search map unmapped alpha" });
    await expect(mappingSearch).toBeFocused();
    await mappingSearch.fill("Original");
    await expect(mappingListbox.getByRole("option")).toHaveCount(2);
    await mappingSearch.press("ArrowDown");
    await mappingSearch.press("Enter");
    await expect(firstMapping).toContainText("Original currency");
    await expect(firstMapping).toBeFocused();

    await firstMapping.press("Enter");
    mappingSearch = page.getByRole("searchbox", { name: "Search map unmapped alpha" });
    await expect(mappingSearch).toBeFocused();
    await mappingSearch.press("Escape");
    await expect(firstMapping).toHaveAttribute("aria-expanded", "false");
    await expect(firstMapping).toBeFocused();

    await firstMapping.press("Enter");
    mappingListbox = await openCombobox(firstMapping);
    await expect(mappingListbox).toBeVisible();
    mappingSearch = page.getByRole("searchbox", { name: "Search map unmapped alpha" });
    await expect(mappingSearch).toBeFocused();
    await mappingSearch.press("Tab");
    await expect(firstMapping).toHaveAttribute("aria-expanded", "false");
    await expect(secondMapping).toBeFocused();

    await navigate(page, "/settings");
    const locale = page.getByRole("combobox", { name: "Locale" });
    await locale.fill("de-");
    await expect(locale).toHaveAttribute("aria-expanded", "true");
    await locale.press("Enter");
    await expect(locale).toHaveValue("de-DE");
    await expect(locale).toHaveAttribute("aria-expanded", "false");

    const timeZone = page.getByRole("combobox", { name: "Time zone" });
    await timeZone.fill("Europe/Berl");
    await expect(timeZone).toHaveAttribute("aria-expanded", "true");
    await timeZone.press("Enter");
    await expect(timeZone).toHaveValue("Europe/Berlin");
    await page.getByRole("button", { name: "Save profile settings" }).click();
    await expect(page.getByText("Profile preferences saved.", { exact: true })).toBeVisible();

    await navigate(page, "/settings");
    await expect(page.getByRole("combobox", { name: "Locale" })).toHaveValue("de-DE");
    await expect(page.getByRole("combobox", { name: "Time zone" })).toHaveValue("Europe/Berlin");
  });
});

test.describe("adaptive account and category workflow", () => {
  test.skip(({ isMobile }) => Boolean(isMobile), "The wide adaptive layout runs in the desktop project.");

  test("keeps account setup contained and creates editable nested categories from a transaction", async ({ page }) => {
    test.setTimeout(120_000);

    await register(page, "adaptive-categories");
    await navigate(page, "/accounts");

    const contentSurface = page.locator(".app-content > *").first();
    const contentGutters = await contentSurface.evaluate((element) => {
      const styles = getComputedStyle(element);
      return {
        left: Number.parseFloat(styles.paddingLeft),
        right: Number.parseFloat(styles.paddingRight),
      };
    });
    expect(contentGutters.left).toBeGreaterThanOrEqual(15);
    expect(contentGutters.left).toBeLessThanOrEqual(29);
    expect(contentGutters.right).toBe(contentGutters.left);

    await page.getByRole("button", { name: "Add account" }).first().click();
    const adaptiveDialog = page.getByRole("dialog", { name: "Add account" });
    await expect(adaptiveDialog).toBeVisible();
    await expect.poll(async () => (await adaptiveDialog.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(700);

    await selectComboboxValue(adaptiveDialog.getByLabel(/^Account type/), "credit_card");
    await expect.poll(async () => (await adaptiveDialog.boundingBox())?.width ?? 0).toBeGreaterThan(1000);
    const liabilityColumns = await adaptiveDialog.locator("form").first().evaluate((element) =>
      getComputedStyle(element).gridTemplateColumns.split(" ").filter(Boolean).length,
    );
    expect(liabilityColumns).toBe(3);

    const currencyTrigger = adaptiveDialog.getByLabel(/^Currency/);
    await openCombobox(currencyTrigger);
    const popupGeometry = await adaptiveDialog.evaluate((dialog) => {
      const popup = dialog.querySelector<HTMLElement>(".currency-combobox-popover");
      if (!popup) return null;
      const popupRect = popup.getBoundingClientRect();
      const dialogRect = dialog.getBoundingClientRect();
      return {
        popupLeft: popupRect.left,
        popupRight: popupRect.right,
        popupBottom: popupRect.bottom,
        dialogLeft: dialogRect.left,
        dialogRight: dialogRect.right,
        dialogBottom: dialogRect.bottom,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        scrollFits: dialog.scrollWidth <= dialog.clientWidth,
      };
    });
    expect(popupGeometry).not.toBeNull();
    expect(popupGeometry!.popupLeft).toBeGreaterThanOrEqual(popupGeometry!.dialogLeft);
    expect(popupGeometry!.popupRight).toBeLessThanOrEqual(popupGeometry!.dialogRight);
    expect(popupGeometry!.popupRight).toBeLessThanOrEqual(popupGeometry!.viewportWidth);
    expect(popupGeometry!.popupBottom).toBeLessThanOrEqual(Math.min(popupGeometry!.dialogBottom, popupGeometry!.viewportHeight));
    expect(popupGeometry!.scrollFits).toBe(true);
    await page.keyboard.press("Escape");
    await expect(currencyTrigger).toHaveAttribute("aria-expanded", "false");

    const advancedCard = adaptiveDialog.getByLabel("Advanced card setup", { exact: true });
    const advancedCardDetails = advancedCard.locator("..");
    await expect(advancedCardDetails).not.toHaveAttribute("open", "");
    await advancedCard.click();
    await expect(advancedCardDetails).toHaveAttribute("open", "");
    await adaptiveDialog.getByRole("button", { name: "Cancel" }).click();
    await expect(adaptiveDialog).toBeHidden();

    await createAccount(page, {
      name: "Category Test Cash",
      type: "cash",
      openingBalance: "500.00",
    });

    async function createCategory(name: string, parentName?: RegExp) {
      await page.getByRole("button", { name: "Add category" }).first().click();
      const categoryDialog = page.getByRole("dialog", { name: "Add category" });
      await categoryDialog.getByLabel("Name", { exact: true }).fill(name);
      if (parentName) {
        const parentSelect = categoryDialog.getByLabel("Parent category");
        const listbox = await openCombobox(parentSelect);
        await listbox.getByRole("option", { name: parentName }).click();
      }
      await categoryDialog.getByRole("button", { name: "Create category" }).click();
      await expect(categoryDialog).toBeHidden();
      await expect(page.getByRole("region", { name: "Category hierarchy" }).getByText(name, { exact: true })).toBeVisible();
    }

    await navigate(page, "/categories");
    await createCategory("Household E2E");
    await createCategory("Maintenance E2E", /^Household E2E$/);
    await createCategory("Plumbing E2E", /Household E2E.*Maintenance E2E$/);

    const categoryTable = page.getByRole("region", { name: "Category hierarchy" });
    const plumbingRow = categoryTable.getByRole("row").filter({ has: page.getByText("Plumbing E2E", { exact: true }) });
    await expect(plumbingRow).toContainText("Under Household E2E");
    await plumbingRow.getByRole("button", { name: "Edit Plumbing E2E" }).click();
    const editDialog = page.getByRole("dialog", { name: "Edit category" });
    await editDialog.getByLabel("Name", { exact: true }).fill("Emergency plumbing E2E");
    await editDialog.getByRole("button", { name: "Save changes" }).click();
    await expect(editDialog).toBeHidden();
    await expect(categoryTable.getByText("Emergency plumbing E2E", { exact: true })).toBeVisible();

    await navigate(page, "/transactions");
    await page.getByRole("button", { name: "Add transaction" }).first().click();
    const transactionDialog = page.getByRole("dialog", { name: "Add transaction" });
    await transactionDialog.getByRole("button", { name: "Expense", exact: true }).click();
    await selectNamedOption(transactionDialog.getByLabel(/^Account/), "Category Test Cash");
    await transactionDialog.getByLabel(/^Merchant or source/).fill("Garden centre E2E");
    await transactionDialog.getByLabel(/^Amount \(USD\)/).fill("25.00");
    await transactionDialog.getByRole("button", { name: "Create category" }).click();
    await transactionDialog.getByLabel("Category name").fill("Garden E2E");
    const inlineParent = transactionDialog.getByLabel("Parent category");
    const inlineParentOptions = await openCombobox(inlineParent);
    await inlineParentOptions.getByRole("option", { name: /^Household E2E$/ }).click();
    await transactionDialog.getByRole("button", { name: "Create and select" }).click();
    await expect(transactionDialog.getByRole("combobox", { name: "Category", exact: true }))
      .toContainText("Garden E2E");
    await transactionDialog.getByRole("button", { name: "Save transaction" }).click();
    await expect(transactionDialog).toBeHidden();
    await expect(page.getByRole("region", { name: "Transactions" })).toContainText("Garden centre E2E");

    await navigate(page, "/categories");
    const gardenRow = page.getByRole("region", { name: "Category hierarchy" })
      .getByRole("row")
      .filter({ has: page.getByText("Garden E2E", { exact: true }) });
    await expect(gardenRow).toContainText("expense");
    await expect(gardenRow).toContainText("Under Household E2E");
    await expectNoHorizontalWindowScroll(page);
  });
});

test.describe("multi-currency transaction workflow", () => {
  test.skip(({ isMobile }) => Boolean(isMobile), "The detailed FX workflow runs in the desktop project.");

  test("posts a foreign purchase with a manual bank rate when BNR is unavailable", async ({ page }) => {
    test.setTimeout(90_000);

    await register(page, "fx-manual");
    await createAccount(page, {
      name: "FX Current",
      type: "current_account",
      openingBalance: "1000.00",
    });
    await page.route("**/api/fx/quote?**", async (route) => {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "Deterministic test: BNR unavailable" }),
      });
    });

    await navigate(page, "/transactions");
    await page.getByRole("button", { name: "Add transaction" }).first().click();
    const dialog = page.getByRole("dialog", { name: "Add transaction" });
    await selectNamedOption(dialog.getByLabel(/^Account/), "FX Current");
    await dialog.getByLabel(/^Merchant or source/).fill("EUR phone bill E2E");
    await dialog.getByLabel("Entered currency").click();
    await dialog.getByRole("combobox", { name: "Search currencies" }).fill("EUR");
    await dialog.getByRole("option", { name: /^EUR,/ }).click();
    await dialog.getByLabel(/^Purchase amount \(EUR\)/).fill("20.00");

    await expect(dialog.getByText("Manual rate needed", { exact: true })).toBeVisible();
    await expect(dialog.getByText(/Deterministic test: BNR unavailable/)).toBeVisible();
    await dialog.getByLabel("Edit exchange rate manually").check();
    await dialog.getByLabel(/^Exchange rate \(USD per 1 EUR\)/).fill("1.15");
    await expect(dialog.getByLabel(/^Amount posted to FX Current \(USD\)/)).toHaveValue("23.00");
    await dialog.getByRole("button", { name: "Save transaction" }).click();
    await expect(dialog).toBeHidden();

    const row = page.getByRole("region", { name: "Transactions" })
      .getByRole("row")
      .filter({ hasText: "EUR phone bill E2E" });
    await expect(row).toContainText("23.00");
    await expect(row).toContainText("20.00");
    await expect(row).toContainText("Manual exchange rate");

    await navigate(page, "/accounts");
    await expect(accountCard(page, "FX Current")).toContainText("977.00");
    await navigate(page, "/statistics");
    await expect(metric(page, "Actual expenses")).toContainText("23.00");
  });

  test("keeps native account ledgers while changing reporting currency, transferring value, and managing a receipt", async ({ page }) => {
    test.setTimeout(120_000);

    await register(page, "native-ledgers");
    await createAccount(page, {
      name: "USD Operating",
      type: "current_account",
      openingBalance: "1000.00",
      currency: "USD",
    });
    await createAccount(page, {
      name: "EUR Wallet",
      type: "cash",
      openingBalance: "100.00",
      currency: "EUR",
    });

    await navigate(page, "/transactions");
    await page.getByRole("button", { name: "Add transaction" }).first().click();
    let dialog = page.getByRole("dialog", { name: "Add transaction" });
    await selectNamedOption(dialog.getByLabel(/^Account/), "EUR Wallet");
    await expect(dialog.getByLabel("Entered currency")).toContainText("EUR");
    await expect(dialog.getByLabel(/^Amount \(EUR\)/)).toBeVisible();
    await dialog.getByLabel(/^Merchant or source/).fill("Native EUR receipt E2E");
    await dialog.getByLabel(/^Amount \(EUR\)/).fill("10.00");
    await dialog.getByLabel("Receipt").setInputFiles({
      name: "native-eur-receipt.png",
      mimeType: "image/png",
      buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"),
    });
    await dialog.getByRole("button", { name: "Save transaction" }).click();
    await expect(dialog).toBeHidden();

    const transactions = page.getByRole("region", { name: "Transactions" });
    const receiptRow = transactions.getByRole("row").filter({ hasText: "Native EUR receipt E2E" });
    await receiptRow.getByRole("button", { name: /^Manage receipts/ }).click();
    const receipts = page.getByRole("dialog", { name: "Receipts" });
    await expect(receipts.getByText("native-eur-receipt.png", { exact: true })).toBeVisible();
    const downloadEvent = page.waitForEvent("download");
    await receipts.getByRole("link", { name: "Download" }).click();
    await expect((await downloadEvent).suggestedFilename()).toBe("native-eur-receipt.png");
    await receipts.getByRole("button", { name: "Delete native-eur-receipt.png" }).click();
    await receipts.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(receipts.getByText("No receipts attached", { exact: true })).toBeVisible();
    await receipts.getByRole("button", { name: "Close", exact: true }).click();

    await page.getByRole("button", { name: "Add transaction" }).first().click();
    dialog = page.getByRole("dialog", { name: "Add transaction" });
    await dialog.getByRole("button", { name: "Transfer", exact: true }).click();
    await selectNamedOption(dialog.getByLabel(/^From account/), "USD Operating");
    await selectNamedOption(dialog.getByLabel(/^To account/), "EUR Wallet");
    await dialog.getByLabel(/^Amount \(USD\)/).fill("100.00");
    await dialog.getByLabel("Edit exchange rate manually").check();
    await dialog.getByLabel(/^Exchange rate \(EUR per 1 USD\)/).fill("0.90");
    await expect(dialog.getByLabel(/^Amount posted to EUR Wallet \(EUR\)/)).toHaveValue("90.00");
    await dialog.getByRole("button", { name: "Save transaction" }).click();
    await expect(dialog).toBeHidden();
    const transferRows = transactions.getByRole("row").filter({ hasText: "Internal transfer" });
    await expect(transferRows).toHaveCount(2);
    await expect(transactions).toContainText("100.00");
    await expect(transactions).toContainText("90.00");

    await navigate(page, "/planned");
    await page.getByRole("button", { name: "Plan payment" }).first().click();
    const planDialog = page.getByRole("dialog", { name: "Plan a payment" });
    await planDialog.getByLabel(/^Payment name/).fill("USD plan paid from EUR E2E");
    await selectNamedOption(planDialog.getByLabel(/^Expected account/), "EUR Wallet");
    await expect(planDialog.getByLabel("Planned currency")).toContainText("EUR");
    await selectComboboxValue(planDialog.getByLabel("Planned currency"), "USD");
    await planDialog.getByLabel(/^Expected amount \(USD\)/).fill("20.00");
    await planDialog.getByLabel(/^Due date/).fill(isoDateOffset(0));
    await planDialog.getByRole("button", { name: "Create planned payment" }).click();
    await expect(planDialog).toBeHidden();

    const plannedRow = page.getByRole("region", { name: "Planned payment occurrences" })
      .getByRole("row")
      .filter({ hasText: "USD plan paid from EUR E2E" });
    await expect(plannedRow).toContainText("$20.00");
    await plannedRow.getByRole("button", { name: "Mark paid" }).click();
    const payDialog = page.getByRole("dialog", { name: "Record actual payment" });
    await expect(payDialog.getByLabel(/^Amount applied to plan \(USD\)/)).toHaveValue("20.00");
    await payDialog.getByLabel("Edit exchange rate manually").check();
    await payDialog.getByLabel(/^Exchange rate \(EUR per 1 USD\)/).fill("0.90");
    await expect(payDialog.getByLabel(/^Amount posted to EUR Wallet \(EUR\)/)).toHaveValue("18.00");
    await payDialog.getByRole("button", { name: "Mark paid" }).click();
    await expect(payDialog).toBeHidden();

    await navigate(page, "/transactions");
    const plannedActual = page.getByRole("region", { name: "Transactions" })
      .getByRole("row")
      .filter({ hasText: "USD plan paid from EUR E2E" });
    await expect(plannedActual).toContainText("€18.00");
    await expect(plannedActual).toContainText("$20.00");

    await navigate(page, "/settings");
    await selectComboboxValue(page.getByLabel("Reporting currency"), "EUR");
    await page.getByRole("button", { name: "Save profile settings" }).click();
    await expect(page.getByText("Profile preferences saved.", { exact: true })).toBeVisible();
    await expect(page.locator(".app-topbar")).toContainText("EUR reporting");

    await navigate(page, "/accounts");
    await expect(accountCard(page, "USD Operating")).toContainText("USD");
    await expect(accountCard(page, "USD Operating")).toContainText("900.00");
    await expect(accountCard(page, "EUR Wallet")).toContainText("EUR");
    await expect(accountCard(page, "EUR Wallet")).toContainText("162.00");
    await expect(metric(page, "Net account value")).toContainText("972.00");
  });

  test("records a card payment from a cash account in another currency", async ({ page }) => {
    test.setTimeout(90_000);

    await register(page, "card-fx");
    await createAccount(page, {
      name: "EUR Payment Cash",
      type: "current_account",
      openingBalance: "1000.00",
      currency: "EUR",
    });

    await page.getByRole("button", { name: "Add account" }).first().click();
    const accountDialog = page.getByRole("dialog", { name: "Add account" });
    await selectComboboxValue(accountDialog.getByLabel(/^Account type/), "credit_card");
    await selectComboboxValue(accountDialog.getByLabel(/^Currency/), "RON");
    await accountDialog.getByLabel(/^Credit card name/).fill("RON Travel Card");
    await accountDialog.getByLabel(/^Credit limit \(RON\)/).fill("5000.00");
    await accountDialog.getByLabel(/^Outstanding debt \(RON\)/).fill("100.00");
    await accountDialog.getByRole("button", { name: "Create account" }).click();
    await expect(accountDialog).toBeHidden();

    const card = accountCard(page, "RON Travel Card");
    await card.getByRole("button", { name: "Manage debt", exact: true }).last().click();
    await page.getByRole("button", { name: "Record payment" }).click();
    const paymentDialog = page.getByRole("dialog", { name: "Record card payment" });
    await expect(paymentDialog.getByLabel("Pay from")).toContainText("EUR Payment Cash");
    await paymentDialog.getByLabel(/^Amount \(RON\)/).fill("50.00");
    await paymentDialog.getByLabel("Edit exchange rate manually").check();
    await paymentDialog.getByLabel(/^Exchange rate \(RON per 1 EUR\)/).fill("5.00");
    await expect(paymentDialog.getByLabel(/^Cash account amount \(EUR\)/)).toHaveValue("10.00");
    await paymentDialog.getByRole("button", { name: "Post payment" }).click();
    await expect(paymentDialog).toBeHidden();

    const history = page.getByRole("region", { name: "Credit-card payment history" });
    await expect(history).toContainText("RON 50.00");
    await expect(history).toContainText("€10.00 debited");
    await navigate(page, "/accounts");
    await expect(accountCard(page, "EUR Payment Cash")).toContainText("990.00");
    await expect(accountCard(page, "RON Travel Card")).toContainText("50.00");
  });
});

test.describe("mobile smoke workflow", () => {
  test.skip(({ isMobile }) => !isMobile, "The mobile smoke workflow runs in the mobile project.");

  test("uses the page transaction action without mobile overflow", async ({ page }) => {
    test.setTimeout(90_000);

    await register(page, "mobile");
    const mobileTopbar = page.locator(".mobile-topbar");
    await expect(mobileTopbar.getByRole("button", {
      name: "Open account menu for LedgerLab E2E",
    })).toBeInViewport();
    await expect(mobileTopbar.getByRole("button", { name: /^Date range:/ })).toBeInViewport();
    await expectNoHorizontalWindowScroll(page);

    await navigate(page, "/accounts?new=1");
    const accountDialog = page.getByRole("dialog", { name: "Add account" });
    await expect(accountDialog).toBeVisible();
    await accountDialog.getByLabel(/^Account name/).fill("Mobile Cash");
    await selectComboboxValue(accountDialog.getByLabel(/^Account type/), "cash");
    await accountDialog.getByLabel(/^Opening balance/).fill("100.00");
    await accountDialog.getByRole("button", { name: "Create account" }).click();
    await expect(page.getByText("Mobile Cash", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Add account" }).first().click();
    const cardDialog = page.getByRole("dialog", { name: "Add account" });
    await selectComboboxValue(cardDialog.getByLabel(/^Account type/), "credit_card");
    await cardDialog.getByLabel(/^Credit card name/).fill("Mobile Card");
    await cardDialog.getByLabel(/^Credit limit/).fill("1000.00");
    await cardDialog.getByLabel(/^Outstanding debt/).fill("250.00");
    await cardDialog.getByRole("button", { name: "Create account" }).click();
    await expect(cardDialog).toBeHidden();

    const mobileCard = accountCard(page, "Mobile Card");
    await mobileCard.getByRole("button", { name: "Manage debt", exact: true }).last().click();
    await expect(page.getByRole("heading", { name: "Mobile Card", exact: true })).toBeVisible();
    await expect(metric(page, "Outstanding")).toContainText("250.00");
    await expect(metric(page, "Available credit")).toContainText("750.00");
    await expectNoHorizontalWindowScroll(page);

    const mobileNavigation = page.getByRole("navigation", { name: "Mobile navigation" });
    const transactionsLink = mobileNavigation.getByRole("link", { name: "Transactions" });
    await expect(transactionsLink).toBeInViewport();
    await transactionsLink.click();
    await expect(page.getByRole("heading", { name: "Transactions" })).toBeVisible();
    const pageTransactionAction = page
      .locator(".app-content")
      .getByRole("button", { name: "Add transaction" })
      .first();
    await expect(pageTransactionAction).toBeInViewport();
    await pageTransactionAction.click();
    const transactionDialog = page.getByRole("dialog", { name: "Add transaction" });
    await transactionDialog.getByRole("button", { name: "Expense", exact: true }).click();
    await selectNamedOption(transactionDialog.getByLabel(/^Account/), "Mobile Cash");
    await transactionDialog.getByLabel(/^Merchant or source/).fill("Mobile coffee E2E");
    await transactionDialog.getByLabel(/^Amount \(USD\)/).fill("12.50");
    await selectNamedOption(transactionDialog.getByLabel(/^Category/), "Dining");
    await transactionDialog.getByRole("button", { name: "Save transaction" }).click();
    await expect(transactionDialog).toBeHidden();
    await expect(page.getByRole("region", { name: "Transactions" })).toContainText("Mobile coffee E2E");

    await expectNoHorizontalWindowScroll(page);
    const statisticsLink = mobileNavigation.getByRole("link", { name: "Statistics" });
    await expect(statisticsLink).toBeInViewport();
    await statisticsLink.click();
    await expect(page.getByRole("heading", { name: "Statistics" })).toBeVisible();
    await expect(metric(page, "Actual expenses")).toContainText("12.50");
    await expectNoHorizontalWindowScroll(page);
  });
});
