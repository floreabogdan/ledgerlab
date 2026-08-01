const DEFAULT_MINOR_UNIT_DIGITS = 2;
const MAX_SUPPORTED_MINOR_UNIT_DIGITS = 4;
const minorUnitDigitsCache = new Map<string, number>();

/**
 * Returns the ISO 4217 minor-unit precision exposed by the runtime's ICU data.
 * LedgerLab caps the result defensively because every persisted amount must
 * remain a safe integer.
 */
export function currencyMinorUnitDigits(currency: string): number {
  const normalized = currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(normalized)) return DEFAULT_MINOR_UNIT_DIGITS;
  const cached = minorUnitDigitsCache.get(normalized);
  if (cached !== undefined) return cached;
  try {
    const resolvedDigits = new Intl.NumberFormat("en", {
      style: "currency",
      currency: normalized,
    }).resolvedOptions().maximumFractionDigits;
    const digits = typeof resolvedDigits === "number" ? resolvedDigits : DEFAULT_MINOR_UNIT_DIGITS;
    const supportedDigits = Number.isInteger(digits) && digits >= 0 && digits <= MAX_SUPPORTED_MINOR_UNIT_DIGITS
      ? digits
      : DEFAULT_MINOR_UNIT_DIGITS;
    minorUnitDigitsCache.set(normalized, supportedDigits);
    return supportedDigits;
  } catch {
    minorUnitDigitsCache.set(normalized, DEFAULT_MINOR_UNIT_DIGITS);
    return DEFAULT_MINOR_UNIT_DIGITS;
  }
}

export function currencyMinorUnitScale(currency: string): number {
  return 10 ** currencyMinorUnitDigits(currency);
}

export function parseCurrencyAmountToMinor(value: string, currency: string): number | null {
  const digits = currencyMinorUnitDigits(currency);
  const normalized = value.trim().replace(/\s/g, "").replace(",", ".");
  const pattern = digits === 0
    ? /^-?\d+$/
    : new RegExp(`^-?\\d+(?:\\.\\d{0,${digits}})?$`);
  if (!pattern.test(normalized)) return null;

  const [whole, fraction = ""] = normalized.split(".");
  const negative = whole.startsWith("-");
  const absoluteWhole = whole.replace("-", "");
  const scale = 10 ** digits;
  const amount = Number(absoluteWhole) * scale + Number(fraction.padEnd(digits, "0") || "0");
  if (!Number.isSafeInteger(amount)) return null;
  return negative ? -amount : amount;
}

export function currencyMinorToInput(value: number, currency: string): string {
  if (!Number.isSafeInteger(value)) return "";
  const digits = currencyMinorUnitDigits(currency);
  const scale = 10 ** digits;
  if (digits === 0) return String(value);
  const negative = value < 0;
  const absolute = Math.abs(value);
  const whole = Math.floor(absolute / scale);
  const fraction = String(absolute % scale).padStart(digits, "0");
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}
