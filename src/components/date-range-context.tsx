"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { monthBounds, parseDateKey, parseMonthKey } from "@/lib/domain/dates";
import { DEFAULT_LOCALE, DEFAULT_TIME_ZONE } from "@/lib/currencies";
import { useTranslations } from "@/i18n/client";
import { defaultLanguage, messageCatalogs } from "@/i18n/generated";
import { createTranslator, type Translator } from "@/i18n/runtime";

const DATE_RANGE_STORAGE_KEY = "ledgerlab.date-range.v1";

export interface DateRange {
  /** Inclusive workspace-local calendar date. */
  from: string;
  /** Inclusive workspace-local calendar date. */
  to: string;
}

export type DateRangeQuickPickId =
  | "this_month"
  | "month_to_date"
  | "last_month"
  | "next_month"
  | "last_3_months"
  | "last_6_months"
  | "this_year"
  | "last_12_months";

export type ActiveDateRange = DateRangeQuickPickId | "custom";

export type DateRangeValidationResult =
  | { success: true; range: DateRange }
  | { success: false; error: string };

export interface DateRangeQuickPick {
  id: DateRangeQuickPickId;
  getRange: (referenceDate?: Date, timeZone?: string) => DateRange;
}

const englishTranslator = createTranslator({
  language: defaultLanguage,
  catalog: messageCatalogs[defaultLanguage],
  fallbackCatalog: messageCatalogs[defaultLanguage],
});

export interface DateRangeContextValue {
  range: DateRange;
  label: string;
  activeRange: ActiveDateRange;
  hydrated: boolean;
  locale: string;
  timeZone: string;
  setRange: (range: DateRange) => DateRangeValidationResult;
  setCustomRange: (from: string, to: string) => DateRangeValidationResult;
  selectQuickPick: (id: DateRangeQuickPickId) => void;
  resetDateRange: () => void;
}

export interface DateRangeProviderProps {
  children: ReactNode;
  initialRange?: DateRange;
  /** Injectable clock for deterministic previews and tests. */
  now?: Date;
  storageKey?: string;
  locale?: string;
  timeZone?: string;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function dateKeyFromParts(year: number, month: number, day: number): string {
  return `${year}-${pad(month)}-${pad(day)}`;
}

function monthKeyForDate(dateKey: string): string {
  return dateKey.slice(0, 7);
}

function shiftMonth(monthKey: string, amount: number): string {
  const { year, month } = parseMonthKey(monthKey);
  const shifted = new Date(Date.UTC(year, month - 1 + amount, 1));
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}`;
}

function calendarMonthSpan(referenceDate: Date, monthCount: number, timeZone: string): DateRange {
  const currentMonth = monthKeyForDate(getDateKey(referenceDate, timeZone));
  const firstMonth = shiftMonth(currentMonth, -(monthCount - 1));
  return {
    from: `${firstMonth}-01`,
    to: monthBounds(currentMonth).end,
  };
}

/** Returns the calendar date at the supplied instant in the requested IANA time zone. */
export function getDateKey(referenceDate: Date = new Date(), timeZone = DEFAULT_TIME_ZONE): string {
  if (Number.isNaN(referenceDate.getTime())) {
    throw new RangeError("invalid_reference_date");
  }

  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(referenceDate);
  const year = Number(parts.find((part) => part.type === "year")?.value);
  const month = Number(parts.find((part) => part.type === "month")?.value);
  const day = Number(parts.find((part) => part.type === "day")?.value);
  return dateKeyFromParts(year, month, day);
}

export function getDefaultDateRange(
  referenceDate: Date = new Date(),
  timeZone = DEFAULT_TIME_ZONE,
): DateRange {
  const monthKey = monthKeyForDate(getDateKey(referenceDate, timeZone));
  const bounds = monthBounds(monthKey);
  return { from: bounds.start, to: bounds.end };
}

export function getQuickPickRange(
  id: DateRangeQuickPickId,
  referenceDate: Date = new Date(),
  timeZone = DEFAULT_TIME_ZONE,
): DateRange {
  const currentDate = getDateKey(referenceDate, timeZone);
  const currentMonth = monthKeyForDate(currentDate);

  switch (id) {
    case "this_month":
      return getDefaultDateRange(referenceDate, timeZone);
    case "month_to_date":
      return { from: `${currentMonth}-01`, to: currentDate };
    case "last_month": {
      const previousMonth = shiftMonth(currentMonth, -1);
      const bounds = monthBounds(previousMonth);
      return { from: bounds.start, to: bounds.end };
    }
    case "next_month": {
      const followingMonth = shiftMonth(currentMonth, 1);
      const bounds = monthBounds(followingMonth);
      return { from: bounds.start, to: bounds.end };
    }
    case "last_3_months":
      return calendarMonthSpan(referenceDate, 3, timeZone);
    case "last_6_months":
      return calendarMonthSpan(referenceDate, 6, timeZone);
    case "this_year": {
      const { year } = parseMonthKey(currentMonth);
      return { from: `${year}-01-01`, to: currentDate };
    }
    case "last_12_months":
      return calendarMonthSpan(referenceDate, 12, timeZone);
  }
}

export const DATE_RANGE_QUICK_PICKS: readonly DateRangeQuickPick[] = [
  { id: "this_month", getRange: (date, timeZone) => getQuickPickRange("this_month", date, timeZone) },
  {
    id: "month_to_date",
    getRange: (date, timeZone) => getQuickPickRange("month_to_date", date, timeZone),
  },
  { id: "last_month", getRange: (date, timeZone) => getQuickPickRange("last_month", date, timeZone) },
  { id: "next_month", getRange: (date, timeZone) => getQuickPickRange("next_month", date, timeZone) },
  {
    id: "last_3_months",
    getRange: (date, timeZone) => getQuickPickRange("last_3_months", date, timeZone),
  },
  {
    id: "last_6_months",
    getRange: (date, timeZone) => getQuickPickRange("last_6_months", date, timeZone),
  },
  { id: "this_year", getRange: (date, timeZone) => getQuickPickRange("this_year", date, timeZone) },
  {
    id: "last_12_months",
    getRange: (date, timeZone) => getQuickPickRange("last_12_months", date, timeZone),
  },
] as const;

function validDateKey(value: string): boolean {
  try {
    parseDateKey(value);
    return true;
  } catch {
    return false;
  }
}

export function validateDateRange(
  input: unknown,
  t: Translator["translate"] = englishTranslator.translate,
): DateRangeValidationResult {
  if (!input || typeof input !== "object") {
    return { success: false, error: t("common.dateRange.validation.missing") };
  }

  const candidate = input as { from?: unknown; to?: unknown };
  const from = typeof candidate.from === "string" ? candidate.from.trim() : "";
  const to = typeof candidate.to === "string" ? candidate.to.trim() : "";

  if (!from || !to) {
    return { success: false, error: t("common.dateRange.validation.missing") };
  }
  if (!validDateKey(from) || !validDateKey(to)) {
    return { success: false, error: t("common.dateRange.validation.invalidCalendar") };
  }
  if (from > to) {
    return { success: false, error: t("common.dateRange.validation.reversed") };
  }
  const spanDays = (parseDateKey(to).getTime() - parseDateKey(from).getTime()) / 86_400_000;
  if (spanDays > 3_660) {
    return { success: false, error: t("common.dateRange.validation.tooLong") };
  }

  return { success: true, range: { from, to } };
}

/** Trims and validates a range, returning null rather than throwing for invalid input. */
export function normalizeDateRange(input: unknown): DateRange | null {
  const result = validateDateRange(input);
  return result.success ? result.range : null;
}

function rangesEqual(left: DateRange, right: DateRange): boolean {
  return left.from === right.from && left.to === right.to;
}

export function identifyQuickPick(
  range: DateRange,
  referenceDate: Date = new Date(),
  timeZone = DEFAULT_TIME_ZONE,
): ActiveDateRange {
  return (
    DATE_RANGE_QUICK_PICKS.find((quickPick) =>
      rangesEqual(range, quickPick.getRange(referenceDate, timeZone)),
    )?.id ?? "custom"
  );
}

function utcDate(dateKey: string): Date {
  return parseDateKey(dateKey);
}

function capitalizeDateLabel(value: string, locale: string) {
  return value ? `${value[0]?.toLocaleUpperCase(locale) ?? ""}${value.slice(1)}` : value;
}

/** Compact label using the workspace locale. */
export function getDateRangeLabel(
  range: DateRange,
  locale = DEFAULT_LOCALE,
  invalidLabel = englishTranslator.translate("common.dateRange.invalid"),
): string {
  const normalized = normalizeDateRange(range);
  if (!normalized) return invalidLabel;

  const fromMonth = monthKeyForDate(normalized.from);
  const toMonth = monthKeyForDate(normalized.to);
  const coversWholeMonths =
    normalized.from === `${fromMonth}-01` && normalized.to === monthBounds(toMonth).end;

  if (coversWholeMonths) {
    const monthYear = new Intl.DateTimeFormat(locale, {
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    });
    if (fromMonth === toMonth) return capitalizeDateLabel(monthYear.format(utcDate(normalized.from)), locale);

    const fromYear = parseMonthKey(fromMonth).year;
    const toYear = parseMonthKey(toMonth).year;
    const fromFormatter = new Intl.DateTimeFormat(locale, {
      month: "long",
      ...(fromYear === toYear ? {} : { year: "numeric" }),
      timeZone: "UTC",
    });
    return capitalizeDateLabel(`${fromFormatter.format(utcDate(normalized.from))} – ${monthYear.format(
      utcDate(normalized.to),
    )}`, locale);
  }

  const fromYear = Number(normalized.from.slice(0, 4));
  const toYear = Number(normalized.to.slice(0, 4));
  const fromFormatter = new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "short",
    ...(fromYear === toYear ? {} : { year: "numeric" }),
    timeZone: "UTC",
  });
  const toFormatter = new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
  return capitalizeDateLabel(`${fromFormatter.format(utcDate(normalized.from))} – ${toFormatter.format(
    utcDate(normalized.to),
  )}`, locale);
}

interface StoredDateRange {
  version: 1;
  range: DateRange;
}

function decodeStoredRange(value: string | null): DateRange | null {
  if (!value) return null;
  try {
    const stored = JSON.parse(value) as Partial<StoredDateRange>;
    if (stored.version !== 1) return null;
    return normalizeDateRange(stored.range);
  } catch {
    return null;
  }
}

const DateRangeContext = createContext<DateRangeContextValue | null>(null);

export function DateRangeProvider({
  children,
  initialRange,
  now,
  storageKey = DATE_RANGE_STORAGE_KEY,
  locale = DEFAULT_LOCALE,
  timeZone = DEFAULT_TIME_ZONE,
}: DateRangeProviderProps) {
  const t = useTranslations();
  const fixedNowTime = now?.getTime();
  const [liveReferenceDate, setLiveReferenceDate] = useState(() =>
    new Date(fixedNowTime ?? Date.now()),
  );
  const referenceDate = useMemo(
    () => new Date(fixedNowTime ?? liveReferenceDate.getTime()),
    [fixedNowTime, liveReferenceDate],
  );
  const [range, setRangeState] = useState<DateRange>(() =>
    normalizeDateRange(initialRange) ?? getDefaultDateRange(referenceDate, timeZone),
  );
  const [hydrated, setHydrated] = useState(false);
  const previousTimeZone = useRef(timeZone);

  useEffect(() => {
    if (previousTimeZone.current === timeZone) return;
    const oldTimeZone = previousTimeZone.current;
    previousTimeZone.current = timeZone;
    setRangeState((current) => rangesEqual(current, getDefaultDateRange(referenceDate, oldTimeZone))
      ? getDefaultDateRange(referenceDate, timeZone)
      : current);
  }, [referenceDate, timeZone]);

  useEffect(() => {
    if (fixedNowTime !== undefined) return;

    const interval = window.setInterval(() => {
      const current = new Date();
      setLiveReferenceDate((previous) =>
        getDateKey(previous, timeZone) === getDateKey(current, timeZone) ? previous : current,
      );
    }, 60_000);

    return () => window.clearInterval(interval);
  }, [fixedNowTime, timeZone]);

  useEffect(() => {
    let active = true;
    let storedRange: DateRange | null = null;
    try {
      storedRange = decodeStoredRange(window.localStorage.getItem(storageKey));
    } catch {
      // Storage can be unavailable in hardened/private browser contexts.
    }

    queueMicrotask(() => {
      if (!active) return;
      if (storedRange) setRangeState(storedRange);
      setHydrated(true);
    });

    return () => {
      active = false;
    };
  }, [storageKey]);

  useEffect(() => {
    if (!hydrated) return;
    try {
      const stored: StoredDateRange = { version: 1, range };
      window.localStorage.setItem(storageKey, JSON.stringify(stored));
    } catch {
      // Range selection remains usable in memory when persistence is unavailable.
    }
  }, [hydrated, range, storageKey]);

  useEffect(() => {
    function handleStorage(event: StorageEvent) {
      if (event.storageArea !== window.localStorage || event.key !== storageKey) return;
      const storedRange = decodeStoredRange(event.newValue);
      if (storedRange) setRangeState(storedRange);
    }
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, [storageKey]);

  const setRange = useCallback((nextRange: DateRange): DateRangeValidationResult => {
    const result = validateDateRange(nextRange, t);
    if (result.success) setRangeState(result.range);
    return result;
  }, [t]);

  const setCustomRange = useCallback(
    (from: string, to: string): DateRangeValidationResult => setRange({ from, to }),
    [setRange],
  );

  const readClock = useCallback(
    () => new Date(fixedNowTime ?? Date.now()),
    [fixedNowTime],
  );

  const selectQuickPick = useCallback((id: DateRangeQuickPickId) => {
    const current = readClock();
    if (fixedNowTime === undefined) setLiveReferenceDate(current);
    setRangeState(getQuickPickRange(id, current, timeZone));
  }, [fixedNowTime, readClock, timeZone]);

  const resetDateRange = useCallback(() => {
    const current = readClock();
    if (fixedNowTime === undefined) setLiveReferenceDate(current);
    setRangeState(getDefaultDateRange(current, timeZone));
  }, [fixedNowTime, readClock, timeZone]);

  const value = useMemo<DateRangeContextValue>(
    () => ({
      range,
      label: getDateRangeLabel(range, locale, t("common.dateRange.invalid")),
      activeRange: identifyQuickPick(range, referenceDate, timeZone),
      hydrated,
      locale,
      timeZone,
      setRange,
      setCustomRange,
      selectQuickPick,
      resetDateRange,
    }),
    [hydrated, locale, range, referenceDate, resetDateRange, selectQuickPick, setCustomRange, setRange, t, timeZone],
  );

  return <DateRangeContext.Provider value={value}>{children}</DateRangeContext.Provider>;
}

export function useDateRange(): DateRangeContextValue {
  const context = useContext(DateRangeContext);
  if (!context) throw new Error("missing_date_range_provider");
  return context;
}
