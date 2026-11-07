import type { Database, SqlJsStatic } from 'sql.js';
import type { RunResult, SqlDriver, SqlOp, SqlValue } from './driver';

export interface SqlJsOptions {
  /** Loads the sql.js library (differs between browser and Node). */
  load: () => Promise<SqlJsStatic>;
  /** Previously saved database bytes, if any. */
  restore?: () => Promise<Uint8Array | undefined>;
  /** Called (debounced) after writes so the browser preview keeps its data. */
  persist?: (bytes: Uint8Array) => Promise<void>;
}

export async function createSqlJsDriver(opts: SqlJsOptions): Promise<SqlDriver & { raw: Database }> {
  const SQL = await opts.load();
  const saved = await opts.restore?.();
  const db: Database = saved ? new SQL.Database(saved) : new SQL.Database();
  db.run('PRAGMA foreign_keys = ON');

  let timer: ReturnType<typeof setTimeout> | undefined;
  const scheduleSave = () => {
    if (!opts.persist) return;
    clearTimeout(timer);
    timer = setTimeout(() => void opts.persist!(db.export()), 300);
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
