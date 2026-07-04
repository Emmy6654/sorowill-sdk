import { describe, expect, it } from 'vitest';

import {
  calculateShares,
  formatDeadline,
  formatUSDC,
  getTimeUntilCheckin,
  isCheckinDue,
  toStroops,
  validateBeneficiaries,
} from '../src/utils';
import { WillStatus, type Will } from '../src/types';

describe('formatUSDC', () => {
  it('formats whole numbers with two decimal places', () => {
    expect(formatUSDC(10_000_000n)).toBe('1.00');
  });

  it('formats fractional amounts', () => {
    expect(formatUSDC(12_345_000_000n)).toBe('1,234.50');
  });

  it('adds thousands separators', () => {
    expect(formatUSDC(1_000_000_000_000n)).toBe('100,000.00');
  });

  it('handles negative amounts', () => {
    expect(formatUSDC(-5_000_000n)).toBe('-0.50');
  });

  it('handles zero', () => {
    expect(formatUSDC(0n)).toBe('0.00');
  });
});

describe('toStroops', () => {
  it('parses whole numbers', () => {
    expect(toStroops('1')).toBe(10_000_000n);
  });

  it('parses decimals', () => {
    expect(toStroops('1234.50')).toBe(12_345_000_000n);
  });

  it('strips thousands separators', () => {
    expect(toStroops('1,234.50')).toBe(12_345_000_000n);
  });

  it('round-trips with formatUSDC at cents precision', () => {
    // formatUSDC only displays 2 decimal places, so only amounts that are
    // exact multiples of one cent (10^5 stroops, since USDC uses 7 decimals)
    // survive a display-and-reparse round trip without loss.
    const original = 9_876_500_000n;
    expect(toStroops(formatUSDC(original))).toBe(original);
  });

  it('throws on invalid input', () => {
    expect(() => toStroops('not-a-number')).toThrow();
    expect(() => toStroops('')).toThrow();
  });
});

function makeWill(overrides: Partial<Will> = {}): Will {
  return {
    id: '1',
    owner: 'GABC',
    token: 'CABC',
    balance: '1000000000',
    beneficiaries: [{ address: 'GBEN', percentage: 100 }],
    checkinPeriodDays: 90,
    gracePeriodDays: 7,
    lastCheckin: new Date(),
    triggerTime: null,
    status: WillStatus.Active,
    guardians: [],
    guardianVotes: 0,
    ...overrides,
  };
}

describe('getTimeUntilCheckin / isCheckinDue', () => {
  it('returns a large positive value for a freshly created will', () => {
    const will = makeWill({ lastCheckin: new Date(), checkinPeriodDays: 90 });
    expect(getTimeUntilCheckin(will)).toBeGreaterThan(89 * 86_400);
    expect(isCheckinDue(will)).toBe(false);
  });

  it('returns a negative value once the deadline has passed', () => {
    const longAgo = new Date(Date.now() - 100 * 86_400 * 1000);
    const will = makeWill({ lastCheckin: longAgo, checkinPeriodDays: 90 });
    expect(getTimeUntilCheckin(will)).toBeLessThan(0);
    expect(isCheckinDue(will)).toBe(true);
  });
});

describe('calculateShares', () => {
  it('splits evenly for a single beneficiary', () => {
    const shares = calculateShares('1000000', [{ address: 'GBEN', percentage: 100 }]);
    expect(shares).toEqual([{ address: 'GBEN', share: '1000000' }]);
  });

  it('splits proportionally across multiple beneficiaries', () => {
    const shares = calculateShares('1000000', [
      { address: 'GBEN_A', percentage: 60 },
      { address: 'GBEN_B', percentage: 40 },
    ]);
    expect(shares).toEqual([
      { address: 'GBEN_A', share: '600000' },
      { address: 'GBEN_B', share: '400000' },
    ]);
  });

  it('pays any rounding remainder to the final beneficiary', () => {
    const shares = calculateShares('100', [
      { address: 'GBEN_A', percentage: 33 },
      { address: 'GBEN_B', percentage: 33 },
      { address: 'GBEN_C', percentage: 34 },
    ]);
    const total = shares.reduce((sum, s) => sum + BigInt(s.share), 0n);
    expect(total).toBe(100n);
    expect(shares[2]?.share).toBe('34');
  });
});

describe('formatDeadline', () => {
  it('formats a date as a human-readable string', () => {
    const formatted = formatDeadline(new Date('2027-01-05T15:45:00Z'));
    expect(formatted).toContain('2027');
    expect(formatted).toContain('Jan');
  });
});

describe('validateBeneficiaries', () => {
  it('accepts percentages that sum to 100', () => {
    expect(
      validateBeneficiaries([
        { address: 'GBEN_A', percentage: 60 },
        { address: 'GBEN_B', percentage: 40 },
      ]),
    ).toBe(true);
  });

  it('rejects percentages that do not sum to 100', () => {
    expect(
      validateBeneficiaries([
        { address: 'GBEN_A', percentage: 60 },
        { address: 'GBEN_B', percentage: 30 },
      ]),
    ).toBe(false);
  });

  it('rejects an empty list', () => {
    expect(validateBeneficiaries([])).toBe(false);
  });

  it('rejects zero or negative percentages', () => {
    expect(
      validateBeneficiaries([
        { address: 'GBEN_A', percentage: 100 },
        { address: 'GBEN_B', percentage: 0 },
      ]),
    ).toBe(false);
  });
});
