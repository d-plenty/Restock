import { describe, expect, it } from 'vitest';
import type { Group, PriceReading, Product } from '../types';
import { computeStats, judge, recommend, worthAlerting } from './verdict';

const NOW = Date.parse('2026-11-05T09:00:00+10:00');
const DAY = 86_400_000;

function r(daysAgo: number, price: number, extra: Partial<PriceReading> = {}): PriceReading {
  return {
    productId: 'p',
    date: new Date(NOW - daysAgo * DAY).toISOString(),
    price,
    isSpecial: false,
    memberOnly: false,
    source: 'demo',
    ...extra,
  };
}

/** Weekly readings: $9 normally, with sales at given weeks-ago. */
function history(weeks: number, sales: Record<number, number>, current: PriceReading): PriceReading[] {
  const out: PriceReading[] = [];
  for (let w = weeks; w >= 1; w--) {
    const sale = sales[w];
    out.push(r(w * 7, sale ?? 9, sale ? { isSpecial: true, wasPrice: 9 } : {}));
  }
  out.push(current);
  return out;
}

describe('judge', () => {
  it('no readings → nodata', () => {
    expect(judge(computeStats([], NOW)).kind).toBe('nodata');
  });

  it('half price and lowest ever → great', () => {
    const s = computeStats(history(26, { 20: 6.75, 13: 6.75 }, r(0, 4.5, { isSpecial: true, wasPrice: 9 })), NOW);
    expect(s.typical).toBe(9);
    expect(s.low).toBe(6.75);
    const v = judge(s);
    expect(v.kind).toBe('great');
    expect(v.saving).toBeCloseTo(4.5);
  });

  it('on sale but has been notably lower → wait', () => {
    const s = computeStats(history(26, { 20: 4.5, 12: 4.5 }, r(0, 6.75, { isSpecial: true, wasPrice: 9 })), NOW);
    const v = judge(s);
    expect(v.kind).toBe('wait');
    expect(v.detail).toContain('$4.50');
    // Sale runs started 20, 12 and 0 weeks ago → gaps of 8 and 12 weeks.
    expect(s.cycleWeeks).toBe(10);
  });

  it('special at the normal price → fake', () => {
    const s = computeStats(history(10, {}, r(0, 9, { isSpecial: true, wasPrice: 10 })), NOW);
    expect(judge(s).kind).toBe('fake');
  });

  it('even 5c off counts as a small saving', () => {
    const v = judge(computeStats(history(10, {}, r(0, 8.95, { isSpecial: true, wasPrice: 9 })), NOW));
    expect(v.kind).toBe('small');
    expect(v.saving).toBeCloseTo(0.05);
  });

  it('normal shelf price → normal', () => {
    expect(judge(computeStats(history(10, {}, r(0, 9)), NOW)).kind).toBe('normal');
  });

  it('little history → uses was-price', () => {
    const v = judge(computeStats([r(0, 5, { isSpecial: true, wasPrice: 10 })], NOW));
    expect(v.kind).toBe('great');
    expect(v.basis).toBe('was-price');
  });

  it('member price without the card is not counted', () => {
    const s = computeStats([r(0, 5, { isSpecial: true, memberOnly: true, wasPrice: 10 })], NOW);
    expect(judge(s, false).kind).toBe('normal');
    expect(judge(s, true).kind).toBe('great');
  });
});

describe('recommend', () => {
  const usual: Product = { id: 'aldi', chain: 'aldi', name: 'Aldi toilet paper', size: '24 pack', createdAt: '' };
  const alt: Product = { id: 'coles', chain: 'coles', name: 'Coles toilet paper', size: '24 pack', createdAt: '' };
  const group: Group = {
    id: 'g',
    name: 'Toilet paper',
    usualProductId: 'aldi',
    sameProductIds: [],
    altProductIds: ['coles'],
    alertLevel: 'good',
    createdAt: '',
  };
  const products = new Map([
    ['aldi', usual],
    ['coles', alt],
  ]);

  const at = (id: string, list: PriceReading[]) => list.map((x) => ({ ...x, productId: id }));

  it('shows an alternative that is on sale and cheaper when yours is not on sale', () => {
    const readings = new Map([
      ['aldi', at('aldi', [r(14, 5), r(7, 5), r(0, 5)])],
      ['coles', at('coles', [r(14, 6), r(7, 6), r(0, 3.5, { isSpecial: true, wasPrice: 6 })])],
    ]);
    const rec = recommend(group, products, readings, new Set(), NOW);
    expect(rec.action).toBe('alt');
    expect(rec.best?.product.id).toBe('aldi');
    expect(rec.alt?.product.id).toBe('coles');
    expect(rec.saving).toBeCloseTo(1.5);
  });

  it('ignores an alternative on sale that is still dearer than yours', () => {
    const readings = new Map([
      ['aldi', at('aldi', [r(0, 5)])],
      ['coles', at('coles', [r(0, 5.5, { isSpecial: true, wasPrice: 7 })])],
    ]);
    const rec = recommend(group, products, readings, new Set(), NOW);
    expect(rec.action).not.toBe('alt');
    expect(rec.alt).toBeUndefined();
  });

  it('puts your own product first when both are on sale', () => {
    const readings = new Map([
      ['aldi', at('aldi', [r(0, 3.5, { isSpecial: true, wasPrice: 5 })])],
      ['coles', at('coles', [r(0, 3, { isSpecial: true, wasPrice: 6 })])],
    ]);
    const rec = recommend(group, products, readings, new Set(), NOW);
    expect(rec.action).toBe('buy');
    expect(rec.best?.product.id).toBe('aldi');
    expect(rec.alt?.product.id).toBe('coles');
  });

  it('picks the cheapest store for your own product', () => {
    const woolies: Product = { id: 'ww', chain: 'woolworths', name: 'Toilet paper', size: '24 pack', createdAt: '' };
    const g2 = { ...group, sameProductIds: ['ww'], altProductIds: [] };
    const readings = new Map([
      ['aldi', at('aldi', [r(0, 5)])],
      ['ww', at('ww', [r(0, 4)])],
    ]);
    const rec = recommend(g2, new Map([...products, ['ww', woolies]]), readings, new Set(), NOW);
    expect(rec.best?.product.id).toBe('ww');
  });

  it('does not count a member-only alternative without the card', () => {
    const readings = new Map([
      ['aldi', at('aldi', [r(0, 5)])],
      ['coles', at('coles', [r(0, 3, { isSpecial: true, memberOnly: true, wasPrice: 6 })])],
    ]);
    expect(recommend(group, products, readings, new Set(), NOW).action).not.toBe('alt');
    expect(recommend(group, products, readings, new Set(['coles']), NOW).action).toBe('alt');
  });
});

describe('stock', () => {
  const a: Product = { id: 'a', chain: 'woolworths', name: 'Diced tomatoes', size: '400g', createdAt: '' };
  const b: Product = { id: 'b', chain: 'coles', name: 'Diced tomatoes', size: '400g', createdAt: '' };
  const c: Product = { id: 'c', chain: 'aldi', name: 'Aldi diced tomatoes', size: '400g', createdAt: '' };
  const g: Group = { id: 'g', name: 'Tomatoes', usualProductId: 'a', sameProductIds: ['b'], altProductIds: ['c'], alertLevel: 'any', createdAt: '' };
  const readings = new Map([
    ['a', [{ ...r(0, 1), productId: 'a' }]],
    ['b', [{ ...r(0, 1.2), productId: 'b' }]],
    ['c', [{ ...r(0, 0.9), productId: 'c' }]],
  ]);

  it('skips a store that is out of stock', () => {
    const rec = recommend(
      g,
      new Map([
        ['a', { ...a, inStock: false }],
        ['b', b],
        ['c', c],
      ]),
      readings,
      new Set(),
      NOW,
    );
    expect(rec.best?.product.id).toBe('b');
    expect(rec.outOfStock).toBeFalsy();
  });

  it('suggests an in-stock alternative when your product is out of stock everywhere', () => {
    const rec = recommend(
      g,
      new Map([
        ['a', { ...a, inStock: false }],
        ['b', { ...b, inStock: false }],
        ['c', c],
      ]),
      readings,
      new Set(),
      NOW,
    );
    expect(rec.outOfStock).toBe(true);
    expect(rec.stockAlt?.product.id).toBe('c');
    expect(rec.headline).toBe('Out of stock online');
  });
});

describe('sale levels and alerts', () => {
  const p: Product = { id: 'x', chain: 'coles', name: 'Thing', size: '1kg', createdAt: '' };
  const mk = (price: number, level: Group['alertLevel'], alertPct?: number) =>
    recommend(
      { id: 'g', name: 'Thing', usualProductId: 'x', sameProductIds: [], altProductIds: [], alertLevel: level, alertPct, createdAt: '' },
      new Map([['x', p]]),
      new Map([['x', [{ ...r(0, price, { isSpecial: true, wasPrice: 10 }), productId: 'x' }]]]),
      new Set(),
      NOW,
    );

  it('grades 10% / 20% / 35% off as small, good, great', () => {
    expect(mk(9, 'any').best?.verdict.kind).toBe('small');
    expect(mk(8, 'any').best?.verdict.kind).toBe('good');
    expect(mk(6.5, 'any').best?.verdict.kind).toBe('great');
    expect(mk(9, 'any').action).toBe('small');
    expect(mk(8, 'any').action).toBe('buy');
  });

  it('alerts according to the level picked', () => {
    expect(worthAlerting(mk(9, 'any'))).toBe(true);
    expect(worthAlerting(mk(9, 'good'))).toBe(false);
    expect(worthAlerting(mk(8, 'good'))).toBe(true);
    expect(worthAlerting(mk(8, 'great'))).toBe(false);
    expect(worthAlerting(mk(6.5, 'great'))).toBe(true);
    expect(worthAlerting(mk(6.5, 'never'))).toBe(false);
  });

  it('custom alerts fire at the chosen % off or more', () => {
    expect(worthAlerting(mk(6, 'custom', 40))).toBe(true);
    expect(worthAlerting(mk(6.5, 'custom', 40))).toBe(false);
    expect(worthAlerting(mk(9, 'custom', 10))).toBe(true);
  });
});

describe('shared price history', () => {
  const day = 86_400_000;
  const r = (daysAgo: number, price: number, isSpecial = false, wasPrice?: number): PriceReading => ({
    productId: 'p',
    date: new Date(NOW - daysAgo * day).toISOString(),
    price,
    wasPrice,
    isSpecial,
    memberOnly: false,
    source: 'auto',
  });
  const market = { normal: 10, sale: 6, saleShare: 0.2, low: 5, cycleWeeks: 6, days: 182, source: 'test', updatedAt: '' };

  it('judges a brand-new item against its usual price instead of the store was-price', async () => {
    const { withMarket } = await import('./verdict');
    // The store claims it was $14, but it's usually $10: 30% off "was" is really 20% off.
    const own = computeStats([r(0, 8, true, 14)], NOW);
    expect(judge(own).kind).toBe('great');
    const shared = withMarket(own, market);
    expect(shared.fromMarket).toBe(true);
    expect(shared.typical).toBe(10);
    // It's been $5, so the shared history says wait for a better sale.
    expect(judge(shared).kind).toBe('wait');
    expect(judge(withMarket(own, { ...market, low: 7.9 })).kind).toBe('good');
  });

  it('steps aside once the phone has its own few weeks of prices', async () => {
    const { withMarket } = await import('./verdict');
    const own = computeStats([r(40, 9), r(30, 9), r(20, 9), r(10, 9), r(0, 6, true, 9)], NOW);
    expect(withMarket(own, market)).toBe(own);
  });

  it('ignores thin shared history', async () => {
    const { withMarket } = await import('./verdict');
    const own = computeStats([r(0, 8, true, 14)], NOW);
    expect(withMarket(own, { ...market, days: 10 })).toBe(own);
  });

  it('flows through recommend from the product', () => {
    const product: Product = { id: 'p', chain: 'coles', name: 'Nutella 1kg', createdAt: '', market };
    const group: Group = { id: 'g', name: 'Nutella', usualProductId: 'p', sameProductIds: [], altProductIds: [], alertLevel: 'good', createdAt: '' };
    const rec = recommend(group, new Map([['p', product]]), new Map([['p', [r(0, 8, true, 14)]]]), new Set(), NOW);
    expect(rec.best?.stats.fromMarket).toBe(true);
    expect(rec.action).toBe('wait');
  });
});

describe('matching shared history to local prices', () => {
  const day = 86_400_000;
  const r = (price: number, isSpecial = false, wasPrice?: number): PriceReading => ({
    productId: 'p',
    date: new Date(NOW - 0 * day).toISOString(),
    price,
    wasPrice,
    isSpecial,
    memberOnly: false,
    source: 'auto',
  });
  const m = { normal: 10, sale: 6, saleShare: 0.2, low: 5, days: 182, latest: 10, source: 'test', updatedAt: '' };

  it('scales up when your store is dearer', async () => {
    const { marketScale, withMarket } = await import('./verdict');
    expect(marketScale(r(10.5), m)).toBeCloseTo(1.05);
    const s = withMarket(computeStats([r(10.5)], NOW), m);
    expect(s.typical).toBeCloseTo(10.5);
    expect(s.low).toBeCloseTo(5.25);
  });
  it('uses the was-price when yours is on special', async () => {
    const { marketScale } = await import('./verdict');
    expect(marketScale(r(7, true, 11), m)).toBeCloseTo(1.1);
  });
  it('leaves big gaps alone (probably not the same thing)', async () => {
    const { marketScale } = await import('./verdict');
    expect(marketScale(r(15), m)).toBe(1);
    expect(marketScale(r(7), m)).toBe(1);
  });
});

describe('multi-buys and half price', () => {
  const day = 86_400_000;
  const r = (daysAgo: number, price: number, isSpecial = false, promo?: string, wasPrice?: number): PriceReading => ({
    productId: 'p',
    date: new Date(NOW - daysAgo * day).toISOString(),
    price,
    wasPrice,
    isSpecial,
    memberOnly: false,
    promo,
    source: 'auto',
  });
  it('reads multi-buy promos', async () => {
    const { multiBuy } = await import('./verdict');
    expect(multiBuy('2 for $5')).toEqual({ n: 2, total: 5 });
    expect(multiBuy('Any 3 for $10.00')).toEqual({ n: 3, total: 10 });
    expect(multiBuy('Buy 2 for $7.50')).toEqual({ n: 2, total: 7.5 });
    expect(multiBuy('2 x 150g')).toBeUndefined();
    expect(multiBuy('Half price')).toBeUndefined();
  });
  it("a 2-for deal at the normal shelf price isn't a fake sale", () => {
    const hist = [r(60, 3), r(45, 3), r(30, 3), r(15, 3)];
    const v = judge(computeStats([...hist, r(0, 3, true, '2 for $5')], NOW));
    expect(v.kind).toBe('good');
    expect(v.detail).toMatch(/^2 for \$5\.00 \(\$2\.50 each\)/);
  });
  it('half price is never "wait", even if it was a little cheaper once', () => {
    const hist = [r(90, 3), r(80, 1.4, true), r(60, 3), r(45, 3), r(30, 3), r(15, 3)];
    expect(judge(computeStats([...hist, r(0, 1.5, true, undefined, 3)], NOW)).kind).toBe('great');
    // A smaller sale still says wait, and says when it was cheaper.
    const v = judge(computeStats([...hist, r(0, 2.5, true, undefined, 3)], NOW));
    expect(v.kind).toBe('wait');
    expect(v.detail).toMatch(/as low as \$1\.40 on /);
  });
  it('counts the multi-buy only for full sets', async () => {
    const { lineCost } = await import('./verdict');
    const o = { price: 2.5, shelfPrice: 3, multi: { n: 2, total: 5 } };
    expect(lineCost(o, 1)).toBe(3);
    expect(lineCost(o, 2)).toBe(5);
    expect(lineCost(o, 3)).toBe(8);
    expect(lineCost({ price: 4 }, 3)).toBe(12);
  });
});

describe('multi-buy setting', () => {
  it('counts a multi-buy only when the item allows it', async () => {
    const { effectivePrice, judge } = await import('./verdict');
    const r = {
      productId: 'v',
      date: new Date().toISOString(),
      price: 7.7,
      isSpecial: true,
      memberOnly: false,
      promo: '2 for $12',
      source: 'auto' as const,
    };
    expect(effectivePrice(r, true).price).toBeCloseTo(6, 2);
    expect(effectivePrice(r, true, false).price).toBeCloseTo(7.7, 2);
    const stats = { current: r, typical: 7.7, typicalFromHistory: true } as never;
    expect(['good', 'great', 'small']).toContain(judge(stats, true).kind);
    expect(judge(stats, true, false).kind).toBe('normal');
  });
});
