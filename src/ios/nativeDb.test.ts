// 0.15.1: the iPhone and iPad app's database in the system's SQLite (nativeDb.ts), against a stand-in
// for RestockSql.swift that keeps each "file" in sql.js and answers later, as the bridge does.
import initSqlJs, { type Database } from 'sql.js';
import { beforeAll, describe, expect, test, vi } from 'vitest';
import { AsyncSyncEngine } from '../server-mode/engine';
import { AppleDb, bindable, isRead, KEPT, READ_LANE_PATIENCE_MS, READ_WAIT_MS, readyFile, rowsOf, type AppleSqlPlugin } from './nativeDb';
import { DB_FILE } from './store';

let SQL: Awaited<ReturnType<typeof initSqlJs>>;
beforeAll(async () => {
  SQL = await initSqlJs();
});

/** The Swift side, as far as these calls go: files by name, a copy kept once, and every call answered later. */
function fakeSwift(files: Map<string, Uint8Array> = new Map()) {
  const open = new Map<string, Database>();
  const log: string[] = [];
  const inTx = new Set<string>();
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
    // 0.15.2: the read-only connection. sql.js has one connection, so this reads the same database;
    // what matters here is that it doesn't wait in the writing queue.
    sqlRead: (o) =>
      new Promise((r, j) =>
        setTimeout(() => {
          try {
            log.push('read ' + o.sql);
            const st = db(o.db).prepare(o.sql);
            st.bind(o.values);
            const rows: Record<string, unknown>[] = [];
            while (st.step()) rows.push(st.getAsObject());
            st.free();
            r({ rows });
          } catch (e) {
            j(e as Error);
          }
        }, 0),
      ),
    sqlRun: (o) => later(() => {
      log.push(o.sql);
      if (/^BEGIN/i.test(o.sql)) inTx.add(o.db);
      else if (/^(COMMIT|ROLLBACK)/i.test(o.sql)) inTx.delete(o.db);
      db(o.db).run(o.sql, o.values);
      return { changes: db(o.db).getRowsModified(), lastId: 0 };
    }),
    sqlBatch: (o) => later(() => {
      const d = db(o.db);
      log.push(`batch ${o.ops.length}`);
      // As RestockSql.swift: inside a transaction already (the sync engine's), part of it.
      if (inTx.has(o.db)) {
        for (const op of o.ops) d.run(op.sql, op.values);
        return;
      }
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

  test("0.15.2: with the read lane, reads skip past a sync that holds the file, but see the app's own writes", async () => {
    const s = fakeSwift();
    const d = new AppleDb('restock.sqlite', s.p, { readLane: true });
    await d.run('CREATE TABLE sync_meta (key TEXT PRIMARY KEY, value TEXT)');
    await d.run('CREATE TABLE household (k TEXT PRIMARY KEY, v TEXT)');
    const e = new AsyncSyncEngine(d.forEngine(), () => true, () => '');
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    // A sync holding the file until it's let go.
    const held = e.hold(async () => {
      await e.setMeta('a', '1');
      await gate;
      order.push('sync done');
    });
    await new Promise((r) => setTimeout(r, 5));
    // A screen's read doesn't wait for it.
    const rows = await d.query<{ n: number }>('SELECT COUNT(*) AS n FROM household');
    order.push('read');
    expect(rows[0].n).toBe(0);
    // A write does, and a read asked after that write waits for it (so it sees it).
    const w = d.run("INSERT INTO household (k, v) VALUES ('x', 'y')").then(() => order.push('write'));
    const after = d.query<{ n: number }>('SELECT COUNT(*) AS n FROM household').then((r) => {
      order.push('read after write');
      return r[0].n;
    });
    await new Promise((r) => setTimeout(r, 5));
    release();
    await Promise.all([held, w]);
    expect(await after).toBe(1);
    expect(order).toEqual(['read', 'sync done', 'write', 'read after write']);
    // Only SELECTs take the read lane.
    expect(s.log.filter((l) => l.startsWith('read ')).length).toBe(2);
    expect([isRead(' select 1'), isRead('PRAGMA user_version'), isRead('INSERT INTO t SELECT 1')]).toEqual([true, false, false]);
  });

  test('0.18.2: a read waits a moment at most for a write that is itself stuck behind a sync', async () => {
    const s = fakeSwift();
    const d = new AppleDb('restock.sqlite', s.p, { readLane: true });
    await d.run('CREATE TABLE sync_meta (key TEXT PRIMARY KEY, value TEXT)');
    await d.run('CREATE TABLE household (k TEXT PRIMARY KEY, v TEXT)');
    const e = new AsyncSyncEngine(d.forEngine(), () => true, () => '');
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const held = e.hold(async () => {
      await gate;
    });
    await new Promise((r) => setTimeout(r, 5));
    // A price check's save, queued behind the sync; a screen reads after it.
    const w = d.run("INSERT INTO household (k, v) VALUES ('x', 'y')");
    const t0 = Date.now();
    const rows = await d.query<{ n: number }>('SELECT COUNT(*) AS n FROM household');
    const took = Date.now() - t0;
    // It read what's there after READ_WAIT_MS, not after the whole sync.
    expect(rows[0].n).toBe(0);
    expect(took).toBeGreaterThanOrEqual(READ_WAIT_MS - 20);
    expect(took).toBeLessThan(READ_WAIT_MS + 400);
    release();
    await Promise.all([held, w]);
    expect((await d.query<{ n: number }>('SELECT COUNT(*) AS n FROM household'))[0].n).toBe(1);
  });

  test('0.19.0: a read lane that never answers, or fails, is not the end: the same read goes the other way', async () => {
    const s = fakeSwift();
    const d0 = new AppleDb('restock.sqlite', s.p);
    await d0.run('CREATE TABLE t (a)');
    await d0.run('INSERT INTO t VALUES (7)');
    // The read lane takes the question and says nothing.
    vi.useFakeTimers();
    try {
      const silent = new AppleDb('restock.sqlite', { ...s.p, sqlRead: () => new Promise(() => undefined) }, { readLane: true });
      const got = silent.query<{ a: number }>('SELECT a FROM t');
      await vi.advanceTimersByTimeAsync(READ_LANE_PATIENCE_MS + 50);
      expect(await got).toEqual([{ a: 7 }]);
      // It fails outright: the other way straight away, no waiting.
      const broken = new AppleDb('restock.sqlite', { ...s.p, sqlRead: () => Promise.reject(new Error('SQL query failed: disk I/O error')) }, { readLane: true });
      const got2 = broken.query<{ a: number }>('SELECT a FROM t');
      await vi.advanceTimersByTimeAsync(50);
      expect(await got2).toEqual([{ a: 7 }]);
      // Both ways fail: the error comes back (it doesn't wait for good).
      const dead = new AppleDb('restock.sqlite', { ...s.p, sqlRead: () => Promise.reject(new Error('one')), sqlQuery: () => Promise.reject(new Error('two')) }, { readLane: true });
      const got3 = dead.query('SELECT a FROM t').catch((e: Error) => e.message);
      await vi.advanceTimersByTimeAsync(50);
      expect(await got3).toMatch(/one|two/);
    } finally {
      vi.useRealTimers();
    }
  });

  test("0.19.0: an answer the bridge couldn't carry (it arrives with no rows at all) is an error in words, not \"undefined\"", async () => {
    expect(rowsOf({ rows: [] }, 'SELECT 1')).toEqual([]);
    expect(() => rowsOf({}, 'SELECT * FROM prices WHERE product_id IN (?)')).toThrow(/answer didn't arrive \(SELECT \* FROM prices/);
    expect(() => rowsOf(undefined, 'SELECT 1')).toThrow(/didn't arrive/);
    const s = fakeSwift();
    const d = new AppleDb('restock.sqlite', { ...s.p, sqlQuery: async () => ({}) as never });
    await expect(d.query('PRAGMA user_version')).rejects.toThrow(/didn't arrive/);
  });

  test('without the read lane (an older native side), reads wait their turn as before', async () => {
    const s = fakeSwift();
    const d = new AppleDb('restock.sqlite', s.p);
    await d.run('CREATE TABLE t (n INTEGER)');
    await d.query('SELECT n FROM t');
    expect(s.log.some((l) => l.startsWith('read '))).toBe(false);
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
