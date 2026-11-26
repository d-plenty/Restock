import { Capacitor } from '@capacitor/core';
import { ensureDefaults, initDb, setMarketDriver } from './db';
import { createNativeDriver } from './sql/native';
import { MIGRATIONS } from './sql/schema';
import type { SqlDriver } from './sql/driver';
import { createSqlJsDriver, type SqlJsDriver } from './sql/sqljs';
import { MARKET_TABLE } from './sql/schema';
import type { SqlValue } from './sql/driver';
import { isIos } from './platform';
import { noteSaved, noteSaveFailed, saveState, setSaveFlusher } from './saveState';
import { quiet } from './quietErrors';

/** A save writes the whole file: with the shared price history in it (several megabytes) it waits a little longer after a change. */
const BIG_DB = 4_000_000;

// Opens the database: the phone's SQLite on Android, or sql.js (kept in the browser's
// storage) in the web preview.

const IDB_NAME = 'restock-web';
const IDB_STORE = 'files';

function idb<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(IDB_NAME, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(IDB_STORE);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction(IDB_STORE, mode);
      const req = fn(tx.objectStore(IDB_STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    };
  });
}

/** 0.9.2: the web app on a Restock server opens its own copy (src/server-mode/live.ts). */
let opener: (() => Promise<void>) | undefined;
export const setDatabaseOpener = (fn: () => Promise<void>) => (opener = fn);

export async function openDatabase(): Promise<void> {
  if (opener) return opener();
  // 0.15.1: the iPhone and iPad app in the system's own SQLite (ios/nativeDb.ts), as Android is in its own.
  if (Capacitor.isNativePlatform() && isIos() && (await import('../ios/nativeDb').then((m) => m.nativeSqlHere()))) return openAppleDatabase();
  // iPhone app: Android has its own SQLite. The iPhone app keeps the same database with sql.js, in the
  // app's own web storage (it isn't Safari's, so iOS doesn't clear it after a week unused).
  if (Capacitor.isNativePlatform() && !isIos()) {
    const d = createNativeDriver();
    const updated = await versionChanged(d);
    await initDb(d);
    if (updated) {
      // A new version: look at the household record afresh at the next sync (just that, not
      // everything), so anything an older version turned away (a takeover with the recovery key,
      // say) counts now; and read the folder's files again.
      await d.run("INSERT OR REPLACE INTO sync_meta (key, value) VALUES ('rehousehold', '1')").catch(quiet('database'));
      await d.run("DELETE FROM sync_meta WHERE key LIKE 'folder_seen:%' OR key LIKE 'folder_ver:%'").catch(quiet('database'));
    }
    await d.run("INSERT OR REPLACE INTO kv (key, value) VALUES ('appVersion', ?)", [JSON.stringify(__APP_VERSION__)]).catch(quiet('database'));
  } else {
    // The one-file preview uses the pure-JavaScript SQLite build (no WebAssembly needed).
    const load =
      import.meta.env.VITE_PREVIEW === '1'
        ? async () => (await import('sql.js/dist/sql-asm.js')).default()
        : async () => {
            const [{ default: initSqlJs }, { default: wasmUrl }] = await Promise.all([
              import('sql.js'),
              import('sql.js/dist/sql-wasm-browser.wasm?url'),
            ]);
            return initSqlJs({ locateFile: () => wasmUrl });
          };
    const ios = Capacitor.isNativePlatform() && isIos();
    // The iPhone and iPad app keeps its database as a real file in the app's own storage (ios/store.ts).
    const store = ios
      ? await (async () => {
          const { databaseStore, fileStore } = await import('../ios/store');
          const web = {
            get: (key: string) => idb<unknown>('readonly', (s) => s.get(key)),
            put: async (key: string, value: unknown) => void (await idb('readwrite', (s) => s.put(value, key))),
          };
          return databaseStore(await fileStore().catch(() => undefined), web, { saved: noteSaved });
        })()
      : undefined;
    const driver = await createSqlJsDriver({
      load,
      restore: store
        ? () => store.restore()
        : async () => {
            try {
              return (await idb<Uint8Array | undefined>('readonly', (s) => s.get('db'))) ?? undefined;
            } catch {
              return undefined;
            }
          },
      persist: store
        ? (bytes) => store.persist(bytes)
        : async (bytes) => {
            try {
              await idb('readwrite', (s) => s.put(bytes, 'db'));
            } catch {
              // Preview only; losing this is harmless.
            }
          },
      // On the iPhone a save writes the whole file: a little later, and never put off for long.
      ...(ios ? { saveAfterMs: () => ((saveState().bytes ?? 0) > BIG_DB ? 2000 : 600), saveWithinMs: 6000, onSaved: (e?: unknown) => (e ? noteSaveFailed(e) : undefined) } : {}),
    });
    await initDb(driver);
    // 0.13.2: the iPhone and iPad app's sync works on the database itself (ios/sync.ts), as the web app's does.
    sqlJs = { db: driver.raw, saved: () => driver.touched() };
    if (ios) {
      // 0.15.0: the shared price history in a database (and file) of its own, written only when it's
      // downloaded, so the main file written after every change stays small.
      const market = await openMarketDb(load, driver);
      setMarketDriver(market);
      setSaveFlusher(async () => {
        await driver.flush();
        await market.flush();
      });
      // Moved over from the web view's storage, or upgraded just now: write the file straight away.
      driver.touched();
      if (store?.needsFirstWrite()) void driver.flush();
      // Going to the background: whatever is waiting is written now (iOS may stop the app any time after).
      const leaving = () => void driver.flush();
      document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && leaving());
      window.addEventListener('pagehide', leaving);
    }
  }
  await ensureDefaults();
}

/**
 * iPhone and iPad: the shared price history's own database. The first time, the rows already in the
 * main database move over to it (and leave the main one), so nothing is downloaded again.
 */
async function openMarketDb(load: () => Promise<import('sql.js').SqlJsStatic>, main: SqlJsDriver): Promise<SqlJsDriver> {
  const { databaseStore, fileStore, MARKET_FILE } = await import('../ios/store');
  const web = {
    get: (key: string) => idb<unknown>('readonly', (s) => s.get(key)),
    put: async (key: string, value: unknown) => void (await idb('readwrite', (s) => s.put(value, key))),
  };
  const store = databaseStore(await fileStore().catch(() => undefined), web, undefined, { file: MARKET_FILE, key: 'market', behind: 'marketBehind' });
  const m = await createSqlJsDriver({ load, restore: () => store.restore(), persist: (b) => store.persist(b), saveAfterMs: 1500, onSaved: (e) => (e ? noteSaveFailed(e) : undefined) });
  await m.run(MARKET_TABLE);
  const moving = await main.query<Record<string, SqlValue>>('SELECT chain, store_product_id, normal, sale, sale_share, low, cycle_weeks, days, source, updated_at, latest FROM market').catch(() => []);
  if (moving.length) {
    await m.batch(
      moving.map((r) => ({
        sql: 'INSERT OR REPLACE INTO market (chain, store_product_id, normal, sale, sale_share, low, cycle_weeks, days, source, updated_at, latest) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        params: [r.chain, r.store_product_id, r.normal, r.sale, r.sale_share, r.low, r.cycle_weeks, r.days, r.source, r.updated_at, r.latest],
      })),
    );
    await m.flush();
    await main.run('DELETE FROM market');
    // The space the rows took is given back, so the main file really is smaller.
    await main.run('VACUUM').catch(quiet('database'));
  }
  return m;
}

/** The sql.js database itself, where that's what this app runs on (not Android), and a nudge to save it after writing to it directly. */
let sqlJs: { db: import('sql.js').Database; saved: () => void } | undefined;
export const sqlJsDatabase = () => sqlJs;

/**
 * 0.15.1: the database the iPhone and iPad app's sync engine works on (ios/sync.ts): the system's
 * SQLite, or (a build of the app's native side without it, and the tests) the sql.js one.
 */
let syncDb: { db: import('../server-mode/engine').AsyncSyncDb; saved: () => void } | undefined;
export async function syncDatabase(): Promise<typeof syncDb> {
  if (syncDb) return syncDb;
  if (!sqlJs) return undefined;
  const { asyncSyncDbOf, syncDbOf } = await import('../server-mode/sqldb');
  syncDb = { db: asyncSyncDbOf(syncDbOf(sqlJs.db)), saved: sqlJs.saved };
  return syncDb;
}
/** Set once the database is open (and by the tests). */
export const setSyncDatabase = (d: typeof syncDb) => (syncDb = d);

/** The iPhone and iPad app on the system's SQLite: the same two files, kept as they were first (ios/nativeDb.ts). */
async function openAppleDatabase(): Promise<void> {
  const { AppleDb, readyFile, readLaneHere } = await import('../ios/nativeDb');
  const { DB_FILE, MARKET_FILE } = await import('../ios/store');
  const web = {
    get: (key: string) => idb<unknown>('readonly', (s) => s.get(key)),
    put: async (key: string, value: unknown) => void (await idb('readwrite', (s) => s.put(value, key))),
  };
  await readyFile(DB_FILE, web).catch(quiet('iPhone database'));
  await readyFile(MARKET_FILE, web).catch(quiet('iPhone database'));
  // 0.15.2: reads on a lane of their own, where this build's native side has one.
  const readLane = await readLaneHere();
  const main = new AppleDb(DB_FILE, undefined, { readLane });
  const updated = await versionChanged(main);
  await initDb(main);
  if (updated) {
    await main.run("INSERT OR REPLACE INTO sync_meta (key, value) VALUES ('rehousehold', '1')").catch(quiet('database'));
    await main.run("DELETE FROM sync_meta WHERE key LIKE 'folder_seen:%' OR key LIKE 'folder_ver:%'").catch(quiet('database'));
  }
  await main.run("INSERT OR REPLACE INTO kv (key, value) VALUES ('appVersion', ?)", [JSON.stringify(__APP_VERSION__)]).catch(quiet('database'));
  // The shared price history keeps its own file (0.15.0), so the main one stays small.
  const market = new AppleDb(MARKET_FILE, undefined, { readLane });
  await market.run(MARKET_TABLE);
  setMarketDriver(market);
  // Every change is on the disk once it answers: nothing waits to be saved.
  setSaveFlusher(async () => undefined);
  syncDb = { db: main.forEngine(), saved: () => undefined };
  await ensureDefaults();
}

/**
 * Whether this is a different version from last time (or the database needs upgrading). 0.9.6: Restock
 * no longer saves a "Backup from before ..." copy at an update, and Settings no longer lists them
 * (Export a backup and Back up automatically are the ways to keep a copy). Copies already on a phone
 * (backups/before-0.8.0.json, backups/before-update*.json) are left where they are, never deleted.
 */
async function versionChanged(d: SqlDriver): Promise<boolean> {
  try {
    const [{ user_version }] = await d.query<{ user_version: number }>('PRAGMA user_version');
    const v = Number(user_version);
    if (v === 0) return false; // a new install
    let from: string | undefined;
    try {
      const r = await d.query<{ value: string }>("SELECT value FROM kv WHERE key = 'appVersion'");
      from = r[0] ? (JSON.parse(r[0].value) as string) : undefined;
    } catch {
      // too old to have kv
    }
    return !(v >= MIGRATIONS.length && from === __APP_VERSION__);
  } catch (e) {
    console.error('version check failed', e);
    return false;
  }
}
