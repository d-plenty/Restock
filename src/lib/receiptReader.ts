import { Capacitor } from '@capacitor/core';
import workerUrl from 'tesseract.js/dist/worker.min.js?url';
import { RestockNative } from './sql/native';
import { isNative } from '../stores/http';

// The receipt reader: Tesseract (open-source text recognition) running on the phone. Its engine
// and its English model are a one-off download of about 7 MB, kept in Restock's own storage, so
// the app itself stays small and nobody downloads it who doesn't use receipts. Nothing is sent
// anywhere to read a receipt.

const CORE_VERSION = '7.0.0';
const DATA_VERSION = '1.0.0';

export const ADDON_FILES = [
  {
    path: 'receipt-reader/tesseract-core.wasm.js',
    url: `https://cdn.jsdelivr.net/npm/tesseract.js-core@${CORE_VERSION}/tesseract-core-simd-lstm.wasm.js`,
    bytes: 3_899_472,
  },
  {
    path: 'receipt-reader/eng.traineddata.gz',
    url: `https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng@${DATA_VERSION}/4.0.0_best_int/eng.traineddata.gz`,
    bytes: 2_952_873,
  },
];

export const ADDON_BYTES = ADDON_FILES.reduce((n, f) => n + f.bytes, 0);
export const ADDON_SIZE_TEXT = `about ${Math.round(ADDON_BYTES / 1_000_000)} MB`;
export const ADDON_SOURCE = 'jsDelivr, a free host for open-source files';

// In a desktop browser (testing) the files come straight from the web, or from VITE_READER_BASE.
const webBase = (import.meta.env.VITE_READER_BASE as string | undefined)?.replace(/\/$/, '');
const webUrl = (f: (typeof ADDON_FILES)[number]) => (webBase ? `${webBase}/${f.path.split('/').pop()}` : f.url);

/** Whether the reader's files are on the phone. */
export async function readerInstalled(): Promise<boolean> {
  if (!isNative()) return true;
  try {
    const all = await Promise.all(ADDON_FILES.map((f) => RestockNative.appFileInfo({ path: f.path })));
    return all.every((i, n) => i.exists && i.bytes === ADDON_FILES[n].bytes);
  } catch {
    return false;
  }
}

/** Downloads the reader. `onProgress` gets 0–1. */
export async function installReader(onProgress?: (fraction: number) => void): Promise<void> {
  if (!isNative()) {
    onProgress?.(1);
    return;
  }
  const done = new Map<string, number>();
  const report = () => onProgress?.(Math.min(1, [...done.values()].reduce((a, b) => a + b, 0) / ADDON_BYTES));
  const sub = await RestockNative.addListener('downloadProgress', (e) => {
    done.set(e.path, e.bytes);
    report();
  });
  try {
    for (const f of ADDON_FILES) {
      const have = await RestockNative.appFileInfo({ path: f.path }).catch(() => undefined);
      if (!have?.exists || have.bytes !== f.bytes) await RestockNative.downloadAppFile({ url: f.url, path: f.path });
      done.set(f.path, f.bytes);
      report();
    }
  } finally {
    await sub.remove();
  }
  stopReader();
}

export async function removeReader(): Promise<void> {
  stopReader();
  if (isNative()) await RestockNative.deleteAppDir({ path: 'receipt-reader' });
}

async function fileBytes(f: (typeof ADDON_FILES)[number]): Promise<ArrayBuffer> {
  let url = webUrl(f);
  if (isNative()) {
    const info = await RestockNative.appFileInfo({ path: f.path });
    if (!info.exists) throw new Error('The receipt reader isn’t downloaded yet.');
    url = Capacitor.convertFileSrc(info.uri);
  }
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Couldn't load the receipt reader (${r.status}).`);
  return r.arrayBuffer();
}

type TWorker = import('tesseract.js').Worker;
let worker: Promise<TWorker> | undefined;
let idle: ReturnType<typeof setTimeout> | undefined;

/** Starts the reader (a second or two), or reuses the running one. */
function getWorker(onStatus?: (s: string) => void): Promise<TWorker> {
  if (idle) clearTimeout(idle);
  if (!worker) {
    worker = (async () => {
      onStatus?.('Starting the receipt reader…');
      const [{ createWorker, OEM }, core, lang] = await Promise.all([import('tesseract.js'), fileBytes(ADDON_FILES[0]), fileBytes(ADDON_FILES[1])]);
      // Everything is handed to Tesseract from memory, so nothing is fetched by its worker: the
      // engine as a blob (the "#.js" tells Tesseract it's the file itself, not a folder), and the
      // English model through a small wrapper that answers the worker's request for it.
      const blobUrl = (data: BlobPart, type: string) => URL.createObjectURL(new Blob([data], { type }));
      const coreUrl = `${blobUrl(core, 'text/javascript')}#core.wasm.js`;
      const langUrl = blobUrl(lang, 'application/gzip');
      const realWorker = new URL(workerUrl, location.href).href;
      const wrapper = blobUrl(
        `const f = self.fetch.bind(self);
self.fetch = (u, o) => (String(u).endsWith('/eng.traineddata.gz') ? f(${JSON.stringify(langUrl)}) : f(u, o));
importScripts(${JSON.stringify(realWorker)});`,
        'text/javascript',
      );
      return createWorker('eng', OEM.LSTM_ONLY, {
        workerPath: wrapper,
        corePath: coreUrl,
        langPath: 'https://reader.restock.invalid',
        cacheMethod: 'none',
        gzip: true,
      });
    })();
    worker.catch(() => (worker = undefined));
  }
  return worker;
}

/** Stops the reader to free its memory (it restarts when needed). */
export function stopReader(): void {
  const w = worker;
  worker = undefined;
  void w?.then((x) => x.terminate()).catch(() => undefined);
}

export interface ReadLine {
  text: string;
  /** Height of the text, in pixels: big text on a pack is usually the product's name. */
  height: number;
  confidence: number;
}

/** Reads the words in a picture. */
export async function readText(image: Blob | HTMLCanvasElement, onStatus?: (s: string) => void): Promise<{ text: string; lines: ReadLine[] }> {
  const w = await getWorker(onStatus);
  onStatus?.('Reading the words…');
  const { data } = await w.recognize(image, {}, { text: true, blocks: true });
  const lines: ReadLine[] = [];
  for (const b of data.blocks ?? [])
    for (const p of b.paragraphs)
      for (const l of p.lines) lines.push({ text: l.text.trim(), height: l.bbox.y1 - l.bbox.y0, confidence: l.confidence });
  // Keep it loaded for a minute in case there's another one; then let the memory go.
  idle = setTimeout(stopReader, 60_000);
  // Stray marks at the paper's edge come out as lines of "|" or dots: leave those out.
  const text = data.text
    .split('\n')
    .filter((l) => !l.trim() || /[A-Za-z0-9]/.test(l))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text, lines: lines.filter((l) => /[A-Za-z0-9]/.test(l.text)) };
}
