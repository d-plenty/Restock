import { describe, expect, it } from 'vitest';
import type { Group, ListEntry, PriceReading, Product } from '../types';
import { buildCatalogue, specialsWeek } from './myCatalogue';
import { aroundPlan, shopTotals } from './shopTotals';
import { formatUnitPrice, money } from './units';
import { recommend } from './verdict';

// 0.9.0: shop around or one store, My catalogue, and the number formats.
const NOW = Date.parse('2026-11-09T00:00:00Z');
const reading = (productId: string, price: number, was?: number, promo?: string): PriceReading => ({
  productId,
  date: new Date(NOW).toISOString(),
  price,
  wasPrice: was,
  isSpecial: !!was || !!promo,
  memberOnly: false,
  source: 'auto',
  promo,
});
const p = (id: string, chain: Product['chain'], size = '400g', name = id): Product => ({ id, chain, name, size, createdAt: '' });
const g = (id: string, ids: string[]): Group => ({
  id,
  name: id,
  usualProductId: ids[0],
  sameProductIds: ids.slice(1),
  altProductIds: [],
  alertLevel: 'any',
  createdAt: '',
});
const build = (products: Product[], groups: Group[], prices: PriceReading[][]) => {
  const pm = new Map(products.map((x) => [x.id, x]));
  const rm = new Map<string, PriceReading[]>();
  for (const rs of prices) for (const r of rs) rm.set(r.productId, [...(rm.get(r.productId) ?? []), r]);
  return groups.map((x) => recommend(x, pm, rm, new Set(), NOW));
};
const entries = (ids: string[]): ListEntry[] => ids.map((id) => ({ id, text: id, groupId: id, checked: false, createdAt: '' }));

describe('shop around or one store', () => {
  // Woolworths has both; Aldi has beans for less.
  const products = [p('ww-beans', 'woolworths'), p('al-beans', 'aldi'), p('ww-milk', 'woolworths', '2L'), p('ww-x', 'woolworths')];
  const recs = (aldi: number) =>
    build(
      products,
      [g('beans', ['ww-beans', 'al-beans']), g('milk', ['ww-milk'])],
      [[reading('ww-beans', 2)], [reading('al-beans', aldi)], [reading('ww-milk', 3)]],
    );
  it('recommends shopping around when it saves at least the minimum', () => {
    const t = shopTotals(entries(['beans', 'milk']), recs(0.85), ['woolworths', 'aldi'], 'price');
    const plan = aroundPlan(t, 'price', 1);
    expect(plan.pick).toBe('around');
    expect(plan.saving).toBeCloseTo(1.15);
    expect(plan.stops.map((s) => s.chain).sort()).toEqual(['aldi', 'woolworths']);
  });
  it('recommends the store with everything when shopping around saves less than that', () => {
    const t = shopTotals(entries(['beans', 'milk']), recs(1.5), ['woolworths', 'aldi'], 'price');
    const plan = aroundPlan(t, 'price', 1);
    expect(plan.pick).not.toBe('around');
    expect(plan.pick !== 'around' && plan.pick.chain).toBe('woolworths');
    // With "any saving", 50c is enough.
    expect(aroundPlan(t, 'price', 0).pick).toBe('around');
  });
  it('compares on the same measure as the list', () => {
    const t = shopTotals(entries(['beans', 'milk']), recs(0.85), ['woolworths', 'aldi'], 'unit');
    const plan = aroundPlan(t, 'unit', 1);
    expect(plan.around).toBeCloseTo(t.around.lines.reduce((s, l) => s + l.fair, 0));
    expect(plan.aroundOther).toBeCloseTo(t.around.total);
  });
});

describe('My catalogue', () => {
  const products = [
    p('co-beans', 'coles', '420g', 'Heinz Baked Beans'),
    p('ww-beans', 'woolworths', '420g'),
    p('al-beans', 'aldi', '420g'),
    p('co-ritz', 'coles', '227g', 'Ritz'),
    // Aldi is cheapest for these, so its page has enough on it.
    p('al-oil', 'aldi', '1L'),
    p('ww-oil', 'woolworths', '1L'),
    p('al-rice', 'aldi', '1kg'),
    p('co-rice', 'coles', '1kg'),
  ];
  const recs = build(
    products,
    [
      g('beans', ['co-beans', 'ww-beans', 'al-beans']),
      g('ritz', ['co-ritz']),
      g('oil', ['al-oil', 'ww-oil']),
      g('rice', ['al-rice', 'co-rice']),
    ],
    [
      [reading('co-beans', 2.1, 3.5)],
      [reading('ww-beans', 3.5)],
      [reading('al-beans', 1.99)],
      [reading('co-ritz', 3.5, undefined, '2 for $5.60')],
      [reading('al-oil', 8.79)],
      [reading('ww-oil', 9.5)],
      [reading('al-rice', 2.5)],
      [reading('co-rice', 3)],
    ],
  );
  const c = buildCatalogue(recs, ['coles', 'woolworths', 'aldi'], new Date(NOW));
  it('puts each shop’s sales on its page with a badge', () => {
    const coles = c.pages.find((x) => x.chain === 'coles')!;
    expect(coles.kind).toBe('sales');
    const beans = coles.deals.find((d) => d.rec.group.id === 'beans')!;
    expect(beans.badge).toBe('40% OFF');
    expect(beans.note).toBe('Save $1.40');
    const ritz = coles.deals.find((d) => d.rec.group.id === 'ritz');
    expect(ritz?.badge).toBe('2 FOR $5.60');
  });
  it('gives a shop with no sales a page of what it’s cheapest for', () => {
    const aldi = c.pages.find((x) => x.chain === 'aldi')!;
    expect(aldi.kind).toBe('cheapest');
    expect(aldi.deals[0].badge).toBe('CHEAPEST');
    // Coles' beans are on sale at $2.10, so that's the one Aldi beats.
    expect(aldi.deals.find((d) => d.rec.group.id === 'beans')?.note).toBe('$0.11 less than Coles');
    expect(aldi.deals.map((d) => d.rec.group.id).sort()).toEqual(['beans', 'oil', 'rice']);
    expect(c.pages.find((x) => x.chain === 'woolworths')).toBeUndefined();
  });
  it('runs Wednesday to Tuesday', () => {
    const w = specialsWeek(new Date(2026, 10, 9));
    expect([w.from.getDay(), w.from.getDate(), w.to.getDate()]).toEqual([3, 4, 10]);
  });
});

describe('numbers', () => {
  it('puts commas in big amounts', () => {
    expect(money(2387.81)).toBe('$2,387.81');
    expect(money(1234567.5)).toBe('$1,234,567.50');
    expect(money(-3)).toBe('-$3.00');
    expect(money(0.5)).toBe('$0.50');
  });
  it('gives liquids per litre, however cheap', () => {
    expect(formatUnitPrice(0.00045, 'ml')).toBe('$0.45 / L');
    expect(formatUnitPrice(0.0016, 'ml')).toBe('$1.60 / L');
  });
});

describe('shared prices', () => {
  it('holds products and prices only, without sample items', async () => {
    const { sharedPrices } = await import('./sharedPrices');
    const out = sharedPrices({
      products: [
        { id: 'a', chain: 'coles', name: 'Heinz Baked Beans', size: '420g', barcode: '9300', storeProductId: '123', createdAt: '', inStock: true },
        { id: 'demo-x', chain: 'coles', name: 'Sample', createdAt: '' },
      ],
      prices: [
        { productId: 'a', date: '2026-11-08T09:15:00Z', price: 2.1, wasPrice: 3.5, isSpecial: true, memberOnly: false, source: 'auto' },
        { productId: 'demo-x', date: '2026-11-08T09:15:00Z', price: 1, isSpecial: false, memberOnly: false, source: 'demo' },
      ],
    });
    expect(out.products).toEqual([
      {
        n: 1,
        chain: 'coles',
        name: 'Heinz Baked Beans',
        size: '420g',
        barcode: '9300',
        shopId: '123',
        prices: [{ day: '2026-11-08', price: 2.1, was: 3.5, special: true, member: false }],
      },
    ]);
  });
});

describe('names', () => {
  it('doesn’t add a size to a multipack name that already says it', async () => {
    const { nameHasSize } = await import('./naming');
    expect(nameHasSize('V Energy Drink Original 4×250ml', '1L')).toBe(true);
    expect(nameHasSize('Sprite 10 x 375ml', '3.75L')).toBe(true);
    expect(nameHasSize('Sprite Lemonade Cans 375mL x 24 pack', '9L')).toBe(true);
    expect(nameHasSize('Heinz Baked Beans', '420g')).toBe(false);
  });
});
