// 0.15.1: the iPhone and iPad app's database in the system's own SQLite (ios/App/App/RestockSql.swift),
// as Android's is in its own: no longer the whole database in memory and the whole file written out
// after every change. The files are the same ones (a SQLite file is a SQLite file); before the first
// open this way a copy of each is kept beside it, and an install that still kept its database in the
// web view's storage (before 0.13.2's file) has it written to the file first.
//
// One thing at a time per file: the app's own writes wait their turn, and the sync engine
// (server-mode/engine.ts, the same one the server and the web use) holds the file for the whole of
// each thing it does, as it does on a database that answers straight away.
//
// 0.15.2: the app's reads (SELECTs) go a lane of their own (sqlRead: a second, read-only connection),
// so a screen doesn't wait behind a price check's saves or a sync. A read still waits for the app's
// own writes asked before it, so it always sees them; what the sync engine is in the middle of it
// doesn't see until the engine has finished (as with any other database).
import { noteSpeed } from '../lib/speedLog';
import { waitingFor } from '../lib/waiting';
import type { RunResult, SqlDriver, SqlOp, SqlValue } from '../lib/sql/driver';
import type { AsyncSyncDb, Row } from '../server-mode/engine';
import { appleHere, RestockApple } from './apple';
import { DB_FILE, MARKET_FILE, databaseStore, fileStore, looksLikeSqlite, type WebCopy } from './store';

/** The plugin version that has the database (RestockSql.swift). */
const SQL_VERSION = 4;
/** 0.15.2: the plugin version with the read lane (sqlRead). */
const READ_LANE_VERSION = 5;
/** The copies kept before the first open in the system's SQLite. */
export const KEPT = { [DB_FILE]: 'restock-before-0.15.1.sqlite', [MARKET_FILE]: 'restock-market-before-0.15.1.sqlite' } as const;

export interface AppleSqlPlugin {
  sqlQuery(o: { db: string; sql: string; values: SqlValue[] }): Promise<{ rows: Record<string, unknown>[] }>;
  /** 0.15.2 (plugin version 5): a read on the read-only connection. */
  sqlRead?(o: { db: string; sql: string; values: SqlValue[] }): Promise<{ rows: Record<string, unknown>[] }>;
  sqlRun(o: { db: string; sql: string; values: SqlValue[] }): Promise<RunResult>;
  sqlBatch(o: { db: string; ops: { sql: string; values: SqlValue[] }[] }): Promise<void>;
  sqlKeepCopy(o: { name: string; copy: string }): Promise<{ copied: boolean; found: boolean }>;
  sqlClose(o: { db: string }): Promise<void>;
}
const plugin = (): AppleSqlPlugin => RestockApple as unknown as AppleSqlPlugin;

const pluginVersion = async (): Promise<number> => {
  if (!appleHere()) return 0;
  try {
    return (await RestockApple.info()).version;
  } catch {
    return 0;
  }
};

/** Does this build of the app's native side have the database? */
export async function nativeSqlHere(): Promise<boolean> {
  return (await pluginVersion()) >= SQL_VERSION;
}

/** 0.15.2: does it have the read lane too? */
export async function readLaneHere(): Promise<boolean> {
  return (await pluginVersion()) >= READ_LANE_VERSION;
}

/** 0.18.2: how long a read waits for the app's own last write before reading what's there. */
export const READ_WAIT_MS = 250;

/** 0.19.0: how long the read lane gets before the same read is also asked the other way. */
export const READ_LANE_PATIENCE_MS = 6000;

/** A read that the read lane can take: a SELECT (anything else, PRAGMAs included, goes the writing way). */
export const isRead = (sql: string): boolean => /^\s*SELECT\b/i.test(sql);

/** What the bridge can carry: true/false as 1/0 (as sql.js and Android store them), nothing as null. */
export const bindable = (args: readonly unknown[] = []): SqlValue[] =>
  args.map((a) => (a === undefined || a === null ? null : typeof a === 'boolean' ? (a ? 1 : 0) : typeof a === 'number' || typeof a === 'string' ? a : String(a)));

/**
 * 0.19.0: the rows of an answer. An answer the bridge couldn't carry arrives empty (no rows at all):
 * that's said in words, with the question, instead of failing somewhere later as "undefined".
 */
export function rowsOf(answer: { rows?: unknown } | undefined | null, sql: string): Row[] {
  if (answer && Array.isArray(answer.rows)) return answer.rows as Row[];
  throw new Error(`The database's answer didn't arrive (${sql.replace(/\s+/g, ' ').trim().slice(0, 70)})`);
}

interface Raw {
  query(sql: string, args?: readonly unknown[]): Promise<Row[]>;
  run(sql: string, args?: readonly unknown[]): Promise<RunResult>;
  batch(ops: SqlOp[]): Promise<void>;
}

/** One database file: the app's driver (every call waits its turn), and the engine's (holds the file). */
export class AppleDb implements SqlDriver {
  private tail: Promise<unknown> = Promise.resolve();
  /** The app's last write (reads wait for it, and nothing else). */
  private written: Promise<unknown> = Promise.resolve();
  private readonly raw: Raw;
  private readonly read?: (sql: string, args: readonly unknown[]) => Promise<Row[]>;

  constructor(
    readonly name: string,
    p: AppleSqlPlugin = plugin(),
    opts: { readLane?: boolean } = {},
  ) {
    const sqlRead = p.sqlRead?.bind(p);
    if (opts.readLane && sqlRead) this.read = async (sql, args) => rowsOf(await sqlRead({ db: name, sql, values: bindable(args) }), sql);
    this.raw = {
      query: async (sql, args) => rowsOf(await p.sqlQuery({ db: name, sql, values: bindable(args) }), sql),
      run: (sql, args) => p.sqlRun({ db: name, sql, values: bindable(args) }),
      batch: async (ops) => {
        if (ops.length) await p.sqlBatch({ db: name, ops: ops.map((o) => ({ sql: o.sql, values: bindable(o.params) })) });
      },
    };
  }

  /** Runs `fn` once everything asked before it is done; what's asked after waits for it. */
  private turn<T>(fn: () => Promise<T>): Promise<T> {
    const go = this.tail.then(fn, fn);
    this.tail = go.catch(() => undefined);
    return go;
  }

  /** A write: waits its turn, and the reads asked after it wait for it. */
  private write<T>(fn: () => Promise<T>): Promise<T> {
    const go = this.turn(fn);
    this.written = go.catch(() => undefined);
    return go;
  }

  query<T = Record<string, unknown>>(sql: string, params: SqlValue[] = []): Promise<T[]> {
    const read = this.read;
    // 0.18.2: a read waits for the app's last write a moment at most (READ_WAIT_MS), then reads what's
    // saved: that write may itself be waiting behind a sync round or a price check's save, and a screen
    // waited for all of it. What it then misses comes with the next change, a moment later.
    if (read && isRead(sql)) {
      const t0 = Date.now();
      return Promise.race([this.written, new Promise((r) => setTimeout(r, READ_WAIT_MS))]).then(() => {
        const waited = Date.now() - t0;
        if (waited >= READ_WAIT_MS) noteSpeed('read', waited);
        return this.readEitherWay(read, sql, params) as Promise<T[]>;
      });
    }
    return this.write(() => this.raw.query(sql, params) as Promise<T[]>);
  }
  /**
   * 0.19.0: a read on the read lane; if that hasn't answered after READ_LANE_PATIENCE_MS (or fails),
   * the same question goes the writing connection's way too, and the first answer counts. So the
   * read lane being stuck behind one huge read, or not working at all, can't keep a screen waiting.
   */
  private readEitherWay(read: (sql: string, args: readonly unknown[]) => Promise<Row[]>, sql: string, params: SqlValue[]): Promise<Row[]> {
    return new Promise<Row[]>((yes, no) => {
      let other: Promise<Row[]> | undefined;
      let failed = 0;
      const fail = (e: unknown) => {
        if (++failed === 2) no(e);
      };
      const otherWay = (why: string) => {
        if (other) return;
        noteSpeed('read', READ_LANE_PATIENCE_MS, `read lane ${why}`);
        other = this.raw.query(sql, params);
        other.then(yes, fail);
      };
      const t = setTimeout(() => otherWay('slow'), READ_LANE_PATIENCE_MS);
      read(sql, params).then(
        (rows) => {
          clearTimeout(t);
          yes(rows);
        },
        (e) => {
          clearTimeout(t);
          otherWay('failed');
          fail(e);
        },
      );
    });
  }
  run(sql: string, params: SqlValue[] = []): Promise<RunResult> {
    return this.write(() => this.raw.run(sql, params));
  }
  batch(ops: SqlOp[]): Promise<void> {
    return this.write(() => this.raw.batch(ops));
  }

  /** The sync engine's way in: each thing it does holds the file (see AsyncSyncEngine). */
  forEngine(): AsyncSyncDb {
    const raw = this.raw;
    let depth = 0;
    return {
      query: (sql, args) => raw.query(sql, args),
      exec: async (sql, args) => void (await raw.run(sql, args)),
      async transaction(body) {
        if (depth++ === 0) await raw.run('BEGIN IMMEDIATE');
        try {
          await body();
          if (depth === 1) await raw.run('COMMIT');
        } catch (e) {
          if (depth === 1) await raw.run('ROLLBACK').catch(() => undefined);
          throw e;
        } finally {
          depth--;
        }
      },
      // 0.18.4: a step that holds the file a long time is noted (Diagnostics → Speed): the app's saves wait for it.
      exclusive: (fn) =>
        this.turn(async () => {
          const t0 = Date.now();
          // 0.19.0: and while it holds it, a screen that's waiting can say so (lib/waiting.ts).
          const wait = waitingFor('sync is holding the database (saves wait for it)', 'database');
          try {
            return await fn();
          } finally {
            wait.done();
            noteSpeed('hold', Date.now() - t0);
          }
        }),
      // 0.18.4: the engine's changes in one trip (RestockSql.swift sqlBatch: inside the engine's
      // transaction, part of it; outside one, all or none).
      batch: (ops) => raw.batch(ops.map((o) => ({ sql: o.sql, params: bindable(o.args ?? []) }))),
    };
  }
}

/**
 * Before the first open in the system's SQLite: the file is on the disk (written from the web view's
 * storage when that's where the newest copy is) and a copy of it is kept. Says whether there was a
 * database to keep (false on a new install).
 */
export async function readyFile(file: typeof DB_FILE | typeof MARKET_FILE, web: WebCopy, p: AppleSqlPlugin = plugin()): Promise<boolean> {
  const names = file === DB_FILE ? { file, key: 'db', behind: 'fileBehind' } : { file, key: 'market', behind: 'marketBehind' };
  // The newest copy in the web view's storage (an install from before 0.13.2's file, or a save that had
  // to fall back there): onto the disk first, so that's the one kept and opened.
  const fromWeb = async () => {
    const store = databaseStore(await fileStore(), web, undefined, names);
    const bytes = await store.restore();
    if (looksLikeSqlite(bytes) && store.needsFirstWrite()) {
      await p.sqlClose({ db: file });
      await store.persist(bytes);
    }
  };
  if (await web.get(names.behind).catch(() => undefined)) await fromWeb();
  let kept = await p.sqlKeepCopy({ name: file, copy: KEPT[file] });
  if (!kept.found) {
    await fromWeb();
    kept = await p.sqlKeepCopy({ name: file, copy: KEPT[file] });
  }
  return kept.found;
}
