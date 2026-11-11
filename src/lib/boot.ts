import { Capacitor } from '@capacitor/core';
import { ensureDefaults, initDb } from './db';
import { createNativeDriver } from './sql/native';
import { MIGRATIONS } from './sql/schema';
import type { SqlDriver } from './sql/driver';
import { createSqlJsDriver } from './sql/sqljs';

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
  if (Capacitor.isNativePlatform()) {
    const d = createNativeDriver();
    const updated = await versionChanged(d);
    await initDb(d);
    if (updated) {
      // A new version: look at the household record afresh at the next sync (just that, not
      // everything), so anything an older version turned away (a takeover with the recovery key,
      // say) counts now; and read the folder's files again.
      await d.run("INSERT OR REPLACE INTO sync_meta (key, value) VALUES ('rehousehold', '1')").catch(() => undefined);
      await d.run("DELETE FROM sync_meta WHERE key LIKE 'folder_seen:%' OR key LIKE 'folder_ver:%'").catch(() => undefined);
    }
    await d.run("INSERT OR REPLACE INTO kv (key, value) VALUES ('appVersion', ?)", [JSON.stringify(__APP_VERSION__)]).catch(() => undefined);
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
    const driver = await createSqlJsDriver({
      load,
      restore: async () => {
        try {
          return (await idb<Uint8Array | undefined>('readonly', (s) => s.get('db'))) ?? undefined;
        } catch {
          return undefined;
        }
      },
      persist: async (bytes) => {
        try {
          await idb('readwrite', (s) => s.put(bytes, 'db'));
        } catch {
          // Preview only; losing this is harmless.
        }
      },
    });
    await initDb(driver);
  }
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
