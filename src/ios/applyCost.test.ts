// 0.18.4: what taking in another phone's file costs on an iPhone or iPad, where every question to
// the database is a trip across to the system's SQLite and back (a millisecond or more each), and
// the database is held for the phone's own saves until it's done. A household on a Restock server
// sends thousands of prices in the server's file every round: asked about one by one, a round held
// the database for minutes, and every screen waiting on a save waited with it ("Loading…").
import initSqlJs from 'sql.js';
import { describe, expect, it } from 'vitest';
import { initDb, updateSettings } from '../lib/db';
import { createSqlJsDriver } from '../lib/sql/sqljs';
import { AsyncSyncEngine, type AsyncSyncDb, type Entry } from '../server-mode/engine';
import { asyncSyncDbOf, syncDbOf } from '../server-mode/sqldb';
import { signedText, verifySig } from '../server-mode/crypto';

async function phone() {
  const driver = await createSqlJsDriver({ load: () => initSqlJs() });
  await initDb(driver);
  await updateSettings({ onboarded: true }, { local: true });
  const inner = asyncSyncDbOf(syncDbOf(driver.raw));
  const count = { q: 0, x: 0, b: 0 };
  const db: AsyncSyncDb = {
    query: (s, a) => (count.q++, inner.query(s, a)),
    exec: (s, a) => (count.x++, inner.exec(s, a)),
    transaction: (b) => inner.transaction(b),
    exclusive: (f) => inner.exclusive!(f),
    batch: (ops) => (count.b++, inner.batch!(ops)),
  };
  const e = new AsyncSyncEngine(db, verifySig, signedText, () => Date.now(), { role: 'phone' });
  await e.setMeta('device', 'pB');
  return { e, count, driver };
}

/** Another phone's records: items with a product each, and a price most days for each product. */
function entries(items: number, pricesEach: number, at = Date.now() - 86_400_000): Entry[] {
  const out: Entry[] = [];
  let stamp = at;
  for (let i = 0; i < items; i++) {
    out.push({ tbl: 'products', pk: 'p' + i, stamp: ++stamp, device: 'pA', deleted: false, created: stamp, row: { id: 'p' + i, chain: 'coles', name: 'Thing ' + i, store_product_id: 's' + i, created_at: new Date(at).toISOString() } } as Entry);
    out.push({ tbl: 'items', pk: 'i' + i, stamp: ++stamp, device: 'pA', deleted: false, created: stamp, row: { id: 'i' + i, name: 'Thing ' + i, usual_product_id: 'p' + i, section: 'pantry', alert_level: 'good', created_at: new Date(at).toISOString() } } as Entry);
    for (let d = 0; d < pricesEach; d++) {
      const date = new Date(at - d * 86_400_000).toISOString();
      out.push({ tbl: 'prices', pk: `p${i}|${date}`, stamp: ++stamp, device: 'pA', deleted: false, created: stamp, row: { product_id: 'p' + i, date, price: 3 + (d % 5), is_special: d % 7 === 0 ? 1 : 0, source: 'auto' } } as Entry);
    }
  }
  return out;
}

describe('0.18.4: taking in a file on an iPhone asks the database a few times, not once per record', () => {
  it('a file already taken in (the server sends it again every round)', async () => {
    const { e, count } = await phone();
    const all = entries(200, 40);
    await e.apply(all);
    count.q = 0;
    count.x = 0;
    count.b = 0;
    await e.apply(all);
    // Before: a question for every record (8,400 here). Now: one for every few hundred.
    expect(count.q + count.x + count.b).toBeLessThan(all.length / 20);
  });

  it('a new file: the questions and the saves go a few hundred at a time', async () => {
    const { e, count, driver } = await phone();
    const all = entries(200, 40);
    await e.apply(all);
    expect(count.q + count.x + count.b).toBeLessThan(all.length / 10);
    // And everything is there, as before.
    const n = (await driver.query<{ n: number }>('SELECT COUNT(*) AS n FROM prices'))[0].n;
    expect(n).toBe(200 * 40);
    const items = (await driver.query<{ n: number }>('SELECT COUNT(*) AS n FROM items'))[0].n;
    expect(items).toBe(200);
  });

  it("this phone's own file: every record it has, asked for a few hundred at a time", async () => {
    const { e, count } = await phone();
    await e.apply(entries(200, 40));
    count.q = 0;
    count.x = 0;
    count.b = 0;
    const c = await e.collect(0, null, 5_000_000, null, '', true, 0);
    expect(c.entries.length).toBe(200 * 42);
    expect(c.entries.filter((x) => x.tbl === 'prices').every((x) => x.row && !('id' in x.row))).toBe(true);
    expect(count.q).toBeLessThan(c.entries.length / 20);
  });

  it('an archive of prices: what is here already is asked for in lots, and nothing is added twice', async () => {
    const { e, count, driver } = await phone();
    const at = Date.now() - 86_400_000;
    await e.apply(entries(200, 10, at));
    const prices = [];
    for (let i = 0; i < 200; i++) for (let d = 0; d < 40; d++) prices.push({ product_id: 'p' + i, date: new Date(at - d * 86_400_000).toISOString(), price: 4, is_special: 0, source: 'auto' });
    count.q = 0;
    expect(await e.takeArchive({ prices })).toBe(200 * 30);
    expect(count.q).toBeLessThan(prices.length / 20);
    expect(await e.takeArchive({ prices })).toBe(0);
    expect((await driver.query<{ n: number }>('SELECT COUNT(*) AS n FROM prices'))[0].n).toBe(200 * 40);
  });
});
