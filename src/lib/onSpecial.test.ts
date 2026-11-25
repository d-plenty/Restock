// 0.11.2: sizes aren't flavours; picks measured differently are said to be; Aldi's 121 g for a 120 g can.
import { describe, expect, it } from 'vitest';
import type { Group, PriceReading, Product } from '../types';
import { flavourNote, flavourWord, sizesOnly } from './flavours';
import { priceLine, readSize, sizeLabel } from './unitPrice';
import { recommend, unitWord } from './verdict';

describe('which are on special (0.11.2)', () => {
  it('sizes of one thing are sizes, never a pack size used as a name', () => {
    const beans = ['Heinz Baked Beans 420g x 3 pack', 'Heinz Baked Beans 420g'];
    expect(sizesOnly(beans)).toBe(true);
    expect(flavourWord(beans)).toBe('sizes');
    expect(flavourNote(beans, [true, false])).toBe('on special in 1 of your 2 sizes');
    expect(flavourNote(beans, [true, true])).toBe('on special in all 2 sizes');
    expect(flavourNote(['Vegemite Spread', 'Vegemite Spread'], [true, false])).toBe('on special in 1 of your 2 sizes');
    expect(flavourNote(['Heinz Baked Beans Tomato Sauce', 'Heinz Baked Beans Tomato Sauce 3x420g'], [false, true])).toBe('on special in 1 of your 2 sizes');
  });
  it('a number is not a name either', () => {
    expect(flavourNote(['Bref Toilet Cleaner Rim Block Self 1', 'Bref Toilet Cleaner Rim Block Self 3', 'Bref Toilet Cleaner Rim Block Blue 2'], [true, false, false])).toBe('on special in 1 of your 3 scents');
  });
  it('real flavours still read by name', () => {
    const chips = ['Doritos Corn Chips Cheese Supreme 170g', 'Doritos Corn Chips Nacho Cheese 170g', 'Doritos Corn Chips Original 170g'];
    expect(sizesOnly(chips)).toBe(false);
    expect(flavourNote(chips, [false, true, true])).toBe('Nacho Cheese and Original on special, not Cheese Supreme');
    expect(flavourWord(['Kleenex Tissues White', 'Kleenex Tissues Pink'])).toBe('colours');
  });
});

describe("the size in the name wins when the shop's size is a hair off (0.11.2)", () => {
  it('Aldi: 121 g for "Deodorant 120g" is 120 g', () => {
    expect(readSize({ name: 'Nivea Anti-Perspirant Deodorant 120g', size: '0.121 kg' }).size).toMatchObject({ qty: 120, unit: 'g' });
    expect(readSize({ name: 'Nivea Anti-Perspirant Deodorant 120g', size: '121 g' }).size).toMatchObject({ qty: 120, unit: 'g' });
  });
  it('and the label and the comparison price say 120 g too', () => {
    const p = { name: 'Nivea Anti-Perspirant Deodorant 120g', size: '0.121 kg' };
    expect(sizeLabel(p)).toBe('120 g');
    expect(priceLine(p, 4.19).compare).toBe('$3.49 / 100g');
    expect(sizeLabel({ name: 'Nutella 400g', size: '400g' })).toBe('400g');
  });
  it('a real difference is left alone, and so are packs', () => {
    expect(readSize({ name: 'Rice 1kg', size: '2kg' }).size).toMatchObject({ qty: 2000, unit: 'g' });
    expect(readSize({ name: 'Cola 375ml', size: '10 x 375mL' }).size).toMatchObject({ qty: 3750, unit: 'ml' });
    expect(readSize({ name: 'Nutella 400g', size: '400g' }).size).toMatchObject({ qty: 400, unit: 'g' });
  });
});

describe('picks measured differently (0.11.2)', () => {
  const NOW = Date.parse('2026-11-15T09:00:00+10:00');
  const product = (id: string, chain: Product['chain'], name: string, size?: string, more: Partial<Product> = {}): Product => ({ id, chain, name, size, createdAt: '', ...more });
  const reading = (productId: string, price: number): PriceReading => ({ productId, date: new Date(NOW).toISOString(), price, isSpecial: false, memberOnly: false, source: 'auto' });
  const group = (ids: string[]): Group => ({ id: 'g', name: 'Deodorant', usualProductId: ids[0], sameProductIds: ids.slice(1), altProductIds: [], alertLevel: 'any', createdAt: '' });
  const run = (ps: Product[], prices: number[]) =>
    recommend(group(ps.map((p) => p.id)), new Map(ps.map((p) => [p.id, p])), new Map(ps.map((p, i) => [p.id, [reading(p.id, prices[i])]])), new Set(), NOW);

  it('mL and g: the shelf price decides, and it says so, naming the odd one out', () => {
    const w = product('w', 'woolworths', 'Nivea Black & White Invisible Clear Aerosol Deodorant 250mL', '250mL');
    const c = product('c', 'coles', 'Nivea Deo Aero Female Invisible Black And White Clear', '250mL');
    const a = product('a', 'aldi', 'Nivea Anti-Perspirant Deodorant 120g', '120g');
    const rec = run([w, c, a], [10.5, 5.25, 4.19]);
    expect(rec.byUnit).toBe(false);
    expect(rec.best?.product.id).toBe('a');
    expect(rec.mixedUnits?.units).toEqual(['ml', 'g']);
    expect(rec.mixedUnits?.odd.map((o) => o.product.id)).toEqual(['a']);
    expect(unitWord('ml')).toBe('in millilitres');
  });
  it("typing the can's 200 mL makes it a fair comparison per litre", () => {
    const w = product('w', 'woolworths', 'Nivea Black & White Invisible Clear Aerosol Deodorant 250mL', '250mL');
    const c = product('c', 'coles', 'Nivea Deo Aero Female Invisible Black And White Clear', '250mL');
    const a = product('a', 'aldi', 'Nivea Anti-Perspirant Deodorant 120g', '120g', { qty: 200, qtyUnit: 'ml' });
    const rec = run([w, c, a], [10.5, 5.25, 4.19]);
    expect(rec.mixedUnits).toBeUndefined();
    expect(rec.byUnit).toBe(true);
    expect(rec.best?.product.id).toBe('a'); // $20.95 a litre against $21.00
  });
  it('all in one measure: nothing to say', () => {
    const a = product('a', 'coles', 'Rice 1kg', '1kg');
    const b = product('b', 'aldi', 'Rice 2kg', '2kg');
    expect(run([a, b], [3, 5]).mixedUnits).toBeUndefined();
  });
});
