import { describe, it, expect } from 'vitest';
import { checkExpense, checkSubmit } from '../../src/domain/rules.js';
import type { ExpenseInput, ClaimContext, ExistingExpense } from '../../src/domain/rules.js';
import type { Category, Policy } from '../../src/db/schema.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const BASE_POLICY: Policy = {
  orgId: 'org1',
  receiptRequiredAboveMinor: 50000,   // ₹500
  gstinRequiredAboveMinor: 200000,    // ₹2,000
  allowWeekendSpend: false,
  notes: '',
};

const BASE_CATEGORY: Category = {
  id: 'cat1',
  orgId: 'org1',
  name: 'Meals',
  code: 'MEALS',
  perItemLimitMinor: 150000,   // ₹1,500
  perDayLimitMinor: 250000,    // ₹2,500
  active: true,
};

const BASE_CLAIM: ClaimContext = {
  userId: 'user1',
  tripStart: '2026-11-03',
  tripEnd: '2026-11-05',
};

function makeExpense(overrides: Partial<ExpenseInput> = {}): ExpenseInput {
  return {
    id: 'exp1',
    claimId: 'claim1',
    date: '2026-11-04',           // Tuesday, within trip
    merchant: 'Truffles',
    categoryId: 'cat1',
    amountMinor: 100000,          // ₹1,000 — under item limit
    gstin: null,
    taxableMinor: 0,
    cgstMinor: 0,
    sgstMinor: 0,
    igstMinor: 0,
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('rules — checkExpense', () => {
  it('returns no flags for a clean expense', () => {
    const flags = checkExpense(makeExpense(), BASE_CLAIM, BASE_POLICY, BASE_CATEGORY, [], []);
    expect(flags).toEqual([]);
  });

  describe('OVER_ITEM_LIMIT', () => {
    it('flags when amount exceeds per-item limit', () => {
      const flags = checkExpense(
        makeExpense({ amountMinor: 160000 }), // ₹1,600 > ₹1,500
        BASE_CLAIM, BASE_POLICY, BASE_CATEGORY, [], [],
      );
      expect(flags).toContain('OVER_ITEM_LIMIT');
    });

    it('does not flag when amount equals limit', () => {
      const flags = checkExpense(
        makeExpense({ amountMinor: 150000 }),
        BASE_CLAIM, BASE_POLICY, BASE_CATEGORY, [], [],
      );
      expect(flags).not.toContain('OVER_ITEM_LIMIT');
    });

    it('does not flag when category has no per-item limit', () => {
      const cat = { ...BASE_CATEGORY, perItemLimitMinor: null };
      const flags = checkExpense(makeExpense({ amountMinor: 9999999 }), BASE_CLAIM, BASE_POLICY, cat, [], []);
      expect(flags).not.toContain('OVER_ITEM_LIMIT');
    });
  });

  describe('OVER_DAY_LIMIT', () => {
    it('flags when day total exceeds limit', () => {
      const existing: ExistingExpense[] = [{
        id: 'other', claimId: 'claim1', date: '2026-11-04',
        merchant: 'Other', categoryId: 'cat1', amountMinor: 200000, // ₹2,000 already
      }];
      const flags = checkExpense(
        makeExpense({ amountMinor: 100000 }), // adds ₹1,000 → ₹3,000 total > ₹2,500
        BASE_CLAIM, BASE_POLICY, BASE_CATEGORY, existing, [],
      );
      expect(flags).toContain('OVER_DAY_LIMIT');
    });

    it('does not flag when category has no day limit', () => {
      const cat = { ...BASE_CATEGORY, perDayLimitMinor: null };
      const flags = checkExpense(makeExpense({ amountMinor: 9999999 }), BASE_CLAIM, BASE_POLICY, cat, [], []);
      expect(flags).not.toContain('OVER_DAY_LIMIT');
    });
  });

  describe('INVALID_GSTIN', () => {
    it('flags when GSTIN is provided but invalid', () => {
      const flags = checkExpense(makeExpense({ gstin: 'INVALIDGSTIN123' }), BASE_CLAIM, BASE_POLICY, BASE_CATEGORY, [], []);
      expect(flags).toContain('INVALID_GSTIN');
    });

    it('does not flag when no GSTIN provided', () => {
      const flags = checkExpense(makeExpense({ gstin: null }), BASE_CLAIM, BASE_POLICY, BASE_CATEGORY, [], []);
      expect(flags).not.toContain('INVALID_GSTIN');
    });

    it('does not flag when GSTIN is valid', () => {
      const flags = checkExpense(makeExpense({ gstin: '27AAPFU0939F1ZV' }), BASE_CLAIM, BASE_POLICY, BASE_CATEGORY, [], []);
      expect(flags).not.toContain('INVALID_GSTIN');
    });
  });

  describe('MISSING_GSTIN', () => {
    it('flags when amount > threshold and no GSTIN', () => {
      const flags = checkExpense(
        makeExpense({ amountMinor: 250000, gstin: null }), // ₹2,500 > ₹2,000
        BASE_CLAIM, BASE_POLICY, BASE_CATEGORY, [], [],
      );
      expect(flags).toContain('MISSING_GSTIN');
    });

    it('does not flag when amount is below threshold', () => {
      const flags = checkExpense(
        makeExpense({ amountMinor: 100000, gstin: null }), // ₹1,000 < ₹2,000
        BASE_CLAIM, BASE_POLICY, BASE_CATEGORY, [], [],
      );
      expect(flags).not.toContain('MISSING_GSTIN');
    });
  });

  describe('GST_MISMATCH', () => {
    it('flags when taxable + gst components ≠ amount (beyond ₹1 tolerance)', () => {
      const flags = checkExpense(
        makeExpense({ amountMinor: 236000, taxableMinor: 200000, cgstMinor: 18000, sgstMinor: 17900, igstMinor: 0 }), // sum = 235900, diff 100 = ₹1 OK
        BASE_CLAIM, BASE_POLICY, BASE_CATEGORY, [], [],
      );
      expect(flags).not.toContain('GST_MISMATCH'); // within tolerance
    });

    it('flags when mismatch is beyond ₹1 tolerance', () => {
      const flags = checkExpense(
        makeExpense({ amountMinor: 236000, taxableMinor: 200000, cgstMinor: 18000, sgstMinor: 17000, igstMinor: 0 }), // sum = 235000, diff = 1000 paise > 100
        BASE_CLAIM, BASE_POLICY, BASE_CATEGORY, [], [],
      );
      expect(flags).toContain('GST_MISMATCH');
    });

    it('does not flag when all GST fields are zero', () => {
      const flags = checkExpense(makeExpense({ taxableMinor: 0, cgstMinor: 0, sgstMinor: 0, igstMinor: 0 }), BASE_CLAIM, BASE_POLICY, BASE_CATEGORY, [], []);
      expect(flags).not.toContain('GST_MISMATCH');
    });
  });

  describe('WEEKEND', () => {
    it('flags a Saturday expense when weekend spend is not allowed', () => {
      const flags = checkExpense(
        makeExpense({ date: '2026-11-07' }), // Saturday
        { ...BASE_CLAIM, tripStart: '2026-11-01', tripEnd: '2026-11-30' },
        { ...BASE_POLICY, allowWeekendSpend: false },
        BASE_CATEGORY, [], [],
      );
      expect(flags).toContain('WEEKEND');
    });

    it('flags a Sunday expense', () => {
      const flags = checkExpense(
        makeExpense({ date: '2026-11-08' }), // Sunday
        { ...BASE_CLAIM, tripStart: '2026-11-01', tripEnd: '2026-11-30' },
        { ...BASE_POLICY, allowWeekendSpend: false },
        BASE_CATEGORY, [], [],
      );
      expect(flags).toContain('WEEKEND');
    });

    it('does not flag when allow_weekend_spend is true', () => {
      const flags = checkExpense(
        makeExpense({ date: '2026-11-07' }),
        { ...BASE_CLAIM, tripStart: '2026-11-01', tripEnd: '2026-11-30' },
        { ...BASE_POLICY, allowWeekendSpend: true },
        BASE_CATEGORY, [], [],
      );
      expect(flags).not.toContain('WEEKEND');
    });
  });

  describe('OUTSIDE_TRIP', () => {
    it('flags a date before trip start', () => {
      const flags = checkExpense(
        makeExpense({ date: '2026-11-01' }), // before 2026-11-03
        BASE_CLAIM, BASE_POLICY, BASE_CATEGORY, [], [],
      );
      expect(flags).toContain('OUTSIDE_TRIP');
    });

    it('flags a date after trip end', () => {
      const flags = checkExpense(
        makeExpense({ date: '2026-11-10' }), // after 2026-11-05
        BASE_CLAIM, BASE_POLICY, BASE_CATEGORY, [], [],
      );
      expect(flags).toContain('OUTSIDE_TRIP');
    });

    it('does not flag when no trip dates set', () => {
      const flags = checkExpense(
        makeExpense({ date: '2026-12-01' }),
        { userId: 'user1', tripStart: null, tripEnd: null },
        BASE_POLICY, BASE_CATEGORY, [], [],
      );
      expect(flags).not.toContain('OUTSIDE_TRIP');
    });
  });

  describe('POSSIBLE_DUPLICATE', () => {
    it('flags when same merchant, date, amount exists in another expense', () => {
      const existing: ExistingExpense[] = [{
        id: 'other-exp',
        claimId: 'other-claim',
        date: '2026-11-04',
        merchant: 'Truffles',        // same merchant (case-insensitive)
        categoryId: 'cat1',
        amountMinor: 100000,         // same amount
      }];
      const flags = checkExpense(makeExpense(), BASE_CLAIM, BASE_POLICY, BASE_CATEGORY, [], existing);
      expect(flags).toContain('POSSIBLE_DUPLICATE');
    });

    it('does not flag the same expense against itself', () => {
      const existing: ExistingExpense[] = [{
        id: 'exp1', // same id as makeExpense()
        claimId: 'claim1',
        date: '2026-11-04',
        merchant: 'Truffles',
        categoryId: 'cat1',
        amountMinor: 100000,
      }];
      const flags = checkExpense(makeExpense(), BASE_CLAIM, BASE_POLICY, BASE_CATEGORY, [], existing);
      expect(flags).not.toContain('POSSIBLE_DUPLICATE');
    });
  });
});

describe('rules — checkSubmit', () => {
  it('flags MISSING_RECEIPT when amount > threshold and no receipt', () => {
    const result = checkSubmit(
      [{ ...makeExpense({ amountMinor: 60000 }), id: 'exp1', receiptUrl: null }], // ₹600 > ₹500
      BASE_POLICY,
    );
    expect(result.get('exp1')).toContain('MISSING_RECEIPT');
  });

  it('does not flag when receipt is present', () => {
    const result = checkSubmit(
      [{ ...makeExpense({ amountMinor: 60000 }), id: 'exp1', receiptUrl: 'https://example.com/r.jpg' }],
      BASE_POLICY,
    );
    expect(result.get('exp1')).toBeUndefined();
  });

  it('does not flag when amount is below threshold', () => {
    const result = checkSubmit(
      [{ ...makeExpense({ amountMinor: 40000 }), id: 'exp1', receiptUrl: null }], // ₹400 < ₹500
      BASE_POLICY,
    );
    expect(result.get('exp1')).toBeUndefined();
  });

  it('returns empty map when no expenses need flagging', () => {
    const result = checkSubmit([], BASE_POLICY);
    expect(result.size).toBe(0);
  });
});
