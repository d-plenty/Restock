// @vitest-environment jsdom
// 0.18.2: iPhone and iPad speed. The price history read once and kept until it changes (and only the
// products a price check saved read again); a tap going before a price check's saves still waiting;
// the deals from last time shown straight away when Restock opens, then today's.
import initSqlJs from 'sql.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { addGroup, addListEntry, addProduct, ensureDefaults, initDb, readingsFor, saveFindings } from './db';
import { createSqlJsDriver } from './sql/sqljs';
import { changed } from './live';
import { act, background } from './undo';
import { loadRecommendations, resetRecsForTests } from './recs';

let reads = 0;
beforeEach(async () => {
  const driver = await createSqlJsDriver({ load: () => initSqlJs() });
  const query = driver.query.bind(driver);
  driver.query = ((sql: string, p?: never) => {
    if (/FROM prices/.test(sql)) reads++;
    return query(sql, p);
  }) as typeof driver.query;
  await initDb(driver);
  await ensureDefaults();
  for (let i = 0; i < 3; i++) {
    await addProduct({ id: 'p' + i, chain: 'coles', name: 'Thing ' + i, storeProductId: 's' + i, createdAt: '' } as never);
    await addGroup({ id: 'g' + i, name: 'Thing ' + i, usualProductId: 'p' + i, sameProductIds: [], altProductIds: [], alertLevel: 'good', createdAt: '' });
  }
  await saveFindings([0, 1, 2].map((i) => ({ productId: 'p' + i, date: '2026-11-20T00:00:00.000Z', price: 3 + i, isSpecial: false, memberOnly: false, source: 'auto' as const })));
  reads = 0;
});

describe('0.18.2: the price history, read once', () => {
  it('is kept while other things change, and read again only for what a price check saved', async () => {
    const ids = ['p0', 'p1', 'p2'];
    expect([...(await readingsFor(ids)).values()].flat()).toHaveLength(3);
    expect(reads).toBe(1);
    // A tick on the list: nothing read again.
    await addListEntry({ id: 'l1', text: 'Milk', checked: false, qty: 1, createdAt: '' } as never);
    expect((await readingsFor(ids)).get('p1')).toHaveLength(1);
    expect(reads).toBe(1);
    // A price check saves p1's new price: only p1 is read again, and it's there.
    await saveFindings([{ productId: 'p1', date: '2026-11-21T00:00:00.000Z', price: 2.5, isSpecial: false, memberOnly: false, source: 'auto' }]);
    reads = 0;
    const after = await readingsFor(ids);
    expect(after.get('p1')!.map((r) => r.price)).toEqual([4, 2.5]);
    expect(after.get('p0')).toHaveLength(1);
    expect(reads).toBe(1);
    // A change from anywhere else (a sync) may have touched prices: all read again.
    changed();
    reads = 0;
    await readingsFor(ids);
    expect(reads).toBe(1);
    // What's handed out can be changed without changing what's kept.
    (await readingsFor(ids)).get('p0')!.push({ productId: 'p0', date: 'x', price: 1 } as never);
    expect((await readingsFor(ids)).get('p0')).toHaveLength(1);
  });
});

describe('0.18.2: a tap goes first', () => {
  it("runs before a price check's saves still waiting, never in the middle of one", async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const first = background(async () => {
      order.push('save 1 starts');
      await gate;
      order.push('save 1 ends');
    });
    const second = background(async () => void order.push('save 2'));
    const third = background(async () => void order.push('save 3'));
    await new Promise((r) => setTimeout(r, 5));
    const tap = act('Added', async () => void order.push('tap'));
    release();
    await Promise.all([first, second, third, tap]);
    expect(order).toEqual(['save 1 starts', 'save 1 ends', 'tap', 'save 2', 'save 3']);
  });
  it('an error in one leaves the rest to run', async () => {
    const out: string[] = [];
    await expect(background(async () => Promise.reject(new Error('no')))).rejects.toThrow('no');
    await background(async () => void out.push('next'));
    expect(out).toEqual(['next']);
  });
});

describe('0.18.2: the deals from last time, straight away', () => {
  it('shows what was kept when Restock opens, then what it works out now', async () => {
    resetRecsForTests();
    localStorage.setItem('restock.recsSnapshot.v1', JSON.stringify({ v: 1, recs: [{ group: { id: 'kept', name: 'From last time' }, options: [] }] }));
    const first = await loadRecommendations();
    expect(first.map((r) => r.group.id)).toEqual(['kept']);
    // Every screen gets it until today's are worked out…
    expect((await loadRecommendations()).map((r) => r.group.id)).toEqual(['kept']);
    // …then today's.
    await new Promise((r) => setTimeout(r, 50));
    expect((await loadRecommendations()).map((r) => r.group.id).sort()).toEqual(['g0', 'g1', 'g2']);
    // And they're kept for next time (as the same JSON).
    await new Promise((r) => setTimeout(r, 50));
    const kept = JSON.parse(localStorage.getItem('restock.recsSnapshot.v1')!) as { recs: { group: { id: string } }[] };
    expect(kept.recs.map((r) => r.group.id).sort()).toEqual(['g0', 'g1', 'g2']);
  });
  it('a damaged one is passed over', async () => {
    resetRecsForTests();
    localStorage.setItem('restock.recsSnapshot.v1', '{nope');
    expect((await loadRecommendations()).map((r) => r.group.id).sort()).toEqual(['g0', 'g1', 'g2']);
  });
});
