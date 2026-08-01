import { createHash } from "node:crypto";

import { ensureDatabase, sqlite } from "@/db";
import { HttpError } from "@/lib/api-response";
import { isSupportedCurrency } from "@/lib/currencies";

export const FX_RATE_SCALE = 100_000_000;
const FX_RATE_SCALE_BIGINT = BigInt(FX_RATE_SCALE);
const BNR_PROVIDER = "National Bank of Romania (BNR)";
const BNR_ANNUAL_BASE_URL = "https://www.bnr.ro/files/xml/years";

export type BnrRateObservationLike = {
  publishedRateScaled?: number;
  rateScaled?: number;
  multiplier?: number;
};

export type FxQuote = {
  requestedDate: string;
  rateDate: string;
  fromCurrency: string;
  toCurrency: string;
  rateScaled: number;
  rateScale: typeof FX_RATE_SCALE;
  fromMinorUnitDigits: number;
  toMinorUnitDigits: number;
  source: "bnr";
  isFallback: boolean;
  fallbackDays: number;
  provider: typeof BNR_PROVIDER;
  sourceUrls: string[];
  cacheStatus: "identity" | "cached" | "refreshed" | "stale";
  isStale: boolean;
  refreshError?: string;
};

export type TransactionFxFields = {
  originalAmountMinor?: number | null;
  originalCurrency?: string | null;
  fxRateScaled?: number | null;
  fxRateSource?: "bnr" | "manual" | null;
  fxRateDate?: string | null;
  referenceFxRateScaled?: number | null;
  referenceFxRateDate?: string | null;
};

type PreparedTransactionFx = {
  originalAmountMinor?: number;
  originalCurrency?: string;
  fxRateScaled?: number;
  fxRateSource?: "bnr" | "manual";
  fxRateDate?: string;
  referenceFxRateScaled?: number;
  referenceFxRateDate?: string;
};

export type TransferFxFields = TransactionFxFields & {
  destinationAmountMinor?: number | null;
};

export type PreparedTransferFx = {
  destinationAmountMinor: number;
  fxRateScaled?: number;
  fxRateSource?: "bnr" | "manual";
  fxRateDate?: string;
  referenceFxRateScaled?: number;
  referenceFxRateDate?: string;
};

type StoredObservation = {
  rateDate: string;
  currency: string;
  publishedRateScaled: number;
  multiplier: number;
  sourceUrl: string;
};

type ParsedBnrObservation = {
  rateDate: string;
  currency: string;
  publishedRateScaled: number;
  multiplier: number;
};

export type ParsedBnrXml = {
  publishingDate: string | null;
  firstObservationDate: string;
  lastObservationDate: string;
  observations: ParsedBnrObservation[];
};

type YearSyncResult = "cached" | "refreshed";

const pendingYearSyncs = new Map<number, Promise<YearSyncResult>>();
const currencyDigitsCache = new Map<string, number>();

function safeInteger(value: bigint, label: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new RangeError(`${label} exceeds the safe integer range.`);
  return result;
}

function assertSafeInteger(value: number, label: string, minimum?: number) {
  if (!Number.isSafeInteger(value) || (minimum !== undefined && value < minimum)) {
    throw new RangeError(`${label} must be a safe integer${minimum === undefined ? "" : ` of at least ${minimum}`}.`);
  }
}

/** Integer division rounded to nearest, with exact halves away from zero. */
function divideRoundHalfAway(numerator: bigint, denominator: bigint, label: string): number {
  if (denominator <= 0n) throw new RangeError(`${label} has an invalid denominator.`);
  const negative = numerator < 0n;
  const absolute = negative ? -numerator : numerator;
  let quotient = absolute / denominator;
  const remainder = absolute % denominator;
  if (remainder * 2n >= denominator) quotient += 1n;
  return safeInteger(negative ? -quotient : quotient, label);
}

function powerOfTen(digits: number, label: string): bigint {
  if (!Number.isInteger(digits) || digits < 0 || digits > 12) {
    throw new RangeError(`${label} must be an integer between 0 and 12.`);
  }
  return 10n ** BigInt(digits);
}

export function currencyMinorUnitDigits(code: string): number {
  const currency = normalizeCurrency(code);
  const cached = currencyDigitsCache.get(currency);
  if (cached !== undefined) return cached;
  let digits = 2;
  try {
    digits = new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    // Validation elsewhere accepts generic ISO-style codes. Two digits keeps
    // legacy LedgerLab behavior for an unknown/private code.
  }
  currencyDigitsCache.set(currency, digits);
  return digits;
}

export function parseRateDecimalToScaled(value: string): number {
  const normalized = value.trim().replace(",", ".");
  if (!/^\+?\d+(?:\.\d+)?$/.test(normalized)) throw new RangeError("The FX rate is not a positive decimal value.");
  const unsigned = normalized.startsWith("+") ? normalized.slice(1) : normalized;
  const [whole, fraction = ""] = unsigned.split(".");
  const denominator = 10n ** BigInt(fraction.length);
  const numerator = BigInt(whole) * denominator + BigInt(fraction || "0");
  if (numerator <= 0n) throw new RangeError("The FX rate must be greater than zero.");
  return divideRoundHalfAway(numerator * FX_RATE_SCALE_BIGINT, denominator, "scaled FX rate");
}

export function normalizeBnrRateScaled(publishedRateScaled: number, multiplier: number): number {
  assertSafeInteger(publishedRateScaled, "publishedRateScaled", 1);
  assertSafeInteger(multiplier, "multiplier", 1);
  return divideRoundHalfAway(BigInt(publishedRateScaled), BigInt(multiplier), "normalized BNR rate");
}

function observationParts(value: BnrRateObservationLike | "RON" | null): { published: bigint; multiplier: bigint } {
  if (value === null || value === "RON") return { published: FX_RATE_SCALE_BIGINT, multiplier: 1n };
  const published = value.publishedRateScaled ?? value.rateScaled;
  if (published === undefined) throw new RangeError("A BNR observation must include publishedRateScaled.");
  const multiplier = value.multiplier ?? 1;
  assertSafeInteger(published, "publishedRateScaled", 1);
  assertSafeInteger(multiplier, "multiplier", 1);
  return { published: BigInt(published), multiplier: BigInt(multiplier) };
}

/** Returns destination-currency major units per source-currency major unit. */
export function crossRateScaled(
  from: BnrRateObservationLike | "RON" | null,
  to: BnrRateObservationLike | "RON" | null,
): number {
  const source = observationParts(from);
  const destination = observationParts(to);
  return divideRoundHalfAway(
    source.published * destination.multiplier * FX_RATE_SCALE_BIGINT,
    source.multiplier * destination.published,
    "cross FX rate",
  );
}

export function convertMinorAtRate(
  amountMinor: number,
  rateScaled: number,
  fromDigits: number,
  toDigits: number,
): number {
  assertSafeInteger(amountMinor, "amountMinor");
  assertSafeInteger(rateScaled, "rateScaled", 1);
  const numerator = BigInt(amountMinor) * BigInt(rateScaled) * powerOfTen(toDigits, "toDigits");
  const denominator = FX_RATE_SCALE_BIGINT * powerOfTen(fromDigits, "fromDigits");
  return divideRoundHalfAway(numerator, denominator, "converted amount");
}

export function deriveRateScaledFromAmounts(
  fromAmountMinor: number,
  toAmountMinor: number,
  fromDigits: number,
  toDigits: number,
): number {
  assertSafeInteger(fromAmountMinor, "fromAmountMinor", 1);
  assertSafeInteger(toAmountMinor, "toAmountMinor", 1);
  const numerator = BigInt(toAmountMinor) * powerOfTen(fromDigits, "fromDigits") * FX_RATE_SCALE_BIGINT;
  const denominator = BigInt(fromAmountMinor) * powerOfTen(toDigits, "toDigits");
  return divideRoundHalfAway(numerator, denominator, "derived FX rate");
}

function normalizeCurrency(value: string): string {
  const currency = value.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency) || !isSupportedCurrency(currency)) {
    throw new HttpError(422, "Choose a supported ISO 4217 currency");
  }
  return currency;
}

function isDateKey(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function requireDateKey(value: string, label = "date") {
  if (!isDateKey(value)) throw new HttpError(422, `Choose a valid ${label} in YYYY-MM-DD format`);
}

function attribute(attributes: string, name: string): string | null {
  const match = attributes.match(new RegExp(`(?:^|\\s)${name}=(?:"([^"]*)"|'([^']*)')`, "i"));
  return match?.[1] ?? match?.[2] ?? null;
}

export function parseBnrXml(xml: string): ParsedBnrXml {
  const publishingDate = xml.match(/<PublishingDate>(\d{4}-\d{2}-\d{2})<\/PublishingDate>/i)?.[1] ?? null;
  const observations: ParsedBnrObservation[] = [];
  const cubePattern = /<Cube\b([^>]*)>([\s\S]*?)<\/Cube>/gi;
  let cube: RegExpExecArray | null;
  while ((cube = cubePattern.exec(xml))) {
    const rateDate = attribute(cube[1], "date");
    if (!rateDate || !isDateKey(rateDate)) continue;
    const ratePattern = /<Rate\b([^>]*)>([^<]+)<\/Rate>/gi;
    let rate: RegExpExecArray | null;
    while ((rate = ratePattern.exec(cube[2]))) {
      const currencyValue = attribute(rate[1], "currency")?.toUpperCase();
      if (!currencyValue || !/^[A-Z]{3}$/.test(currencyValue)) continue;
      const multiplierValue = attribute(rate[1], "multiplier") ?? "1";
      const multiplier = Number(multiplierValue);
      if (!Number.isSafeInteger(multiplier) || multiplier <= 0) {
        throw new HttpError(502, `BNR returned an invalid multiplier for ${currencyValue}`);
      }
      let publishedRateScaled: number;
      try {
        publishedRateScaled = parseRateDecimalToScaled(rate[2]);
      } catch {
        throw new HttpError(502, `BNR returned an invalid rate for ${currencyValue} on ${rateDate}`);
      }
      observations.push({ rateDate, currency: currencyValue, publishedRateScaled, multiplier });
    }
  }
  if (!observations.length) throw new HttpError(502, "The official BNR XML did not contain any usable exchange-rate observations");
  const dates = observations.map((item) => item.rateDate).sort();
  return {
    publishingDate,
    firstObservationDate: dates[0],
    lastObservationDate: dates[dates.length - 1],
    observations,
  };
}

export function persistBnrXml(xml: string, sourceUrl: string, fetchedAt = new Date().toISOString()): ParsedBnrXml {
  ensureDatabase();
  const parsed = parseBnrXml(xml);
  const year = Number(parsed.firstObservationDate.slice(0, 4));
  const insert = sqlite.prepare(
    `INSERT INTO fx_rate_observations
      (id, rate_date, currency, published_rate_scaled, multiplier, source_url, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(rate_date, currency) DO UPDATE SET
       published_rate_scaled = excluded.published_rate_scaled,
       multiplier = excluded.multiplier,
       source_url = excluded.source_url,
       fetched_at = excluded.fetched_at`,
  );
  sqlite.transaction(() => {
    for (const item of parsed.observations) {
      const id = createHash("sha256").update(`${item.rateDate}|${item.currency}`).digest("hex");
      insert.run(id, item.rateDate, item.currency, item.publishedRateScaled, item.multiplier, sourceUrl, fetchedAt);
    }
    sqlite.prepare(
      `INSERT INTO fx_sync_metadata
        (year, source_url, publishing_date, first_observation_date, last_observation_date, observation_count, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(year) DO UPDATE SET
         source_url = excluded.source_url,
         publishing_date = excluded.publishing_date,
         first_observation_date = excluded.first_observation_date,
         last_observation_date = excluded.last_observation_date,
         observation_count = excluded.observation_count,
         fetched_at = excluded.fetched_at`,
    ).run(
      year,
      sourceUrl,
      parsed.publishingDate,
      parsed.firstObservationDate,
      parsed.lastObservationDate,
      parsed.observations.length,
      fetchedAt,
    );
  })();
  return parsed;
}

function annualUrl(year: number) {
  return `${BNR_ANNUAL_BASE_URL}/nbrfxrates${year}.xml`;
}

function bucharestDateKey(value = new Date()): string {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: "Europe/Bucharest",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

async function fetchAndPersistYear(year: number, requestedDate: string): Promise<YearSyncResult> {
  ensureDatabase();
  const metadata = sqlite.prepare(
    `SELECT fetched_at AS fetchedAt, last_observation_date AS lastObservationDate
       FROM fx_sync_metadata WHERE year = ?`,
  ).get(year) as { fetchedAt: string; lastObservationDate: string } | undefined;
  const today = bucharestDateKey();
  const currentYear = Number(today.slice(0, 4));
  if (metadata && year < currentYear) return "cached";
  if (metadata && year === currentYear) {
    const fetchedDate = bucharestDateKey(new Date(metadata.fetchedAt));
    const fetchedToday = fetchedDate === today;
    const coversRequest = metadata.lastObservationDate >= requestedDate;
    // An annual feed fetched today has already established the latest available
    // banking day. Do not hammer BNR for a weekend or future requested date.
    if (coversRequest || fetchedToday) return "cached";
  }

  const sourceUrl = annualUrl(year);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  let response: Response;
  try {
    response = await fetch(sourceUrl, {
      headers: { Accept: "application/xml,text/xml;q=0.9", "User-Agent": "LedgerLab/1.0 local personal finance app" },
      cache: "no-store",
      signal: controller.signal,
    });
  } catch (error) {
    throw new HttpError(502, `Could not reach the official BNR exchange-rate feed for ${year}`, {
      provider: BNR_PROVIDER,
      sourceUrl,
      reason: error instanceof Error ? error.message : "Network request failed",
    });
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    throw new HttpError(502, `The official BNR exchange-rate feed for ${year} returned HTTP ${response.status}`, {
      provider: BNR_PROVIDER,
      sourceUrl,
    });
  }
  const xml = await response.text();
  if (xml.length > 20 * 1024 * 1024) throw new HttpError(502, "The official BNR exchange-rate response was unexpectedly large");
  persistBnrXml(xml, sourceUrl);
  return "refreshed";
}

async function ensureBnrYear(year: number, requestedDate: string): Promise<YearSyncResult> {
  const pending = pendingYearSyncs.get(year);
  if (pending) {
    await pending;
    return fetchAndPersistYear(year, requestedDate);
  }
  const sync = fetchAndPersistYear(year, requestedDate).finally(() => pendingYearSyncs.delete(year));
  pendingYearSyncs.set(year, sync);
  return sync;
}

function observationFor(date: string, currency: string): StoredObservation | null {
  if (currency === "RON") return null;
  return sqlite.prepare(
    `SELECT rate_date AS rateDate, currency, published_rate_scaled AS publishedRateScaled,
            multiplier, source_url AS sourceUrl
       FROM fx_rate_observations WHERE rate_date = ? AND currency = ?`,
  ).get(date, currency) as StoredObservation | undefined ?? null;
}

function latestCommonRateDate(requestedDate: string, fromCurrency: string, toCurrency: string): string | null {
  if (fromCurrency === toCurrency) return requestedDate;
  if (fromCurrency === "RON" || toCurrency === "RON") {
    const currency = fromCurrency === "RON" ? toCurrency : fromCurrency;
    return (sqlite.prepare(
      "SELECT rate_date FROM fx_rate_observations WHERE currency = ? AND rate_date <= ? ORDER BY rate_date DESC LIMIT 1",
    ).pluck().get(currency, requestedDate) as string | undefined) ?? null;
  }
  return (sqlite.prepare(
    `SELECT source.rate_date
       FROM fx_rate_observations source
       JOIN fx_rate_observations destination ON destination.rate_date = source.rate_date
      WHERE source.currency = ? AND destination.currency = ? AND source.rate_date <= ?
      ORDER BY source.rate_date DESC LIMIT 1`,
  ).pluck().get(fromCurrency, toCurrency, requestedDate) as string | undefined) ?? null;
}

function daysBetween(earlier: string, later: string) {
  return Math.max(0, Math.round(
    (new Date(`${later}T00:00:00.000Z`).getTime() - new Date(`${earlier}T00:00:00.000Z`).getTime()) / 86_400_000,
  ));
}

function identityQuote(requestedDate: string, currency: string): FxQuote {
  const minorUnitDigits = currencyMinorUnitDigits(currency);
  return {
    requestedDate,
    rateDate: requestedDate,
    fromCurrency: currency,
    toCurrency: currency,
    rateScaled: FX_RATE_SCALE,
    rateScale: FX_RATE_SCALE,
    fromMinorUnitDigits: minorUnitDigits,
    toMinorUnitDigits: minorUnitDigits,
    source: "bnr",
    isFallback: false,
    fallbackDays: 0,
    provider: BNR_PROVIDER,
    sourceUrls: [],
    cacheStatus: "identity",
    isStale: false,
  };
}

export function findPersistedBnrQuote(requestedDateValue: string, fromValue: string, toValue: string): FxQuote | null {
  ensureDatabase();
  requireDateKey(requestedDateValue, "FX quote date");
  const fromCurrency = normalizeCurrency(fromValue);
  const toCurrency = normalizeCurrency(toValue);
  if (fromCurrency === toCurrency) return identityQuote(requestedDateValue, fromCurrency);
  const rateDate = latestCommonRateDate(requestedDateValue, fromCurrency, toCurrency);
  if (!rateDate) return null;
  const fromObservation = observationFor(rateDate, fromCurrency);
  const toObservation = observationFor(rateDate, toCurrency);
  if (fromCurrency !== "RON" && !fromObservation) return null;
  if (toCurrency !== "RON" && !toObservation) return null;
  const rateScaled = crossRateScaled(fromObservation ?? "RON", toObservation ?? "RON");
  const sourceUrls = [...new Set([fromObservation?.sourceUrl, toObservation?.sourceUrl].filter((value): value is string => Boolean(value)))];
  return {
    requestedDate: requestedDateValue,
    rateDate,
    fromCurrency,
    toCurrency,
    rateScaled,
    rateScale: FX_RATE_SCALE,
    fromMinorUnitDigits: currencyMinorUnitDigits(fromCurrency),
    toMinorUnitDigits: currencyMinorUnitDigits(toCurrency),
    source: "bnr",
    isFallback: rateDate !== requestedDateValue,
    fallbackDays: daysBetween(rateDate, requestedDateValue),
    provider: BNR_PROVIDER,
    sourceUrls,
    cacheStatus: "cached",
    isStale: false,
  };
}

export async function resolveBnrQuote(requestedDate: string, from: string, to: string): Promise<FxQuote> {
  requireDateKey(requestedDate, "FX quote date");
  const fromCurrency = normalizeCurrency(from);
  const toCurrency = normalizeCurrency(to);
  if (fromCurrency === toCurrency) {
    return identityQuote(requestedDate, fromCurrency);
  }
  const year = Number(requestedDate.slice(0, 4));
  let syncError: unknown;
  const syncResults: YearSyncResult[] = [];
  try {
    syncResults.push(await ensureBnrYear(year, requestedDate));
  } catch (error) {
    syncError = error;
  }
  let quote = findPersistedBnrQuote(requestedDate, fromCurrency, toCurrency);
  if (!quote) {
    try {
      syncResults.push(await ensureBnrYear(year - 1, requestedDate));
    } catch (error) {
      syncError ??= error;
    }
    quote = findPersistedBnrQuote(requestedDate, fromCurrency, toCurrency);
  }
  if (quote) {
    if (syncError) {
      return {
        ...quote,
        cacheStatus: "stale",
        isStale: true,
        refreshError: syncError instanceof Error ? syncError.message : "The BNR feed could not be refreshed",
      };
    }
    return {
      ...quote,
      cacheStatus: syncResults.includes("refreshed") ? "refreshed" : "cached",
    };
  }
  if (syncError instanceof HttpError) throw syncError;
  throw new HttpError(422, `BNR has no common ${fromCurrency}/${toCurrency} reference rate on or before ${requestedDate}`, {
    provider: BNR_PROVIDER,
    requestedDate,
    fromCurrency,
    toCurrency,
    noFutureRatesUsed: true,
  });
}

function hasFxValue(input: TransactionFxFields) {
  return [
    input.originalAmountMinor,
    input.originalCurrency,
    input.fxRateScaled,
    input.fxRateSource,
    input.fxRateDate,
    input.referenceFxRateScaled,
    input.referenceFxRateDate,
  ].some((value) => value !== undefined && value !== null && value !== "");
}

function requireOriginalPair(input: TransactionFxFields) {
  const hasAmount = input.originalAmountMinor !== undefined && input.originalAmountMinor !== null;
  const hasCurrency = Boolean(input.originalCurrency?.trim());
  if (hasAmount !== hasCurrency) throw new HttpError(422, "Provide both the original amount and original currency");
  return hasAmount && hasCurrency;
}

function validatePostedConversion(accountCurrency: string, amountMinor: number, input: PreparedTransactionFx) {
  if (!input.originalAmountMinor || !input.originalCurrency || !input.fxRateScaled) return;
  const expected = convertMinorAtRate(
    input.originalAmountMinor,
    input.fxRateScaled,
    currencyMinorUnitDigits(input.originalCurrency),
    currencyMinorUnitDigits(accountCurrency),
  );
  if (expected !== amountMinor) {
    throw new HttpError(422, "The posted account amount does not match the original amount and FX rate", {
      expectedAmountMinor: expected,
      receivedAmountMinor: amountMinor,
      accountCurrency,
      originalCurrency: input.originalCurrency,
      rateScaled: input.fxRateScaled,
      rateScale: FX_RATE_SCALE,
    });
  }
}

function validateTransferConversion(
  sourceCurrency: string,
  destinationCurrency: string,
  sourceAmountMinor: number,
  destinationAmountMinor: number,
  input: PreparedTransferFx,
) {
  validatePostedConversion(destinationCurrency, destinationAmountMinor, {
    originalAmountMinor: sourceAmountMinor,
    originalCurrency: sourceCurrency,
    fxRateScaled: input.fxRateScaled,
  });
}

function rejectTransferOriginalFields(input: TransferFxFields) {
  if (input.originalAmountMinor != null || input.originalCurrency?.trim()) {
    throw new HttpError(422, "Transfer source amount and currency are inferred from the source account");
  }
}

function transferAccountCurrencies(userId: string, sourceAccountId: string, destinationAccountId: string) {
  const rows = sqlite.prepare(
    `SELECT id, currency FROM accounts
      WHERE user_id = ? AND archived_at IS NULL AND id IN (?, ?)`,
  ).all(userId, sourceAccountId, destinationAccountId) as Array<{ id: string; currency: string }>;
  const byId = new Map(rows.map((row) => [row.id, normalizeCurrency(row.currency)]));
  const sourceCurrency = byId.get(sourceAccountId);
  const destinationCurrency = byId.get(destinationAccountId);
  if (!sourceCurrency || !destinationCurrency) {
    throw new HttpError(422, "Choose active source and destination accounts that belong to your profile");
  }
  if (sourceAccountId === destinationAccountId) throw new HttpError(422, "Transfer accounts must be different");
  return { sourceCurrency, destinationCurrency };
}

function assertQuoteMatchesSupplied(
  quote: FxQuote,
  suppliedRate?: number | null,
  suppliedDate?: string | null,
  label = "BNR FX",
) {
  if (suppliedRate !== undefined && suppliedRate !== null && suppliedRate !== quote.rateScaled) {
    throw new HttpError(422, `${label} rate does not match the persisted official quote`, {
      expectedRateScaled: quote.rateScaled,
      receivedRateScaled: suppliedRate,
      rateScale: FX_RATE_SCALE,
      rateDate: quote.rateDate,
    });
  }
  if (suppliedDate && suppliedDate !== quote.rateDate) {
    throw new HttpError(422, `${label} date does not match the official fallback date`, {
      expectedRateDate: quote.rateDate,
      receivedRateDate: suppliedDate,
    });
  }
}

export async function prepareTransactionFx(
  userId: string,
  accountId: string,
  kind: string,
  amountMinor: number,
  date: string,
  input: TransactionFxFields,
): Promise<PreparedTransactionFx> {
  ensureDatabase();
  const account = sqlite.prepare(
    "SELECT currency FROM accounts WHERE id = ? AND user_id = ? AND archived_at IS NULL",
  ).get(accountId, userId) as { currency: string } | undefined;
  if (!account) throw new HttpError(422, "Choose an active account that belongs to your profile");
  requireDateKey(date, "transaction date");
  assertSafeInteger(amountMinor, "amountMinor", 1);
  if (kind === "transfer") {
    if (hasFxValue(input)) throw new HttpError(422, "Transfers cannot carry original-currency fields; cross-currency transfers require two explicit account amounts and are not supported yet");
    return {};
  }
  if (!requireOriginalPair(input)) {
    if (hasFxValue(input)) throw new HttpError(422, "FX rate fields require an original amount and original currency");
    return {};
  }

  const originalAmountMinor = input.originalAmountMinor as number;
  assertSafeInteger(originalAmountMinor, "originalAmountMinor", 1);
  const originalCurrency = normalizeCurrency(input.originalCurrency as string);
  const accountCurrency = normalizeCurrency(account.currency);
  if (originalCurrency === accountCurrency) {
    if (amountMinor !== originalAmountMinor) throw new HttpError(422, "Same-currency original and posted amounts must match");
    if ([input.fxRateScaled, input.fxRateSource, input.fxRateDate, input.referenceFxRateScaled, input.referenceFxRateDate]
      .some((value) => value !== undefined && value !== null && value !== "")) {
      throw new HttpError(422, "Same-currency transactions do not need FX rate fields");
    }
    return { originalAmountMinor, originalCurrency };
  }

  if (!input.fxRateSource) throw new HttpError(422, "Choose BNR or manual as the FX rate source");
  if (input.fxRateSource === "bnr") {
    const quote = await resolveBnrQuote(date, originalCurrency, accountCurrency);
    assertQuoteMatchesSupplied(quote, input.fxRateScaled, input.fxRateDate);
    if (input.referenceFxRateScaled != null || input.referenceFxRateDate) {
      throw new HttpError(422, "A BNR transaction rate does not need separate reference-rate fields");
    }
    const prepared: PreparedTransactionFx = {
      originalAmountMinor,
      originalCurrency,
      fxRateScaled: quote.rateScaled,
      fxRateSource: "bnr",
      fxRateDate: quote.rateDate,
    };
    validatePostedConversion(accountCurrency, amountMinor, prepared);
    return prepared;
  }

  if (!input.fxRateScaled) throw new HttpError(422, "Enter a positive manual FX rate");
  assertSafeInteger(input.fxRateScaled, "fxRateScaled", 1);
  const hasReferenceRate = input.referenceFxRateScaled !== undefined && input.referenceFxRateScaled !== null;
  const hasReferenceDate = Boolean(input.referenceFxRateDate);
  if (hasReferenceRate !== hasReferenceDate) {
    throw new HttpError(422, "Provide both the reference BNR rate and its rate date");
  }
  const prepared: PreparedTransactionFx = {
    originalAmountMinor,
    originalCurrency,
    fxRateScaled: input.fxRateScaled,
    fxRateSource: "manual",
    fxRateDate: input.fxRateDate || date,
  };
  requireDateKey(prepared.fxRateDate as string, "manual FX rate date");
  if (hasReferenceRate && input.referenceFxRateDate) {
    const quote = await resolveBnrQuote(date, originalCurrency, accountCurrency);
    assertQuoteMatchesSupplied(quote, input.referenceFxRateScaled, input.referenceFxRateDate, "Reference BNR FX");
    prepared.referenceFxRateScaled = quote.rateScaled;
    prepared.referenceFxRateDate = quote.rateDate;
  }
  validatePostedConversion(accountCurrency, amountMinor, prepared);
  return prepared;
}

/**
 * Resolves the amount posted to a transfer's destination account. The positive
 * destination leg preserves the source amount/currency in its original-money
 * fields, so an unequal pair remains auditable without a separate transfer
 * table.
 */
export async function prepareTransferFx(
  userId: string,
  sourceAccountId: string,
  destinationAccountId: string,
  sourceAmountMinor: number,
  date: string,
  input: TransferFxFields,
): Promise<PreparedTransferFx> {
  ensureDatabase();
  requireDateKey(date, "transfer date");
  assertSafeInteger(sourceAmountMinor, "sourceAmountMinor", 1);
  rejectTransferOriginalFields(input);
  const { sourceCurrency, destinationCurrency } = transferAccountCurrencies(
    userId,
    sourceAccountId,
    destinationAccountId,
  );

  const suppliedDestinationAmount = input.destinationAmountMinor;
  if (suppliedDestinationAmount != null) {
    assertSafeInteger(suppliedDestinationAmount, "destinationAmountMinor", 1);
  }
  if (sourceCurrency === destinationCurrency) {
    if (hasFxValue(input)) throw new HttpError(422, "Same-currency transfers do not need FX rate fields");
    if (suppliedDestinationAmount != null && suppliedDestinationAmount !== sourceAmountMinor) {
      throw new HttpError(422, "Same-currency transfer amounts must match");
    }
    return { destinationAmountMinor: sourceAmountMinor };
  }

  if (!input.fxRateSource) throw new HttpError(422, "Choose BNR or manual as the transfer FX rate source");
  if (input.fxRateSource === "bnr") {
    const quote = await resolveBnrQuote(date, sourceCurrency, destinationCurrency);
    assertQuoteMatchesSupplied(quote, input.fxRateScaled, input.fxRateDate, "Transfer BNR FX");
    if (input.referenceFxRateScaled != null || input.referenceFxRateDate) {
      throw new HttpError(422, "A BNR transfer rate does not need separate reference-rate fields");
    }
    const destinationAmountMinor = convertMinorAtRate(
      sourceAmountMinor,
      quote.rateScaled,
      quote.fromMinorUnitDigits,
      quote.toMinorUnitDigits,
    );
    if (destinationAmountMinor <= 0) {
      throw new HttpError(422, "The transfer amount is too small to produce a destination minor unit at this rate");
    }
    if (suppliedDestinationAmount != null && suppliedDestinationAmount !== destinationAmountMinor) {
      throw new HttpError(422, "The destination amount does not match the official transfer rate", {
        expectedAmountMinor: destinationAmountMinor,
        receivedAmountMinor: suppliedDestinationAmount,
        destinationCurrency,
      });
    }
    return {
      destinationAmountMinor,
      fxRateScaled: quote.rateScaled,
      fxRateSource: "bnr",
      fxRateDate: quote.rateDate,
    };
  }

  if (!input.fxRateScaled) throw new HttpError(422, "Enter a positive manual transfer FX rate");
  assertSafeInteger(input.fxRateScaled, "fxRateScaled", 1);
  const destinationAmountMinor = convertMinorAtRate(
    sourceAmountMinor,
    input.fxRateScaled,
    currencyMinorUnitDigits(sourceCurrency),
    currencyMinorUnitDigits(destinationCurrency),
  );
  if (destinationAmountMinor <= 0) {
    throw new HttpError(422, "The transfer amount is too small to produce a destination minor unit at this rate");
  }
  if (suppliedDestinationAmount != null && suppliedDestinationAmount !== destinationAmountMinor) {
    throw new HttpError(422, "The destination amount does not match the manual transfer rate", {
      expectedAmountMinor: destinationAmountMinor,
      receivedAmountMinor: suppliedDestinationAmount,
      destinationCurrency,
    });
  }
  const prepared: PreparedTransferFx = {
    destinationAmountMinor,
    fxRateScaled: input.fxRateScaled,
    fxRateSource: "manual",
    fxRateDate: input.fxRateDate || date,
  };
  requireDateKey(prepared.fxRateDate as string, "manual transfer FX rate date");
  const hasReferenceRate = input.referenceFxRateScaled != null;
  const hasReferenceDate = Boolean(input.referenceFxRateDate);
  if (hasReferenceRate !== hasReferenceDate) {
    throw new HttpError(422, "Provide both the reference BNR rate and its rate date");
  }
  if (hasReferenceRate && input.referenceFxRateDate) {
    const quote = await resolveBnrQuote(date, sourceCurrency, destinationCurrency);
    assertQuoteMatchesSupplied(quote, input.referenceFxRateScaled, input.referenceFxRateDate, "Reference transfer BNR FX");
    prepared.referenceFxRateScaled = quote.rateScaled;
    prepared.referenceFxRateDate = quote.rateDate;
  }
  validateTransferConversion(
    sourceCurrency,
    destinationCurrency,
    sourceAmountMinor,
    destinationAmountMinor,
    prepared,
  );
  return prepared;
}

/** Synchronous defense-in-depth used by the atomic transfer writer. */
export function validateTransferFxForPosting(
  sourceCurrencyValue: string,
  destinationCurrencyValue: string,
  sourceAmountMinor: number,
  date: string,
  input: TransferFxFields,
): PreparedTransferFx {
  const sourceCurrency = normalizeCurrency(sourceCurrencyValue);
  const destinationCurrency = normalizeCurrency(destinationCurrencyValue);
  requireDateKey(date, "transfer date");
  assertSafeInteger(sourceAmountMinor, "sourceAmountMinor", 1);
  rejectTransferOriginalFields(input);
  const destinationAmountMinor = input.destinationAmountMinor;
  if (sourceCurrency === destinationCurrency) {
    if (hasFxValue(input)) throw new HttpError(422, "Same-currency transfers do not need FX rate fields");
    if (destinationAmountMinor != null && destinationAmountMinor !== sourceAmountMinor) {
      throw new HttpError(422, "Same-currency transfer amounts must match");
    }
    return { destinationAmountMinor: sourceAmountMinor };
  }
  if (!destinationAmountMinor) throw new HttpError(422, "Enter the amount received by the destination account");
  assertSafeInteger(destinationAmountMinor, "destinationAmountMinor", 1);
  if (!input.fxRateSource || !input.fxRateScaled || !input.fxRateDate) {
    throw new HttpError(422, "Cross-currency transfers require a verified FX rate, source, rate date, and destination amount");
  }
  assertSafeInteger(input.fxRateScaled, "fxRateScaled", 1);
  requireDateKey(input.fxRateDate, "transfer FX rate date");
  const prepared: PreparedTransferFx = {
    destinationAmountMinor,
    fxRateScaled: input.fxRateScaled,
    fxRateSource: input.fxRateSource,
    fxRateDate: input.fxRateDate,
  };
  if (input.fxRateSource === "bnr") {
    const quote = findPersistedBnrQuote(date, sourceCurrency, destinationCurrency);
    if (!quote) throw new HttpError(422, "The official transfer quote is not cached. Request the FX quote before posting this transfer");
    assertQuoteMatchesSupplied(quote, input.fxRateScaled, input.fxRateDate, "Transfer BNR FX");
    if (input.referenceFxRateScaled != null || input.referenceFxRateDate) {
      throw new HttpError(422, "A BNR transfer rate does not need separate reference-rate fields");
    }
  } else {
    const hasReferenceRate = input.referenceFxRateScaled != null;
    const hasReferenceDate = Boolean(input.referenceFxRateDate);
    if (hasReferenceRate !== hasReferenceDate) {
      throw new HttpError(422, "Provide both the reference BNR rate and its rate date");
    }
    if (hasReferenceRate && input.referenceFxRateDate) {
      const quote = findPersistedBnrQuote(date, sourceCurrency, destinationCurrency);
      if (!quote) throw new HttpError(422, "The reference transfer quote is not cached. Request it before posting this transfer");
      assertQuoteMatchesSupplied(quote, input.referenceFxRateScaled, input.referenceFxRateDate, "Reference transfer BNR FX");
      prepared.referenceFxRateScaled = quote.rateScaled as number;
      prepared.referenceFxRateDate = quote.rateDate;
    }
  }
  validateTransferConversion(
    sourceCurrency,
    destinationCurrency,
    sourceAmountMinor,
    destinationAmountMinor,
    prepared,
  );
  return prepared;
}

/** Synchronous defense-in-depth used by the ledger writer after API preparation. */
export function validateTransactionFxForPosting(
  accountCurrencyValue: string,
  kind: string,
  amountMinor: number,
  date: string,
  input: TransactionFxFields,
): PreparedTransactionFx {
  const accountCurrency = normalizeCurrency(accountCurrencyValue);
  requireDateKey(date, "transaction date");
  if (kind === "transfer") {
    if (hasFxValue(input)) throw new HttpError(422, "Transfers cannot carry original-currency fields");
    return {};
  }
  if (!requireOriginalPair(input)) {
    if (hasFxValue(input)) throw new HttpError(422, "FX rate fields require an original amount and original currency");
    return {};
  }
  const originalAmountMinor = input.originalAmountMinor as number;
  assertSafeInteger(originalAmountMinor, "originalAmountMinor", 1);
  const originalCurrency = normalizeCurrency(input.originalCurrency as string);
  if (originalCurrency === accountCurrency) {
    if (amountMinor !== originalAmountMinor) throw new HttpError(422, "Same-currency original and posted amounts must match");
    if ([input.fxRateScaled, input.fxRateSource, input.fxRateDate, input.referenceFxRateScaled, input.referenceFxRateDate]
      .some((value) => value !== undefined && value !== null && value !== "")) {
      throw new HttpError(422, "Same-currency transactions do not need FX rate fields");
    }
    return { originalAmountMinor, originalCurrency };
  }
  if (!input.fxRateSource || !input.fxRateScaled || !input.fxRateDate) {
    throw new HttpError(422, "Foreign-currency transactions require a verified FX rate, source, and rate date");
  }
  const fxRateDate = input.fxRateDate;
  assertSafeInteger(input.fxRateScaled, "fxRateScaled", 1);
  const prepared: PreparedTransactionFx = {
    originalAmountMinor,
    originalCurrency,
    fxRateScaled: input.fxRateScaled,
    fxRateSource: input.fxRateSource,
    fxRateDate,
  };
  requireDateKey(fxRateDate, "FX rate date");
  if (input.fxRateSource === "bnr") {
    const quote = findPersistedBnrQuote(date, originalCurrency, accountCurrency);
    if (!quote) throw new HttpError(422, "The official BNR quote is not cached. Request the FX quote before posting this transaction");
    assertQuoteMatchesSupplied(quote, input.fxRateScaled, input.fxRateDate);
  }
  const hasReferenceRate = input.referenceFxRateScaled !== undefined && input.referenceFxRateScaled !== null;
  const hasReferenceDate = Boolean(input.referenceFxRateDate);
  if (hasReferenceRate !== hasReferenceDate) throw new HttpError(422, "Provide both the reference BNR rate and its rate date");
  if (hasReferenceRate && input.referenceFxRateDate) {
    const quote = findPersistedBnrQuote(date, originalCurrency, accountCurrency);
    if (!quote) throw new HttpError(422, "The reference BNR quote is not cached. Request the FX quote before posting this transaction");
    assertQuoteMatchesSupplied(quote, input.referenceFxRateScaled, input.referenceFxRateDate, "Reference BNR FX");
    prepared.referenceFxRateScaled = quote.rateScaled;
    prepared.referenceFxRateDate = quote.rateDate;
  }
  validatePostedConversion(accountCurrency, amountMinor, prepared);
  return prepared;
}
