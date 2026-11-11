import { describe, it, expect } from 'vitest';
import { csvCell, csvRow } from '../../src/domain/csv.js';
import { paiseToDecimal } from '../../src/domain/money.js';

describe('csvCell', () => {
  it('leaves plain text alone', () => expect(csvCell('Hotel Leela')).toBe('Hotel Leela'));
  it('renders null/undefined as empty', () => {
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
  });
  it('quotes commas', () => expect(csvCell('Truffles, Koramangala')).toBe('"Truffles, Koramangala"'));
  it('doubles embedded quotes', () => expect(csvCell('The "Best" Cafe')).toBe('"The ""Best"" Cafe"'));
  it('quotes newlines', () => expect(csvCell('line1\nline2')).toBe('"line1\nline2"'));

  describe('formula injection', () => {
    it.each(['=HYPERLINK("http://x","y")', '+1+1', '-2+3', '@SUM(A1)', '\tcmd'])('neutralises %j', (v) => {
      expect(csvCell(v).replace(/^"/, '').startsWith("'")).toBe(true);
    });
    it('still quotes a neutralised value that contains a comma', () =>
      expect(csvCell('=1,2')).toBe(`"'=1,2"`));
    it('does not touch numeric cells', () => expect(csvCell('-12.50', { numeric: true })).toBe('-12.50'));
    it('does not touch an email with @ in the middle', () => expect(csvCell('riya@acme.test')).toBe('riya@acme.test'));
  });
});

describe('csvRow', () => {
  it('joins with commas and ends with CRLF', () => expect(csvRow(['a', 'b'])).toBe('a,b\r\n'));
});

describe('paiseToDecimal', () => {
  it('formats whole rupees', () => expect(paiseToDecimal(50000)).toBe('500.00'));
  it('pads single-digit paise', () => expect(paiseToDecimal(105)).toBe('1.05'));
  it('formats zero', () => expect(paiseToDecimal(0)).toBe('0.00'));
  it('formats under a rupee', () => expect(paiseToDecimal(7)).toBe('0.07'));
  it('formats negatives', () => expect(paiseToDecimal(-1250)).toBe('-12.50'));
  it('is exact where floats are not', () => expect(paiseToDecimal(1_000_000_000_001)).toBe('10000000000.01'));
  it('rejects fractional paise', () => expect(() => paiseToDecimal(1.5)).toThrow());
});
