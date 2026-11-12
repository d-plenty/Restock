import { describe, expect, it } from 'vitest';
import { HELPER_SEARCHES, helperSearches, helperStatus, tidyHelperUrl, tidySearches } from './priceHelper';
import { checkSettings } from './settingsCheck';

describe('price helper (0.9.11)', () => {
  it('has 500 everyday searches, each once', () => {
    expect(HELPER_SEARCHES.length).toBe(500);
    expect(new Set(HELPER_SEARCHES).size).toBe(500);
    expect(HELPER_SEARCHES).toEqual(expect.arrayContaining(['full cream milk', 'white bread', 'coconut cream', 'flour', 'sugar', 'spaghetti']));
    expect(HELPER_SEARCHES.every((t) => t === t.trim().toLowerCase() && t.length <= 60)).toBe(true);
  });

  it('tidies an edited list and an address', () => {
    expect(tidySearches(' Milk \n\nmilk\n  baked   beans ')).toEqual(['milk', 'baked beans']);
    expect(helperSearches({ enabled: true })).toBe(HELPER_SEARCHES);
    expect(helperSearches({ enabled: true, searches: ['tea'] })).toEqual(['tea']);
    expect(tidyHelperUrl(' http://192.168.1.20:8790/ ')).toBe('http://192.168.1.20:8790');
    expect(tidyHelperUrl('192.168.1.20')).toBeUndefined();
    expect(tidyHelperUrl('http://x/helper')).toBeUndefined();
  });

  it('keeps its settings through the settings check', () => {
    const s = checkSettings({ priceHelper: { enabled: true, url: 'http://10.0.0.2:8790', key: 'k', searches: ['milk', 5, ''] } });
    expect(s.priceHelper).toEqual({ enabled: true, url: 'http://10.0.0.2:8790', key: 'k', searches: ['milk'] });
    expect(checkSettings({}).priceHelper).toBeUndefined();
  });
});

describe('price helper status (0.9.12)', () => {
  const now = Date.parse('2026-11-12T06:30:00+10:00');
  it('says when it is running, and what it did', () => {
    const run = helperStatus({ state: { week: '2026-W46', done: 3, of: 500, sent: 320, runningSince: new Date(now - 60_000).toISOString() }, enabled: true, of: 500, now });
    expect(run[0]).toBe('Running now: search 4 of 500. Each one takes about a minute.');
    expect(run[1]).toMatch(/^This week: 3 of 500 searches done · 320 prices sent/);
  });
  it('a run that went quiet long ago is not shown as running, and a tap shows Starting', () => {
    const old = helperStatus({ state: { week: '2026-W46', done: 3, runningSince: new Date(now - 3_600_000).toISOString(), lastError: 'x' }, enabled: true, of: 500, now });
    expect(old.some((l) => l.startsWith('Running now'))).toBe(false);
    expect(old).toContain('Last problem: x');
    expect(helperStatus({ enabled: true, of: 500, asked: now - 2000, now })).toEqual(['Starting…']);
    expect(helperStatus({ enabled: true, of: 500, now })[0]).toMatch(/^Not run yet/);
    expect(helperStatus({ enabled: false, of: 500, now })).toEqual(['Off.']);
  });
});
