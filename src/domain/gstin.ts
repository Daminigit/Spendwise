/**
 * src/domain/gstin.ts
 *
 * Validates Indian GST Identification Numbers (GSTIN).
 *
 * Format: 15 characters
 *   [0-1]   State code (01–37, two digits)
 *   [2-11]  PAN (10 chars: AAAAA9999A pattern)
 *   [12]    Entity number (1–9, A–Z)
 *   [13]    'Z' (always)
 *   [14]    Checksum character (0-9, A-Z)
 *
 * Checksum algorithm: mod-36 on a weighted sum of char codes.
 */

const GSTIN_REGEX =
  /^[0-3][0-9][A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

const CHAR_SET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

function charValue(ch: string): number {
  return CHAR_SET.indexOf(ch);
}

/**
 * Compute the expected checksum character for a 14-character GSTIN prefix.
 * Returns the check character (position 14).
 */
function computeChecksum(gstin14: string): string {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const cv = charValue(gstin14[i]);
    const weighted = cv * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(weighted / 36) + (weighted % 36);
  }
  const remainder = sum % 36;
  const checkIndex = (36 - remainder) % 36;
  return CHAR_SET[checkIndex];
}

/**
 * Returns true if the GSTIN passes both the format regex and checksum.
 * Accepts lowercase input (normalises to upper before checking).
 */
export function validateGSTIN(gstin: string): boolean {
  const upper = gstin.trim().toUpperCase();
  if (!GSTIN_REGEX.test(upper)) return false;
  const expected = computeChecksum(upper.slice(0, 14));
  return upper[14] === expected;
}

/**
 * Returns a human-readable error message, or null if valid.
 * Useful for returning specific errors in MCP tool responses.
 */
export function gstinError(gstin: string): string | null {
  const upper = gstin.trim().toUpperCase();
  if (upper.length !== 15) return `GSTIN must be exactly 15 characters (got ${upper.length}).`;
  if (!GSTIN_REGEX.test(upper)) return `GSTIN format is invalid. Expected: 2-digit state code + PAN + entity + Z + check digit.`;
  const expected = computeChecksum(upper.slice(0, 14));
  if (upper[14] !== expected) return `GSTIN checksum is invalid (expected '${expected}', got '${upper[14]}').`;
  return null;
}

