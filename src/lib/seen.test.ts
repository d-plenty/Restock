import initSqlJs from 'sql.js';
import { beforeEach, describe, expect, it } from 'vitest';
import type { StoreProduct } from '../stores/types';

// 0.11.0: what searches found is remembered on the phone (history only), kept as long as the price
// history or for its own time, and never re-checked or shown as today's price.

const { initDb, queryRows } = await import('./db');
const { createSqlJsDriver } = await import('./sql/sqljs');
const { noteSeen, seenBefore, seenSpecials, pruneSeen, seenCount, seenKeepWeeks, seenShape } = await import('./seen');

const p = (over: Partial<StoreProduct> = {}): StoreProduct =>
  ({ chain: 'coles', storeProductId: '123', name: 'Wheat biscuits 1.2kg', brand: 'Sanitarium', size: '1.2kg', barcode: '9300652010374', price: 7, imageUrl: 'https://example.com/a.jpg', ...over }) as StoreProduct;

describe('0.11.0: remembering what searches found', () => {
  beforeEach(async () => {
    await initDb(await createSqlJsDriver({ load: () => initSqlJs() }));
  });

  it('keeps one row for each product and day; the newest reading of the day wins', async () => {
    await noteSeen([p(), p({ storeProductId: '456', name: 'Yoghurt 1kg', price: 5 })], '2026-10-25');
    await noteSeen([p({ price: 6.5, isSpecial: true, wasPrice: 8.5 })], '2026-11-15');
    await noteSeen([p({ price: 6, isSpecial: true, wasPrice: 8.5 })], '2026-11-15');
    const rows = await queryRows<{ day: string; price: number }>("SELECT day, price FROM seen_prices WHERE store_product_id = '123' ORDER BY day");
    expect(rows).toEqual([
      { day: '2026-10-25', price: 7 },
      { day: '2026-11-15', price: 6 },
    ]);
    expect(await seenCount()).toEqual({ rows: 3, products: 2, oldest: '2026-10-25' });
  });

  it('leaves out what was never a shop price: no price, sample and test products, odd ids', () => {
    expect(seenShape(p({ price: 0 }))).toBeUndefined();
    expect(seenShape(p({ price: undefined }))).toBeUndefined();
    expect(seenShape(p({ storeProductId: 'demo-1' }))).toBeUndefined();
    expect(seenShape(p({ storeProductId: undefined }))).toBeUndefined();
    expect(seenShape(p({ name: '  ' }))).toBeUndefined();
    expect(seenShape(p({ barcode: 'abc', imageUrl: 'javascript:1', wasPrice: 3 }), '2026-11-15')).toMatchObject({ barcode: null, image_url: null, was_price: null });
    // any shop, not only the four the shared price service takes
    expect(seenShape(p({ chain: 'bunnings' as StoreProduct['chain'] }))?.chain).toBe('bunnings');
  });

  it('says what an earlier search saw, only when the price was different', async () => {
    await noteSeen([p(), p({ storeProductId: '456', price: 5 })], '2026-10-25');
    await noteSeen([p({ price: 6.5 }), p({ storeProductId: '456', price: 5 })], '2026-11-15');
    const m = await seenBefore([p({ price: 6.5 }), p({ storeProductId: '456', price: 5 }), p({ storeProductId: '999' })], '2026-11-15');
    expect([...m.entries()]).toEqual([['coles|123', { price: 7, day: '2026-10-25', special: false }]]);
    // today's own reading is never "before"
    expect((await seenBefore([p({ price: 9 })], '2026-10-25')).size).toBe(0);
  });

  it('lists a shop’s remembered specials from this week, newest reading only', async () => {
    await noteSeen([p({ isSpecial: true, price: 6 })], '2026-11-03'); // an older week
    await noteSeen([p({ storeProductId: '456', name: 'Yoghurt', price: 4, isSpecial: true, wasPrice: 5 })], '2026-11-12');
    await noteSeen([p({ storeProductId: '789', name: 'Butter', price: 6, isSpecial: true })], '2026-11-11');
    await noteSeen([p({ storeProductId: '789', name: 'Butter', price: 7.5 })], '2026-11-14'); // the special ended
    await noteSeen([p({ chain: 'woolworths', storeProductId: '1', name: 'Milk', price: 3, isSpecial: true })], '2026-11-12');
    expect((await seenSpecials('coles', '2026-11-11')).map((r) => r.name)).toEqual(['Yoghurt']);
  });

  it('is kept as long as the price history, or for its own time', async () => {
    expect(seenKeepWeeks({ historyWeeks: 26 })).toBe(26);
    expect(seenKeepWeeks({ historyWeeks: 26, searchKeepWeeks: 8 })).toBe(8);
    expect(seenKeepWeeks({ historyWeeks: 26, searchKeepWeeks: 3 })).toBe(26);
    const now = Date.parse('2026-11-15T02:00:00Z');
    await noteSeen([p()], '2026-08-01'); // 15 weeks ago
    await noteSeen([p()], '2026-10-25'); // 3 weeks ago
    expect(await pruneSeen({ historyWeeks: 26 }, now)).toBe(0);
    expect(await pruneSeen({ historyWeeks: 26, searchKeepWeeks: 8 }, now)).toBe(1);
    expect((await seenCount()).rows).toBe(1);
    // a nonsense length deletes nothing
    expect(await pruneSeen({ historyWeeks: 0 }, now)).toBe(0);
  });
});
