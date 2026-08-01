import { ensureDatabase, sqlite } from "@/db";
import { HttpError } from "@/lib/api-response";
import { isSupportedCurrency, normalizeCurrencyCode } from "@/lib/currencies";
import { monthKey, todayKey } from "@/lib/format";

export type UserRegionalSettings = {
  currency: string;
  locale: string;
  timeZone: string;
};

/** Canonical server-side lookup for formatting and calendar calculations. */
export function getUserRegionalSettings(userId: string): UserRegionalSettings {
  ensureDatabase();
  const row = sqlite.prepare(
    `SELECT default_currency AS currency, locale, time_zone AS timeZone
       FROM users WHERE id = ?`,
  ).get(userId) as UserRegionalSettings | undefined;
  if (!row) throw new HttpError(404, "User profile not found");

  const currency = normalizeCurrencyCode(row.currency);
  if (!isSupportedCurrency(currency)) {
    throw new HttpError(500, "The user profile contains an unsupported default currency");
  }
  try {
    void new Intl.Locale(row.locale);
    void new Intl.DateTimeFormat("en", { timeZone: row.timeZone });
  } catch {
    throw new HttpError(500, "The user profile contains invalid regional settings");
  }
  return { currency, locale: row.locale, timeZone: row.timeZone };
}

/** One consistent workspace-local calendar snapshot for a server operation. */
export function getUserCalendarContext(userId: string, referenceDate = new Date()) {
  const regionalSettings = getUserRegionalSettings(userId);
  return {
    ...regionalSettings,
    today: todayKey(referenceDate, regionalSettings.timeZone),
    month: monthKey(referenceDate, regionalSettings.timeZone),
  };
}
