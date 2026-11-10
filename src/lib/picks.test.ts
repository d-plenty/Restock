import initSqlJs from 'sql.js';
import { describe, expect, it } from 'vitest';
import type { Group, ListEntry, PriceReading, Product } from '../types';
import { toPicks } from './picks';
import { shopTotals } from './shopTotals';
import { createSqlJsDriver } from './sql/sqljs';
import { migrate, MIGRATIONS } from './sql/schema';
import { recommend } from './verdict';

// My picks, Would also take, Any size and Not at this shop (0.8.9).
const NOW = Date.parse('2026-11-09T00:00:00Z');
const reading = (productId: string, price: number, promo?: string): PriceReading => ({
  productId,
  date: new Date(NOW).toISOString(),
  price,
  isSpecial: !!promo,
  memberOnly: false,
  source: 'auto',
  promo,
});
const item = (over: Partial<Group>): Group => ({
  id: 'g',
  name: 'Item',
  sameProductIds: [],
  altProductIds: [],
  alertLevel: 'any',
  createdAt: '',
  ...over,
});
const entry = (qty = 1): ListEntry => ({ id: 'e', text: 'Item', groupId: 'g', qty, checked: false, createdAt: '' });
const totals = (
  products: Product[],
  g: Group,
  prices: [string, number, string?][],
  chains: ('coles' | 'woolworths' | 'aldi')[],
  qty = 1,
) => {
  const pm = new Map(products.map((p) => [p.id, p]));
  const readings = new Map(prices.map(([id, p, promo]) => [id, [reading(id, p, promo)]]));
  return shopTotals([entry(qty)], [recommend(g, pm, readings, new Set(), NOW)], chains, 'unit');
};
const p = (id: string, chain: Product['chain'], size: string, name = id): Product => ({ id, chain, name, size, createdAt: '' });

describe('moving to My picks', () => {
  const chain: Record<string, string> = { heinz: 'coles', heinzW: 'woolworths', aldiBeans: 'aldi', coles: 'coles', ww: 'woolworths' };
  it('makes an alternative a pick at a shop that had none of your picks', () => {
    const g = toPicks({ usualProductId: 'heinz', sameProductIds: ['heinzW'], altProductIds: ['aldiBeans', 'coles'] }, (id) => chain[id]);
    expect(g).toEqual({ usualProductId: 'heinz', sameProductIds: ['heinzW', 'aldiBeans'], altProductIds: ['coles'] });
  });
  it('leaves an item alone when every alternative is at a shop with a pick', () => {
    const before = { usualProductId: 'heinz', sameProductIds: [], altProductIds: ['coles'] };
    expect(toPicks(before, (id) => chain[id])).toBe(before);
  });
  it('gives an item with only alternatives a usual product', () => {
    expect(toPicks({ sameProductIds: [], altProductIds: ['coles', 'ww'] }, (id) => chain[id])).toEqual({
      usualProductId: 'coles',
      sameProductIds: ['ww'],
      altProductIds: [],
    });
  });

  it("leaves a bulk pack as Would also take when the item doesn't want bulk packs", () => {
    const sizes: Record<string, { name: string; size: string }> = { r500: { name: 'Rice', size: '500g' }, r5k: { name: 'Rice', size: '5kg' } };
    const c: Record<string, string> = { r500: 'coles', r5k: 'aldi' };
    const g = { usualProductId: 'r500', sameProductIds: [], altProductIds: ['r5k'], allowBulk: false };
    expect(toPicks(g, (id) => c[id], (id) => sizes[id])).toBe(g);
    expect(toPicks({ ...g, allowBulk: true }, (id) => c[id], (id) => sizes[id]).sameProductIds).toEqual(['r5k']);
  });

  it('happens once, when Restock updates', async () => {
    const d = await createSqlJsDriver({ load: () => initSqlJs(), restore: async () => undefined, persist: async () => undefined });
    // A phone on 0.8.8: everything before the 0.8.9 step (0.9.0's, 0.9.1's and 0.9.3's sync steps come after it).
    const PICKS = MIGRATIONS.length - 4;
    for (let v = 0; v < PICKS; v++) for (const sql of MIGRATIONS[v]) await d.run(sql);
    await d.run(`PRAGMA user_version = ${PICKS}`);
    for (const [id, c] of Object.entries(chain))
      await d.run(`INSERT INTO products (id, chain, name, created_at) VALUES (?, ?, ?, 'x')`, [id, c, id]);
    await d.run(
      `INSERT INTO items (id, name, usual_product_id, same_product_ids, alt_product_ids, created_at) VALUES ('beans', 'Baked beans', 'heinz', '["heinzW"]', '["aldiBeans","coles"]', 'x')`,
    );
    const log = 'SELECT tbl, pk, stamp, device, deleted, seq FROM sync_log ORDER BY seq';
    const logBefore = await d.query(log);
    await migrate(d);
    const [row] = await d.query<Record<string, unknown>>('SELECT * FROM items');
    expect(row).toMatchObject({ same_product_ids: '["heinzW","aldiBeans"]', alt_product_ids: '["coles"]', any_size: 0, not_at: null });
    // Each phone moves its own items, so it isn't sent to a paired phone.
    expect(await d.query(log)).toEqual(logBefore);
    expect(await d.query("SELECT 1 FROM sync_meta WHERE key = 'applying'")).toEqual([]);
  });
});

describe('store comparisons use My picks only', () => {
  it("doesn't count a Would also take, even when it's cheaper there", () => {
    // Woolworths home-brand sauce is the pick at Woolworths; Coles' home brand is only "would also take".
    const products = [p('ww-sauce', 'woolworths', '500ml'), p('coles-sauce', 'coles', '500ml'), p('heinz-coles', 'coles', '500ml')];
    const g = item({ usualProductId: 'ww-sauce', sameProductIds: ['heinz-coles'], altProductIds: ['coles-sauce'] });
    const t = totals(
      products,
      g,
      [
        ['ww-sauce', 2],
        ['coles-sauce', 1.5],
        ['heinz-coles', 4],
      ],
      ['woolworths', 'coles'],
    );
    expect(t.stores.find((s) => s.chain === 'coles')!.lines[0].pick.product.id).toBe('heinz-coles');
  });

  it('counts a shop marked "Not at this shop" as missing it, and says so', () => {
    const products = [p('ww', 'woolworths', '500ml'), p('aldi', 'aldi', '500ml')];
    const g = item({ usualProductId: 'ww', sameProductIds: ['aldi'], notAt: ['coles'] });
    const t = totals(
      products,
      g,
      [
        ['ww', 2],
        ['aldi', 1],
      ],
      ['woolworths', 'coles', 'aldi'],
    );
    const coles = t.stores.find((s) => s.chain === 'coles')!;
    expect(coles.missing[0]).toMatchObject({ notHere: true });
    // A pick ticked there later wins over the old "not at".
    const back = totals(
      [...products, p('c', 'coles', '500ml')],
      { ...g, sameProductIds: ['aldi', 'c'] },
      [
        ['ww', 2],
        ['aldi', 1],
        ['c', 3],
      ],
      ['coles'],
    );
    expect(back.stores[0].lines[0].pick.product.id).toBe('c');
  });
});

describe('Any size', () => {
  // Popcorn: you usually buy the 300 g bag. Coles also has 100 g bags, cheaper per 100 g.
  const products = [p('big', 'coles', '300g'), p('small', 'coles', '100g'), p('ww', 'woolworths', '120g')];
  const prices: [string, number][] = [
    ['big', 6],
    ['small', 1.5],
    ['ww', 2],
  ];
  const g = item({ usualProductId: 'big', sameProductIds: ['small', 'ww'], anySize: true });

  it('buys as many small packs as it takes when that is cheapest', () => {
    const t = totals(products, g, prices, ['coles', 'woolworths']);
    const coles = t.stores.find((s) => s.chain === 'coles')!.lines[0];
    expect(coles).toMatchObject({ packs: 3, qty: 3 });
    expect(coles.pick.product.id).toBe('small');
    // 300 g from 120 g packs is three of them (360 g): $6.
    const ww = t.stores.find((s) => s.chain === 'woolworths')!;
    expect(ww.lines[0]).toMatchObject({ packs: 3 });
    expect(ww.total).toBeCloseTo(6);
    expect(t.stores.find((s) => s.chain === 'coles')!.total).toBeCloseTo(4.5);
  });

  it('scales with how many are on the list', () => {
    const t = totals(products, g, prices, ['coles'], 2);
    expect(t.stores[0].lines[0]).toMatchObject({ packs: 6 });
    expect(t.stores[0].total).toBeCloseTo(9);
  });

  it('is one of your pick as usual on "This size"', () => {
    const t = totals(products, { ...g, anySize: false }, prices, ['coles'], 1);
    expect(t.stores[0].lines[0].packs).toBeUndefined();
    expect(t.stores[0].lines[0].qty).toBe(1);
  });

  it('counts a pack of unknown size as one per item, the same in shop totals and on the list', () => {
    const items = [p('known', 'aldi', '500g'), p('odd', 'woolworths', '')];
    const t = totals(
      items,
      item({ usualProductId: 'known', sameProductIds: ['odd'], anySize: true }),
      [
        ['known', 1.5],
        ['odd', 1],
      ],
      ['aldi', 'woolworths'],
      2,
    );
    expect(t.stores.find((s) => s.chain === 'woolworths')!.total).toBeCloseTo(2);
    expect(t.stores.find((s) => s.chain === 'aldi')!.total).toBeCloseTo(3);
    expect(t.around.lines[0].pick.product.id).toBe('odd');
    expect(t.around.lines[0].packs).toBeUndefined();
  });

  it('counts a multi-buy when enough packs are bought to get it', () => {
    // Up&Go: the 6 pack is usual; Woolworths has 3 packs at 2 for $5.
    const items = [p('six', 'woolworths', '6 x 250ml'), p('three', 'woolworths', '3 x 250ml')];
    const t = totals(
      items,
      item({ usualProductId: 'six', sameProductIds: ['three'], anySize: true }),
      [
        ['six', 6],
        ['three', 3.2, '2 for $5'],
      ],
      ['woolworths'],
    );
    expect(t.stores[0].lines[0]).toMatchObject({ packs: 2 });
    expect(t.stores[0].lines[0].pick.product.id).toBe('three');
    expect(t.stores[0].total).toBeCloseTo(5);
  });
});
