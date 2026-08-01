export const FX_RATE_SCALE = 100_000_000;

function roundedRatio(numerator: bigint, denominator: bigint) {
  if (denominator <= 0n || numerator < 0n) return null;
  const result = (numerator + denominator / 2n) / denominator;
  return result <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(result) : null;
}

/** Converts non-negative integer minor units using a scaled major-unit rate. */
export function convertCurrencyMinor(
  sourceMinor: number,
  rateScaled: number,
  rateScale: number,
  sourceDigits: number,
  targetDigits: number,
) {
  if (!Number.isSafeInteger(sourceMinor) || sourceMinor < 0 || !Number.isSafeInteger(rateScaled) || rateScaled <= 0) return null;
  const numerator = BigInt(sourceMinor) * BigInt(rateScaled) * (10n ** BigInt(targetDigits));
  const denominator = BigInt(rateScale) * (10n ** BigInt(sourceDigits));
  return roundedRatio(numerator, denominator);
}

/** Solves for source minor units when the target amount and rate are known. */
export function reverseConvertCurrencyMinor(
  targetMinor: number,
  rateScaled: number,
  rateScale: number,
  sourceDigits: number,
  targetDigits: number,
) {
  if (!Number.isSafeInteger(targetMinor) || targetMinor < 0 || !Number.isSafeInteger(rateScaled) || rateScaled <= 0) return null;
  const numerator = BigInt(targetMinor) * BigInt(rateScale) * (10n ** BigInt(sourceDigits));
  const denominator = BigInt(rateScaled) * (10n ** BigInt(targetDigits));
  return roundedRatio(numerator, denominator);
}

/** Derives target-major-units per source-major-unit as an integer-scaled rate. */
export function deriveRateScaled(
  sourceMinor: number,
  targetMinor: number,
  rateScale: number,
  sourceDigits: number,
  targetDigits: number,
) {
  if (!Number.isSafeInteger(sourceMinor) || !Number.isSafeInteger(targetMinor) || sourceMinor <= 0 || targetMinor <= 0) return null;
  const numerator = BigInt(targetMinor) * BigInt(rateScale) * (10n ** BigInt(sourceDigits));
  const denominator = BigInt(sourceMinor) * (10n ** BigInt(targetDigits));
  return roundedRatio(numerator, denominator);
}

export function rateInputToScaled(value: string, rateScale = FX_RATE_SCALE) {
  const normalized = value.trim().replace(",", ".");
  if (rateScale !== FX_RATE_SCALE || !/^\d+(?:\.\d{0,8})?$/.test(normalized)) return null;
  const [whole, fraction = ""] = normalized.split(".");
  const scaled = BigInt(whole) * BigInt(rateScale) + BigInt(fraction.padEnd(8, "0"));
  return scaled > 0n && scaled <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(scaled) : null;
}

export function rateScaledToInput(value: number, rateScale = FX_RATE_SCALE) {
  if (!Number.isSafeInteger(value) || value <= 0 || rateScale !== FX_RATE_SCALE) return "";
  const whole = Math.floor(value / rateScale);
  const fraction = String(value % rateScale).padStart(8, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : String(whole);
}
