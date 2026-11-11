import { describe, it, expect } from 'vitest';
import { toPaise, toRupees, formatINR, sumPaise, withinTolerance } from '../../src/domain/money.js';

describe('money', () => {
  describe('toPaise', () => {
    it('converts whole rupees', () => expect(toPaise(100)).toBe(10000));
    it('converts decimal rupees', () => expect(toPaise(1.5)).toBe(150));
    it('rounds half-up correctly', () => expect(toPaise(1.505)).toBe(151));
    it('handles zero', () => expect(toPaise(0)).toBe(0));
    it('handles large amounts', () => expect(toPaise(123456.78)).toBe(12345678));
  });

  describe('toRupees', () => {
    it('converts paise to rupees', () => expect(toRupees(10000)).toBe(100));
    it('handles fractional paise', () => expect(toRupees(150)).toBe(1.5));
    it('handles zero', () => expect(toRupees(0)).toBe(0));
  });

  describe('formatINR', () => {
    it('formats thousands correctly', () => {
      expect(formatINR(100000)).toMatch(/1,000/);
    });
    it('formats lakhs with Indian grouping', () => {
      expect(formatINR(12345600)).toMatch(/1,23,456/);
    });
    it('includes ₹ symbol', () => {
      expect(formatINR(5000)).toMatch(/₹/);
    });
    it('shows two decimal places', () => {
      expect(formatINR(5050)).toMatch(/50\.50/);
    });
  });

  describe('sumPaise', () => {
    it('sums an array of paise', () => expect(sumPaise([100, 200, 300])).toBe(600));
    it('returns 0 for empty array', () => expect(sumPaise([])).toBe(0));
    it('handles large values', () => expect(sumPaise([1000000, 2000000])).toBe(3000000));
  });

  describe('withinTolerance', () => {
    it('returns true when values are equal', () => expect(withinTolerance(500, 500)).toBe(true));
    it('returns true within default 100 paise tolerance', () => expect(withinTolerance(500, 599)).toBe(true));
    it('returns false outside default tolerance', () => expect(withinTolerance(500, 601)).toBe(false));
    it('respects custom tolerance', () => expect(withinTolerance(500, 510, 10)).toBe(true));
    it('handles negative difference', () => expect(withinTolerance(600, 500)).toBe(true));
  });
});
