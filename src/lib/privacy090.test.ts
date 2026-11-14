import { describe, expect, it } from 'vitest';
import privacyMd from '../../PRIVACY.md?raw';
import legal from './legal.json';
import { householdSettingsFor } from './household';
import { mergeSettings } from './db';
import { recallLink } from '../ui/screens/Recalls';
import { httpsLink } from '../ui/screens/Catalogues';
import type { Settings } from '../types';

// 0.9.0: privacy fixes from the outside review.

describe('joining a household (0.9.0)', () => {
  const owner = {
    enabledChains: ['coles', 'woolworths', 'custom-odd00001', 'custom-good0001'],
    stores: {
      coles: { primary: 'Coles Kirwan', primaryMap: 'way/1', storeId: '0844', branchStoreNo: '0844', branchStoreNo2: '0700', secondary: 'Coles Willows' },
    },
    customShops: [
      { id: 'custom-odd00001', name: 'Odd', website: 'https://www.odd.com.au', section: 'pantry', search: 'https://elsewhere.example/?q={q}', createdAt: '' },
      { id: 'custom-good0001', name: 'Good', website: 'https://www.good.com.au', section: 'pantry', createdAt: '' },
    ],
    historyWeeks: 26,
    marketData: { enabled: true, wifiOnly: false },
    area: { label: 'Owner St', lat: -19.3, lon: 146.7 },
    autoBackup: { enabled: true, folder: 'content://owner', everyDays: 1, keep: 3, password: 'owners-secret' },
    accounts: { woolworths: { signedIn: true, storeId: '1234' } },
    localPrices: true,
    household: { name: 'Plenty house' },
  } as unknown as Partial<Settings>;

  it('takes only the shared settings, never the owner’s own', () => {
    for (const replace of [true, false]) {
      const mine = mergeSettings({});
      const out = householdSettingsFor(mine, owner, { tabs: ['pantry'], replace });
      expect(out.historyWeeks).toBe(26);
      expect(out.household.name).toBe('Plenty house');
      expect(out.marketData).toEqual(mine.marketData);
      expect(out.area).toBeUndefined();
      expect(out.autoBackup).toEqual(mine.autoBackup);
      expect(out.accounts).toBeUndefined();
      expect(out.localPrices).toBeUndefined();
      expect(JSON.stringify(out)).not.toContain('owners-secret');
      // The branch, but not its store numbers.
      expect(out.stores.coles).toEqual({ primary: 'Coles Kirwan', primaryMap: 'way/1', secondary: 'Coles Willows' });
      // A shop of theirs whose search page is on another site doesn't come across.
      expect(out.customShops.map((c) => c.id)).toEqual(['custom-good0001']);
      expect(out.enabledChains).not.toContain('custom-odd00001');
    }
  });

  it('keeps this phone’s own store numbers when it has the same branch', () => {
    const mine = mergeSettings({ stores: { coles: { primary: 'Coles Kirwan', primaryMap: 'way/1', branchStoreNo: '0844' } } } as Partial<Settings>);
    const out = householdSettingsFor(mine, owner, { tabs: ['pantry'], replace: true });
    expect(out.stores.coles?.branchStoreNo).toBe('0844');
    expect(out.stores.coles?.branchStoreNo2).toBeUndefined();
  });

  it('copes with settings that aren’t settings', () => {
    const mine = mergeSettings({});
    expect(householdSettingsFor(mine, 'nonsense' as never, { tabs: ['pantry'], replace: true }).historyWeeks).toBe(mine.historyWeeks);
    expect(householdSettingsFor(mine, { historyWeeks: -3 } as Partial<Settings>, { tabs: ['pantry'], replace: false }).historyWeeks).toBe(8);
  });
});

describe('links from data', () => {
  it('only opens a recall notice on an official recall site, else that list’s page', () => {
    expect(recallLink({ source: 'FSANZ', url: 'https://www.foodstandards.gov.au/food-recalls/recall-alert/x' })).toBe(
      'https://www.foodstandards.gov.au/food-recalls/recall-alert/x',
    );
    expect(recallLink({ source: 'TGA', url: 'https://apps.tga.gov.au/PROD/SARA/x' })).toBe('https://apps.tga.gov.au/PROD/SARA/x');
    expect(recallLink({ source: 'TGA', url: 'http://www.tga.gov.au/x' })).toBe('https://www.tga.gov.au/safety/safety-alerts');
    expect(recallLink({ source: 'FSANZ', url: 'https://foodstandards.gov.au.evil.example/x' })).toBe('https://www.foodstandards.gov.au/food-recalls/alerts');
    expect(recallLink({ source: 'Product Safety Australia', url: 'javascript:alert(1)' })).toBe('https://www.productsafety.gov.au/recalls');
  });

  it('only shows https catalogue and website links', () => {
    expect(httpsLink('https://www.coles.com.au/catalogues')).toBe('https://www.coles.com.au/catalogues');
    for (const u of ['http://x.com.au', 'javascript:alert(1)', 'intent://x', '', undefined]) expect(httpsLink(u)).toBeUndefined();
  });
});

describe('the privacy policy', () => {
  /** PRIVACY.md is legal.json written out (CONTRIBUTING.md): the same words, in the same order. */
  const render = () => {
    const p = legal.privacy;
    const out = [`# ${p.title}`, '', `_Last updated ${legal.updated}_`, '', `**${p.tagline}**`, '', p.intro, '', '## In short', ''];
    out.push(...p.summary.map((s) => `- ${s}`), '');
    for (const s of p.sections) out.push(`## ${s.title}`, '', ...s.body.flatMap((b) => [b, '']));
    out.push(`_${p.outro}_`, '', '---', '', '_This file is generated from `src/lib/legal.json`, which the app shows on screen. Edit that file, not this one._', '');
    return out.join('\n');
  };

  it('matches PRIVACY.md', () => {
    expect(privacyMd).toBe(render());
  });

  it('names every service the app talks to for barcodes and near me', () => {
    const text = render();
    expect(legal.updated).toBe('14 November 2026');
    for (const name of ['Open Food Facts', 'Open Beauty Facts', 'Open Products Facts', 'nominatim.openstreetmap.org', 'overpass-api.de', 'overpass.private.coffee'])
      expect(text).toContain(name);
    expect(text).not.toContain('mail.ru');
    expect(text).toContain('about 100 metres');
    expect(text).toContain('one at a time');
    expect(text).toContain("only the ones you've switched on");
    expect(text).toMatch(/Erase everything[^\n]*signs you out[^\n]*exported/);
  });

  it('0.9.13 to 0.10.0: says what feedback and Shared prices send, and where', () => {
    const text = render();
    expect(text).toContain('restock-prices.plenty.family');
    expect(text).toContain('restock-prices.plenty.family/share/prices');
    expect(text).toContain('Attach diagnostics');
    expect(text).toMatch(/"Shared prices" is on unless you turn it off/);
    // 0.9.14: it sends now, so the policy no longer says it doesn't.
    expect(text).not.toMatch(/For now nothing is sent anywhere/);
    expect(text).toMatch(/which products a phone's searches and price checks showed/);
    expect(text).toMatch(/Prices you type in or change yourself are never sent/);
    // 0.10.0: spending can go to your own server (Share my spending with the server), never to us.
    expect(text).toContain('Share my spending with the server');
    expect(text).not.toContain('never synced, never in a backup, never sent anywhere');
    // 0.10.0: one switch; turning it back on never sends what was read while it was off.
    expect(text).toContain('prices read while it was off are never sent');
    expect(text).not.toMatch(/decentralised|before any prices are shared publicly/);
    // Phones no longer download from hotprices.org, and the old "it will ask you first" promise is gone.
    expect(text).toContain("Phones don't download from hotprices.org");
    expect(text).not.toContain('it will ask you first');
    expect(text).not.toContain('Restock has no server run by its makers');
  });
});
