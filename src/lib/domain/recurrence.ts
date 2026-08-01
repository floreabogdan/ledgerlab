import type { RecurrenceFrequency } from "@/db/schema";

import { formatDateKey, parseDateKey } from "./dates";

const DAY_MS = 86_400_000;
const MAX_SCAN_DAYS = 366 * 500;

export type RecurrenceRule = {
  frequency: RecurrenceFrequency;
  interval?: number;
  startDate: string;
  endDate?: string | null;
  occurrenceCount?: number | null;
  daysOfWeek?: number[] | null;
  dayOfMonth?: number | null;
  monthOfYear?: number | null;
  adjustment?: "clamp" | "skip";
};

function daysBetween(left: Date, right: Date): number {
  return Math.floor((right.getTime() - left.getTime()) / DAY_MS);
}

function startOfIsoWeek(date: Date): Date {
  const result = new Date(date.getTime());
  const mondayOffset = (result.getUTCDay() + 6) % 7;
  result.setUTCDate(result.getUTCDate() - mondayOffset);
  return result;
}

function lastDayOfMonth(year: number, zeroBasedMonth: number): number {
  return new Date(Date.UTC(year, zeroBasedMonth + 1, 0)).getUTCDate();
}

function isMatchingDate(candidate: Date, start: Date, rule: Required<Pick<RecurrenceRule, "frequency" | "interval" | "adjustment">> & RecurrenceRule): boolean {
  const dayOffset = daysBetween(start, candidate);
  if (dayOffset < 0) return false;

  switch (rule.frequency) {
    case "daily":
      return dayOffset % rule.interval === 0;
    case "weekly": {
      const weekOffset = Math.floor(daysBetween(startOfIsoWeek(start), startOfIsoWeek(candidate)) / 7);
      const weekdays = rule.daysOfWeek?.length ? [...new Set(rule.daysOfWeek)] : [start.getUTCDay()];
      return weekOffset % rule.interval === 0 && weekdays.includes(candidate.getUTCDay());
    }
    case "monthly": {
      const monthOffset =
        (candidate.getUTCFullYear() - start.getUTCFullYear()) * 12 +
        candidate.getUTCMonth() -
        start.getUTCMonth();
      if (monthOffset < 0 || monthOffset % rule.interval !== 0) return false;
      const targetDay = rule.dayOfMonth ?? start.getUTCDate();
      const lastDay = lastDayOfMonth(candidate.getUTCFullYear(), candidate.getUTCMonth());
      if (targetDay > lastDay && rule.adjustment === "skip") return false;
      return candidate.getUTCDate() === Math.min(targetDay, lastDay);
    }
    case "yearly": {
      const yearOffset = candidate.getUTCFullYear() - start.getUTCFullYear();
      if (yearOffset < 0 || yearOffset % rule.interval !== 0) return false;
      const targetMonth = (rule.monthOfYear ?? start.getUTCMonth() + 1) - 1;
      if (candidate.getUTCMonth() !== targetMonth) return false;
      const targetDay = rule.dayOfMonth ?? start.getUTCDate();
      const lastDay = lastDayOfMonth(candidate.getUTCFullYear(), targetMonth);
      if (targetDay > lastDay && rule.adjustment === "skip") return false;
      return candidate.getUTCDate() === Math.min(targetDay, lastDay);
    }
  }
}

function validateRecurrenceRule(rule: RecurrenceRule): void {
  parseDateKey(rule.startDate);
  if (rule.endDate) {
    parseDateKey(rule.endDate);
    if (rule.endDate < rule.startDate) throw new RangeError("Recurrence end date precedes its start date.");
  }
  if (!Number.isInteger(rule.interval ?? 1) || (rule.interval ?? 1) < 1) {
    throw new RangeError("Recurrence interval must be a positive integer.");
  }
  if (rule.occurrenceCount != null && (!Number.isInteger(rule.occurrenceCount) || rule.occurrenceCount < 1)) {
    throw new RangeError("Occurrence count must be a positive integer.");
  }
  if (rule.dayOfMonth != null && (!Number.isInteger(rule.dayOfMonth) || rule.dayOfMonth < 1 || rule.dayOfMonth > 31)) {
    throw new RangeError("Day of month must be between 1 and 31.");
  }
  if (rule.monthOfYear != null && (!Number.isInteger(rule.monthOfYear) || rule.monthOfYear < 1 || rule.monthOfYear > 12)) {
    throw new RangeError("Month of year must be between 1 and 12.");
  }
  if (rule.daysOfWeek?.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) {
    throw new RangeError("Weekdays must be integers from 0 (Sunday) through 6 (Saturday). ");
  }
}

/**
 * Generates date-only occurrence keys, inclusive at both boundaries. Calendar math
 * deliberately uses UTC arithmetic so daylight-saving transitions cannot shift date-only occurrences.
 */
export function occurrencesBetween(
  rule: RecurrenceRule,
  fromDate: string,
  throughDate: string,
  existingDates: Iterable<string> = [],
): string[] {
  validateRecurrenceRule(rule);
  const start = parseDateKey(rule.startDate);
  const from = parseDateKey(fromDate);
  const through = parseDateKey(throughDate);
  if (through < from) return [];

  const effectiveEnd = rule.endDate && rule.endDate < throughDate ? parseDateKey(rule.endDate) : through;
  if (effectiveEnd < start) return [];
  const scanDays = daysBetween(start, effectiveEnd);
  if (scanDays > MAX_SCAN_DAYS) throw new RangeError("Recurrence range is too large.");

  const normalizedRule = {
    ...rule,
    interval: rule.interval ?? 1,
    adjustment: rule.adjustment ?? "clamp",
  };
  const existing = new Set(existingDates);
  const result: string[] = [];
  let matchedCount = 0;

  for (let offset = 0; offset <= scanDays; offset += 1) {
    const candidate = new Date(start.getTime() + offset * DAY_MS);
    if (!isMatchingDate(candidate, start, normalizedRule)) continue;
    matchedCount += 1;
    if (rule.occurrenceCount != null && matchedCount > rule.occurrenceCount) break;
    const key = formatDateKey(candidate);
    if (candidate >= from && !existing.has(key)) result.push(key);
  }
  return result;
}

export function nextOccurrence(
  rule: RecurrenceRule,
  afterDate: string,
  existingDates: Iterable<string> = [],
): string | null {
  const after = parseDateKey(afterDate);
  const searchFrom = new Date(after.getTime() + DAY_MS);
  const searchThrough = new Date(searchFrom.getTime());
  searchThrough.setUTCFullYear(searchThrough.getUTCFullYear() + 100);
  const occurrences = occurrencesBetween(rule, formatDateKey(searchFrom), formatDateKey(searchThrough), existingDates);
  return occurrences[0] ?? null;
}
