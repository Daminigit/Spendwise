import { describe, it, expect } from 'vitest';
import { validateGSTIN, gstinError } from '../../src/domain/gstin.js';

// Known valid GSTINs (checksums verified against the official algorithm)
const VALID = [
  '27AAPFU0939F1ZV',
  '07AAGFF2194N1Z1',
];

// Invalid GSTINs
const INVALID_FORMAT = [
  '12345',                   // too short
  'ABCDE1234F1Z5XX',        // wrong state code format
  '99ABCDE1234F1Z5',        // state code 99 invalid
  '29ABCDE1234F1Z',         // 14 chars, missing check digit
];

describe('gstin', () => {
  describe('validateGSTIN', () => {
    it('accepts known valid GSTINs', () => {
      for (const g of VALID) {
        expect(validateGSTIN(g), `Expected ${g} to be valid`).toBe(true);
      }
    });

    it('accepts lowercase input (normalises internally)', () => {
      expect(validateGSTIN('27aapfu0939f1zv')).toBe(true);
    });

    it('rejects too-short strings', () => {
      expect(validateGSTIN('12345')).toBe(false);
    });

    it('rejects format-invalid GSTINs', () => {
      for (const g of INVALID_FORMAT) {
        expect(validateGSTIN(g), `Expected ${g} to be invalid`).toBe(false);
      }
    });

    it('rejects a valid-format but wrong-checksum GSTIN', () => {
      // Flip the last character of a valid GSTIN
      const tampered = '29ABCDE1234F1Z9'; // 5 → 9
      expect(validateGSTIN(tampered)).toBe(false);
    });
  });

  describe('gstinError', () => {
    it('returns null for valid GSTIN', () => {
      expect(gstinError(VALID[0])).toBeNull();
    });

    it('returns length error for short input', () => {
      const err = gstinError('123');
      expect(err).toContain('15 characters');
    });

    it('returns format error for bad pattern', () => {
      const err = gstinError('00ABCDE1234F1Z5');
      expect(err).toBeTruthy();
    });

    it('returns checksum error for bad check digit', () => {
      const err = gstinError('29ABCDE1234F1Z9');
      expect(err).toContain('checksum');
    });
  });
});
