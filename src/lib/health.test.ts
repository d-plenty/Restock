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
