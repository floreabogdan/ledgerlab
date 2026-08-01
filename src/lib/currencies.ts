import { currencyMinorUnitDigits } from "@/lib/domain/currency";

export const DEFAULT_CURRENCY = "USD";
export const DEFAULT_LOCALE = "en-US";
export const DEFAULT_TIME_ZONE = "UTC";

/**
 * Currencies shown first in pickers. The complete catalog is sourced from the
 * runtime's ICU data, so less common ISO 4217 currencies remain available.
 */
export const COMMON_CURRENCY_CODES = [
  "USD",
  "EUR",
  "GBP",
  "JPY",
  "CHF",
  "CAD",
  "AUD",
  "CNY",
  "INR",
  "RON",
  "PLN",
  "CZK",
  "HUF",
  "SEK",
  "NOK",
  "DKK",
  "NZD",
  "SGD",
  "HKD",
  "KRW",
  "BRL",
  "MXN",
  "ZAR",
  "TRY",
  "AED",
  "SAR",
  "ILS",
  "THB",
  "IDR",
  "MYR",
  "PHP",
  "VND",
  "UAH",
] as const;

const supportedCurrencyCodes = Object.freeze(
  Intl.supportedValuesOf("currency")
    .map((code) => code.toUpperCase())
    .filter((code) => /^[A-Z]{3}$/.test(code))
    .sort(),
);
const supportedCurrencySet = new Set<string>(supportedCurrencyCodes);
const commonCurrencyRank = new Map<string, number>(
  COMMON_CURRENCY_CODES.map((code, index) => [code, index]),
);

export type CurrencyCatalogItem = {
  code: string;
  name: string;
  symbol: string;
  minorUnitDigits: number;
  common: boolean;
};

export function normalizeCurrencyCode(value: string): string {
  return value.trim().toUpperCase();
}

export function isSupportedCurrency(value: string): boolean {
  return supportedCurrencySet.has(normalizeCurrencyCode(value));
}

function safeLocale(locale: string): string {
  try {
    return new Intl.Locale(locale).toString();
  } catch {
    return DEFAULT_LOCALE;
  }
}

function currencySymbol(code: string, locale: string): string {
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency: code,
      currencyDisplay: "narrowSymbol",
    }).formatToParts(0).find((part) => part.type === "currency")?.value ?? code;
  } catch {
    return code;
  }
}

export function currencyCatalog(locale = DEFAULT_LOCALE): CurrencyCatalogItem[] {
  const resolvedLocale = safeLocale(locale);
  const names = new Intl.DisplayNames([resolvedLocale], { type: "currency", fallback: "code" });
  return supportedCurrencyCodes
    .map((code) => ({
      code,
      name: names.of(code) ?? code,
      symbol: currencySymbol(code, resolvedLocale),
      minorUnitDigits: currencyMinorUnitDigits(code),
      common: commonCurrencyRank.has(code),
    }))
    .sort((left, right) => {
      const leftRank = commonCurrencyRank.get(left.code);
      const rightRank = commonCurrencyRank.get(right.code);
      if (leftRank !== undefined || rightRank !== undefined) {
        if (leftRank === undefined) return 1;
        if (rightRank === undefined) return -1;
        return leftRank - rightRank;
      }
      return left.name.localeCompare(right.name, resolvedLocale);
    });
}
