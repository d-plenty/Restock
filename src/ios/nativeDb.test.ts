// 0.15.1: the iPhone and iPad app's database in the system's SQLite (nativeDb.ts), against a stand-in
// for RestockSql.swift that keeps each "file" in sql.js and answers later, as the bridge does.
import initSqlJs, { type Database } from 'sql.js';
import { beforeAll, describe, expect, test } from 'vitest';
import { AsyncSyncEngine } from '../server-mode/engine';
import { AppleDb, bindable, KEPT, readyFile, type AppleSqlPlugin } from './nativeDb';
import { DB_FILE } from './store';

let SQL: Awaited<ReturnType<typeof initSqlJs>>;
beforeAll(async () => {
  SQL = await initSqlJs();
});

/** The Swift side, as far as these calls go: files by name, a copy kept once, and every call answered later. */
function fakeSwift(files: Map<string, Uint8Array> = new Map()) {
  const open = new Map<string, Database>();
  const log: string[] = [];
  const db = (name: string) => {
    let d = open.get(name);
    if (!d) {
      d = new SQL.Database(files.get(name));
      open.set(name, d);
    }
    return d;
  };
  const later = <T>(fn: () => T) => new Promise<T>((r, j) => setTimeout(() => { try { r(fn()); } catch (e) { j(e as Error); } }, 1));
  const p: AppleSqlPlugin = {
    sqlQuery: (o) => later(() => {
      log.push(o.sql);
      const st = db(o.db).prepare(o.sql);
      st.bind(o.values);
      const rows: Record<string, unknown>[] = [];
      while (st.step()) rows.push(st.getAsObject());
      st.free();
      return { rows };
    }),
    sqlRun: (o) => later(() => {
      log.push(o.sql);
      db(o.db).run(o.sql, o.values);
      return { changes: db(o.db).getRowsModified(), lastId: 0 };
    }),
    sqlBatch: (o) => later(() => {
      const d = db(o.db);
      log.push(`batch ${o.ops.length}`);
      d.run('BEGIN');
      try {
        for (const op of o.ops) d.run(op.sql, op.values);
        d.run('COMMIT');
      } catch (e) {
        d.run('ROLLBACK');
        throw e;
      }
    }),
    sqlKeepCopy: (o) => later(() => {
      const now = open.get(o.name)?.export() ?? files.get(o.name);
      if (!now) return { copied: false, found: false };
      if (files.has(o.copy)) return { copied: false, found: true };
      files.set(o.copy, now);
      return { copied: true, found: true };
    }),
    sqlClose: (o) => later(() => {
      const d = open.get(o.db);
      if (d) files.set(o.db, d.export());
      open.delete(o.db);
    }),
  };
  return { p, files, log, db };
}

describe('the database in the system SQLite', () => {
  test('what the bridge carries: true and false as 1 and 0, nothing as null', () => {
    expect(bindable([true, false, undefined, null, 2.5, 'x', { a: 1 }])).toEqual([1, 0, null, null, 2.5, 'x', '[object Object]']);
  });

  test("the app's reads and writes go one at a time, in the order asked", async () => {
    const s = fakeSwift();
    const d = new AppleDb('restock.sqlite', s.p);
    await d.run('CREATE TABLE t (n INTEGER)');
    await Promise.all([1, 2, 3].map((n) => d.run('INSERT INTO t (n) VALUES (?)', [n])));
    expect((await d.query<{ n: number }>('SELECT n FROM t ORDER BY rowid')).map((r) => r.n)).toEqual([1, 2, 3]);
  });

  test('while the sync engine holds the file, the app waits; a failed hold leaves nothing of it', async () => {
    const s = fakeSwift();
    const d = new AppleDb('restock.sqlite', s.p);
    await d.run('CREATE TABLE sync_meta (key TEXT PRIMARY KEY, value TEXT)');
    await d.run('CREATE TABLE household (k TEXT PRIMARY KEY, v TEXT)');
    const e = new AsyncSyncEngine(d.forEngine(), () => true, () => '');
    const order: string[] = [];
    const held = e.hold(async () => {
      await e.setMeta('a', '1');
      order.push('engine a');
      await e.setMeta('b', '2');
      order.push('engine b');
    });
    const app = d.run("INSERT INTO sync_meta (key, value) VALUES ('app', 'x')").then(() => order.push('app'));
    await Promise.all([held, app]);
    expect(order).toEqual(['engine a', 'engine b', 'app']);
    await expect(
      e.hold(async () => {
        await e.setMeta('c', '3');
        throw new Error('stop');
      }),
    ).rejects.toThrow('stop');
    expect(await e.meta('c')).toBeNull();
    expect(await e.meta('b')).toBe('2');
  });

  test("before the first open: a copy is kept, once; an install whose newest copy was in the web view's storage has it written to the file first", async () => {
    const old = new SQL.Database();
    old.run("CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT); INSERT INTO kv VALUES ('appVersion', '\"0.15.0\"')");
    const bytes = old.export();
    // The file is there: kept, then opened as it is.
    const a = fakeSwift(new Map([[DB_FILE, bytes]]));
    const none = { get: async () => undefined, put: async () => undefined };
    expect(await readyFile(DB_FILE, none, a.p)).toBe(true);
    expect(a.files.get(KEPT[DB_FILE])).toEqual(bytes);
    expect(await readyFile(DB_FILE, none, a.p)).toBe(true);
    // A new install: nothing to keep.
    const b = fakeSwift();
    expect(await readyFile(DB_FILE, none, b.p)).toBe(false);
    expect(b.files.has(KEPT[DB_FILE])).toBe(false);
  });
});
