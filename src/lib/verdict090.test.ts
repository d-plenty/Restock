// 0.9.0 audit fixes to the verdicts: last week's specials, old prices, member prices without the
// card, was-price wording, switched-off shops and multi-buy reading. Pinned to Sydney time, so the
// specials week (Wednesday to Tuesday) starts at the same moment whichever machine runs it.
declare const process: { env: Record<string, string | undefined> };
process.env.TZ = 'Australia/Sydney';

import { describe, expect, it } from 'vitest';
import type { Group, PriceReading, Product } from '../types';
import { computeStats, effectivePrice, judge, multiBuy, recommend, specialsWeekStart, STALE_DAYS } from './verdict';
import { buildCatalogue, specialsWeek } from './myCatalogue';

// Thursday 5 November 2026, 9 am in Sydney. The specials week started Wednesday 4 November.
const NOW = Date.parse('2026-11-05T09:00:00+11:00');
const DAY = 86_400_000;
const r = (daysAgo: number, price: number, extra: Partial<PriceReading> = {}): PriceReading => ({
  productId: 'p',
  date: new Date(NOW - daysAgo * DAY).toISOString(),
  price,
  isSpecial: false,
  memberOnly: false,
  source: 'auto',
  ...extra,
});
/** Weekly $10 prices for `weeks` weeks, then `current`. */
const weekly = (weeks: number, current: PriceReading, price = 10) => [...Array.from({ length: weeks }, (_, i) => r((weeks - i) * 7, price)), current];

describe('the specials week', () => {
  it('runs in Sydney time', () => {
    expect(new Date(NOW).getHours()).toBe(9);
  });

  it('starts at midnight on the Wednesday', () => {
    expect(new Date(specialsWeekStart(NOW)).toString()).toContain('Wed Nov 04 2026 00:00:00');
    // On a Wednesday it's that day; on a Tuesday, the Wednesday before.
    expect(new Date(specialsWeekStart(Date.parse('2026-11-11T00:30:00+11:00'))).getDate()).toBe(11);
    expect(new Date(specialsWeekStart(Date.parse('2026-11-10T23:30:00+11:00'))).getDate()).toBe(4);
    // My catalogue's week is the same week.
    expect(specialsWeek(new Date(NOW)).from.getTime()).toBe(specialsWeekStart(NOW));
  });
});

describe('last week’s specials and old prices', () => {
  it("doesn't call a special from before Wednesday on sale now", () => {
    // Half price last Tuesday afternoon, not checked since.
    const v = judge(computeStats(weekly(8, r(1.8, 5, { isSpecial: true, wasPrice: 10 })), NOW));
    expect(v.kind).toBe('normal');
    expect(v.stale).toBe('ended');
    expect(v.headline).toBe('Sale may have ended');
    expect(v.detail).toContain('$5.00');
  });

  it("still calls this week's special a deal", () => {
    // Wednesday morning, this week.
    const v = judge(computeStats(weekly(8, r(0.9, 5, { isSpecial: true, wasPrice: 10 })), NOW));
    expect(v.kind).toBe('great');
    expect(v.stale).toBeUndefined();
  });

  it("doesn't count last week's multi-buy, and prices it for one", () => {
    const products = new Map<string, Product>([['p', { id: 'p', chain: 'coles', name: 'Biscuits', size: '200g', createdAt: '' }]]);
    const g: Group = { id: 'g', name: 'Biscuits', usualProductId: 'p', sameProductIds: [], altProductIds: [], alertLevel: 'any', createdAt: '' };
    const rec = recommend(g, products, new Map([['p', weekly(6, r(3, 4, { promo: '2 for $6' }), 4)]]), new Set(), NOW);
    expect(rec.best?.verdict.stale).toBe('ended');
    expect(rec.best?.multi).toBeUndefined();
    expect(rec.best?.price).toBe(4);
    expect(['buy', 'small', 'alt']).not.toContain(rec.action);
    // Not in this week's catalogue either.
    expect(buildCatalogue([rec], ['coles'], new Date(NOW)).deals).toBe(0);
  });

  it(`doesn't call a price drop from over ${STALE_DAYS} days ago a deal, but keeps the price`, () => {
    const stats = computeStats([...Array.from({ length: 8 }, (_, i) => r(80 - i * 7, 10)), r(20, 7)], NOW);
    const v = judge(stats);
    expect(v.kind).toBe('normal');
    expect(v.stale).toBe('old');
    expect(v.headline).toBe('Price may be out of date');
    // The item page can still show the last price, with its date.
    expect(stats.current?.price).toBe(7);
    expect(v.detail).toContain('$7.00');
  });

  it('a rarely checked shop still has its last price and "cheapest at"', () => {
    const products = new Map<string, Product>([['p', { id: 'p', chain: 'aldi', name: 'Oats', size: '1kg', createdAt: '' }]]);
    const g: Group = { id: 'g', name: 'Oats', usualProductId: 'p', sameProductIds: [], altProductIds: [], alertLevel: 'any', createdAt: '' };
    const rec = recommend(g, products, new Map([['p', [r(60, 3), r(30, 3)]]]), new Set(), NOW);
    expect(rec.best?.price).toBe(3);
    expect(rec.headline).toBe('Cheapest at Aldi');
  });
});

describe('member prices without the card', () => {
  it("aren't the lowest price to wait for", () => {
    const rs = weekly(10, r(0, 8, { isSpecial: true, wasPrice: 10 }));
    // A $6 Flybuys price five weeks ago.
    rs.splice(5, 1, r(35, 6, { isSpecial: true, memberOnly: true, wasPrice: 10 }));
    const noCard = judge(computeStats(rs, NOW, false), false);
    expect(noCard.kind).toBe('good');
    expect(noCard.detail).not.toContain('$6.00');
    // With the card it was a price you could have paid, so it's worth waiting for.
    expect(judge(computeStats(rs, NOW, true), true).kind).toBe('wait');
  });

  it("aren't the normal price, even typed in by hand without a was-price", () => {
    // A $3 member price typed in (not ticked as a special), among $5 shelf prices.
    const rs = [r(21, 5), r(14, 5), r(7, 5), r(1, 3, { memberOnly: true, source: 'manual' })];
    const noCard = computeStats(rs, NOW, false);
    expect(noCard.typical).toBe(5);
    expect(noCard.low).toBe(5);
    // What a shopper without the card pays: its normal price, not the member price.
    const eff = effectivePrice(noCard.current!, false, true, noCard.typical);
    expect(eff).toMatchObject({ price: 5, locked: true });
  });

  it('use the "was" price for the price you pay, when there is one', () => {
    expect(effectivePrice(r(0, 3, { memberOnly: true, isSpecial: true, wasPrice: 4.5 }), false, true, 5).price).toBe(4.5);
  });

  it('still count, as before, with the card', () => {
    const s = computeStats([r(0, 5, { isSpecial: true, memberOnly: true, wasPrice: 10 })], NOW, true);
    expect(judge(s, true).kind).toBe('great');
  });
});

describe('what the saving is measured against', () => {
  it('says "was-price" only for the store’s was-price', () => {
    const v = judge(computeStats([r(0, 5, { isSpecial: true, wasPrice: 10 })], NOW));
    expect(v.basis).toBe('was-price');
    expect(v.detail).toBe("50% off the store's was-price of $10.00.");
  });

  it('says "its usual" for prices Restock has seen, before there is much history', () => {
    const v = judge(computeStats([r(3, 5), r(0, 4, { isSpecial: true, wasPrice: 6 })], NOW));
    expect(v.basis).toBe('history');
    expect(v.detail).toBe('20% off its usual $5.00.');
    expect(v.detail).not.toContain('was-price');
  });

  it('says "its normal" with enough history', () => {
    const v = judge(computeStats(weekly(6, r(0, 7, { isSpecial: true, wasPrice: 10 })), NOW));
    expect(v.detail).toBe('30% off its normal $10.00.');
  });
});

describe('switched-off shops', () => {
  const products = new Map<string, Product>([
    ['ww', { id: 'ww', chain: 'woolworths', name: 'Rice 1kg', size: '1kg', createdAt: '' }],
    ['aldi', { id: 'aldi', chain: 'aldi', name: 'Rice 1kg', size: '1kg', createdAt: '' }],
    ['mine', { id: 'mine', chain: 'other', name: 'Rice 1kg', size: '1kg', createdAt: '' }],
  ]);
  const g: Group = { id: 'g', name: 'Rice', usualProductId: 'ww', sameProductIds: ['aldi', 'mine'], altProductIds: [], alertLevel: 'any', createdAt: '' };
  const readings = new Map([
    ['ww', weekly(6, r(0, 4)).map((x) => ({ ...x, productId: 'ww', price: x.price === 10 ? 4 : x.price }))],
    ['aldi', weekly(6, r(0, 1.5, { isSpecial: true, wasPrice: 3 }), 3).map((x) => ({ ...x, productId: 'aldi' }))],
    ['mine', [r(0, 4.2)].map((x) => ({ ...x, productId: 'mine' }))],
  ]);

  it('give no deal, verdict or "cheapest at"', () => {
    const all = recommend(g, products, readings, new Set(), NOW);
    expect(all.action).toBe('buy');
    expect(all.best?.product.chain).toBe('aldi');
    const off = recommend(g, products, readings, new Set(), NOW, new Set(['woolworths']));
    expect(off.options.map((o) => o.product.id)).toEqual(['ww', 'mine']);
    expect(off.best?.product.chain).toBe('woolworths');
    expect(off.action).toBe('none');
  });

  it('never leave out hand-typed prices', () => {
    const rec = recommend(g, products, readings, new Set(), NOW, new Set());
    expect(rec.options.map((o) => o.product.id)).toEqual(['mine']);
  });
});

describe('multi-buys', () => {
  it('read the number before "for" whole', () => {
    expect(multiBuy('112 for $5')).toBeUndefined();
    expect(multiBuy('2 for $5')).toEqual({ n: 2, total: 5 });
    expect(multiBuy('Any 3 for $10')).toEqual({ n: 3, total: 10 });
    expect(multiBuy('Buy 2 for $10.5')).toEqual({ n: 2, total: 10.5 });
    expect(multiBuy('12 for $5')).toEqual({ n: 12, total: 5 });
  });
});
