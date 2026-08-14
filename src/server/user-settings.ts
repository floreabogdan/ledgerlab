import { ensureDatabase, sqlite } from "@/db";
import { HttpError } from "@/lib/api-response";
import { isSupportedCurrency, normalizeCurrencyCode } from "@/lib/currencies";
import { monthKey, todayKey } from "@/lib/format";
import type { WorkspaceContext } from "@/lib/workspace-context";

export type UserRegionalSettings = {
  locale: string;
};

export type WorkspaceFinancialSettings = {
  currency: string;
  timeZone: string;
};

/** Per-user formatting preferences. These never control shared financial data. */
export function getUserRegionalSettings(userId: string): UserRegionalSettings {
  ensureDatabase();
  const row = sqlite.prepare(
    "SELECT locale FROM users WHERE id = ?",
  ).get(userId) as UserRegionalSettings | undefined;
  if (!row) {
    throw new HttpError(404, {
      code: "PROFILE_NOT_FOUND",
      message: "User profile not found",
    });
  }

  try {
    void new Intl.Locale(row.locale);
  } catch {
    throw new HttpError(500, {
      code: "PROFILE_REGIONAL_SETTINGS_INVALID",
      message: "The user profile contains invalid regional settings",
    });
  }
  return { locale: row.locale };
}

/** Canonical currency and time zone for all shared financial behavior. */
export function getWorkspaceFinancialSettings(context: WorkspaceContext): WorkspaceFinancialSettings {
  ensureDatabase();
  const row = sqlite.prepare(
    `SELECT default_currency AS currency, time_zone AS timeZone
       FROM workspaces WHERE id = ?`,
  ).get(context.workspaceId) as WorkspaceFinancialSettings | undefined;
  if (!row) {
    throw new HttpError(404, {
      code: "WORKSPACE_NOT_FOUND",
      message: "Workspace not found",
    });
  }

  const currency = normalizeCurrencyCode(row.currency);
  if (!isSupportedCurrency(currency)) {
    throw new HttpError(500, {
      code: "WORKSPACE_CURRENCY_INVALID",
      message: "The workspace contains an unsupported default currency",
    });
  }
  try {
    void new Intl.DateTimeFormat("en", { timeZone: row.timeZone });
  } catch {
    throw new HttpError(500, {
      code: "WORKSPACE_TIME_ZONE_INVALID",
      message: "The workspace contains an invalid financial time zone",
    });
  }
  return { currency, timeZone: row.timeZone };
}

/** One consistent workspace-local calendar snapshot for a server operation. */
export function getWorkspaceCalendarContext(context: WorkspaceContext, referenceDate = new Date()) {
  const regionalSettings = getWorkspaceFinancialSettings(context);
  return {
    ...regionalSettings,
    today: todayKey(referenceDate, regionalSettings.timeZone),
    month: monthKey(referenceDate, regionalSettings.timeZone),
  };
}
