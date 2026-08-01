import { ensureDatabase, sqlite } from "@/db";
import { HttpError } from "@/lib/api-response";
import {
  convertMinorAtRate,
  currencyMinorUnitDigits,
  FX_RATE_SCALE,
  findPersistedBnrQuote,
  resolveBnrQuote,
} from "@/server/fx";
import { getUserCalendarContext } from "@/server/user-settings";

export type DatedMoney = {
  amountMinor: number;
  currency: string;
  date: string;
};

export type ReportingValue = {
  amountMinor: number;
  fromCurrency: string;
  reportingCurrency: string;
  requestedDate: string;
  rateDate: string;
  rateScaled: number;
  rateSource: "identity" | "bnr";
  isFallback: boolean;
};

function normalizeCurrency(value: string) {
  return value.trim().toUpperCase();
}

/**
 * Converts an immutable ledger amount into the user's current reporting
 * currency. Reporting conversions are deliberately resolved at read time:
 * changing the profile currency never rewrites native account history.
 */
export function toReportingValue(
  money: DatedMoney,
  reportingCurrencyValue: string,
  context = "this report",
): ReportingValue {
  if (!Number.isSafeInteger(money.amountMinor)) {
    throw new RangeError("Reporting amounts must be safe integers in minor units");
  }
  const fromCurrency = normalizeCurrency(money.currency);
  const reportingCurrency = normalizeCurrency(reportingCurrencyValue);
  if (fromCurrency === reportingCurrency) {
    return {
      amountMinor: money.amountMinor,
      fromCurrency,
      reportingCurrency,
      requestedDate: money.date,
      rateDate: money.date,
      rateScaled: FX_RATE_SCALE,
      rateSource: "identity",
      isFallback: false,
    };
  }

  const quote = findPersistedBnrQuote(money.date, fromCurrency, reportingCurrency);
  if (!quote) {
    throw new HttpError(
      422,
      `Cannot calculate ${context}: no persisted BNR ${fromCurrency}/${reportingCurrency} reference rate is available on or before ${money.date}`,
      {
        code: "REPORTING_FX_RATE_UNAVAILABLE",
        context,
        requestedDate: money.date,
        fromCurrency,
        reportingCurrency,
        noFutureRatesUsed: true,
      },
    );
  }
  return {
    amountMinor: convertMinorAtRate(
      money.amountMinor,
      quote.rateScaled,
      currencyMinorUnitDigits(fromCurrency),
      currencyMinorUnitDigits(reportingCurrency),
    ),
    fromCurrency,
    reportingCurrency,
    requestedDate: money.date,
    rateDate: quote.rateDate,
    rateScaled: quote.rateScaled,
    rateSource: "bnr",
    isFallback: quote.isFallback,
  };
}

export function toReportingMinor(
  money: DatedMoney,
  reportingCurrencyValue: string,
  context = "this report",
): number {
  return toReportingValue(money, reportingCurrencyValue, context).amountMinor;
}

export function sumInReportingCurrency(
  amounts: readonly DatedMoney[],
  reportingCurrency: string,
  context = "this report",
) {
  return amounts.reduce(
    (sum, money) => sum + toReportingMinor(money, reportingCurrency, context),
    0,
  );
}

export type ReportingRateHydrationOptions = {
  from?: string;
  to?: string;
  asOfDate?: string;
};

export type ReportingRateHydrationResult = {
  reportingCurrency: string;
  requestedPairs: number;
  hydratedPairs: Array<{
    fromCurrency: string;
    toCurrency: string;
    requestedDate: string;
    rateDate: string;
    cacheStatus: string;
  }>;
};

function dateKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const date = value.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const parsed = new Date(`${date}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date ? date : null;
}

/**
 * Ensures the official observations needed by synchronous report builders are
 * present locally. API GET handlers should await this before calling
 * dashboard(), accountsPayload(), listBudgets(), planningWorkspace(), or
 * statistics(). The ledger remains read-only; only the shared BNR cache is
 * hydrated.
 */
export async function hydrateReportingRates(
  userId: string,
  options: ReportingRateHydrationOptions = {},
): Promise<ReportingRateHydrationResult> {
  ensureDatabase();
  const calendar = getUserCalendarContext(userId);
  const reportingCurrency = normalizeCurrency(calendar.currency);
  const asOfDate = dateKey(options.asOfDate) ?? calendar.today;
  const from = options.from === undefined ? undefined : dateKey(options.from);
  const to = options.to === undefined ? undefined : dateKey(options.to);
  if (options.from !== undefined && !from) throw new HttpError(422, "Choose a valid reporting-rate start date");
  if (options.to !== undefined && !to) throw new HttpError(422, "Choose a valid reporting-rate end date");
  if (from && to && from > to) throw new HttpError(422, "The reporting-rate start date must not be after the end date");

  const candidates: Array<{ currency: string; date: string }> = [];
  const add = (currencyValue: unknown, dateValue: unknown, respectRange = true) => {
    if (typeof currencyValue !== "string") return;
    const currency = normalizeCurrency(currencyValue);
    if (currency === reportingCurrency) return;
    const rawDate = dateKey(dateValue);
    if (!rawDate) return;
    if (respectRange && from && rawDate < from) return;
    if (respectRange && to && rawDate > to) return;
    candidates.push({ currency, date: rawDate > asOfDate ? asOfDate : rawDate });
  };

  const accountRows = sqlite.prepare(
    "SELECT currency, opening_balance_date AS date FROM accounts WHERE user_id = ?",
  ).all(userId) as Array<{ currency: string; date: string }>;
  for (const row of accountRows) {
    // Current totals translate the whole native balance at the report as-of
    // date. Range endpoints cover historical net-worth snapshots.
    add(row.currency, asOfDate, false);
    const effectiveRangeStart = from && row.date > from ? row.date : from;
    if (effectiveRangeStart && (!to || effectiveRangeStart <= to)) add(row.currency, effectiveRangeStart);
    if (to && row.date <= to) add(row.currency, to);
    if (from && to) {
      const effectiveFrom = row.date > from ? row.date : from;
      const effectiveTo = (to < asOfDate ? to : asOfDate);
      if (effectiveFrom <= effectiveTo) {
        const firstYear = Number(effectiveFrom.slice(0, 4));
        const lastYear = Number(effectiveTo.slice(0, 4));
        for (let year = firstYear; year <= lastYear; year += 1) {
          // Historical BNR feeds are annual files. One request at the latest
          // required date in every covered year hydrates all monthly snapshot
          // dates in that year, including years with no ledger activity.
          const yearEnd = `${year}-12-31`;
          add(row.currency, year === lastYear ? effectiveTo : yearEnd, false);
        }
      }
    }
  }

  const datedRows = sqlite.prepare(
    `SELECT currency, substr(occurred_at, 1, 10) AS date
       FROM transactions WHERE user_id = ? AND voided_at IS NULL
     UNION ALL
     SELECT p.currency, o.due_date AS date
       FROM planned_payments p
       JOIN planned_payment_occurrences o ON o.planned_payment_id = p.id
      WHERE p.user_id = ?
     UNION ALL
     SELECT currency, month || '-01' AS date FROM budgets WHERE user_id = ?
     UNION ALL
     SELECT currency, month || '-01' AS date FROM month_plans WHERE user_id = ?
     UNION ALL
     SELECT a.currency, e.due_date AS date
       FROM loan_schedule_entries e JOIN accounts a ON a.id = e.loan_account_id
      WHERE a.user_id = ?
     UNION ALL
     SELECT a.currency, p.payment_date AS date
       FROM loan_payments p JOIN accounts a ON a.id = p.loan_account_id
      WHERE p.user_id = ? AND p.voided_at IS NULL
     UNION ALL
     SELECT a.currency, p.payment_date AS date
       FROM credit_card_payments p JOIN accounts a ON a.id = p.account_id
      WHERE p.user_id = ? AND p.voided_at IS NULL`,
  ).all(userId, userId, userId, userId, userId, userId, userId) as Array<{ currency: string; date: string }>;
  for (const row of datedRows) add(row.currency, row.date);

  // One quote request per currency/year is enough because BNR annual feeds are
  // persisted as a whole. Keep the latest required date in each year so the
  // current-year cache is refreshed through the newest relevant observation.
  const latestByPairYear = new Map<string, { currency: string; date: string }>();
  for (const candidate of candidates) {
    const key = `${candidate.currency}:${candidate.date.slice(0, 4)}`;
    const current = latestByPairYear.get(key);
    if (!current || candidate.date > current.date) latestByPairYear.set(key, candidate);
  }

  const hydratedPairs: ReportingRateHydrationResult["hydratedPairs"] = [];
  for (const candidate of latestByPairYear.values()) {
    const quote = await resolveBnrQuote(candidate.date, candidate.currency, reportingCurrency);
    hydratedPairs.push({
      fromCurrency: candidate.currency,
      toCurrency: reportingCurrency,
      requestedDate: candidate.date,
      rateDate: quote.rateDate,
      cacheStatus: quote.cacheStatus,
    });
  }
  return { reportingCurrency, requestedPairs: latestByPairYear.size, hydratedPairs };
}
