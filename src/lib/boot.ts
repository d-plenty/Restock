import { Capacitor } from '@capacitor/core';
import { ensureDefaults, initDb } from './db';
import { createNativeDriver } from './sql/native';
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
    await initDb(createNativeDriver());
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
