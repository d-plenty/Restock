import { describe, expect, it } from 'vitest';
import { chainOf, overpassQuery, type NearbyStore } from './lib/places';
import { branchKey, byShop, cleanStoreName, isBranch } from './ui/screens/Stores';
import { activeSections, chainName, enabledIn, searchChainsIn, sectionOf, sectionOn, setCustomShops, SHOPS, shopsIn } from './shops';

describe('shops and tabs', () => {
  it('has every shop asked for, on the right tab', () => {
    expect(shopsIn('keg').map((s) => s.name)).toEqual([
      "Dan Murphy's",
      'BWS',
      'Liquorland',
      'Liquorland Warehouse',
      'Liquorland Cellars',
      'The Bottle-O',
      'Cellarbrations',
      'Thirsty Camel',
      'Porters Liquor',
    ]);
    expect(shopsIn('pharmacy')).toHaveLength(16);
    expect(new Set(SHOPS.map((s) => s.id)).size).toBe(SHOPS.length);
  });

  it('never sends a grocery search to a bottle shop, or the reverse', () => {
    const enabled = ['woolworths', 'coles', 'danmurphys', 'bws', 'chemistwarehouse'] as const;
    expect(searchChainsIn([...enabled], 'pantry')).toEqual(['woolworths', 'coles']);
    expect(searchChainsIn([...enabled], 'keg')).toEqual(['danmurphys', 'bws']);
    expect(searchChainsIn([...enabled], 'pharmacy')).toEqual(['chemistwarehouse']);
  });

  it('searches liquorland.com.au once for all three Liquorland shops', () => {
    expect(searchChainsIn(['liquorlandwarehouse', 'liquorlandcellars', 'liquorland'], 'keg')).toEqual(['liquorland']);
    expect(searchChainsIn(['liquorlandwarehouse'], 'keg')).toEqual(['liquorland']);
  });

  it('only shows Keg and Pharmacy when switched on with a shop picked', () => {
    const base = { enabledChains: ['coles', 'bws'] as string[], sections: { keg: true, pharmacy: true } };
    expect(activeSections(base)).toEqual(['pantry', 'keg']);
    expect(sectionOn({ ...base, sections: { keg: false, pharmacy: true } }, 'keg')).toBe(false);
    expect(sectionOn({ ...base, enabledChains: ['coles'] }, 'keg')).toBe(false);
  });

  it("puts the person's own shops on the tab they chose", () => {
    setCustomShops([{ id: 'custom-abc', name: 'Corner Chemist', website: 'https://corner.example.com', section: 'pharmacy', createdAt: '' }]);
    expect(chainName('custom-abc')).toBe('Corner Chemist');
    expect(sectionOf('custom-abc')).toBe('pharmacy');
    expect(enabledIn(['custom-abc', 'coles'], 'pharmacy')).toEqual(['custom-abc']);
    expect(shopsIn('pharmacy').at(-1)).toMatchObject({ id: 'custom-abc', custom: true, note: 'corner.example.com' });
    setCustomShops([]);
    expect(chainName('custom-abc')).toBe('Other shop');
  });
});

describe('finding bottle shops and pharmacies on the map', () => {
  it('tells the shops apart by brand, most specific first', () => {
    expect(chainOf({ brand: "Dan Murphy's", name: "Dan Murphy's Townsville" }, 'keg')).toBe('danmurphys');
    expect(chainOf({ name: 'Liquorland Warehouse Bohle' }, 'keg')).toBe('liquorlandwarehouse');
    expect(chainOf({ name: 'Liquorland' }, 'keg')).toBe('liquorland');
    expect(chainOf({ brand: 'The Bottle-O' }, 'keg')).toBe('bottleo');
    expect(chainOf({ brand: 'Chemist Warehouse' }, 'pharmacy')).toBe('chemistwarehouse');
    expect(chainOf({ name: 'My Chemist Aitkenvale' }, 'pharmacy')).toBe('mychemist');
    expect(chainOf({ brand: 'TerryWhite Chemmart' }, 'pharmacy')).toBe('terrywhite');
    expect(chainOf({ name: 'Coles' }, 'keg')).toBeUndefined();
  });

  it('asks the map for the right kind of shop', () => {
    expect(overpassQuery(-19.3, 146.7, 25000, 'keg')).toContain('"shop"~"^(alcohol|wine|beverages)$"');
    expect(overpassQuery(-19.3, 146.7, 25000, 'pharmacy')).toContain('"amenity"="pharmacy"');
    expect(overpassQuery(-19.3, 146.7, 25000)).toContain('"shop"="supermarket"');
  });
});

describe('near me', () => {
  it('groups branches by shop, closest shop first, closest branch first', () => {
    const at = (chain: NearbyStore['chain'], name: string, km: number): NearbyStore => ({ chain, name, km, lat: 0, lon: 0 });
    const groups = byShop([
      at('danmurphys', 'DM Garbutt', 7.8),
      at('bws', 'BWS Kelso', 10),
      at('bws', 'BWS Thuringowa', 3.9),
      at('danmurphys', 'DM Thuringowa', 4),
      at('liquorland', 'LL Cranbrook', 6.8),
    ]);
    expect(groups.map((g) => g.chain)).toEqual(['bws', 'danmurphys', 'liquorland']);
    expect(groups[0].branches.map((b) => b.name)).toEqual(['BWS Thuringowa', 'BWS Kelso']);
    expect(groups[1].branches.map((b) => b.name)).toEqual(['DM Thuringowa', 'DM Garbutt']);
  });
});

describe('telling branches apart', () => {
  it('names bare map entries properly and never gives two branches the same name', async () => {
    const { parseStores } = await import('./lib/places');
    const el = (name: string, lat: number, tags: Record<string, string> = {}) => ({
      type: 'node',
      lat,
      lon: 146.7,
      tags: { shop: 'alcohol', name, ...tags },
    });
    const list = parseStores(
      {
        elements: [
          el('Liquorland', -19.3),
          el('Liquorland', -19.31, { 'addr:street': 'Ross River Road' }),
          el('Liquorland', -19.32),
          el('cellarbrations', -19.33, { 'addr:suburb': 'Douglas' }),
          el('BottleO', -19.34),
        ],
      },
      { lat: -19.3, lon: 146.7 },
      'keg',
    );
    const { uniqueNames } = await import('./lib/places');
    const names = uniqueNames(list).map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain('Liquorland (Ross River Road)');
    expect(names).toContain('Cellarbrations Douglas');
    expect(names).toContain('The Bottle-O');
  });
});

describe('same-named branches', () => {
  it('uses the direction, never a repeated distance, and keeps map ids', async () => {
    const { parseStores, uniqueNames } = await import('./lib/places');
    const el = (id: number, lat: number, lon: number, name = 'Liquorland') => ({ type: 'node', id, lat, lon, tags: { shop: 'alcohol', name } });
    const list = uniqueNames(
      parseStores(
        { elements: [el(1, -19.25, 146.75), el(2, -19.35, 146.65), el(3, -19.3, 146.8, 'First Choice Liquour')] },
        { lat: -19.3, lon: -0 + 146.7 },
        'keg',
      ),
    );
    const names = list.map((s) => s.name);
    expect(names).toContain('Liquorland, north-east');
    expect(names).toContain('Liquorland, south-west');
    expect(names.some((n) => /km/.test(n))).toBe(false);
    expect(list.map((s) => s.id)).toEqual(expect.arrayContaining(['node/1', 'node/2']));
    const fc = list.find((s) => s.chain === 'liquorlandwarehouse')!;
    expect(fc.name).toBe('Liquorland Warehouse');
    expect(fc.note).toBe('Listed on the map as First Choice Liquor');
  });
});

describe('branches saved by older versions', () => {
  const b = (name: string, km: number, id?: string): NearbyStore => ({ chain: 'liquorland', name, km, lat: -19.3, lon: 146.7, id });
  const list = [b('Liquorland, north-east', 8.01, 'node/1'), b('Liquorland, south-west', 8.04, 'node/2'), b('Liquorland Cranbrook', 15.2, 'node/3')];

  it('lights up one branch for a name like "Liquorland (8.0 km)", the closest at that distance', () => {
    const cur = { primary: 'Liquorland (8.0 km)' };
    expect(list.map((s) => isBranch(cur, 'primary', s, true, list))).toEqual([true, false, false]);
    expect(list.map((s) => isBranch({ primary: 'Liquorland (15 km)' }, 'primary', s, true, list))).toEqual([false, false, true]);
  });

  it('still matches by map id and by exact name', () => {
    expect(isBranch({ primary: 'whatever', primaryMap: 'node/2' }, 'primary', list[1], true, list)).toBe(true);
    expect(isBranch({ primary: 'Liquorland Cranbrook' }, 'primary', list[2], true, list)).toBe(true);
    expect(isBranch({ primary: 'Liquorland (9.0 km)' }, 'primary', list[0], true, list)).toBe(false);
  });

  it("doesn't show a branch as chosen for a shop that isn't ticked", () => {
    expect(isBranch({ primary: 'Liquorland Cranbrook' }, 'primary', list[2], false, list)).toBe(false);
  });

  it('shows old names without the distance', () => {
    expect(cleanStoreName('Liquorland (8.0 km) 8.0 km')).toBe('Liquorland');
    expect(cleanStoreName('BWS (4.0 km)')).toBe('BWS');
    expect(cleanStoreName('Coles Kirwan')).toBe('Coles Kirwan');
  });
});

describe('branches on the same street', () => {
  it('tells them apart by street number, not #1 and #2', async () => {
    const { uniqueNames } = await import('./lib/places');
    const b = (address: string, km: number): NearbyStore => ({
      chain: 'terrywhite',
      name: 'TerryWhite Chemmart Thuringowa Central',
      km,
      lat: -19.3,
      lon: 146.7,
      address,
    });
    const names = uniqueNames([b('36 Thuringowa Drive, Thuringowa Central', 3.9), b('86 Thuringowa Drive, Thuringowa Central', 3.9)]).map(
      (s) => s.name,
    );
    expect(names).toEqual([
      'TerryWhite Chemmart Thuringowa Central (36 Thuringowa Drive)',
      'TerryWhite Chemmart Thuringowa Central (86 Thuringowa Drive)',
    ]);
    const streets = uniqueNames([b('1 Ross River Road, Kirwan', 3), b('9 Thuringowa Drive, Kirwan', 4)]).map((s) => s.name);
    expect(streets).toEqual([
      'TerryWhite Chemmart Thuringowa Central (Ross River Road)',
      'TerryWhite Chemmart Thuringowa Central (Thuringowa Drive)',
    ]);
  });

  it('keeps a branch picked after its name is tidied, even without a map id', () => {
    const s: NearbyStore = { chain: 'terrywhite', name: 'TerryWhite Chemmart #1', km: 3.9, lat: -19.31234, lon: 146.71234 };
    const saved = { primary: 'TerryWhite Chemmart Thuringowa Central', primaryMap: branchKey(s) };
    expect(isBranch(saved, 'primary', s, true, [s])).toBe(true);
    expect(isBranch(saved, 'primary', { ...s, lat: -19.4 }, true, [s])).toBe(false);
  });
});

describe('your Coles store', () => {
  it('reads the store number from a store page link or the number itself', async () => {
    const { colesStoreNo } = await import('./types');
    expect(colesStoreNo('https://www.coles.com.au/find-stores/coles/wa/karratha-313')).toBe('313');
    expect(colesStoreNo('https://www.coles.com.au/find-stores/coles/qld/kirwan-0844/')).toBe('0844');
    expect(colesStoreNo(' 0844 ')).toBe('0844');
    expect(colesStoreNo('Coles Kirwan')).toBeUndefined();
  });
  it('searches your branch only with the testing setting on', async () => {
    const { searchStoreId, stockAtBranch } = await import('./types');
    const stores = { coles: { primary: 'Coles Kirwan', branchStoreNo: '0844' }, aldi: { storeId: '1234' } };
    expect(searchStoreId({ stores, localPrices: false }, 'coles')).toBeUndefined();
    expect(searchStoreId({ stores, localPrices: true }, 'coles')).toBe('0844');
    expect(searchStoreId({ stores, localPrices: true }, 'aldi')).toBe('1234');
    expect(stockAtBranch({ stores, localPrices: true }, 'coles')).toBe('Coles Kirwan');
    expect(stockAtBranch({ stores, localPrices: true }, 'woolworths')).toBeUndefined();
  });
});
