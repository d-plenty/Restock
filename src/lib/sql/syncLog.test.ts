import initSqlJs from 'sql.js';
import { describe, expect, it } from 'vitest';
import { createSqlJsDriver } from './sqljs';
import { migrate, MIGRATIONS, SYNC_VERSION } from './schema';

async function freshDb() {
  const SQL = await initSqlJs();
  const driver = await createSqlJsDriver({ load: async () => SQL, restore: async () => undefined, persist: async () => undefined });
  return driver;
}

describe('sync change log (0.8.0)', () => {
  it('is the newest migration', () => {
    expect(SYNC_VERSION).toBe(MIGRATIONS.length - 6);
  });

  it('notes adds, edits and deletes, and seeds what was already there', async () => {
    const d = await freshDb();
    // An older Restock with an item already in it.
    for (let v = 0; v < SYNC_VERSION; v++) for (const sql of MIGRATIONS[v]) await d.run(sql);
    await d.run(`PRAGMA user_version = ${SYNC_VERSION}`);
    await d.run(`INSERT INTO items (id, name, created_at) VALUES ('old', 'Milk', 'x')`);
    await d.run(`INSERT INTO products (id, chain, name, created_at) VALUES ('p1', 'coles', 'Milk 2L', 'x')`);
    await d.run(`INSERT INTO prices (product_id, date, price, source) VALUES ('p1', '2026-11-01', 3.1, 'check')`);
    await migrate(d);
    const device = (await d.query<{ value: string }>(`SELECT value FROM sync_meta WHERE key = 'device'`))[0].value;
    expect(device).toMatch(/^[0-9a-f]{16}$/);
    const seeded = await d.query<{ tbl: string; pk: string; device: string }>('SELECT tbl, pk, device FROM sync_log ORDER BY seq');
    expect(seeded.map((r) => `${r.tbl}:${r.pk}`)).toEqual(expect.arrayContaining(['items:old', 'products:p1', 'prices:p1|2026-11-01']));

    await d.run(`INSERT INTO items (id, name, created_at) VALUES ('new', 'Bread', 'x')`);
    await d.run(`UPDATE items SET name = 'Milk 3L' WHERE id = 'old'`);
    await d.run(`DELETE FROM items WHERE id = 'new'`);
    const log = await d.query<{ pk: string; deleted: number; seq: number; stamp: number; device: string }>(
      `SELECT pk, deleted, seq, stamp, device FROM sync_log WHERE tbl = 'items' ORDER BY seq`,
    );
    expect(log.map((r) => [r.pk, r.deleted])).toEqual([
      ['old', 0],
      ['new', 1],
    ]);
    expect(log[1].seq).toBeGreaterThan(log[0].seq);
    expect(log[0].device).toBe(device);
    expect(Math.abs(log[0].stamp - Date.now())).toBeLessThan(60_000);
  });

  it('stays quiet while changes from another phone are applied', async () => {
    const d = await freshDb();
    await migrate(d);
    await d.run(`INSERT INTO sync_meta (key, value) VALUES ('applying', '1')`);
    await d.run(`INSERT INTO items (id, name, created_at) VALUES ('a', 'Eggs', 'x')`);
    await d.run(`DELETE FROM sync_meta WHERE key = 'applying'`);
    expect(await d.query(`SELECT * FROM sync_log WHERE pk = 'a'`)).toEqual([]);
  });

  it('never goes backwards in time after seeing another phone ahead of it', async () => {
    const d = await freshDb();
    await migrate(d);
    const ahead = Date.now() + 3_600_000;
    await d.run(`INSERT INTO sync_meta (key, value) VALUES ('clock', ?)`, [String(ahead)]);
    await d.run(`INSERT INTO items (id, name, created_at) VALUES ('b', 'Tea', 'x')`);
    const [r] = await d.query<{ stamp: number }>(`SELECT stamp FROM sync_log WHERE pk = 'b'`);
    expect(r.stamp).toBeGreaterThanOrEqual(ahead);
  });

  it('0.9.1: notes receipts; an edit keeps when it was made, a delete then a new one makes it again', async () => {
    const d = await freshDb();
    // A phone on 0.9.0 with a receipt already kept.
    const before = MIGRATIONS.length - 1;
    for (let v = 0; v < before; v++) for (const sql of MIGRATIONS[v]) await d.run(sql);
    await d.run(`PRAGMA user_version = ${before}`);
    await d.run(`INSERT INTO receipts (id, scanned_at, section) VALUES ('old', 'x', 'pantry')`);
    await migrate(d);
    type L = { pk: string; deleted: number; created: number; stamp: number };
    const row = async (pk: string) => (await d.query<L>(`SELECT pk, deleted, created, stamp FROM sync_log WHERE tbl = 'receipts' AND pk = ?`, [pk]))[0];
    const seeded = await row('old');
    expect(seeded).toMatchObject({ deleted: 0 });
    expect(seeded.created).toBeGreaterThan(0);
    expect((await d.query(`PRAGMA table_info(sync_peers)`)).map((c) => (c as { name: string }).name)).toContain('seen');

    // Saved again (db.ts saveReceipt uses INSERT OR REPLACE): an edit, not a new receipt.
    await d.run(`INSERT OR REPLACE INTO receipts (id, scanned_at, section, note) VALUES ('old', 'x', 'pantry', 'milk run')`);
    const edited = await row('old');
    expect(edited.created).toBe(seeded.created);
    expect(edited.stamp).toBeGreaterThan(seeded.stamp);

    await d.run(`DELETE FROM receipts WHERE id = 'old'`);
    expect((await row('old')).deleted).toBe(1);
    await d.run(`INSERT OR REPLACE INTO receipts (id, scanned_at, section) VALUES ('old', 'x', 'pantry')`);
    const again = await row('old');
    expect(again.deleted).toBe(0);
    expect(again.created).toBeGreaterThan(edited.stamp);
  });
});
