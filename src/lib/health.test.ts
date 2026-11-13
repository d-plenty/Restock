import { describe, expect, it } from 'vitest';
import { failingStores, nextHealth } from './health';

describe('store health', () => {
  it('remembers when a run of failures started, and clears it when the store works again', () => {
    let h = nextHealth({}, { coles: 'HTTP 403', woolworths: null }, '2026-11-01T00:00:00Z');
    h = nextHealth(h, { coles: 'HTTP 403' }, '2026-11-03T00:00:00Z');
    expect(h.coles?.failingSince).toBe('2026-11-01T00:00:00Z');
    expect(h.coles?.lastFail).toBe('2026-11-03T00:00:00Z');
    const now = Date.parse('2026-11-04T00:00:00Z');
    expect(failingStores(h, now)).toEqual([{ chain: 'coles', since: '2026-11-01T00:00:00Z', days: 3, error: 'HTTP 403' }]);
    h = nextHealth(h, { coles: null }, '2026-11-04T00:00:00Z');
    expect(h.coles?.failingSince).toBeUndefined();
    expect(failingStores(h, now)).toEqual([]);
  });
  it("doesn't worry about a single recent failure", () => {
    const h = nextHealth({}, { aldi: 'timeout' }, '2026-11-04T00:00:00Z');
    expect(failingStores(h, Date.parse('2026-11-04T05:00:00Z'))).toEqual([]);
  });
});

describe('0.10.4: blocked shops and Hide for a day', () => {
  it('knows a blocked shop from its error', async () => {
    const { isBlockedError } = await import('./health');
    expect(isBlockedError("Cellarbrations blocked the price check (HTTP 403). Try again later, or add the price by hand.")).toBe(true);
    expect(isBlockedError('The shop answered but found nothing for "beer"')).toBe(false);
    expect(isBlockedError(undefined)).toBe(false);
  });
  it('hides a warning for 24 hours, then it comes back', async () => {
    const { hideUntil, isHidden } = await import('./health');
    const now = Date.parse('2026-11-13T09:00:00Z');
    const hidden = { cellarbrations: hideUntil(now) };
    expect(isHidden(hidden, 'cellarbrations', now + 23 * 3_600_000)).toBe(true);
    expect(isHidden(hidden, 'cellarbrations', now + 24 * 3_600_000 + 1)).toBe(false);
    expect(isHidden(hidden, 'danmurphys', now)).toBe(false);
  });
  it("never hides for good: a broken or far-off time doesn't count", async () => {
    const { isHidden } = await import('./health');
    const now = Date.parse('2026-11-13T09:00:00Z');
    expect(isHidden({ bws: 'soon' }, 'bws', now)).toBe(false);
    expect(isHidden({ bws: '2099-01-01T00:00:00Z' }, 'bws', now)).toBe(false);
  });
});
