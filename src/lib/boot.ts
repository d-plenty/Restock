import { Capacitor } from '@capacitor/core';
import { ensureDefaults, getSettings, initDb, useDriver } from './db';
import { createNativeDriver, RestockNative } from './sql/native';
import { SYNC_VERSION } from './sql/schema';
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

export async function openDatabase(): Promise<void> {
  if (Capacitor.isNativePlatform()) {
    const d = createNativeDriver();
    await backupBeforeUpgrade(d);
    await initDb(d);
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

/** Where the copy made just before the 0.8.0 upgrade is kept (Settings → Data and backup). */
export const BEFORE_UPGRADE_FILE = 'backups/before-0.8.0.json';

/**
 * 0.8.0 adds sync to the database. Just before that upgrade runs, Restock saves a full backup
 * (without receipt photos) inside the app, and in the automatic backup folder if one is set.
 * If it can't, the upgrade still goes ahead: it only adds tables.
 */
async function backupBeforeUpgrade(d: SqlDriver): Promise<void> {
  try {
    const [{ user_version }] = await d.query<{ user_version: number }>('PRAGMA user_version');
    const v = Number(user_version);
    if (v === 0 || v > SYNC_VERSION) return;
    useDriver(d);
    const { saveCopyInApp } = await import('./backup');
    const json = await saveCopyInApp(BEFORE_UPGRADE_FILE);
    const s = await getSettings().catch(() => undefined);
    if (s?.autoBackup.folder) {
      await RestockNative.writeBackup({ uri: s.autoBackup.folder, name: 'restock-before-0.8.0.json', json, keep: s.autoBackup.keep + 1 }).catch(
        () => undefined,
      );
    }
  } catch (e) {
    console.error('backup before upgrade failed', e);
  }
}
