export type MinorUnits = number;

export function assertMinorUnits(value: number, field = "amountMinor"): asserts value is MinorUnits {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${field} must be a safe integer expressed in minor units.`);
  }
}

export function addMinor(...amounts: number[]): MinorUnits {
  const total = amounts.reduce((sum, amount) => {
    assertMinorUnits(amount);
    return sum + amount;
  }, 0);
  assertMinorUnits(total, "total");
  return total;
}
