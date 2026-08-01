import { NextRequest, NextResponse } from "next/server";

import { db as appDb, ensureDatabase } from "@/db";
import { users } from "@/db/schema";
import {
  AuthError,
  authenticateUser,
  createSession,
  createUser,
  hashPassword,
  readSessionToken,
  revokeSession,
  serializeExpiredSessionCookie,
  serializeSessionCookie,
  validateSessionToken,
  verifyPassword,
} from "@/lib/auth";
import { HttpError, jsonError, readJson } from "@/lib/api-response";
import { clearRateLimit, consumeRateLimit, opaqueRateLimitKey } from "@/lib/rate-limit";
import {
  COMMON_CURRENCY_CODES,
  DEFAULT_CURRENCY,
  DEFAULT_LOCALE,
  currencyCatalog,
} from "@/lib/currencies";
import {
  accountInput,
  budgetInput,
  categoryInput,
  categoryUpdateInput,
  creditCardPaymentInput,
  creditCardProfileInput,
  creditCardStatementInput,
  importCommitInput,
  importPreviewInput,
  loginInput,
  loanPaymentInput,
  loanDisbursementInput,
  loanProfileInput,
  loanRateInput,
  plannedInput,
  plannedPayInput,
  plannedSkipInput,
  monthKeyInput,
  passwordChangeInput,
  profilePreferencesInput,
  registerInput,
  reminderSettingsInput,
  restoreInput,
  transactionInput,
} from "@/lib/validation";
import {
  archivePlannedPayment,
  cancelPlannedOccurrence,
  clearPendingTransaction,
  createAccount,
  createCategory,
  createDefaultCategories,
  createPlannedPayment,
  createTag,
  createTransaction,
  database,
  listCategories,
  listMerchants,
  listPlannedPayments,
  listTags,
  listTransactionPage,
  one,
  payPlannedOccurrence,
  preparePlannedOccurrencePayment,
  setCategoryArchived,
  setMerchantArchived,
  setTagArchived,
  skipPlannedOccurrence,
  undoPlannedOccurrence,
  updateAccount,
  updateCategory,
  updateMerchant,
  updateTag,
  voidTransaction,
} from "@/server/core";
import {
  accountsPayload,
  dashboard,
  listBudgets,
  planningWorkspace,
  saveBudget,
  savePlan,
  statistics,
} from "@/server/insights";
import {
  addLoanRatePeriod,
  createCreditCardStatement,
  disburseLoan,
  liabilityAccountDetail,
  listLiabilityObligations,
  recordCreditCardPayment,
  recordLoanPayment,
  saveCreditCardProfile,
  saveLoanProfile,
  undoLiabilityPayment,
} from "@/server/liabilities";
import {
  commitImport,
  createBackup,
  exportData,
  previewImport,
  restoreBackup,
} from "@/server/portability";
import { getUserCalendarContext, getUserRegionalSettings } from "@/server/user-settings";
import { prepareTransactionFx, prepareTransferFx, resolveBnrQuote } from "@/server/fx";
import { hydrateReportingRates, toReportingMinor } from "@/server/reporting-currency";
import {
  attachmentContentDisposition,
  attachmentDownload,
  deleteAttachment,
  listTransactionAttachments,
  uploadTransactionAttachment,
} from "@/server/attachments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ path: string[] }> };

const AUTH_JSON_BODY_BYTES = 64 * 1024;
const DEFAULT_JSON_BODY_BYTES = 2 * 1024 * 1024;
const CSV_IMPORT_JSON_BODY_BYTES = 32 * 1024 * 1024;
// Full database backups are already limited to 100 MB by the portability layer.
// Allow for the surrounding JSON envelope without leaving this endpoint unbounded.
const BACKUP_RESTORE_JSON_BODY_BYTES = 128 * 1024 * 1024;
const AUTH_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1_000;

type RegistrationMode = "first-user" | "open" | "closed";

function registrationMode(): RegistrationMode {
  const configured = process.env.REGISTRATION_MODE?.trim().toLowerCase() || "first-user";
  if (configured === "first-user" || configured === "open" || configured === "closed") return configured;
  throw new HttpError(500, "REGISTRATION_MODE must be first-user, open, or closed");
}

function registrationAvailability() {
  ensureDatabase();
  const mode = registrationMode();
  const hasUsers = Boolean(appDb.select({ id: users.id }).from(users).limit(1).get());
  return {
    mode,
    available: mode === "open" || (mode === "first-user" && !hasUsers),
  };
}

function clientAddress(request: NextRequest) {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim().slice(0, 80)
    || request.headers.get("x-real-ip")?.trim().slice(0, 80)
    || "unknown";
}

function enforceRateLimits(limits: Array<{ key: string; maxAttempts: number }>) {
  let longestRetry = 0;
  for (const limit of limits) {
    const result = consumeRateLimit(limit.key, {
      maxAttempts: limit.maxAttempts,
      windowMs: AUTH_RATE_LIMIT_WINDOW_MS,
    });
    if (!result.allowed) longestRetry = Math.max(longestRetry, result.retryAfterSeconds);
  }
  if (longestRetry > 0) {
    const minutes = Math.max(1, Math.ceil(longestRetry / 60));
    throw new HttpError(
      429,
      `Too many authentication attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}`,
      { retryAfterSeconds: longestRetry },
      { "Retry-After": String(longestRetry) },
    );
  }
}

function requestProtocol(request: NextRequest): "http:" | "https:" {
  const forwarded = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  if (forwarded === "http" || forwarded === "https") return `${forwarded}:`;
  return new URL(request.url).protocol === "https:" ? "https:" : "http:";
}

function comparableOrigin(url: URL) {
  const hostname = ["127.0.0.1", "[::1]"].includes(url.hostname) ? "localhost" : url.hostname.toLowerCase();
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  return `${url.protocol}//${hostname}:${port}`;
}

function assertSameOrigin(request: NextRequest) {
  if (request.headers.get("sec-fetch-site")?.toLowerCase() === "cross-site") {
    throw new HttpError(403, "Cross-origin changes are not allowed");
  }
  const origin = request.headers.get("origin");
  if (!origin) return;
  let originUrl: URL;
  try {
    originUrl = new URL(origin);
  } catch {
    throw new HttpError(403, "Cross-origin changes are not allowed");
  }
  if (!new Set(["http:", "https:"]).has(originUrl.protocol)) {
    throw new HttpError(403, "Cross-origin changes are not allowed");
  }

  const requestUrl = new URL(request.url);
  const protocol = requestProtocol(request);
  const candidateUrls = [requestUrl];
  for (const header of ["host", "x-forwarded-host"] as const) {
    const host = request.headers.get(header)?.split(",")[0]?.trim();
    if (!host) continue;
    try {
      candidateUrls.push(new URL(`${protocol}//${host}`));
    } catch {
      // Ignore malformed proxy metadata; it must never turn an invalid Origin
      // into a trusted one or surface as an internal server error.
    }
  }
  if (!candidateUrls.some((candidate) => comparableOrigin(candidate) === comparableOrigin(originUrl))) {
    throw new HttpError(403, "Cross-origin changes are not allowed");
  }
}

function sessionFromRequest(request: NextRequest) {
  ensureDatabase();
  const token = readSessionToken(request.headers.get("cookie"));
  const valid = validateSessionToken(token);
  if (!valid) throw new HttpError(401, "Sign in to continue");
  return { ...valid, token };
}

function clientMetadata(request: NextRequest) {
  return {
    userAgent: request.headers.get("user-agent")?.slice(0, 500) || undefined,
    ipAddress: clientAddress(request) === "unknown" ? undefined : clientAddress(request),
  };
}

function authResponse(user: object, token: string, expiresAt: Date, request: NextRequest, status = 200) {
  const response = NextResponse.json({ user }, { status });
  response.headers.set("Set-Cookie", serializeSessionCookie(token, expiresAt, requestProtocol(request) === "https:"));
  return response;
}

async function authRoute(request: NextRequest, segments: string[]) {
  const action = segments[1];
  if (request.method === "GET" && action === "registration") {
    return NextResponse.json(registrationAvailability());
  }
  if (request.method === "POST" && action === "register") {
    const input = registerInput.parse(await readJson(request, AUTH_JSON_BODY_BYTES));
    const registration = registrationAvailability();
    if (!registration.available) {
      throw new HttpError(403, "Registration is closed for this installation");
    }
    enforceRateLimits([{
      key: opaqueRateLimitKey("register-address", clientAddress(request)),
      maxAttempts: 10,
    }]);
    try {
      const user = await createUser({
        email: input.email,
        password: input.password,
        displayName: input.name,
        currency: input.currency,
        locale: input.locale,
        timeZone: input.timeZone,
      }, appDb, { requireEmptyDatabase: registration.mode === "first-user" });
      createDefaultCategories(user.id);
      const session = createSession(user.id, clientMetadata(request));
      return authResponse(user, session.token, session.expiresAt, request, 201);
    } catch (error) {
      if (error instanceof AuthError) {
        const status = error.code === "EMAIL_TAKEN" ? 409 : error.code === "REGISTRATION_CLOSED" ? 403 : 422;
        throw new HttpError(status, error.message);
      }
      throw error;
    }
  }
  if (request.method === "POST" && action === "login") {
    const input = loginInput.parse(await readJson(request, AUTH_JSON_BODY_BYTES));
    ensureDatabase();
    const addressLimitKey = opaqueRateLimitKey("login-address", clientAddress(request));
    const identityLimitKey = opaqueRateLimitKey("login-identity", input.email);
    enforceRateLimits([
      { key: addressLimitKey, maxAttempts: 60 },
      { key: identityLimitKey, maxAttempts: 10 },
    ]);
    try {
      const user = await authenticateUser(input.email, input.password);
      clearRateLimit(identityLimitKey);
      const session = createSession(user.id, clientMetadata(request));
      return authResponse(user, session.token, session.expiresAt, request);
    } catch (error) {
      if (error instanceof AuthError) throw new HttpError(401, error.message);
      throw error;
    }
  }
  if (request.method === "POST" && action === "logout") {
    const token = readSessionToken(request.headers.get("cookie"));
    ensureDatabase();
    if (token) revokeSession(token);
    const response = NextResponse.json({ success: true });
    response.headers.set("Set-Cookie", serializeExpiredSessionCookie(requestProtocol(request) === "https:"));
    return response;
  }
  if (request.method === "GET" && (action === "session" || action === "me")) {
    return NextResponse.json({ user: sessionFromRequest(request).user });
  }
  throw new HttpError(404, "Authentication endpoint not found");
}

function queryInteger(request: NextRequest, key: string) {
  const value = request.nextUrl.searchParams.get(key);
  if (value === null || value === "") return undefined;
  if (!/^-?\d+$/.test(value)) throw new HttpError(422, `${key} must be a whole number`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new HttpError(422, `${key} must be a whole number`);
  return parsed;
}

function queryDate(request: NextRequest, key: string) {
  const value = request.nextUrl.searchParams.get(key);
  if (value === null || value === "") return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new HttpError(422, `${key} must be a calendar date`);
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new HttpError(422, `${key} must be a valid calendar date`);
  }
  return value;
}

function queryRange(request: NextRequest) {
  const from = queryDate(request, "from");
  const to = queryDate(request, "to");
  if (!from && !to) return undefined;
  if (!from || !to) throw new HttpError(422, "Both from and to dates are required");
  if (from > to) throw new HttpError(422, "The start date must be on or before the end date");
  const spanDays = (new Date(`${to}T00:00:00.000Z`).getTime() - new Date(`${from}T00:00:00.000Z`).getTime()) / 86_400_000;
  if (spanDays > 3_660) throw new HttpError(422, "Choose a date range of ten years or less");
  return { from, to };
}

function rollingMonthHydrationRange(month: string, today: string, months: number) {
  const [year, monthNumber] = month.split("-").map(Number);
  const absoluteMonth = year * 12 + (monthNumber - 1) - (months - 1);
  const startYear = Math.floor(absoluteMonth / 12);
  const startMonth = absoluteMonth - startYear * 12 + 1;
  return {
    from: `${startYear}-${String(startMonth).padStart(2, "0")}-01`,
    to: today,
  };
}

async function getRoute(request: NextRequest, segments: string[]) {
  if (segments[0] === "health") {
    ensureDatabase();
    return NextResponse.json({ ok: true, app: "LedgerLab", database: "ready" });
  }
  if (segments[0] === "currencies") {
    const locale = request.nextUrl.searchParams.get("locale")?.trim() || DEFAULT_LOCALE;
    return NextResponse.json({
      currencies: currencyCatalog(locale),
      commonCurrencyCodes: COMMON_CURRENCY_CODES,
      defaultCurrency: DEFAULT_CURRENCY,
    }, {
      headers: { "Cache-Control": "public, max-age=86400, stale-while-revalidate=604800" },
    });
  }
  if (segments[0] === "auth") return authRoute(request, segments);
  const { user } = sessionFromRequest(request);
  const endpoint = segments[0];

  if (endpoint === "fx" && segments[1] === "quote") {
    const date = queryDate(request, "date");
    const from = request.nextUrl.searchParams.get("from")?.trim();
    const to = request.nextUrl.searchParams.get("to")?.trim();
    if (!date || !from || !to) throw new HttpError(422, "FX quotes require date, from, and to query parameters");
    return NextResponse.json({ quote: await resolveBnrQuote(date, from, to) }, {
      headers: { "Cache-Control": "private, no-store" },
    });
  }
  if (endpoint === "dashboard") {
    await hydrateReportingRates(user.id);
    return NextResponse.json(dashboard(user.id, queryRange(request)));
  }
  if (endpoint === "accounts") {
    await hydrateReportingRates(user.id);
    return NextResponse.json(accountsPayload(user.id, queryRange(request)));
  }
  if (endpoint === "liabilities") {
    const accountId = segments[1];
    if (accountId) return NextResponse.json(liabilityAccountDetail(user.id, accountId));
    return NextResponse.json({ obligations: listLiabilityObligations(user.id, {
      from: queryDate(request, "from"),
      to: queryDate(request, "to"),
      status: request.nextUrl.searchParams.get("status") ?? undefined,
    }) });
  }
  if (endpoint === "categories") {
    const includeArchived = request.nextUrl.searchParams.get("archived") === "all";
    const categories = listCategories(user.id, includeArchived).map((category) => ({
      ...category,
      spendingType: category.spendingNature,
      essential: category.spendingPriority === "essential",
    }));
    return NextResponse.json({ categories });
  }
  if (endpoint === "tags") {
    return NextResponse.json({ tags: listTags(user.id, request.nextUrl.searchParams.get("archived") === "all") });
  }
  if (endpoint === "merchants") {
    return NextResponse.json({
      merchants: listMerchants(user.id, request.nextUrl.searchParams.get("archived") === "all"),
      categories: listCategories(user.id),
    });
  }
  if (endpoint === "transactions" && segments[1] && segments[2] === "attachments") {
    return NextResponse.json({ attachments: listTransactionAttachments(user.id, segments[1]) });
  }
  if (endpoint === "attachments" && segments[1] && segments[2] === "download") {
    const attachment = attachmentDownload(user.id, segments[1]);
    return new Response(attachment.content, {
      headers: {
        "Content-Type": attachment.mimeType || "application/octet-stream",
        "Content-Length": String(attachment.sizeBytes),
        "Content-Disposition": attachmentContentDisposition(attachment.fileName),
        "Content-Security-Policy": "sandbox; default-src 'none'",
        "Cross-Origin-Resource-Policy": "same-origin",
      },
    });
  }
  if (endpoint === "transactions") {
    await hydrateReportingRates(user.id, {
      from: queryDate(request, "from"),
      to: queryDate(request, "to"),
    });
    const minMinor = queryInteger(request, "minMinor");
    const maxMinor = queryInteger(request, "maxMinor");
    const accountId = request.nextUrl.searchParams.get("account") ?? request.nextUrl.searchParams.get("accountId") ?? undefined;
    const limit = queryInteger(request, "limit");
    const offset = queryInteger(request, "offset");
    if ((minMinor ?? 0) < 0 || (maxMinor ?? 0) < 0) throw new HttpError(422, "Amount filters cannot be negative");
    if (minMinor !== undefined && maxMinor !== undefined && minMinor > maxMinor) {
      throw new HttpError(422, "The minimum amount cannot exceed the maximum amount");
    }
    if (limit !== undefined && limit < 1) throw new HttpError(422, "limit must be at least 1");
    if (offset !== undefined && offset < 0) throw new HttpError(422, "offset cannot be negative");
    if ((minMinor !== undefined || maxMinor !== undefined) && !accountId) {
      throw new HttpError(422, "Choose one account before filtering by amount; native account currencies cannot be compared directly");
    }
    const page = listTransactionPage(user.id, {
      from: queryDate(request, "from"),
      to: queryDate(request, "to"),
      accountId,
      categoryId: request.nextUrl.searchParams.get("category") ?? request.nextUrl.searchParams.get("categoryId") ?? undefined,
      tag: request.nextUrl.searchParams.get("tag") ?? undefined,
      status: request.nextUrl.searchParams.get("status") ?? undefined,
      kind: request.nextUrl.searchParams.get("kind") ?? request.nextUrl.searchParams.get("type") ?? undefined,
      merchant: request.nextUrl.searchParams.get("merchant") ?? undefined,
      search: request.nextUrl.searchParams.get("q") ?? request.nextUrl.searchParams.get("search") ?? undefined,
      minMinor,
      maxMinor,
      limit,
      offset,
    });
    const accountPayload = accountsPayload(user.id);
    const merchants = database().prepare("SELECT id, name FROM merchants WHERE user_id = ? AND archived_at IS NULL ORDER BY name").all(user.id);
    const tags = database().prepare("SELECT id, name, color FROM tags WHERE user_id = ? AND archived_at IS NULL ORDER BY name").all(user.id);
    return NextResponse.json({
      ...page,
      currency: accountPayload.defaultCurrency,
      categories: listCategories(user.id),
      accounts: accountPayload.accounts.filter((account) => !account.archivedAt),
      merchants,
      tags,
    });
  }
  if (endpoint === "planned") {
    await hydrateReportingRates(user.id);
    const range = queryRange(request);
    const accountPayload = accountsPayload(user.id);
    const reportingCurrency = accountPayload.defaultCurrency;
    const accountCurrencyById = new Map(accountPayload.accounts.map((account) => [account.id, account.currency]));
    const nativeOccurrences = listPlannedPayments(user.id, {
      from: range?.from,
      to: range?.to,
      status: request.nextUrl.searchParams.get("status") ?? undefined,
      includeArchived: request.nextUrl.searchParams.get("archived") === "all",
    });
    const occurrences = nativeOccurrences.map((item) => {
      const convert = (amountMinor: number) => toReportingMinor(
        { amountMinor, currency: item.currency, date: item.dueDate },
        reportingCurrency,
        `the planned payment “${item.title}”`,
      );
      const outstandingNativeMinor = item.status === "paid"
        ? 0
        : Math.max(item.expectedAmountMinor - item.paidAmountMinor, 0);
      return {
        ...item,
        nativeCurrency: item.currency,
        nativeExpectedAmountMinor: item.expectedAmountMinor,
        nativePaidAmountMinor: item.paidAmountMinor,
        nativeOutstandingAmountMinor: outstandingNativeMinor,
        nativeCashFlowAmountMinor: outstandingNativeMinor,
        nativeSpendingAmountMinor: item.direction === "expense" ? outstandingNativeMinor : 0,
        nativePrincipalAmountMinor: 0,
        reportingExpectedAmountMinor: convert(item.expectedAmountMinor),
        reportingPaidAmountMinor: convert(item.paidAmountMinor),
        reportingOutstandingAmountMinor: convert(outstandingNativeMinor),
        reportingCashFlowAmountMinor: convert(outstandingNativeMinor),
        reportingSpendingAmountMinor: item.direction === "expense" ? convert(outstandingNativeMinor) : 0,
        reportingPrincipalAmountMinor: 0,
      };
    });
    const nativeLiabilityObligations = listLiabilityObligations(user.id, {
      from: range?.from,
      to: range?.to,
      status: request.nextUrl.searchParams.get("status") ?? undefined,
    });
    const liabilityObligations = nativeLiabilityObligations.map((item) => {
      const nativeCurrency = accountCurrencyById.get(item.liabilityAccountId)
        ?? (item.accountId ? accountCurrencyById.get(item.accountId) : undefined);
      if (!nativeCurrency) throw new HttpError(422, `Cannot determine the account currency for ${item.title}`);
      const convert = (amountMinor: number) => toReportingMinor(
        { amountMinor, currency: nativeCurrency, date: item.dueDate },
        reportingCurrency,
        `the liability obligation “${item.title}”`,
      );
      return {
        ...item,
        nativeCurrency,
        nativeExpectedAmountMinor: item.expectedAmountMinor,
        nativePaidAmountMinor: item.paidAmountMinor,
        nativeCashFlowAmountMinor: item.cashFlowAmountMinor,
        nativeSpendingAmountMinor: item.spendingAmountMinor,
        nativePlannedSpendingAmountMinor: item.plannedSpendingAmountMinor,
        nativePrincipalAmountMinor: item.principalAmountMinor,
        currency: nativeCurrency,
        reportingExpectedAmountMinor: convert(item.expectedAmountMinor),
        reportingPaidAmountMinor: convert(item.paidAmountMinor),
        reportingCashFlowAmountMinor: convert(item.cashFlowAmountMinor),
        reportingSpendingAmountMinor: convert(item.spendingAmountMinor),
        reportingPlannedSpendingAmountMinor: convert(item.plannedSpendingAmountMinor),
        reportingPrincipalAmountMinor: convert(item.principalAmountMinor),
      };
    });
    const combined = [...occurrences, ...liabilityObligations].sort((left, right) => left.dueDate.localeCompare(right.dueDate));
    return NextResponse.json({
      planned: combined,
      occurrences: combined,
      liabilityObligations,
      currency: reportingCurrency,
      categories: listCategories(user.id),
      accounts: accountPayload.accounts.filter((account) => !account.archivedAt),
    });
  }
  if (endpoint === "budgets") {
    await hydrateReportingRates(user.id);
    const requestedMonth = request.nextUrl.searchParams.get("month") ?? undefined;
    const month = requestedMonth ? monthKeyInput.parse(requestedMonth) : undefined;
    return NextResponse.json({ ...listBudgets(user.id, month), categories: listCategories(user.id) });
  }
  if (endpoint === "plans") {
    await hydrateReportingRates(user.id);
    const requestedMonth = request.nextUrl.searchParams.get("month") ?? undefined;
    return NextResponse.json(planningWorkspace(user.id, requestedMonth ? monthKeyInput.parse(requestedMonth) : undefined));
  }
  if (endpoint === "statistics") {
    const period = request.nextUrl.searchParams.get("period");
    const calendar = getUserCalendarContext(user.id);
    const periodMonths = period === "3m" ? 3 : period === "6m" ? 6 : period === "24m" ? 24 : period === "all" ? 60 : period === "ytd" ? Number(calendar.month.slice(-2)) : 12;
    const months = Math.min(Math.max(queryInteger(request, "months") ?? periodMonths, 3), 60);
    const requestedRange = queryRange(request);
    const hydrationRange = requestedRange ?? rollingMonthHydrationRange(calendar.month, calendar.today, months);
    await hydrateReportingRates(user.id, hydrationRange);
    return NextResponse.json(statistics(user.id, months, requestedRange));
  }
  if (endpoint === "export") {
    const requested = request.nextUrl.searchParams.get("format") === "csv" ? "csv" : "json";
    const exported = exportData(user.id, requested);
    return new NextResponse(exported.body, {
      headers: {
        "Content-Type": exported.contentType,
        "Content-Disposition": `attachment; filename="ledgerlab-export-${todayStamp()}.${exported.extension}"`,
        "Cache-Control": "no-store",
      },
    });
  }
  if (endpoint === "backup") {
    const backup = createBackup(user.id);
    return new NextResponse(JSON.stringify(backup, null, 2), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="ledgerlab-backup-${todayStamp()}.json"`,
        "Cache-Control": "no-store",
      },
    });
  }
  if (endpoint === "settings") {
    const saved = (action: string) => {
      const value = one<{ after: string | null }>(
        `SELECT after FROM audit_logs
          WHERE user_id = ? AND entity_type = 'user_settings' AND action = ?
          ORDER BY created_at DESC, rowid DESC LIMIT 1`,
        [user.id, action],
      )?.after;
      if (!value) return {};
      try {
        const parsed = JSON.parse(value) as unknown;
        return parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? parsed as Record<string, unknown>
          : {};
      } catch {
        return {};
      }
    };
    return NextResponse.json({
      user: { ...user, name: user.displayName },
      preferences: { compactTables: true, ...saved("preferences") },
      reminders: { dueSoon: true, overdue: true, budgetWarnings: true, daysBefore: 3, ...saved("reminders") },
    });
  }
  throw new HttpError(404, "API endpoint not found");
}

function todayStamp() {
  return new Date().toISOString().slice(0, 10);
}

function text(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function integer(value: unknown, fallback = 0) {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : fallback;
}

function object(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

async function postRoute(request: NextRequest, segments: string[]) {
  assertSameOrigin(request);
  if (segments[0] === "auth") return authRoute(request, segments);
  const currentSession = sessionFromRequest(request);
  const { user } = currentSession;
  const endpoint = segments[0];
  if (endpoint === "transactions" && segments[1] && segments[2] === "attachments") {
    if (request.method !== "POST") throw new HttpError(405, "Method not allowed");
    const attachment = await uploadTransactionAttachment(user.id, segments[1], {
      fileName: request.nextUrl.searchParams.get("filename") ?? "",
      claimedMimeType: request.headers.get("content-type"),
      contentLength: request.headers.get("content-length"),
      body: request.body,
    });
    return NextResponse.json({ attachment }, { status: 201 });
  }
  const maxBodyBytes = endpoint === "backup"
    ? BACKUP_RESTORE_JSON_BODY_BYTES
    : endpoint === "import"
      ? CSV_IMPORT_JSON_BODY_BYTES
      : DEFAULT_JSON_BODY_BYTES;
  const body = object(await readJson(request, maxBodyBytes));

  if (endpoint === "accounts") {
    if (body.action === "archive" || body.action === "restore") {
      const id = text(body.id);
      if (!id) throw new HttpError(422, "Account id is required");
      const account = updateAccount(user.id, id, { archived: body.action === "archive" });
      return NextResponse.json({ account });
    }
    const workspaceCurrency = getUserRegionalSettings(user.id).currency;
    const normalized = accountInput.parse({
      ...body,
      type: body.type === "current_account" ? "current" : body.type,
      customType: body.customType ?? body.customTypeLabel,
      currency: body.currency ?? workspaceCurrency,
      openingDate: body.openingDate ?? body.openingBalanceDate,
    });
    const result = database().transaction(() => {
      const account = createAccount(user.id, normalized);
      if (!account) throw new HttpError(500, "Account could not be created");
      const creditCard = object(body.creditCard);
      const loan = object(body.loan);
      if (normalized.type === "credit_card" && (Object.keys(creditCard).length || normalized.creditLimitMinor != null)) {
        const profile = creditCardProfileInput.parse({
          ...creditCard,
          creditLimitMinor: creditCard.creditLimitMinor ?? normalized.creditLimitMinor ?? 0,
        });
        return saveCreditCardProfile(user.id, account.id, profile).account;
      }
      if (normalized.type === "loan" && Object.keys(loan).length) {
        const profile = loanProfileInput.parse(loan);
        return saveLoanProfile(user.id, account.id, profile).account.account;
      }
      return account;
    })();
    return NextResponse.json({ account: result }, { status: 201 });
  }
  if (endpoint === "liabilities") {
    if (segments[1] === "payments") {
      const paymentId = segments[2] ?? text(body.paymentId);
      if (!paymentId || (segments[3] ?? text(body.action)) !== "undo") throw new HttpError(422, "Choose a liability payment to undo");
      return NextResponse.json(undoLiabilityPayment(user.id, paymentId));
    }
    const accountId = segments[1] ?? text(body.accountId);
    if (!accountId) throw new HttpError(422, "Account id is required");
    const action = segments[2] ?? text(body.action);
    if (action === "card-profile") {
      return NextResponse.json(saveCreditCardProfile(user.id, accountId, creditCardProfileInput.parse(body)));
    }
    if (action === "loan-profile") {
      return NextResponse.json(saveLoanProfile(user.id, accountId, loanProfileInput.parse(body)));
    }
    if (action === "statements") {
      return NextResponse.json(createCreditCardStatement(user.id, accountId, creditCardStatementInput.parse(body)), { status: 201 });
    }
    if (action === "rates") {
      return NextResponse.json(addLoanRatePeriod(user.id, accountId, loanRateInput.parse(body)), { status: 201 });
    }
    if (action === "payments") {
      const kind = text(body.kind);
      if (kind === "card_payment") {
        return NextResponse.json(recordCreditCardPayment(user.id, accountId, creditCardPaymentInput.parse(body)), { status: 201 });
      }
      if (kind === "loan_payment") {
        return NextResponse.json(recordLoanPayment(user.id, accountId, loanPaymentInput.parse(body)), { status: 201 });
      }
      throw new HttpError(422, "Choose a card or loan payment type");
    }
    if (action === "disburse") {
      return NextResponse.json(
        disburseLoan(user.id, accountId, loanDisbursementInput.parse(body)),
        { status: 201 },
      );
    }
    throw new HttpError(422, "Unknown liability action");
  }
  if (endpoint === "categories") {
    const action = text(body.action, "create");
    if (action === "archive" || action === "restore") {
      const categoryId = text(body.id);
      if (!categoryId) throw new HttpError(422, "Category id is required");
      return NextResponse.json({ category: setCategoryArchived(user.id, categoryId, action === "archive") });
    }
    const categoryPayload = {
      ...body,
      spendingNature: body.spendingNature ?? body.spendingType
        ?? (["fixed", "variable"].includes(text(body.classification)) ? body.classification : undefined),
      spendingPriority: body.spendingPriority
        ?? (typeof body.essential === "boolean" ? (body.essential ? "essential" : "discretionary") : undefined)
        ?? (["essential", "discretionary"].includes(text(body.classification)) ? body.classification : undefined),
    };
    if (action === "create") {
      const normalized = categoryInput.parse(categoryPayload);
      return NextResponse.json({ category: createCategory(user.id, normalized) }, { status: 201 });
    }
    if (action === "update" || action === "edit") {
      const categoryId = text(body.id);
      if (!categoryId) throw new HttpError(422, "Category id is required");
      const normalized = categoryUpdateInput.parse(categoryPayload);
      return NextResponse.json({ category: updateCategory(user.id, categoryId, normalized) });
    }
    throw new HttpError(422, "Unknown category action");
  }
  if (endpoint === "tags") {
    const action = text(body.action, "create");
    const id = text(body.id);
    if ((action === "rename" || action === "update") && !id) throw new HttpError(422, "Tag id is required");
    if ((action === "archive" || action === "restore") && !id) throw new HttpError(422, "Tag id is required");
    const color = body.color === null || body.color === undefined ? undefined : text(body.color);
    if (color !== undefined && !/^#[0-9a-fA-F]{6}$/.test(color)) throw new HttpError(422, "Tag colour must be a six-digit hex value");
    if (action === "create") return NextResponse.json({ tag: createTag(user.id, { name: text(body.name), color }) }, { status: 201 });
    if (action === "rename" || action === "update") return NextResponse.json({ tag: updateTag(user.id, id, { name: text(body.name), color }) });
    if (action === "archive" || action === "restore") return NextResponse.json({ tag: setTagArchived(user.id, id, action === "archive") });
    throw new HttpError(422, "Unknown tag action");
  }
  if (endpoint === "merchants") {
    const action = text(body.action, "update");
    const id = text(body.id);
    if (!id) throw new HttpError(422, "Merchant id is required");
    if (action === "rename" || action === "update") {
      return NextResponse.json({
        merchant: updateMerchant(user.id, id, {
          name: text(body.name),
          defaultCategoryId: Object.prototype.hasOwnProperty.call(body, "defaultCategoryId")
            ? body.defaultCategoryId === null ? null : text(body.defaultCategoryId) || null
            : undefined,
        }),
      });
    }
    if (action === "archive" || action === "restore") {
      return NextResponse.json({ merchant: setMerchantArchived(user.id, id, action === "archive") });
    }
    throw new HttpError(422, "Unknown merchant action");
  }
  if (endpoint === "transactions") {
    const transactionAction = segments[2] ?? text(body.action);
    if (transactionAction === "clear") {
      const transactionId = segments[1] ?? text(body.id ?? body.transactionId);
      if (!transactionId) throw new HttpError(422, "Transaction id is required");
      return NextResponse.json(clearPendingTransaction(user.id, transactionId));
    }
    const rawAmount = integer(body.amountMinor);
    const kind = text(body.kind ?? body.type) as "income" | "expense" | "transfer" | "refund" | "adjustment";
    const normalized = transactionInput.parse({
      ...body,
      kind,
      accountId: body.accountId,
      transferAccountId: body.transferAccountId ?? body.toAccountId,
      amountMinor: Math.abs(rawAmount),
      destinationAmountMinor: body.destinationAmountMinor ?? body.toAmountMinor ?? body.transferAmountMinor,
      originalAmountMinor: body.originalAmountMinor ?? body.original_amount_minor,
      originalCurrency: body.originalCurrency ?? body.original_currency,
      fxRateScaled: body.fxRateScaled ?? body.fx_rate_scaled,
      fxRateSource: body.fxRateSource ?? body.fx_rate_source,
      fxRateDate: body.fxRateDate ?? body.fx_rate_date,
      referenceFxRateScaled: body.referenceFxRateScaled ?? body.reference_fx_rate_scaled,
      referenceFxRateDate: body.referenceFxRateDate ?? body.reference_fx_rate_date,
      date: body.date ?? body.occurredAt,
      note: body.note ?? body.notes,
      receiptReference: body.receiptReference ?? body.attachmentRef,
      adjustmentSign: kind === "adjustment" && rawAmount < 0 ? -1 : 1,
    });
    const preparedFx = normalized.kind === "transfer"
      ? await prepareTransferFx(
        user.id,
        normalized.accountId,
        normalized.transferAccountId as string,
        normalized.amountMinor,
        normalized.date,
        normalized,
      )
      : await prepareTransactionFx(
        user.id,
        normalized.accountId,
        normalized.kind,
        normalized.amountMinor,
        normalized.date,
        normalized,
      );
    const result = createTransaction(user.id, { ...normalized, ...preparedFx });
    return NextResponse.json({ transaction: result }, { status: 201 });
  }
  if (endpoint === "planned") {
    const action = segments[2] ?? segments[1] ?? text(body.action);
    const occurrenceId = segments.length >= 3 ? segments[1] : text(body.occurrenceId ?? body.id);
    if (action === "pay") {
      const normalized = plannedPayInput.parse({
        amountMinor: Math.abs(integer(body.amountMinor ?? body.accountAmountMinor ?? body.actualAmountMinor)),
        appliedAmountMinor: body.appliedAmountMinor
          ?? body.appliedPlannedAmountMinor
          ?? body.originalAmountMinor
          ?? body.original_amount_minor,
        date: body.date ?? body.paymentDate ?? body.paidDate,
        accountId: body.accountId,
        fxRateScaled: body.fxRateScaled ?? body.fx_rate_scaled,
        fxRateSource: body.fxRateSource ?? body.fx_rate_source,
        fxRateDate: body.fxRateDate ?? body.fx_rate_date,
        referenceFxRateScaled: body.referenceFxRateScaled ?? body.reference_fx_rate_scaled,
        referenceFxRateDate: body.referenceFxRateDate ?? body.reference_fx_rate_date,
        partial: body.partial ?? body.status === "partial",
        note: body.note ?? body.notes,
      });
      const prepared = await preparePlannedOccurrencePayment(user.id, occurrenceId, normalized);
      return NextResponse.json({ result: payPlannedOccurrence(user.id, occurrenceId, prepared) });
    }
    if (action === "skip") {
      const normalized = plannedSkipInput.parse({ reason: body.reason ?? body.notes });
      return NextResponse.json(skipPlannedOccurrence(user.id, occurrenceId, normalized.reason));
    }
    if (action === "cancel") {
      const normalized = plannedSkipInput.parse({ reason: body.reason ?? body.notes });
      return NextResponse.json(cancelPlannedOccurrence(user.id, occurrenceId, normalized.reason));
    }
    if (action === "undo") return NextResponse.json(undoPlannedOccurrence(user.id, occurrenceId));
    if (action === "archive" || action === "restore") {
      const paymentId = text(body.plannedPaymentId ?? body.id ?? segments[1]);
      return NextResponse.json(archivePlannedPayment(user.id, paymentId, action === "archive"));
    }
    const recurrence = object(body.recurrence);
    const normalized = plannedInput.parse({
      ...body,
      name: body.name ?? body.title,
      type: body.type ?? body.direction,
      note: body.note ?? body.notes,
      recurrence: Object.keys(recurrence).length ? {
        frequency: recurrence.frequency ?? body.frequency,
        interval: recurrence.interval ?? body.interval ?? 1,
        endDate: recurrence.endDate ?? body.endDate ?? null,
      } : body.frequency ? { frequency: body.frequency, interval: body.interval ?? 1, endDate: body.endDate ?? null } : null,
    });
    return NextResponse.json({ occurrence: createPlannedPayment(user.id, normalized) }, { status: 201 });
  }
  if (endpoint === "budgets") {
    if (body.action === "copy") {
      const sourceMonth = monthKeyInput.parse(body.sourceMonth);
      const targetMonth = monthKeyInput.parse(body.targetMonth ?? body.month);
      database().transaction(() => {
        const source = database().prepare("SELECT category_id AS categoryId, amount_minor AS amountMinor, currency, rollover, notes FROM budgets WHERE user_id = ? AND month = ?").all(user.id, sourceMonth) as Array<{ categoryId: string; amountMinor: number; currency: string; rollover: number; notes: string | null }>;
        for (const item of source) {
          saveBudget(user.id, {
            month: targetMonth,
            categoryId: item.categoryId,
            amountMinor: item.amountMinor,
            amountCurrency: item.currency,
            rollover: Boolean(item.rollover),
          });
        }
      })();
      return NextResponse.json(listBudgets(user.id, targetMonth));
    }
    const normalized = budgetInput.parse({
      month: body.month,
      categoryId: body.categoryId,
      amountMinor: Math.abs(integer(body.amountMinor ?? body.budgetMinor)),
      rollover: body.rollover ?? false,
    });
    return NextResponse.json({ budget: saveBudget(user.id, normalized) });
  }
  if (endpoint === "plans") {
    const month = monthKeyInput.parse(body.month);
    const sourceItems = body.items ?? body.lines;
    const normalizedItems = Array.isArray(sourceItems) ? sourceItems.map((value: unknown) => {
      const line = object(value);
      return {
        title: text(line.title ?? line.name, "Plan item"),
        direction: line.direction === "income" ? "income" as const : "expense" as const,
        amountMinor: Math.abs(integer(line.amountMinor)),
        expectedDate: text(line.expectedDate ?? line.date, `${month}-01`),
        accountId: text(line.accountId) || null,
        categoryId: text(line.categoryId) || null,
        spendingNature: line.spendingNature === "fixed" || line.spendingType === "fixed" ? "fixed" as const : "variable" as const,
        spendingPriority: line.spendingPriority === "essential" || line.essential === true ? "essential" as const : "discretionary" as const,
      };
    }) : undefined;
    const payload = {
      ...body,
      month,
      action: text(body.action) || undefined,
      name: text(body.name) || undefined,
      expectedIncomeMinor: body.expectedIncomeMinor === undefined ? undefined : integer(body.expectedIncomeMinor),
      discretionaryTargetMinor: body.discretionaryTargetMinor === undefined ? undefined : integer(body.discretionaryTargetMinor),
      copyFromMonth: text(body.copyFromMonth ?? body.sourceMonth) || undefined,
      scenarioName: text(body.scenarioName ?? body.name) || undefined,
      openingBalances: Array.isArray(body.openingBalances) ? body.openingBalances : undefined,
      items: normalizedItems,
    };
    return NextResponse.json(savePlan(user.id, payload));
  }
  if (endpoint === "import" && segments[1] === "preview") {
    const rawMapping = object(body.mapping);
    const normalizedMapping: Record<string, string> = {};
    for (const [csvHeader, target] of Object.entries(rawMapping)) {
      if (["date", "amount", "description", "merchant", "externalId", "originalAmount", "originalCurrency", "exchangeRate"].includes(String(target))) {
        normalizedMapping[String(target)] = csvHeader;
      }
    }
    const normalized = importPreviewInput.parse({
      csv: body.csv ?? body.content ?? body.fileText,
      mapping: Object.keys(normalizedMapping).length ? normalizedMapping : body.mapping,
      hasHeader: body.hasHeader ?? true,
      options: body.options,
    });
    const result = previewImport(user.id, { ...normalized, accountId: text(body.accountId ?? body.defaultAccountId) || undefined });
    return NextResponse.json({
      ...result,
      duplicates: result.rows.filter((row) => row.duplicate),
      summary: { valid: result.validCount, invalid: result.invalidCount, duplicates: result.duplicateCount, total: result.rows.length },
      previewToken: null,
    });
  }
  if (endpoint === "import" && segments[1] === "commit") {
    if (!Array.isArray(body.rows) && typeof body.csv === "string") {
      const rawMapping = object(body.mapping);
      const normalizedMapping: Record<string, string> = {};
      for (const [csvHeader, target] of Object.entries(rawMapping)) {
        if (["date", "amount", "description", "merchant", "externalId", "originalAmount", "originalCurrency", "exchangeRate"].includes(String(target))) {
          normalizedMapping[String(target)] = csvHeader;
        }
      }
      const accountId = text(body.accountId ?? body.defaultAccountId);
      if (!accountId) throw new HttpError(422, "Choose the account that will receive imported transactions");
      const previewInput = importPreviewInput.parse({
        csv: body.csv,
        mapping: normalizedMapping,
        hasHeader: body.hasHeader ?? true,
        options: body.options,
      });
      const preview = previewImport(user.id, { ...previewInput, accountId });
      const validRows = preview.rows.filter((row) => row.valid).map((row) => ({
        date: row.date!, amountMinor: row.amountMinor!, description: row.description,
        merchant: row.merchant, externalId: row.externalId, duplicate: row.duplicate, raw: row.raw,
        originalAmountMinor: row.originalAmountMinor,
        originalCurrency: row.originalCurrency,
        fxRateScaled: row.fxRateScaled,
        fxRateSource: row.fxRateSource,
        fxRateDate: row.fxRateDate,
      }));
      const result = commitImport(user.id, {
        accountId,
        rows: validRows,
        duplicateStrategy: body.duplicateHandling === "import" ? "import" : "skip",
        fileName: text(body.fileName) || undefined,
        mapping: normalizedMapping,
      });
      return NextResponse.json({
        ...result,
        importedCount: result.importedRows,
        skippedCount: result.duplicateRows + result.invalidRows,
        imported: result.importedRows,
        skipped: result.duplicateRows + result.invalidRows,
      });
    }
    const normalized = importCommitInput.parse({
      accountId: body.accountId,
      rows: body.rows,
      duplicateStrategy: body.duplicateStrategy ?? "skip",
    });
    return NextResponse.json(commitImport(user.id, { ...normalized, fileName: text(body.fileName) || undefined, mapping: object(body.mapping) as Record<string, string> }));
  }
  if (endpoint === "backup") {
    const backupValue = typeof body.backup === "string" ? body.backup : JSON.stringify(body.backup);
    const normalized = restoreInput.parse({ backup: backupValue, confirmation: body.confirmation });
    return NextResponse.json(restoreBackup(user.id, normalized));
  }
  if (endpoint === "settings") {
    const action = text(body.action, "preferences");
    if (action === "preferences") {
      const settings = profilePreferencesInput.parse({
        displayName: body.displayName ?? body.name ?? user.displayName,
        currency: body.currency ?? user.defaultCurrency,
        locale: body.locale ?? user.locale,
        timeZone: body.timeZone ?? user.timeZone,
        compactTables: body.compactTables ?? true,
      });
      database().transaction(() => {
        database().prepare("UPDATE users SET display_name = ?, locale = ?, default_currency = ?, time_zone = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
          .run(settings.displayName, settings.locale, settings.currency, settings.timeZone, user.id);
        database().prepare("INSERT INTO audit_logs (id, user_id, entity_type, entity_id, action, after) VALUES (?, ?, 'user_settings', ?, 'preferences', ?)")
          .run(crypto.randomUUID(), user.id, user.id, JSON.stringify(settings));
      })();
      return NextResponse.json({
        user: {
          ...user,
          displayName: settings.displayName,
          defaultCurrency: settings.currency,
          locale: settings.locale,
          timeZone: settings.timeZone,
        },
        preferences: settings,
      });
    }
    if (action === "reminders") {
      const reminders = reminderSettingsInput.parse(body);
      database().prepare("INSERT INTO audit_logs (id, user_id, entity_type, entity_id, action, after) VALUES (?, ?, 'user_settings', ?, 'reminders', ?)")
        .run(crypto.randomUUID(), user.id, user.id, JSON.stringify(reminders));
      return NextResponse.json({ reminders });
    }
    if (action === "password-change") {
      const passwordChange = passwordChangeInput.parse(body);
      const row = one<{ passwordHash: string }>("SELECT password_hash AS passwordHash FROM users WHERE id = ?", [user.id]);
      if (!row || !(await verifyPassword(passwordChange.currentPassword, row.passwordHash))) throw new HttpError(401, "Current password is incorrect");
      const passwordHash = await hashPassword(passwordChange.newPassword);
      database().transaction(() => {
        database().prepare("UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(passwordHash, user.id);
        database().prepare("DELETE FROM sessions WHERE user_id = ? AND id <> ?").run(user.id, currentSession.session.id);
      })();
      return NextResponse.json({ success: true });
    }
    throw new HttpError(422, "Unknown settings action");
  }
  throw new HttpError(404, "API endpoint not found");
}

async function deleteRoute(request: NextRequest, segments: string[]) {
  assertSameOrigin(request);
  const { user } = sessionFromRequest(request);
  if (segments[0] === "attachments" && segments[1]) {
    return NextResponse.json(deleteAttachment(user.id, segments[1]));
  }
  if (segments[0] === "transactions" && segments[1]) {
    return NextResponse.json(voidTransaction(user.id, segments[1]));
  }
  throw new HttpError(404, "API endpoint not found");
}

function finalizeApiResponse(response: Response) {
  response.headers.set("Cache-Control", "private, no-store");
  response.headers.set("Pragma", "no-cache");
  response.headers.set("X-Content-Type-Options", "nosniff");
  return response;
}

async function handler(request: NextRequest, context: RouteContext) {
  try {
    const { path } = await context.params;
    if (request.method === "GET") return finalizeApiResponse(await getRoute(request, path));
    if (request.method === "POST" || request.method === "PATCH") return finalizeApiResponse(await postRoute(request, path));
    if (request.method === "DELETE") return finalizeApiResponse(await deleteRoute(request, path));
    throw new HttpError(405, "Method not allowed");
  } catch (error) {
    return finalizeApiResponse(jsonError(error));
  }
}

export const GET = handler;
export const POST = handler;
export const PATCH = handler;
export const DELETE = handler;
