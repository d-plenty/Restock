import type { Database, SqlJsStatic } from 'sql.js';
import type { RunResult, SqlDriver, SqlOp, SqlValue } from './driver';

export interface SqlJsOptions {
  /** Loads the sql.js library (differs between browser and Node). */
  load: () => Promise<SqlJsStatic>;
  /** Previously saved database bytes, if any. */
  restore?: () => Promise<Uint8Array | undefined>;
  /** Called (debounced) after writes so the browser preview keeps its data. */
  persist?: (bytes: Uint8Array) => Promise<void>;
  /** How long after a write the save runs (300 ms), and the longest a run of writes can put it off. */
  saveAfterMs?: number | (() => number);
  saveWithinMs?: number;
  /** Hears how each save went (an error when it failed), so a failed save is never silent. */
  onSaved?: (error?: unknown) => void;
}

export interface SqlJsDriver extends SqlDriver {
  raw: Database;
  /** Saves now if anything is waiting (the app is going to the background). Resolves when it's written. */
  flush(): Promise<void>;
  /** Marks the database as changed (something wrote to `raw` directly). */
  touched(): void;
}

export async function createSqlJsDriver(opts: SqlJsOptions): Promise<SqlJsDriver> {
  const SQL = await opts.load();
  const saved = await opts.restore?.();
  const db: Database = saved ? new SQL.Database(saved) : new SQL.Database();
  db.run('PRAGMA foreign_keys = ON');

  let timer: ReturnType<typeof setTimeout> | undefined;
  let dirtySince = 0;
  let saving: Promise<void> = Promise.resolve();
  const saveNow = (): Promise<void> => {
    clearTimeout(timer);
    timer = undefined;
    if (!opts.persist || !dirtySince) return saving;
    dirtySince = 0;
    // One save at a time, in order: a later save never lands before an earlier one.
    saving = saving.then(async () => {
      try {
        await opts.persist!(db.export());
        opts.onSaved?.();
      } catch (e) {
        // Not saved: still changed, so the next write (or flush) tries again.
        dirtySince = dirtySince || Date.now();
        opts.onSaved?.(e ?? new Error('save failed'));
      }
    });
    return saving;
  };
  const scheduleSave = () => {
    if (!opts.persist) return;
    const now = Date.now();
    dirtySince = dirtySince || now;
    const after = typeof opts.saveAfterMs === 'function' ? opts.saveAfterMs() : (opts.saveAfterMs ?? 300);
    // A steady run of writes can't put the save off for ever.
    const wait = opts.saveWithinMs ? Math.max(0, Math.min(after, dirtySince + opts.saveWithinMs - now)) : after;
    clearTimeout(timer);
    timer = setTimeout(() => void saveNow(), wait);
  };

  const exec = (sql: string, params: SqlValue[] = []) => {
    const stmt = db.prepare(sql);
    try {
      stmt.bind(params);
      while (stmt.step());
    } finally {
      stmt.free();
    }
  };

  return {
    raw: db,
    flush: () => saveNow(),
    touched: scheduleSave,
    async query<T>(sql: string, params: SqlValue[] = []): Promise<T[]> {
      const stmt = db.prepare(sql);
      const rows: T[] = [];
      try {
        stmt.bind(params);
        while (stmt.step()) rows.push(stmt.getAsObject() as T);
      } finally {
        stmt.free();
      }
      return rows;
    },
    async run(sql: string, params: SqlValue[] = []): Promise<RunResult> {
      exec(sql, params);
      const changes = db.getRowsModified();
      const lastId = Number(db.exec('SELECT last_insert_rowid()')[0]?.values[0]?.[0] ?? 0);
      scheduleSave();
      return { changes, lastId };
    },
    async batch(ops: SqlOp[]): Promise<void> {
      db.run('BEGIN');
      try {
        for (const op of ops) exec(op.sql, op.params);
        db.run('COMMIT');
      } catch (e) {
        db.run('ROLLBACK');
        throw e;
      }
      scheduleSave();
    },
  };
}
