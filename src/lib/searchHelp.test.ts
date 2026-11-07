import { describe, expect, it } from 'vitest';
import type { StoreProduct } from '../stores/types';
import { bestMatches, bestScore, matchesFor, normaliseQuery, sameness, UNLIKELY, unitOf, whichOne } from './searchHelp';

const sp = (o: Partial<StoreProduct>): StoreProduct => ({
  chain: 'coles',
  storeProductId: Math.random().toString(),
  name: '',
  isSpecial: false,
  memberOnly: false,
  ...o,
});

describe('normaliseQuery', () => {
  it('fixes typos and everyday names', () => {
    expect(normaliseQuery('Vegimite')).toBe('vegemite');
    expect(normaliseQuery('loo paper')).toBe('toilet paper');
    expect(normaliseQuery('snags')).toBe('sausages');
    expect(normaliseQuery('  choclate   biscuts ')).toBe('chocolate biscuits');
    expect(normaliseQuery('ketchup')).toBe('tomato sauce');
  });
  it('leaves normal searches alone', () => {
    expect(normaliseQuery('diced tomatoes')).toBe('diced tomatoes');
  });
});

describe('sameness', () => {
  it('matches house brands of the same thing', () => {
    const a = sp({ chain: 'coles', name: 'Coles Diced Tomatoes', size: '400g' });
    const b = sp({ chain: 'woolworths', name: 'Woolworths Diced Tomatoes', size: '400g' });
    expect(sameness(a, b)).toBeGreaterThanOrEqual(0.6);
  });
  it('needs the same size', () => {
    const a = sp({ chain: 'coles', name: 'Heinz Baked Beans', brand: 'Heinz', size: '420g' });
    const b = sp({ chain: 'woolworths', name: 'Heinz Baked Beans', brand: 'Heinz', size: '4 x 420g' });
    expect(sameness(a, b)).toBe(0);
  });
  it('trusts barcodes', () => {
    const a = sp({ chain: 'coles', name: 'x', barcode: '9300633' });
    const b = sp({ chain: 'aldi', name: 'y', barcode: '9300633' });
    expect(sameness(a, b)).toBe(1);
  });
  it('different brands are not the same', () => {
    const a = sp({ chain: 'coles', name: 'Heinz Baked Beans', brand: 'Heinz', size: '420g' });
    const b = sp({ chain: 'woolworths', name: 'SPC Baked Beans', brand: 'SPC', size: '420g' });
    expect(sameness(a, b)).toBeLessThan(0.6);
  });
  it('picks one match per store', () => {
    const p = sp({ chain: 'coles', name: 'Vegemite Spread', brand: 'Vegemite', size: '380g' });
    const out = matchesFor(p, [
      sp({ chain: 'woolworths', name: 'Vegemite Spread', brand: 'Vegemite', size: '380g' }),
      sp({ chain: 'woolworths', name: 'Vegemite Spread', brand: 'Vegemite', size: '220g' }),
      sp({ chain: 'aldi', name: 'Vegemite Yeast Spread', brand: 'Vegemite', size: '380g' }),
    ]);
    expect(out.map((o) => o.chain).sort()).toEqual(['aldi', 'woolworths']);
    expect(out.find((o) => o.chain === 'woolworths')?.size).toBe('380g');
  });
});

describe('unitOf', () => {
  it('works out a per-gram price', () => {
    expect(unitOf(sp({ price: 4, size: '400g' }))?.per).toBeCloseTo(0.01);
    expect(unitOf(sp({ price: 4 }))).toBeUndefined();
  });
});

describe('best match for a scan', () => {
  const sp = (chain: string, id: string, name: string, size: string, extra: Partial<StoreProduct> = {}): StoreProduct =>
    ({ chain, storeProductId: id, name, size, price: 3, ...extra }) as StoreProduct;
  const code = '9310692112198';
  const q = { text: 'Earth Choice Tough On Grease Green Tea & Lime Dishwashing Liquid 900mL', brand: 'Earth Choice', size: '900mL', barcode: code };
  const ww = [
    sp('woolworths', '1', 'Earth Choice Dishwashing Liquid 1L', '1L'),
    sp('woolworths', '2', 'Earth Choice Tough On Grease Green Tea & Lime Dishwashing Liquid 900mL', '900mL', {
      barcode: code,
      brand: 'Earth Choice',
    }),
  ];
  const coles = [
    sp('coles', 'a', 'Earth Choice Dishwashing Liquid', '1L', { brand: 'Earth Choice' }),
    sp('coles', 'b', 'Earth Choice Tough On Grease Green Tea & Lime Dishwashing Liquid Ultra Concentrate', '900mL', { brand: 'Earth Choice' }),
  ];
  const aldi = [sp('aldi', 'x', 'Shiraz 750ml', '750ml'), sp('aldi', 'y', 'Firm Tofu 450g', '450g')];

  it('ticks the barcode match, the same product elsewhere, and nothing at a shop without it', () => {
    const m = bestMatches(q, { woolworths: ww, coles, aldi });
    expect(m.get('woolworths')).toMatchObject({ sure: 'barcode', sp: { storeProductId: '2' } });
    expect(m.get('coles')).toMatchObject({ sure: 'same', sp: { storeProductId: 'b' } });
    expect(m.has('aldi')).toBe(false);
  });

  it('knows when a shop has nothing like it', () => {
    expect(bestScore(q, aldi)).toBeLessThan(UNLIKELY);
    expect(bestScore(q, coles)).toBeGreaterThan(UNLIKELY);
  });

  it('without a barcode match, only ticks a near-certain name and size match', () => {
    const noCode = { ...q, barcode: '0000' };
    const m = bestMatches(noCode, { woolworths: ww.map((p) => ({ ...p, barcode: undefined })), coles });
    expect(m.get('woolworths')?.sp.storeProductId).toBe('2');
    expect(m.get('woolworths')?.sure).toBe('name');
    // No size known: the clear front-runner by name and brand, marked as one to check.
    expect(bestMatches({ ...noCode, size: undefined }, { coles }).get('coles')).toMatchObject({ sure: 'closest', sp: { storeProductId: 'b' } });
    // A size that disagrees: nothing.
    expect(bestMatches({ ...noCode, size: '500mL' }, { coles }).size).toBe(0);
  });

  it('matches barcodes with or without leading zeros', () => {
    const m = bestMatches({ ...q, barcode: '0' + code }, { woolworths: ww });
    expect(m.get('woolworths')?.sure).toBe('barcode');
  });

  it('leaves a brand-only scan to the person, offering the brand’s products grouped across shops', () => {
    const brandScan = { text: 'Earth Choice', brand: 'Earth Choice', barcode: '0000' };
    const plain = ww.map((p) => ({ ...p, barcode: undefined, brand: 'Earth Choice' }));
    expect(bestMatches(brandScan, { woolworths: plain, coles, aldi }).size).toBe(0);
    const c = whichOne(brandScan, { woolworths: plain, coles, aldi });
    expect(c.map((x) => x.at.map((p) => p.chain).sort())).toEqual([
      ['coles', 'woolworths'],
      ['coles', 'woolworths'],
    ]);
    expect(c.flatMap((x) => x.at).some((p) => p.chain === 'aldi')).toBe(false);
  });
});

describe('sameness: flavours and short names', () => {
  it("doesn't call two flavours the same product", () => {
    const a = sp({ chain: 'woolworths', name: 'Up&Go Liquid Breakfast Vanilla Ice 250mL x 12 pack', brand: 'Up&Go', size: '3L' });
    const b = sp({ chain: 'coles', name: 'UP&GO Liquid Breakfast Choc Ice 12x250ml', brand: 'Up&Go', size: '3L' });
    expect(sameness(a, b)).toBeLessThan(0.6);
    const c = sp({ chain: 'coles', name: 'UP&GO Liquid Breakfast Vanilla Ice 12x250ml', brand: 'Up&Go', size: '3L' });
    expect(sameness(a, c)).toBeGreaterThanOrEqual(0.6);
  });
  it('matches a shorter name for the same branded product and size', () => {
    const aldi = sp({ chain: 'aldi', name: 'Nutella 400g', size: '400g' });
    const ww = sp({ chain: 'woolworths', name: 'Nutella Hazelnut Chocolate Spread 400g', brand: 'Nutella', size: '400g' });
    expect(sameness(aldi, ww)).toBeGreaterThanOrEqual(0.6);
    const croissants = sp({ chain: 'woolworths', name: 'Nutella Croissants 4 pack', brand: 'Nutella', size: '340g' });
    expect(sameness(aldi, croissants)).toBe(0);
  });
  it("doesn't stretch a supermarket's own brand that way", () => {
    const a = sp({ chain: 'coles', name: 'Coles Milk', brand: 'Coles', size: '2L' });
    const b = sp({ chain: 'woolworths', name: 'Woolworths Lactose Free Milk', brand: 'Woolworths', size: '2L' });
    expect(sameness(a, b)).toBeLessThan(0.6);
  });
});
