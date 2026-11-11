import { describe, expect, it } from 'vitest';
import { HELPER_SEARCHES, helperSearches, tidyHelperUrl, tidySearches } from './priceHelper';
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
