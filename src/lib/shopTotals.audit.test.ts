import { describe, expect, it } from 'vitest';
import type { Group, ListEntry, PriceReading, Product } from '../types';
import { recommendedStores, shopTotals } from './shopTotals';
import { recommend } from './verdict';

// From a real list checked by hand (0.8.9).
const NOW = Date.parse('2026-11-08T00:00:00Z');
const reading = (productId: string, price: number, promo?: string): PriceReading => ({
  productId,
  date: new Date(NOW).toISOString(),
  price,
  isSpecial: !!promo,
  memberOnly: false,
  source: 'auto',
  promo,
});
const group = (id: string, usual: string, same: string[] = [], alt: string[] = []): Group => ({
  id,
  name: id,
  usualProductId: usual,
  sameProductIds: same,
  altProductIds: alt,
  alertLevel: 'any',
  createdAt: '',
});
const entry = (groupId: string, qty = 1): ListEntry => ({ id: groupId, text: groupId, groupId, qty, checked: false, createdAt: '' });
const build = (products: Product[], groups: Group[], prices: [string, number, string?][]) => {
  const pm = new Map(products.map((p) => [p.id, p]));
  const readings = new Map(prices.map(([id, p, promo]) => [id, [reading(id, p, promo)]]));
  return groups.map((g) => recommend(g, pm, readings, new Set(), NOW));
};

describe('checked against a real list', () => {
  it('compares toilet paper in sheets with toilet paper in packs by the roll', () => {
    const products: Product[] = [
      { id: 'aldi', chain: 'aldi', name: 'Toilet Tissue 3 Ply 24 Pack', size: '4,320 sheets', createdAt: '' },
      { id: 'ww', chain: 'woolworths', name: 'Quilton White 3 Ply Toilet Paper 48 pack', size: '48 pack', createdAt: '' },
    ];
    const recs = build(products, [group('tp', 'aldi', ['ww'])], [
      ['aldi', 8.39],
      ['ww', 23],
    ]);
    const t = shopTotals([entry('tp')], recs, ['woolworths', 'aldi']);
    const ww = t.stores.find((s) => s.chain === 'woolworths')!;
    // 24 rolls' worth of a 48-pack at $23 is $11.50, not 4,320 ÷ 48 × $23 = $2,070.
    expect(ww.fair).toBeCloseTo(11.5);
  });

  it("doesn't count a multi-buy price when the list has only one", () => {
    const products: Product[] = [
      { id: 'coles', chain: 'coles', name: 'Ritz Original Crackers', size: '227g', createdAt: '' },
      { id: 'ww', chain: 'woolworths', name: 'Ritz Original Crackers 227g', size: '227g', createdAt: '' },
    ];
    const recs = build(products, [group('ritz', 'ww', ['coles'])], [
      ['coles', 3.5, '2 for $5.60'],
      ['ww', 3],
    ]);
    // One packet: $3.50 at Coles, $3 at Woolworths.
    expect(shopTotals([entry('ritz')], recs, ['woolworths', 'coles'], 'price').around.lines[0].pick.product.id).toBe('ww');
    // Two: $5.60 at Coles beats $6.
    expect(shopTotals([entry('ritz', 2)], recs, ['woolworths', 'coles'], 'price').around.lines[0].pick.product.id).toBe('coles');
  });

  it("doesn't recommend a store missing a third of the list as the one store", () => {
    const products: Product[] = [];
    const groups: Group[] = [];
    const prices: [string, number][] = [];
    for (let i = 0; i < 12; i++) {
      products.push({ id: `ww${i}`, chain: 'woolworths', name: `Item ${i}`, size: '500g', createdAt: '' });
      const ids: string[] = [];
      if (i < 8) {
        products.push({ id: `aldi${i}`, chain: 'aldi', name: `Item ${i}`, size: '500g', createdAt: '' });
        ids.push(`aldi${i}`);
        prices.push([`aldi${i}`, 1]);
      }
      prices.push([`ww${i}`, 4]);
      groups.push(group(`g${i}`, `ww${i}`, ids));
    }
    const recs = build(products, groups, prices);
    const t = shopTotals(
      groups.map((g) => entry(g.id)),
      recs,
      ['woolworths', 'aldi'],
      'price',
    );
    // Aldi plus Woolworths for the other 4 is far cheaper, but that's two shops, not one.
    expect(recommendedStores(t).recommended?.chain).toBe('woolworths');
  });
});
