import { Capacitor } from '@capacitor/core';
import { ensureDefaults, getSettings, initDb, useDriver } from './db';
import { createNativeDriver, RestockNative } from './sql/native';
import { MIGRATIONS } from './sql/schema';
import type { SqlDriver } from './sql/driver';
import { createSqlJsDriver } from './sql/sqljs';
import { textToBase64 } from './base64';

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
    const updated = await backupBeforeUpdate(d);
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

/** Where the copy made just before the 0.8.0 upgrade is kept (Settings → Sync and backups). */
export const BEFORE_UPGRADE_FILE = 'backups/before-0.8.0.json';

/** 0.9.0: the copies made just before an update, newest first (the last two are kept). */
export const BEFORE_UPDATE_FILES = ['backups/before-update.json', 'backups/before-update-previous.json'];
const BEFORE_UPDATE_INFO = 'backups/before-update-info.json';
const BEFORE_UPDATE_TEMP = 'backups/before-update-new.json';

export interface BeforeUpdate {
  path: string;
  /** The version it was made on (undefined: older than 0.9.0, which didn't note it). */
  from?: string;
  to: string;
  at: string;
}

/** The copies made before updates, newest first. */
export async function beforeUpdateCopies(): Promise<BeforeUpdate[]> {
  try {
    const { readCopyInApp } = await import('./backup');
    const info = await readCopyInApp(BEFORE_UPDATE_INFO);
    return info ? (JSON.parse(info) as BeforeUpdate[]) : [];
  } catch {
    return [];
  }
}

/**
 * Just before a new version first opens (0.9.0, as for 0.8.0 before it): Restock saves a full
 * backup (without receipt photos) inside the app, so an update that went wrong can be undone
 * from Settings → Sync and backups. The last two are kept. It also goes into the automatic backup
 * folder, if one is set, locked like the automatic backups. If it can't be made, the update still
 * goes ahead.
 */
/** True when this is a different version from last time (a copy was made, or tried). */
async function backupBeforeUpdate(d: SqlDriver): Promise<boolean> {
  let updated = false;
  try {
    const [{ user_version }] = await d.query<{ user_version: number }>('PRAGMA user_version');
    const v = Number(user_version);
    if (v === 0) return false; // a new install: nothing to keep
    let from: string | undefined;
    try {
      const r = await d.query<{ value: string }>("SELECT value FROM kv WHERE key = 'appVersion'");
      from = r[0] ? (JSON.parse(r[0].value) as string) : undefined;
    } catch {
      // too old to have kv: the copy below says "an older version"
    }
    if (v >= MIGRATIONS.length && from === __APP_VERSION__) return false;
    updated = true;
    useDriver(d);
    const { saveCopyInApp, readCopyInApp, backupJson, EVERYTHING } = await import('./backup');
    const { autoName } = await import('./autoBackup');
    const copies = await beforeUpdateCopies();
    // The new copy first, so a copy that can't be made (a full phone) never costs the older ones.
    const fresh = await saveCopyInApp(BEFORE_UPDATE_TEMP);
    // Then the newest becomes the previous one, and the new copy the newest.
    const newest = await readCopyInApp(BEFORE_UPDATE_FILES[0]);
    if (newest) await RestockNative.writeAppFile({ path: BEFORE_UPDATE_FILES[1], data: textToBase64(newest) });
    await RestockNative.writeAppFile({ path: BEFORE_UPDATE_FILES[0], data: textToBase64(fresh) });
    await RestockNative.deleteAppFile({ path: BEFORE_UPDATE_TEMP }).catch(() => undefined);
    const now = new Date().toISOString();
    const info: BeforeUpdate[] = [
      { path: BEFORE_UPDATE_FILES[0], from, to: __APP_VERSION__, at: now },
      ...(copies[0] && newest ? [{ ...copies[0], path: BEFORE_UPDATE_FILES[1] }] : []),
    ];
    await RestockNative.writeAppFile({ path: BEFORE_UPDATE_INFO, data: textToBase64(JSON.stringify(info)) });
    const s = await getSettings().catch(() => undefined);
    if (s?.autoBackup.folder) {
      const json = await backupJson({ ...EVERYTHING, receiptPhotos: false, password: s.autoBackup.password || undefined });
      const name = autoName().replace(/\.json$/, `-before-${__APP_VERSION__}.json`);
      await RestockNative.writeBackup({ uri: s.autoBackup.folder, name, json, keep: s.autoBackup.keep + 1 }).catch(() => undefined);
    }
  } catch (e) {
    console.error('backup before update failed', e);
  }
  return updated;
}
