import initSqlJs from 'sql.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addProduct, clearMarket, ensureDefaults, getProducts, initDb, marketStatus, marketWrite, setMarketDriver } from './db';
import { createSqlJsDriver } from './sql/sqljs';
import { MARKET_TABLE, MIGRATIONS } from './sql/schema';
import type { Product } from '../types';

// 0.15.0: the shared price history can live in a database of its own (the iPhone and iPad app keeps it
// there so its main file stays small). Everything that reads or writes it goes there.

const ROW = 'INSERT INTO market (chain, store_product_id, normal, sale, sale_share, low, cycle_weeks, days, source, updated_at, latest) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';

let main: Awaited<ReturnType<typeof createSqlJsDriver>>;
let market: Awaited<ReturnType<typeof createSqlJsDriver>>;
beforeEach(async () => {
  main = await createSqlJsDriver({ load: () => initSqlJs() });
  await initDb(main);
  await ensureDefaults();
  market = await createSqlJsDriver({ load: () => initSqlJs() });
  await market.run(MARKET_TABLE);
  setMarketDriver(market);
});
afterEach(() => setMarketDriver(undefined));

describe('the shared price history in its own database', () => {
  it('has the same columns as the main database’s table after every migration', async () => {
    const cols = async (d: typeof main) => (await d.query<{ name: string }>('PRAGMA table_info(market)')).map((c) => c.name).sort();
    expect(MIGRATIONS.length).toBeGreaterThan(0);
    expect(await cols(market)).toEqual(await cols(main));
  });

  it('is where products get their shared history, the counts come from, and Remove clears', async () => {
    await addProduct({ id: 'p1', chain: 'coles', storeProductId: '123', name: 'Milk', createdAt: '2026-11-01T00:00:00Z' } as Product);
    await marketWrite([{ sql: ROW, params: ['coles', '123', 4.5, 3, 0.2, 3, 6, 56, 'restock-prices', '2026-11-20T00:00:00Z', 4.5] }]);
    expect((await main.query('SELECT COUNT(*) AS n FROM market'))[0].n).toBe(0);
    const [p] = await getProducts(['p1']);
    expect(p.market).toMatchObject({ normal: 4.5, sale: 3, cycleWeeks: 6 });
    expect(await marketStatus()).toMatchObject({ count: 1, byChain: { coles: 1 } });
    await clearMarket();
    expect((await market.query('SELECT COUNT(*) AS n FROM market'))[0].n).toBe(0);
  });

  it('without its own database, the main one is used as before', async () => {
    setMarketDriver(undefined);
    await marketWrite([{ sql: ROW, params: ['aldi', '9', 2, null, 0, 2, null, 30, 'restock-prices', '2026-11-20T00:00:00Z', 2] }]);
    expect((await main.query('SELECT COUNT(*) AS n FROM market'))[0].n).toBe(1);
    expect((await marketStatus()).count).toBe(1);
  });
});
