// Server mode: the sync engine's database (engine.ts SyncDb) on a sql.js Database, synchronously.
import type { Database } from 'sql.js';
import type { AsyncSyncDb, Row, SyncDb } from './engine';

type Bindable = string | number | null | Uint8Array;

const bindable = (args: unknown[]): Bindable[] =>
  args.map((a) => (a === undefined || a === null ? null : typeof a === 'boolean' ? (a ? 1 : 0) : typeof a === 'number' || typeof a === 'string' || a instanceof Uint8Array ? a : String(a)));

export function syncDbOf(db: Database): SyncDb {
  let depth = 0;
  const self: SyncDb = {
    query(sql, args = []) {
      const st = db.prepare(sql);
      const out: Row[] = [];
      try {
        st.bind(bindable(args));
        while (st.step()) out.push(st.getAsObject() as Row);
      } finally {
        st.free();
      }
      return out;
    },
    exec(sql, args = []) {
      const st = db.prepare(sql);
      try {
        st.bind(bindable(args));
        while (st.step());
      } finally {
        st.free();
      }
    },
    transaction(body) {
      if (depth++ === 0) db.run('BEGIN');
      try {
        body();
        if (depth === 1) db.run('COMMIT');
      } catch (e) {
        if (depth === 1) db.run('ROLLBACK');
        throw e;
      } finally {
        depth--;
      }
    },
  };
  return self;
}

/**
 * 0.15.1: the same database for the engine that answers later (AsyncSyncEngine): each thing the engine
 * does holds it, one at a time, as it would on the iPhone's own SQLite.
 */
export function asyncSyncDbOf(sync: SyncDb): AsyncSyncDb {
  let tail: Promise<unknown> = Promise.resolve();
  let depth = 0;
  return {
    query: async (sql, args) => sync.query(sql, args),
    exec: async (sql, args) => sync.exec(sql, args),
    async transaction(body) {
      // sql.js can't wait inside its own transaction: BEGIN and COMMIT around what's awaited.
      if (depth++ === 0) sync.exec('BEGIN');
      try {
        await body();
        if (depth === 1) sync.exec('COMMIT');
      } catch (e) {
        if (depth === 1) sync.exec('ROLLBACK');
        throw e;
      } finally {
        depth--;
      }
    },
    exclusive(fn) {
      const go = tail.then(fn, fn);
      tail = go.catch(() => undefined);
      return go;
    },
  };
}
