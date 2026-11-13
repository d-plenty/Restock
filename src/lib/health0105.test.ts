import { describe, expect, it } from 'vitest';
import { BlockedError } from '../stores/http';
import { inTurns, offerUnblock, testTimeoutMs, usesBrowser } from './health';

// 0.10.5: Unblock for shops that never answer, and tests that are fair to every shop.
describe('offering Unblock', () => {
  it('offers it for a clear block at any shop', () => {
    expect(offerUnblock('coles', new BlockedError('Coles', '403').message)).toBe(true);
  });
  it("offers it when a hidden-browser shop doesn't answer or finds nothing", () => {
    expect(usesBrowser('cellarbrations')).toBe(true);
    expect(usesBrowser('danmurphys')).toBe(true);
    expect(offerUnblock('cellarbrations', 'No answer after 75 seconds')).toBe(true);
    expect(offerUnblock('danmurphys', 'No answer after 30 seconds')).toBe(true);
    // Saved by 0.10.4 and older.
    // 0.10.6: Dan Murphy's finding nothing is an answer, not a check (endeavour0106.test.ts).
    expect(offerUnblock('danmurphys', 'The shop answered but found nothing for "beer"')).toBe(false);
  });
  it('not for shops with their own app data, or no error', () => {
    expect(offerUnblock('woolworths', 'No answer after 30 seconds')).toBe(false);
    expect(offerUnblock('cellarbrations', undefined)).toBe(false);
    expect(offerUnblock('other', 'No answer after 30 seconds')).toBe(false);
  });
});

describe('testing shops in turns', () => {
  it('gives website shops longer than app-data shops', () => {
    expect(testTimeoutMs('cellarbrations')).toBeGreaterThan(testTimeoutMs('woolworths'));
    expect(testTimeoutMs('danmurphys')).toBeGreaterThan(30_000);
  });
  it('runs at most n at once, and keeps the order', async () => {
    let now = 0;
    let most = 0;
    const out = await inTurns([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      now++;
      most = Math.max(most, now);
      await new Promise((r) => setTimeout(r, 5 + (n % 3)));
      now--;
      return n * 2;
    });
    expect(most).toBe(3);
    expect(out).toEqual([2, 4, 6, 8, 10, 12, 14]);
  });
});
