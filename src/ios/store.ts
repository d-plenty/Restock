// The iPhone and iPad app's database file. The database runs in memory (sql.js: the sync engine the
// app shares with the Restock server needs to read and write it without waiting), and after each
// change it is written out as one real SQLite file in the app's own storage (Application Support,
// "Restock/restock.sqlite"), by the app's native side: written beside the old file and swapped in, so
// a save that is cut short never leaves half a file. Before this it was kept in the web view's
// storage; that copy is read once, written to the file, and left where it is.
import { appleHere, RestockApple } from './apple';

export const DB_FILE = 'restock.sqlite';
/** The plugin version that has the file store. */
export const STORE_VERSION = 3;

export const bytesToB64 = (b: Uint8Array): string => {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000) as unknown as number[]);
  return btoa(s);
};
export const b64ToBytes = (s: string): Uint8Array => {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

/** A SQLite file starts with these 16 bytes. Anything else is never loaded as the database. */
const MAGIC = 'SQLite format 3\u0000';
export const looksLikeSqlite = (b: Uint8Array | undefined): b is Uint8Array =>
  !!b && b.length >= 100 && MAGIC.split('').every((c, i) => b[i] === c.charCodeAt(0));

export interface FileStore {
  read(name: string): Promise<Uint8Array | undefined>;
  write(name: string, bytes: Uint8Array): Promise<void>;
  remove(name: string): Promise<void>;
}

/** The native file store, when this build of the app's native side has it. */
export async function fileStore(): Promise<FileStore | undefined> {
  if (!appleHere()) return undefined;
  try {
    const info = await RestockApple.info();
    if (!(info.version >= STORE_VERSION)) return undefined;
  } catch {
    return undefined;
  }
  return {
    async read(name) {
      const r = await RestockApple.storeRead({ name });
      return r.found && r.data ? b64ToBytes(r.data) : undefined;
    },
    async write(name, bytes) {
      const r = await RestockApple.storeWrite({ name, data: bytesToB64(bytes) });
      if (r.bytes !== bytes.length) throw new Error(`Only ${r.bytes} of ${bytes.length} bytes were written`);
    },
    async remove(name) {
      await RestockApple.storeDelete({ name });
    },
  };
}

/** The web view's storage, as the app kept its database before the file. */
export interface WebCopy {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
}

/**
 * Where the database is read from at start-up and written to after changes.
 *
 * Reading: the file, unless the last save had to fall back to the web view's storage (`fileBehind`),
 * in which case that newer copy is used. No file yet (the first start after updating): the web view's
 * copy, which is then written to the file straight away.
 *
 * Writing: the file. If that fails, the web view's storage, marked as the newer one, and the failure
 * is still reported (the caller hears the error) so it isn't silent.
 */
export function databaseStore(file: FileStore | undefined, web: WebCopy, heard: { saved: (where: 'file' | 'web', bytes: number) => void } = { saved: () => undefined }) {
  const webBytes = async () => {
    const v = await web.get('db').catch(() => undefined);
    return v instanceof Uint8Array ? v : undefined;
  };
  let needsFirstWrite = false;
  return {
    async restore(): Promise<Uint8Array | undefined> {
      if (!file) return webBytes();
      const behind = !!(await web.get('fileBehind').catch(() => undefined));
      const fromWeb = await webBytes();
      if (behind && looksLikeSqlite(fromWeb)) {
        needsFirstWrite = true;
        return fromWeb;
      }
      const fromFile = await file.read(DB_FILE).catch(() => undefined);
      if (looksLikeSqlite(fromFile)) return fromFile;
      needsFirstWrite = looksLikeSqlite(fromWeb);
      return fromWeb;
    },
    /** True when what was restored isn't in the file yet (moved over from the web view's storage). */
    needsFirstWrite: () => needsFirstWrite,
    async persist(bytes: Uint8Array): Promise<void> {
      if (!file) {
        await web.put('db', bytes);
        heard.saved('web', bytes.length);
        return;
      }
      try {
        await file.write(DB_FILE, bytes);
      } catch (e) {
        // Keep the change somewhere, and remember that the file is the older copy now.
        await web.put('db', bytes);
        await web.put('fileBehind', 1);
        throw e;
      }
      needsFirstWrite = false;
      heard.saved('file', bytes.length);
      if (await web.get('fileBehind').catch(() => undefined)) await web.put('fileBehind', 0).catch(() => undefined);
    },
  };
}
