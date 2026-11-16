// 0.11.3: picks in different measures that all give a count are compared by the price of one; item
// names start with a capital; Costco is no longer a shared-price shop; the new shops.
import { describe, expect, it } from 'vitest';
import type { Group, PriceReading, Product } from '../types';
import { tidyItemName } from './itemName';
import { MARKET_SHOPS } from './market';
import { SHARE_SHOPS } from './priceShare';
import { eachPriceOf, recommend } from './verdict';
import { BETA_SHOPS, groupOf, SHARED_PRICE_SHOPS, SHOP_GROUPS, shopDef, shopsByGroup, SHOPS } from '../shops';

describe('picks that all say how many are in the pack (0.11.3)', () => {
  const NOW = Date.parse('2026-11-16T09:00:00+10:00');
  const product = (id: string, chain: Product['chain'], name: string, size?: string): Product => ({ id, chain, name, size, createdAt: '' });
  const reading = (productId: string, price: number): PriceReading => ({ productId, date: new Date(NOW).toISOString(), price, isSpecial: false, memberOnly: false, source: 'auto' });
  const group = (ids: string[]): Group => ({ id: 'g', name: 'Bagels', usualProductId: ids[0], sameProductIds: ids.slice(1), altProductIds: [], alertLevel: 'any', createdAt: '' });
  const run = (ps: Product[], prices: number[]) =>
    recommend(group(ps.map((p) => p.id)), new Map(ps.map((p) => [p.id, p])), new Map(ps.map((p, i) => [p.id, [reading(p.id, prices[i])]])), new Set(), NOW);

  it('a "4 pack 360g" and a "6 pack": the price of one decides, and nothing says Measured differently', () => {
    const c = product('c', 'coles', 'Coles Bakery Bagels Plain 4 pack 360g', '4 pack 360g');
    const w = product('w', 'woolworths', 'Woolworths Plain Bagels 6 pack', '6 pack');
    expect(eachPriceOf({ product: c, price: 3.7 })).toBeCloseTo(0.925, 3);
    expect(eachPriceOf({ product: w, price: 5 })).toBeCloseTo(0.833, 3);
    const rec = run([c, w], [3.7, 5]);
    expect(rec.byUnit).toBe(false);
    expect(rec.byEach).toBe(true);
    expect(rec.mixedUnits).toBeUndefined();
    expect(rec.best?.product.id).toBe('w'); // $0.83 each beats $0.93 each, though its shelf price is higher
  });
  it('one single thing among them: still Measured differently, and the shelf price decides', () => {
    const one = product('a', 'aldi', 'Baked Beans 420g', '420g');
    const pack = product('w', 'woolworths', 'Baked Beans 3 pack', '3 pack');
    expect(eachPriceOf({ product: one, price: 2 })).toBeUndefined();
    const rec = run([one, pack], [2, 4]);
    expect(rec.byEach).toBeUndefined();
    expect(rec.mixedUnits?.units.sort()).toEqual(['ea', 'g']);
    expect(rec.best?.product.id).toBe('a');
  });
  it('grams and millilitres are never compared by count', () => {
    const a = product('a', 'aldi', 'Deodorant 2 pack 240g', '2 x 120g');
    const b = product('b', 'coles', 'Deodorant 2 pack 500mL', '2 x 250mL');
    const rec = run([a, b], [8, 10]);
    expect(rec.byEach).toBeUndefined();
    expect(rec.mixedUnits).toBeDefined();
  });
  it('the same measure everywhere is compared by it, as before', () => {
    const a = product('a', 'aldi', 'Bagels 4 pack 360g', '4 pack 360g');
    const b = product('b', 'coles', 'Bagels 6 pack 480g', '6 pack 480g');
    const rec = run([a, b], [3.6, 5]);
    expect(rec.byUnit).toBe(true);
    expect(rec.byEach).toBeUndefined();
  });
});

describe('item names start with a capital (0.11.3)', () => {
  it('a name typed all in small letters gets one', () => {
    expect(tidyItemName('baked beans')).toBe('Baked beans');
    expect(tidyItemName('  toilet   paper ')).toBe('Toilet paper');
  });
  it('a name written on purpose is left as typed', () => {
    expect(tidyItemName('iPhone cable')).toBe('iPhone cable');
    expect(tidyItemName('pH strips')).toBe('pH strips');
    expect(tidyItemName('Baked beans')).toBe('Baked beans');
    expect(tidyItemName('2 minute noodles')).toBe('2 minute noodles');
    expect(tidyItemName('')).toBe('');
  });
});

describe('shared prices: Coles, Woolworths and Aldi only (0.11.3)', () => {
  it('one list for sending and for downloading, without Costco', () => {
    expect([...SHARED_PRICE_SHOPS]).toEqual(['coles', 'woolworths', 'aldi']);
    expect(SHARE_SHOPS).toBe(SHARED_PRICE_SHOPS);
    expect(MARKET_SHOPS).toBe(SHARED_PRICE_SHOPS);
  });
  it('Costco is still a shop you can pick', () => {
    expect(shopDef('costco')?.name).toBe('Costco');
  });
});

describe('more shops to pick from (0.11.3)', () => {
  const NEW_GROUPS = ['auto', 'hardware', 'outdoors', 'sport', 'electronics', 'home', 'beauty', 'variety'];
  it('eight new headings, each with shops under it', () => {
    const groups = shopsByGroup();
    for (const g of NEW_GROUPS) {
      expect(SHOP_GROUPS.some((x) => x.id === g), g).toBe(true);
      expect(groups.find((x) => x.group === g)?.shops.length ?? 0, g).toBeGreaterThanOrEqual(2);
    }
    expect(groupOf(shopDef('bunnings')!)).toBe('hardware');
    expect(groupOf(shopDef('supercheap')!)).toBe('auto');
  });
  it('every shop has one id, an https website of its own and a map name, and every new one is Beta', () => {
    const ids = SHOPS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of SHOPS) {
      expect(s.website.startsWith('https://'), s.id).toBe(true);
      expect(s.map.test(s.name.replace(/\s*\(.*\)$/, '')) || s.map.test(s.name), `${s.id} map`).toBe(true);
    }
    for (const id of ['supercheap', 'repco', 'mitre10', 'bcf', 'rebel', 'jbhifi', 'spotlight', 'mecca', 'rejectshop', 'foodworks', 'liquorlegends', 'babykingdom', 'peto'])
      expect(BETA_SHOPS.includes(id), id).toBe(true);
  });
  it('no new shop has a saved search address (each is found from its home page), so none is a guess', () => {
    for (const id of ['supercheap', 'repco', 'autobarn', 'autopro', 'burson', 'mitre10', 'totaltools', 'sydneytools', 'homehardware', 'bcf', 'anaconda', 'kings', 'tentworld', 'kathmandu'])
      expect(shopDef(id)?.search, id).toBeUndefined();
  });
});
