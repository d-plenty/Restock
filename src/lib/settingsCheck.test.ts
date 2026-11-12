import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type Settings } from '../types';
import { checkCustomShop, checkSettings } from './settingsCheck';
import { mergeRestoredSettings } from './db';
import { accentVars, luminance } from './theme';

// 0.9.0: settings from a backup, another phone or a damaged database are checked before use.

const bad = (x: unknown) => x as Partial<Settings>;

describe('checking settings', () => {
  it('gives the defaults for nothing, or for something that isn’t settings', () => {
    for (const x of [undefined, null, 5, 'settings', [], [1, 2]]) expect(checkSettings(x)).toEqual(checkSettings({}));
    expect(checkSettings({})).toEqual(DEFAULT_SETTINGS);
  });

  it('keeps good settings exactly as they are, and checking twice changes nothing', () => {
    const good: Settings = {
      ...DEFAULT_SETTINGS,
      onboarded: true,
      enabledChains: ['coles', 'bws', 'custom-ab12cd34'],
      stores: { woolworths: {}, coles: { primary: 'Coles Kirwan', branchStoreNo: '0844', primaryMap: 'way/1' }, aldi: {} },
      customShops: [
        { id: 'custom-ab12cd34', name: 'Corner Cellar', website: 'https://www.cornercellar.com.au', section: 'keg', search: 'https://shop.cornercellar.com.au/search?q={q}', createdAt: '2026-11-01T00:00:00.000Z' },
      ],
      sections: { keg: true, pharmacy: false },
      historyWeeks: 26,
      marketData: { enabled: true, wifiOnly: false, days: 182, every: 'daily' },
      checkIntervalHours: 168,
      shopAroundMin: 0.5,
      look: { style: 'plain', accent: '#ffcd00', icon: 'match', black: false },
      a11y: { text: 1.3, contrast: true, motion: false, big: true },
      receipts: { enabled: true, installed: true, keepMonths: 0 },
      autoBackup: { enabled: true, folder: 'content://x/tree/y', everyDays: 14, keep: 10, password: '  spaces kept  ' },
      area: { label: 'Bohle Plains QLD 4817', lat: -19.31, lon: 146.69 },
      updates: { notify: true, lastCheck: '2026-11-09T03:12:45.123456Z' },
      tour: { seen: true, step: 3 },
      widgets: { background: 'colour', colour: '#123456', transparency: 40, text: '#ffffff' },
    };
    const once = checkSettings(good);
    expect(once).toEqual(good);
    expect(checkSettings(JSON.parse(JSON.stringify(once)))).toEqual(once);
  });

  it('replaces odd values with the defaults, and keeps numbers within limits', () => {
    const s = checkSettings(
      bad({
        look: { accent: 5, style: 'neon', icon: 'blue' },
        receipts: { keepMonths: -1, enabled: 'yes' },
        historyWeeks: -3,
        enabledChains: null,
        checkIntervalHours: 7,
        shopAroundMin: -5,
        defaultThresholdPct: 1e9,
        theme: 'purple',
        connection: 42,
        sharePrices: true,
        alerts: { dailyTime: 'soon', catalogueWeekday: 9, daily: 'true' },
        a11y: { text: 40 },
        autoBackup: { keep: 0, everyDays: -2, enabled: 1 },
        widgets: { transparency: 500, colour: 'red', text: 'javascript:alert(1)' },
        seenHints: 'all',
        setup: { done: [1, 'pantry', null] },
        tour: { step: -4 },
        household: { name: 7 },
        area: { label: 'x', lat: 999, lon: 0 },
      }),
    );
    expect(s.look).toEqual(DEFAULT_SETTINGS.look);
    expect(s.receipts).toEqual(DEFAULT_SETTINGS.receipts);
    expect(s.historyWeeks).toBe(8);
    expect(s.enabledChains).toEqual(['woolworths', 'coles', 'aldi']);
    expect(s.checkIntervalHours).toBe(24);
    expect(s.checkTime).toBe('05:00');
    expect(s.shopAroundMin).toBe(0);
    expect(s.defaultThresholdPct).toBe(90);
    expect(s.theme).toBe('system');
    expect(s.connection).toBe('auto');
    expect(s.sharePrices).toBe('yes'); // 0.10.0: Shared prices is on to start with
    expect(s.alerts).toEqual(DEFAULT_SETTINGS.alerts);
    expect(s.a11y.text).toBe(1.5);
    expect(s.autoBackup).toEqual({ enabled: false, everyDays: 1, keep: 1 });
    expect(s.widgets).toEqual({ ...DEFAULT_SETTINGS.widgets, transparency: 90 });
    expect(s.seenHints).toEqual([]);
    expect(s.setup.done).toEqual(['pantry']);
    expect(s.tour).toEqual({});
    expect(s.household.name).toBe('Our house');
    expect(s.area).toBeUndefined();
  });

  it('only keeps real shops, and drops what it doesn’t know', () => {
    // As it would come out of a file: JSON keeps "__proto__" as an ordinary key.
    const s = checkSettings(
      JSON.parse(
        JSON.stringify({
          enabledChains: ['coles', 'other', 'nope', 7, 'coles', 'custom-gone'],
          stores: { coles: { primary: 'Coles Kirwan', storeId: 1234 }, nope: { primary: 'x' }, aldi: 'Aldi' },
          hiddenTabs: ['keg', 'garage'],
          evil: { anything: true },
        })
          .replace('{', '{"__proto__":{"polluted":true},')
          .replace('"stores":{', '"stores":{"__proto__":{"primary":"x"},'),
      ),
    );
    expect(s.enabledChains).toEqual(['coles']);
    expect(s.stores).toEqual({ woolworths: {}, coles: { primary: 'Coles Kirwan' }, aldi: {} });
    expect(s.hiddenTabs).toEqual(['keg']);
    expect('evil' in s).toBe(false);
    expect(Object.keys(s)).not.toContain('__proto__');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect((s as unknown as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('shops people add (0.9.0)', () => {
  const shop = { id: 'custom-ab12cd34', name: 'Corner Chemist', website: 'https://www.cornerchemist.com.au', section: 'pharmacy', createdAt: '' };

  it('needs a proper website, moved to https', () => {
    expect(checkCustomShop(shop)?.website).toBe('https://www.cornerchemist.com.au');
    expect(checkCustomShop({ ...shop, website: 'http://www.cornerchemist.com.au' })?.website).toBe('https://www.cornerchemist.com.au');
    for (const website of ['javascript:alert(1)', 'ftp://x.com', 'https://localhost', '', 5, 'https://me:pw@x.com.au'])
      expect(checkCustomShop({ ...shop, website })).toBeUndefined();
    expect(checkCustomShop({ ...shop, id: 'woolworths' })).toBeUndefined();
    expect(checkCustomShop({ ...shop, section: 'garage' })).toBeUndefined();
    expect(checkCustomShop({ ...shop, name: '  ' })).toBeUndefined();
  });

  it('keeps a search page on the same site, and drops one anywhere else', () => {
    expect(checkCustomShop({ ...shop, search: 'https://search.cornerchemist.com.au/?q={q}' })?.search).toBe('https://search.cornerchemist.com.au/?q={q}');
    expect(checkCustomShop({ ...shop, search: 'http://www.cornerchemist.com.au/?s={q}' })?.search).toBe('https://www.cornerchemist.com.au/?s={q}');
    // This phone's own shop: only the odd search page goes.
    const mine = checkCustomShop({ ...shop, search: 'https://elsewhere.example/?q={q}' });
    expect(mine?.id).toBe(shop.id);
    expect(mine?.search).toBeUndefined();
    // From a backup or another phone: the whole shop goes.
    expect(checkCustomShop({ ...shop, search: 'https://elsewhere.example/?q={q}' }, true)).toBeUndefined();
    expect(checkCustomShop({ ...shop, search: 'https://www.cornerchemist.com.au/search' }, true)).toBeUndefined();
    // Another shop on the same big ending isn't the same site.
    expect(checkCustomShop({ ...shop, search: 'https://www.other.com.au/?q={q}' }, true)).toBeUndefined();
  });

  it('leaves out a restored shop whose search page is on another site', () => {
    const current = checkSettings({});
    const incoming = bad({
      enabledChains: ['custom-ab12cd34', 'custom-good0001'],
      customShops: [
        { ...shop, search: 'https://elsewhere.example/?q={q}' },
        { ...shop, id: 'custom-good0001', name: 'Good', search: 'https://www.cornerchemist.com.au/?q={q}' },
      ],
      sections: { keg: false, pharmacy: true },
    });
    const out = mergeRestoredSettings(current, incoming, { shops: true });
    expect(out.customShops.map((c) => c.id)).toEqual(['custom-good0001']);
    expect(out.enabledChains).toContain('custom-good0001');
    expect(out.enabledChains).not.toContain('custom-ab12cd34');
  });
});

describe('colours from settings', () => {
  it('never throws on a colour that isn’t one, and uses the default green', () => {
    expect(() => accentVars(5 as never, false)).not.toThrow();
    expect(accentVars(undefined as never, true)).toEqual(accentVars('#00843d', true));
    expect(luminance(null as never)).toBe(luminance('#00843d'));
  });
});

describe('0.9.14: one price history setting', () => {
  it('turns 1 and 3 months into the next choice up, and the day-one length follows', async () => {
    const { checkSettings } = await import('./settingsCheck');
    expect(checkSettings({ historyWeeks: 4 }).historyWeeks).toBe(8);
    expect(checkSettings({ historyWeeks: 13 }).historyWeeks).toBe(26);
    expect(checkSettings({ historyWeeks: 13 }).marketData.days).toBe(182);
    expect(checkSettings({ historyWeeks: 52, marketData: { days: 56 } }).marketData.days).toBe(365);
    expect(checkSettings({}).marketData).toEqual({ enabled: true, wifiOnly: true, days: 56, every: 'weekly' });
    // 0.10.0: one switch: getting shared prices follows sending them.
    expect(checkSettings({ sharePrices: 'no', marketData: { enabled: true } }).marketData.enabled).toBe(false);
    expect(checkSettings({ sharePrices: 'unasked', marketData: { enabled: false } }).marketData.enabled).toBe(true);
  });
});
