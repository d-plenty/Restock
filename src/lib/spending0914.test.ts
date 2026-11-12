import initSqlJs from 'sql.js';
import { beforeEach, describe, expect, it } from 'vitest';

// 0.9.14: Your data on a phone without a server: spending from ticks, worked out as the server does.

const { initDb, deleteListEntries } = await import('./db');
const { createSqlJsDriver } = await import('./sql/sqljs');
const { makeSpending, phoneSpending, noteTicks, UNDO_MS } = await import('./spending');

type Run = (sql: string, params?: (string | number | null)[]) => Promise<void>;
let run: Run;
const NOW = Date.parse('2026-11-12T08:00:00Z');

describe('0.9.14 spending on the phone', () => {
  beforeEach(async () => {
    const d = await createSqlJsDriver({ load: () => initSqlJs() });
    await initDb(d);
    run = async (sql, params = []) => {
      await d.run(sql, params);
    };
    await run("INSERT INTO items (id, name, usual_product_id, same_product_ids, alt_product_ids, created_at) VALUES ('milk', 'Milk 3L', 'p-coles', '[\"p-wool\"]', '[]', '2026-01-01')");
    await run("INSERT INTO products (id, chain, name, store_product_id, created_at) VALUES ('p-coles', 'coles', 'Coles Milk 3L', '1', '2026-01-01'), ('p-wool', 'woolworths', 'Woolworths Milk 3L', '2', '2026-01-01')");
    for (const [pid, date, price, special] of [
      ['p-coles', '2026-10-01T00:00:00Z', 4.95, 0],
      ['p-coles', '2026-10-20T00:00:00Z', 4.95, 0],
      ['p-coles', '2026-11-10T00:00:00Z', 3.5, 1],
      ['p-wool', '2026-11-10T00:00:00Z', 4.8, 0],
    ] as const)
      await run('INSERT INTO prices (product_id, date, price, is_special, source) VALUES (?, ?, ?, ?, ?)', [pid, date, price, special, 'auto']);
  });

  it('a tick is a purchase at its shop, priced from the newest price, with what it saved', async () => {
    await run("INSERT INTO list_entries (id, text, item_id, chain, checked, checked_at, qty, created_at) VALUES ('l1', 'Milk', 'milk', 'coles', 1, ?, 2, '2026-11-11')", [NOW - 3600_000]);
    await run("INSERT INTO list_entries (id, text, chain, checked, checked_at, qty, price, created_at) VALUES ('l2', 'Birthday card', 'woolworths', 1, ?, 1, 6, '2026-11-11')", [NOW - 1800_000]);
    await run("INSERT INTO list_entries (id, text, checked, checked_at, created_at) VALUES ('demo-1', 'Sample', 1, ?, '2026-11-11')", [NOW]);
    const s = makeSpending(
      async (sql, p) => (await phoneQuery(sql, p)) as never,
      (sql, p) => run(sql, p as never),
      () => NOW,
    );
    expect(await s.recordTicks()).toEqual({ added: 2, removed: 0 });
    expect(await s.recordTicks()).toEqual({ added: 0, removed: 0 }); // once only
    const st = await s.stats(3);
    expect(st.spending.total).toBe(13); // 2 × $3.50 + $6
    expect(st.spending.count).toBe(2);
    expect(st.shops.map((x) => [x.chain, x.total])).toEqual([
      ['coles', 7],
      ['woolworths', 6],
    ]);
    expect(st.saved.total).toBe(2.9); // 2 × ($4.95 − $3.50)
    expect(st.top.items.map((i) => i.name)).toEqual(['Birthday card', 'Milk 3L']); // the same times: the newest first
    const series = await s.series('milk', 3);
    expect(series.chains.map((c) => c.chain).sort()).toEqual(['coles', 'woolworths']);
    expect(series.paid).toEqual([{ at: new Date(NOW - 3600_000).toISOString(), chain: 'coles', price: 3.5, qty: 2 }]);
  });

  it('an untick soon after takes it back, and clearing the list keeps it', async () => {
    await run("INSERT INTO list_entries (id, text, item_id, chain, checked, checked_at, created_at) VALUES ('l1', 'Milk', 'milk', 'coles', 1, ?, '2026-11-11')", [Date.now() - 60_000]);
    await noteTicks();
    expect((await phoneSpending().stats(3)).spending.count).toBe(1);
    await run('UPDATE list_entries SET checked = 0, checked_at = ? WHERE id = ?', [Date.now(), 'l1']);
    await noteTicks();
    expect((await phoneSpending().stats(3)).spending.count).toBe(0);
    await run('UPDATE list_entries SET checked = 1, checked_at = ? WHERE id = ?', [Date.now() + 1, 'l1']);
    await deleteListEntries(['l1']); // notes it first
    expect((await phoneSpending().stats(3)).spending.count).toBe(1);
    expect(UNDO_MS).toBe(2 * 86_400_000);
  });
});

async function phoneQuery(sql: string, params: unknown[] = []) {
  const { queryRows } = await import('./db');
  return queryRows(sql, params as never);
}
