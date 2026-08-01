const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_PATTERN = /^(\d{4})-(\d{2})$/;

export function parseDateKey(value: string): Date {
  const match = DATE_PATTERN.exec(value);
  if (!match) throw new RangeError(`Invalid date key: ${value}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const result = new Date(Date.UTC(year, month - 1, day));
  if (
    result.getUTCFullYear() !== year ||
    result.getUTCMonth() !== month - 1 ||
    result.getUTCDate() !== day
  ) {
    throw new RangeError(`Invalid calendar date: ${value}`);
  }
  return result;
}

export function formatDateKey(date: Date): string {
  return `${date.getUTCFullYear().toString().padStart(4, "0")}-${(date.getUTCMonth() + 1)
    .toString()
    .padStart(2, "0")}-${date.getUTCDate().toString().padStart(2, "0")}`;
}

export function parseMonthKey(value: string): { year: number; month: number } {
  const match = MONTH_PATTERN.exec(value);
  if (!match) throw new RangeError(`Invalid month key: ${value}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) throw new RangeError(`Invalid month key: ${value}`);
  return { year, month };
}

export function monthBounds(monthKey: string): { start: string; end: string } {
  const { year, month } = parseMonthKey(monthKey);
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { start: `${monthKey}-01`, end: `${monthKey}-${String(last).padStart(2, "0")}` };
}

export function datePart(isoOrDate: string): string {
  const value = isoOrDate.slice(0, 10);
  parseDateKey(value);
  return value;
}

