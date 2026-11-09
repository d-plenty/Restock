// 0.9.0: one-off buys with a price count in the shopping list's totals, so the totals card and
// "Start shopping · about $X" agree. Only a line with no price at all is "without a price".
import { describe, expect, it } from 'vitest';
import type { Group, ListEntry, PriceReading, Product } from '../types';
import { aroundPlan, recommendedStores, shopTotals } from './shopTotals';
import { lineCost, recommend } from './verdict';

const NOW = Date.parse('2026-11-05T09:00:00+10:00');
const prod = (id: string, chain: Product['chain']): Product => ({ id, chain, name: id, size: '1kg', createdAt: '' });
const reading = (productId: string, price: number): PriceReading => ({
  productId,
  date: new Date(NOW).toISOString(),
  price,
  isSpecial: false,
  memberOnly: false,
  source: 'auto',
});

describe('one-off buys with a price', () => {
  const products = new Map([
    ['rc', prod('rc', 'coles')],
    ['rw', prod('rw', 'woolworths')],
  ]);
  const readings = new Map([
    ['rc', [reading('rc', 5)]],
    ['rw', [reading('rw', 6)]],
  ]);
  const rice: Group = { id: 'rice', name: 'Rice', usualProductId: 'rc', sameProductIds: ['rw'], altProductIds: [], alertLevel: 'good', createdAt: '' };
  const recs = [recommend(rice, products, readings, new Set(), NOW)];
  const entries: ListEntry[] = [
    { id: '1', text: 'Rice', groupId: 'rice', checked: false, createdAt: '' },
    // Found at Woolworths with "Find cheapest": $3.50 each, two of them.
    { id: '2', text: 'Bananas', chain: 'woolworths', price: 3.5, qty: 2, checked: false, createdAt: '' },
    // A note with no price.
    { id: '3', text: 'Ask about the cake', checked: false, createdAt: '' },
    // Ticked: not counted.
    { id: '4', text: 'Ice', chain: 'coles', price: 4, checked: true, createdAt: '' },
  ];

  it('count in every total and in shopping around', () => {
    const t = shopTotals(entries, recs, ['woolworths', 'coles'], 'price');
    const by = Object.fromEntries(t.stores.map((s) => [s.chain, s]));
    expect(t.oneOffs).toEqual({ count: 1, total: 7 });
    expect(by.coles.total).toBeCloseTo(12);
    expect(by.woolworths.total).toBeCloseTo(13);
    expect(by.coles.oneOffs).toBe(7);
    expect(t.around.total).toBeCloseTo(12);
    // The shop it's from is a stop when shopping around.
    expect(t.around.chains.sort()).toEqual(['coles', 'woolworths']);
    // Only the note is without a price.
    expect(t.unpriced).toBe(1);
  });

  it('match the list’s own "about $X" (what Start shopping shows)', () => {
    const t = shopTotals(entries, recs, ['woolworths', 'coles'], 'price');
    // List.tsx priceOf: the pick's line cost for pantry items, price × qty for a one-off.
    const listTotal = entries
      .filter((e) => !e.checked)
      .reduce((s, e) => {
        const l = e.groupId ? t.pickFor.get(e.groupId) : undefined;
        if (l) return s + lineCost(l.pick, l.qty);
        return e.price !== undefined ? s + Math.round(e.price * (e.qty ?? 1) * 100) / 100 : s;
      }, 0);
    expect(t.around.total).toBeCloseTo(listTotal);
    expect(aroundPlan(t, 'price', 1).around).toBeCloseTo(listTotal);
    expect(aroundPlan(t, 'unit', 1).around).toBeCloseTo(listTotal);
  });

  it("don't tip which store is cheaper, or shop around against one store", () => {
    const without = shopTotals(entries.filter((e) => e.id !== '2'), recs, ['woolworths', 'coles'], 'price');
    const withIt = shopTotals(entries, recs, ['woolworths', 'coles'], 'price');
    expect(recommendedStores(withIt).recommended?.chain).toBe(recommendedStores(without).recommended?.chain);
    expect(recommendedStores(withIt).saving).toBeCloseTo(recommendedStores(without).saving!);
    expect(aroundPlan(withIt, 'price', 1).saving).toBeCloseTo(aroundPlan(without, 'price', 1).saving!);
  });

  it("aren't counted for a shop you're not going to today", () => {
    const t = shopTotals(entries, recs, ['coles'], 'price');
    expect(t.oneOffs.count).toBe(0);
    expect(t.around.total).toBeCloseTo(5);
    // It has a price, so it isn't called "without a price".
    expect(t.unpriced).toBe(1);
  });

  it('count for any shop when no shop was picked', () => {
    const t = shopTotals([...entries, { id: '5', text: 'Bread', price: 4, checked: false, createdAt: '' }], recs, ['coles'], 'price');
    expect(t.oneOffs).toEqual({ count: 1, total: 4 });
    expect(t.around.total).toBeCloseTo(9);
  });
});
