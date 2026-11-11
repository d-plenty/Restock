// 0.9.6: one comparison unit on every line of one list or sheet (per kg when any pack is 5 kg or more; per 100 or
// each for all counted lines). Only the writing changes: the cheapest pick is the same.
import { describe, expect, it } from 'vitest';
import type { Group, PriceReading, Product } from '../types';
import { compareStyleOf, compareStyleOfProducts, compareText, priceLine } from './unitPrice';
import { formatUnitPrice } from './units';
import { optionStyle, recommend } from './verdict';

const NOW = Date.parse('2026-11-12T09:00:00+10:00');
const product = (id: string, chain: Product['chain'], name: string, size?: string): Product => ({ id, chain, name, size, createdAt: '' });
const reading = (productId: string, price: number): PriceReading => ({ productId, date: new Date(NOW).toISOString(), price, isSpecial: false, memberOnly: false, source: 'auto' });
const group = (ids: string[]): Group => ({ id: 'g', name: 'Rice', usualProductId: ids[0], sameProductIds: ids.slice(1), altProductIds: [], alertLevel: 'any', createdAt: '' });

describe('comparison unit for one list (0.9.6)', () => {
  it('on its own a 4 kg pack is per 100 g and a 5 kg pack per kg (as before)', () => {
    expect(compareText(0.0045, 'g', { total: 4000 })).toBe('$0.45 / 100g');
    expect(compareText(0.0042, 'g', { total: 5000 })).toBe('$4.20 / kg');
  });
  it('a style makes every row the same', () => {
    expect(compareText(0.0045, 'g', { total: 4000, style: { kg: true } })).toBe('$4.50 / kg');
    expect(compareText(0.0042, 'g', { total: 5000, style: { kg: false } })).toBe('$0.42 / 100g');
    expect(compareText(0.05, 'ea', { style: { per100: false } })).toBe('$0.05 each');
    expect(compareText(0.5, 'ea', { style: { per100: true } })).toBe('$50.00 per 100');
    expect(formatUnitPrice(0.0045, 'g', { kg: true })).toBe('$4.50 / kg');
    expect(formatUnitPrice(0.5, 'ea', { per100: true })).toBe('$50.00 per 100');
    expect(formatUnitPrice(0.0045, 'g')).toBe('$0.45 / 100g');
  });
  it('per kg when any row is 5 kg or more, else per 100 g', () => {
    expect(compareStyleOf([{ unit: 'g', perBase: 0.0045, total: 4000 }, { unit: 'g', perBase: 0.0042, total: 5000 }]).kg).toBe(true);
    expect(compareStyleOf([{ unit: 'g', perBase: 0.0045, total: 4000 }, { unit: 'g', perBase: 0.005, total: 1000 }]).kg).toBe(false);
  });
  it('counted rows use the unit that fits most', () => {
    const r = (p: number) => ({ unit: 'ea' as const, perBase: p, total: 1 });
    expect(compareStyleOf([r(0.05), r(0.08), r(0.2)]).per100).toBe(true);
    expect(compareStyleOf([r(0.05), r(0.2), r(0.3)]).per100).toBe(false);
    expect(compareStyleOf([r(0.05)]).per100).toBeUndefined();
  });
  it('an item with a 4 kg and a 5 kg bag shows both per kg, and the cheapest is unchanged', () => {
    const a = product('a', 'coles', 'Rice 4kg', '4kg');
    const b = product('b', 'woolworths', 'Rice 5kg', '5kg');
    const rec = recommend(group(['a', 'b']), new Map([['a', a], ['b', b]]), new Map([['a', [reading('a', 18)]], ['b', [reading('b', 21)]]]), new Set(), NOW);
    const style = optionStyle(rec.options);
    expect(style.kg).toBe(true);
    const lines = rec.options.map((o) => priceLine(o.product, o.price, style).compare);
    expect(lines).toEqual(['$4.50 / kg', '$4.20 / kg']);
    expect(rec.best?.product.id).toBe('b');
    expect(rec.options.map((o) => priceLine(o.product, o.price).compare)).toEqual(['$0.45 / 100g', '$4.20 / kg']);
  });
  it('compareStyleOfProducts ignores a line with no size', () => {
    const a = product('a', 'coles', 'Sprite 24 Pack', '24 Pack');
    expect(compareStyleOfProducts([{ product: a, price: 14 }])).toEqual({});
  });
});
