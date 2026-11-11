// 0.9.6: two prices on every product line (per item, then the comparison price), a size worked out when the
// shop gave none (and always labelled), "Last updated", and prices typed in by hand.
declare const process: { env: Record<string, string | undefined> };
process.env.TZ = 'Australia/Sydney';

import { describe, expect, it } from 'vitest';
import type { Group, PriceReading, Product } from '../types';
import type { StoreProduct } from '../stores/types';
import { unitTextOf } from './searchHelp';
import { lastUpdatedText, newestReading, priceLine, readSize, sameProductLine, sizeLabel, sizeUp, storePriceLine } from './unitPrice';
import { bothPrices, computeStats, normaliseReadings, productQty, recommend } from './verdict';

const NOW = Date.parse('2026-11-12T09:00:00+11:00');
const DAY = 86_400_000;
const reading = (productId: string, price: number, daysAgo = 0, extra: Partial<PriceReading> = {}): PriceReading => ({
  productId,
  date: new Date(NOW - daysAgo * DAY).toISOString(),
  price,
  isSpecial: false,
  memberOnly: false,
  source: 'auto',
  ...extra,
});
const product = (id: string, chain: Product['chain'], name: string, extra: Partial<Product> = {}): Product => ({ id, chain, name, createdAt: '', ...extra });
const group = (ids: string[]): Group => ({ id: 'g', name: 'Sprite', usualProductId: ids[0], sameProductIds: ids.slice(1), altProductIds: [], alertLevel: 'any', createdAt: '' });

// The real example (11 Nov): Coles gave only "$0.98 each", Woolworths had 375mL x 24 pack at $2.61/L.
const COLES = product('c', 'coles', 'Sprite Soft Drink Cans Lemonade Cca Flavour', { size: '24 Pack', brand: 'Sprite' });
const WOOLIES = product('w', 'woolworths', 'Sprite Lemonade Soft Drink Cans 375mL x 24 pack', { brand: 'Sprite' });

describe('reading a size from the words', () => {
  const read = (name: string, size?: string) => readSize({ name, size }).size;
  it('reads packs written every way', () => {
    expect(read('Pepsi Max 10x375ml')).toMatchObject({ qty: 3750, unit: 'ml', count: 10, basis: 'shop' });
    expect(read('Solo Lemon 375mL x 24 pack')).toMatchObject({ qty: 9000, unit: 'ml', count: 24 });
    expect(read('Tim Tam Biscuits', '1.58kg')).toMatchObject({ qty: 1580, unit: 'g' });
    expect(read('Arnotts Shapes 36 x 40g')).toMatchObject({ qty: 1440, unit: 'g', count: 36 });
    expect(read('Bundaberg Ginger Beer 4 x 375mL cans')).toMatchObject({ qty: 1500, unit: 'ml', count: 4 });
  });
  it('finds a size in the name when the size field says only "1 each"', () => {
    expect(read('Coca-Cola Classic 1.25L', '1 Each')).toMatchObject({ qty: 1250, unit: 'ml' });
  });
  it('says a pack of drinks with only a count has no size', () => {
    expect(readSize({ name: COLES.name, size: COLES.size })).toEqual({ packCount: 24 });
  });
  it('still counts things sold by the item', () => {
    expect(read('Quilton Toilet Tissue 24 Pack')).toMatchObject({ qty: 24, unit: 'ea' });
  });
  it("uses the shop's own unit price when it gives one", () => {
    expect(readSize({ name: 'Sprite Cans', size: '24 Pack', unitPriceText: '$2.61 / 1L', price: 23.5 }).size).toMatchObject({ qty: 9000, unit: 'ml', basis: 'shop' });
  });
  it('uses a size the person confirmed above everything', () => {
    expect(readSize({ name: COLES.name, size: COLES.size, qty: 9000, qtyUnit: 'ml' }).size).toMatchObject({ qty: 9000, unit: 'ml', count: 24, basis: 'confirmed' });
  });
});

describe('the pack total is said to be the total', () => {
  it('Coles "10x375ml" with size "3.75L" says 10 × 375 mL and 3.75 L in total', () => {
    const p = product('x', 'coles', 'Pepsi Max Soft Drink Cans 10x375ml', { size: '3.75L' });
    expect(productQty(p)).toMatchObject({ qty: 3750, unit: 'ml', count: 10 });
    expect(sizeLabel(p)).toBe('10 × 375 mL, 3.75 L in total');
    const l = priceLine(p, 9);
    expect(l.each).toBe('$0.90 each');
    expect(l.compare).toBe('$2.40 / L');
    expect(l.text).toBe('$0.90 each · $2.40 / L');
  });
});

describe('the Coles Sprite example', () => {
  it('has no size on its own, and says so, without guessing silently', () => {
    const l = priceLine(COLES, 23.5);
    expect(l.unknown).toBe(true);
    expect(l.each).toBe('$0.98 each');
    expect(l.compare).toBeUndefined();
    expect(l.text).toBe('$0.98 each · size unknown');
    // The common size is only a suggestion.
    expect(l.suggestion).toContain('24 × 375 mL = 9 L');
    expect(l.suggestion).toContain('usually 375 mL');
  });

  it('is sized from the look-alike at Woolworths when the pack count and price each match, and says estimated', () => {
    const s = sizeUp({ ...COLES, price: 23.5 }, [{ ...WOOLIES, price: 23.5 }]);
    expect(s.size).toMatchObject({ qty: 9000, unit: 'ml', count: 24, basis: 'estimated' });
    const rec = recommend(group(['c', 'w']), new Map([['c', COLES], ['w', WOOLIES]]), new Map([['c', [reading('c', 23.5)]], ['w', [reading('w', 23.5)]]]), new Set(), NOW);
    const coles = rec.options.find((o) => o.product.id === 'c')!;
    expect(coles.unitPrice! * 1000).toBeCloseTo(2.611, 2);
    expect(bothPrices(coles)).toBe('$0.98 each · $2.61 / L (estimated)');
    const wool = rec.options.find((o) => o.product.id === 'w')!;
    expect(bothPrices(wool)).toBe('$0.98 each · $2.61 / L');
    expect(rec.byUnit).toBe(true);
  });

  it("doesn't match a different price, a different pack count or a different drink", () => {
    expect(sizeUp({ ...COLES, price: 20 }, [{ ...WOOLIES, price: 23.5 }]).size).toBeUndefined();
    expect(sizeUp({ ...COLES, price: 23.5 }, [{ ...WOOLIES, name: 'Sprite Lemonade Soft Drink Cans 375mL x 30 pack', price: 23.5 }]).size).toBeUndefined();
    expect(sizeUp({ ...COLES, price: 23.5 }, [{ ...WOOLIES, name: 'Sprite Zero Sugar Lemonade Soft Drink Cans 375mL x 24 pack', price: 23.5 }]).size).toBeUndefined();
    expect(sameProductLine(COLES, WOOLIES)).toBe(true);
    expect(sameProductLine(COLES, { ...WOOLIES, name: 'Sprite Zero Lemonade Cans 375mL x 24 pack' })).toBe(false);
  });

  it('is left out of the cheapest comparison when its size is unknown', () => {
    // A different price: nothing to estimate from. Coles is cheaper on the shelf but its size is unknown.
    const rec = recommend(group(['c', 'w']), new Map([['c', COLES], ['w', WOOLIES]]), new Map([['c', [reading('c', 20)]], ['w', [reading('w', 23.5)]]]), new Set(), NOW);
    expect(rec.byUnit).toBe(true);
    expect(rec.best?.product.id).toBe('w');
    expect(rec.sizeUnknown?.map((o) => o.product.id)).toEqual(['c']);
    expect(bothPrices(rec.options.find((o) => o.product.id === 'c'))).toBe('$0.83 each · size unknown');
  });

  it('falls back to shelf prices when none of your picks has a size', () => {
    const a = product('a', 'coles', 'Sprite Cans', { size: '24 Pack' });
    const b = product('b', 'woolworths', 'Fanta Cans', { size: '24 Pack' });
    const rec = recommend(group(['a', 'b']), new Map([['a', a], ['b', b]]), new Map([['a', [reading('a', 20)]], ['b', [reading('b', 23)]]]), new Set(), NOW);
    expect(rec.byUnit).toBe(false);
    expect(rec.best?.product.id).toBe('a');
  });

  it('copies the size from the same barcode in the catalogue', () => {
    const withCode = { ...COLES, barcode: '9300675024235' };
    const known = product('k', 'woolworths', 'Sprite 375mL x 24', { barcode: '09300675024235' });
    const rec = recommend(group(['c']), new Map([['c', withCode]]), new Map([['c', [reading('c', 23.5)]]]), new Set(), NOW, undefined, [known]);
    const o = rec.options[0];
    expect(o.product.sizing?.size).toMatchObject({ qty: 9000, unit: 'ml', basis: 'barcode', count: 24 });
    expect(bothPrices(o)).toBe('$0.98 each · $2.61 / L (from barcode)');
  });

  it('keeps what the person confirmed, and calls it confirmed', () => {
    const mine = { ...COLES, qty: 9000, qtyUnit: 'ml' as const };
    const l = priceLine(mine, 23.5);
    expect(l.compare).toBe('$2.61 / L');
    expect(l.tag).toBe('confirmed');
    expect(l.text).toBe('$0.98 each · $2.61 / L (confirmed)');
  });
});

describe('the comparison price decides, never the price each', () => {
  it('picks the shop that is cheaper per litre even when its price each is higher', () => {
    const a = product('a', 'coles', 'Cola 4 x 250mL cans'); // $3.60: $0.90 each, $3.60 / L
    const b = product('b', 'woolworths', 'Cola 12 x 375mL cans'); // $12: $1.00 each, $2.67 / L
    const rec = recommend(group(['a', 'b']), new Map([['a', a], ['b', b]]), new Map([['a', [reading('a', 3.6)]], ['b', [reading('b', 12)]]]), new Set(), NOW);
    expect(rec.best?.product.id).toBe('b');
    expect(bothPrices(rec.best)).toBe('$1.00 each · $2.67 / L');
  });

  it('shows a counted thing by the item, and sheets by 100 sheets', () => {
    expect(priceLine(product('t', 'coles', 'Nappies 48 Pack'), 24).text).toBe('$0.50 each');
    const tp = product('t', 'coles', 'Toilet Tissue 12 Pack', { size: '2,400 sheets' });
    expect(priceLine(tp, 12).text).toBe('$1.00 each · $0.50 per 100 sheets');
  });

  it('uses per kg for big bags and per 100 g otherwise', () => {
    expect(priceLine(product('r', 'coles', 'Rice 10kg'), 25).compare).toBe('$2.50 / kg');
    expect(priceLine(product('r', 'coles', 'Rice 1kg'), 4).compare).toBe('$0.40 / 100g');
  });
});

describe('search results and specials say both prices too', () => {
  const sp = (extra: Partial<StoreProduct>): StoreProduct => ({ chain: 'coles', storeProductId: '1', name: 'x', isSpecial: false, memberOnly: false, ...extra });
  it('puts per item then the comparison price', () => {
    expect(unitTextOf(sp({ name: 'Pepsi Max 10x375ml', price: 9 }))).toBe('$0.90 each · $2.40 / L');
  });
  it('says size unknown for the Coles drink pack, with the per item price', () => {
    expect(unitTextOf(sp({ name: COLES.name, size: '24 Pack', price: 23.5, unitPriceText: '$0.98 / 1EA' }))).toBe('$0.98 each · size unknown');
    expect(storePriceLine(sp({ name: COLES.name, size: '24 Pack', price: 23.5 })).unknown).toBe(true);
  });
});

describe('Last updated', () => {
  it('says today, yesterday and a date, with the time', () => {
    expect(lastUpdatedText(new Date(NOW - 3 * 3600_000).toISOString(), 'auto', NOW)).toBe('Last updated today, 6:00 am');
    expect(lastUpdatedText(new Date(NOW - DAY).toISOString(), 'auto', NOW)).toBe('Last updated yesterday, 9:00 am');
    expect(lastUpdatedText('2026-11-03T14:05:00+11:00', 'auto', NOW)).toBe('Last updated Tue 3 Nov, 2:05 pm');
    expect(lastUpdatedText('2026-11-12T00:07:00+11:00', 'auto', NOW)).toBe('Last updated today, 12:07 am');
  });
  it('says Not checked yet when there is no price, and when typed by hand', () => {
    expect(lastUpdatedText(undefined)).toBe('Not checked yet');
    expect(lastUpdatedText(new Date(NOW - 3600_000).toISOString(), 'manual', NOW)).toContain('entered by hand');
  });
  it('takes the newest reading of the product shown', () => {
    expect(newestReading([reading('p', 1, 5), reading('p', 2, 1), reading('p', 3, 3)])?.price).toBe(2);
    expect(newestReading([])).toBeUndefined();
  });
});

describe('prices typed by hand', () => {
  it("aren't overwritten by a check the same day, and still count in the stats", () => {
    const hand = reading('p', 4.5, 0, { source: 'manual', date: new Date(NOW - 3 * 3600_000).toISOString() });
    const check = reading('p', 5, 0, { date: new Date(NOW - 3600_000).toISOString() });
    const kept = normaliseReadings([hand, check], NOW);
    expect(kept).toHaveLength(1);
    expect(kept[0].price).toBe(4.5);
    expect(computeStats([reading('p', 5, 8), hand, check], NOW).current?.price).toBe(4.5);
  });
  it('lose to a check on a later day, as any older price does', () => {
    const hand = reading('p', 4.5, 1, { source: 'manual' });
    const check = reading('p', 5, 0);
    expect(normaliseReadings([hand, check], NOW).map((r) => r.price)).toEqual([4.5, 5]);
  });
});
