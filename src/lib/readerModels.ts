// The photo reader's two model files (PaddleOCR's PP-OCRv5 mobile, Apache-2.0; about 20 MB together).
// The phone and tablet apps no longer carry them: they're downloaded the first time the reader is
// wanted, after asking, kept in the app's own storage, and can be removed and downloaded again from
// Settings. The reader's own code (the engine) stays part of the app.
//
// Where from: Restock's own repository on GitHub, at a fixed release tag, so the files can never
// change under an installed app. Each file's size and SHA-256 fingerprint are checked before it is
// kept; anything else is thrown away. Nothing about you or your photos is sent: it's a plain download
// of the same two files for everyone, and photos are still read on the device.

export interface ReaderModel {
  key: 'det' | 'rec';
  file: string;
  bytes: number;
  sha256: string;
}

export const READER_MODELS: readonly ReaderModel[] = [
  { key: 'det', file: 'ppocrv5-mobile-det.onnx', bytes: 4_819_576, sha256: '4d97c44a20d30a81aad087d6a396b08f786c4635742afc391f6621f5c6ae78ae' },
  { key: 'rec', file: 'ppocrv5-mobile-rec.onnx', bytes: 16_631_306, sha256: '5825fc7ebf84ae7a412be049820b4d86d77620f204a041697b0494669b1742c5' },
];
export const READER_SOURCE = 'https://raw.githubusercontent.com/d-plenty/Restock/v0.14.0/src/assets/reader/';
export const READER_BYTES = READER_MODELS.reduce((n, m) => n + m.bytes, 0);
/** "20 MB", for the words on screen. */
export const READER_SIZE_TEXT = `${Math.round(READER_BYTES / 1_000_000)} MB`;
/** What it's for, in one line: used wherever the download is offered. */
export const READER_WHAT = 'It reads receipts, and reads a product’s name from a photo when you add something without a barcode.';

/** Built into this build (the Restock server's web pages): nothing to download or remove. */
export const readerBundled = (): boolean => typeof __READER_BUNDLED__ !== 'undefined' && __READER_BUNDLED__;

// ---------- where the files are kept ----------

export interface ModelStore {
  get(key: string): Promise<ArrayBuffer | undefined>;
  put(key: string, bytes: ArrayBuffer): Promise<void>;
  remove(key: string): Promise<void>;
}

const IDB = 'restock-reader';
const FILES = 'files';
function idb<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(IDB, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(FILES);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction(FILES, mode);
      const req = fn(tx.objectStore(FILES));
      // A write counts once the transaction is done, not when the request is.
      if (mode === 'readonly') req.onsuccess = () => resolve(req.result);
      else tx.oncomplete = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('Storage is full'));
    };
  });
}
/** The app's own storage (IndexedDB), apart from the database. */
const deviceStore: ModelStore = {
  get: async (key) => {
    const v = await idb<unknown>('readonly', (s) => s.get(key));
    return v instanceof ArrayBuffer ? v : undefined;
  },
  put: async (key, bytes) => void (await idb('readwrite', (s) => s.put(bytes, key))),
  remove: async (key) => void (await idb('readwrite', (s) => s.delete(key))),
};

// ---------- checking and downloading ----------

export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** The file is exactly the one expected: the right size and the right fingerprint. */
export async function modelOk(m: ReaderModel, bytes: ArrayBuffer | undefined): Promise<boolean> {
  return !!bytes && bytes.byteLength === m.bytes && (await sha256Hex(bytes)) === m.sha256;
}

/** Both files are here. (Their fingerprints were checked when they were kept; the size is checked again.) */
export async function readerDownloaded(store: ModelStore = deviceStore): Promise<boolean> {
  try {
    for (const m of READER_MODELS) if ((await store.get(m.key))?.byteLength !== m.bytes) return false;
    return true;
  } catch {
    return false;
  }
}

export interface DownloadDeps {
  store?: ModelStore;
  /** The file's bytes, telling `onBytes` as they arrive. Throws when it can't be fetched. */
  fetchFile?: (url: string, onBytes: (n: number) => void, signal?: AbortSignal) => Promise<ArrayBuffer>;
  signal?: AbortSignal;
}

async function fetchWithProgress(url: string, onBytes: (n: number) => void, signal?: AbortSignal): Promise<ArrayBuffer> {
  const r = await fetch(url, { signal, cache: 'no-store' });
  if (!r.ok) throw new Error(`GitHub answered ${r.status}`);
  if (!r.body) {
    const all = await r.arrayBuffer();
    onBytes(all.byteLength);
    return all;
  }
  const reader = r.body.getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    n += value.byteLength;
    // Far more than the file should be: stop, rather than fill the device.
    if (n > READER_BYTES * 2) throw new Error('The download was bigger than it should be');
    onBytes(n);
  }
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out.buffer;
}

let running: Promise<void> | undefined;

/**
 * Downloads what's missing, checks it, and keeps it. `onProgress` hears the bytes so far out of
 * READER_BYTES. A file that isn't exactly the one expected is never kept. One download at a time:
 * asking again while one is going waits for that one.
 */
export function downloadReader(onProgress?: (done: number, total: number) => void, deps: DownloadDeps = {}): Promise<void> {
  running ??= (async () => {
    const store = deps.store ?? deviceStore;
    const get = deps.fetchFile ?? fetchWithProgress;
    let before = 0;
    for (const m of READER_MODELS) {
      const have = await store.get(m.key).catch(() => undefined);
      if (!(await modelOk(m, have))) {
        const got = await get(READER_SOURCE + m.file, (n) => onProgress?.(before + Math.min(n, m.bytes), READER_BYTES), deps.signal);
        if (!(await modelOk(m, got))) throw new Error('The download didn’t match what Restock expects, so it wasn’t kept. Try again.');
        try {
          await store.put(m.key, got);
        } catch {
          throw new Error(`There isn’t room to keep it. It needs about ${READER_SIZE_TEXT}.`);
        }
      }
      before += m.bytes;
      onProgress?.(before, READER_BYTES);
    }
  })().finally(() => (running = undefined));
  return running;
}

/** Removes the reader's files (it can be downloaded again any time). */
export async function removeReader(store: ModelStore = deviceStore): Promise<void> {
  for (const m of READER_MODELS) await store.remove(m.key).catch(() => undefined);
}

// ---------- handing the files to the reader ----------

/** The two kept files, for the reader's worker (handed over whole when the worker starts). */
export async function readerFiles(store: ModelStore = deviceStore): Promise<{ det: ArrayBuffer; rec: ArrayBuffer } | undefined> {
  const [det, rec] = await Promise.all(READER_MODELS.map((m) => store.get(m.key).catch(() => undefined)));
  if (det?.byteLength !== READER_MODELS[0].bytes || rec?.byteLength !== READER_MODELS[1].bytes) return undefined;
  return { det, rec };
}
