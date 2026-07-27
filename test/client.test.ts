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
import { HookManager } from '../src/hooks';
import type { AfterInvokeContext } from '../src/hooks';

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

describe('HookManager', () => {
  it('registers and counts beforeInvoke hooks', () => {
    const hm = new HookManager();
    expect(hm.beforeInvokeCount).toBe(0);
    hm.onBeforeInvoke(() => {});
    hm.onBeforeInvoke(() => {});
    expect(hm.beforeInvokeCount).toBe(2);
  });

  it('registers and counts afterInvoke hooks', () => {
    const hm = new HookManager();
    hm.onAfterInvoke(() => {});
    expect(hm.afterInvokeCount).toBe(1);
  });

  it('runs beforeInvoke hooks in order and returns true when none abort', async () => {
    const hm = new HookManager();
    const calls: string[] = [];
    hm.onBeforeInvoke(async () => { calls.push('a'); });
    hm.onBeforeInvoke(async () => { calls.push('b'); });
    const proceed = await hm.runBeforeInvoke({ method: 'test', args: {}, timestamp: '' });
    expect(proceed).toBe(true);
    expect(calls).toEqual(['a', 'b']);
  });

  it('aborts when a beforeInvoke hook returns false', async () => {
    const hm = new HookManager();
    const calls: string[] = [];
    hm.onBeforeInvoke(async () => { calls.push('a'); });
    hm.onBeforeInvoke(async () => { calls.push('b'); return false; });
    hm.onBeforeInvoke(async () => { calls.push('c'); });
    const proceed = await hm.runBeforeInvoke({ method: 'test', args: {}, timestamp: '' });
    expect(proceed).toBe(false);
    expect(calls).toEqual(['a', 'b']);
  });

  it('offBeforeInvoke removes a specific hook', async () => {
    const hm = new HookManager();
    const calls: string[] = [];
    const hook = async () => { calls.push('x'); };
    hm.onBeforeInvoke(hook);
    hm.onBeforeInvoke(async () => { calls.push('y'); });
    hm.offBeforeInvoke(hook);
    await hm.runBeforeInvoke({ method: 'test', args: {}, timestamp: '' });
    expect(calls).toEqual(['y']);
    expect(hm.beforeInvokeCount).toBe(1);
  });

  it('offAfterInvoke removes a specific hook', () => {
    const hm = new HookManager();
    const hook = () => {};
    hm.onAfterInvoke(hook);
    hm.onAfterInvoke(() => {});
    hm.offAfterInvoke(hook);
    expect(hm.afterInvokeCount).toBe(1);
  });

  it('clear removes all hooks', () => {
    const hm = new HookManager();
    hm.onBeforeInvoke(() => {});
    hm.onAfterInvoke(() => {});
    hm.onAfterInvoke(() => {});
    hm.clear();
    expect(hm.beforeInvokeCount).toBe(0);
    expect(hm.afterInvokeCount).toBe(0);
  });

  it('runs afterInvoke hooks with context', async () => {
    const hm = new HookManager();
    let captured: AfterInvokeContext | null = null;
    hm.onAfterInvoke((ctx: AfterInvokeContext) => { captured = ctx; });
    const ctx: AfterInvokeContext = { method: 'test', args: { a: 1 }, timestamp: '', txHash: 'abc', error: null, durationMs: 42 };
    await hm.runAfterInvoke(ctx);
    expect(captured).toBe(ctx);
  });
});
