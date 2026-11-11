/**
 * src/domain/money.ts
 *
 * All money is stored as integer paise (100ths of a rupee).
 * Major units (₹) are only used at the boundary: MCP tool input / CSV output.
 * Never store or compute with floats.
 */

/** Convert rupees (major units) → paise (minor units). Rounds half-up. */
export function toPaise(rupees: number): number {
  return Math.round(rupees * 100);
}

/** Convert paise (minor units) → rupees (major units). */
export function toRupees(paise: number): number {
  return paise / 100;
}

/**
 * Format paise as an INR string using Indian numbering (₹1,23,456.00).
 * Uses Intl.NumberFormat so it's locale-correct.
 */
export function formatINR(paise: number): string {
  const rupees = toRupees(paise);
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(rupees);
}

/** Sum an array of paise values safely (integer arithmetic). */
export function sumPaise(values: number[]): number {
  return values.reduce((acc, v) => acc + v, 0);
}

/**
 * Check whether two paise amounts are within a tolerance.
 * Default tolerance: 100 paise (₹1) for GST rounding.
 */
export function withinTolerance(a: number, b: number, tolerancePaise = 100): boolean {
  return Math.abs(a - b) <= tolerancePaise;
}

