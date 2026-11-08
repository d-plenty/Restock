import workerUrl from 'tesseract.js/dist/worker.min.js?url';
import { RestockNative } from './sql/native';
import { isNative } from '../stores/http';

// The receipt reader: Tesseract (open-source text recognition) running on the phone. Since 0.7.4
// its engine and English model ship inside the app (about 7 MB), so nothing is downloaded and it
// works offline. Nothing is sent anywhere to read a receipt. Both come from npm packages
// (tesseract.js-core, Apache-2.0; @tesseract.js-data/eng, MIT), so F-Droid builds them from source.
import coreFile from 'tesseract.js-core/tesseract-core-simd-lstm.wasm.js?url';
import langFile from '@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz?url';

/** The reader is part of the app: always there. Kept so older screens and settings keep working. */
export async function readerInstalled(): Promise<boolean> {
  return true;
}

/**
 * Before 0.7.4 the reader was a separate download into Restock's storage. Clears that old copy (it
 * isn't used any more) to free the space. Safe to call any time.
 */
export async function removeOldDownload(): Promise<void> {
  if (!isNative()) return;
  await RestockNative.deleteAppDir({ path: 'receipt-reader' }).catch(() => undefined);
}

async function fileBytes(url: string): Promise<ArrayBuffer> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Couldn't load the receipt reader (${r.status}).`);
  return r.arrayBuffer();
}

/**
 * The English model, packed (gzip). It's built as "….gz.bin" so Android leaves it alone (0.8.7);
 * in case a build still unpacked it and dropped the ".gz", the unpacked copy is tried too.
 */
async function modelBytes(): Promise<{ bytes: ArrayBuffer; packed: boolean }> {
  try {
    return { bytes: await fileBytes(langFile), packed: true };
  } catch (e) {
    const unpacked = langFile.replace(/\.gz(\.bin)?$/, '');
    if (unpacked === langFile) throw e;
    return { bytes: await fileBytes(unpacked), packed: false };
  }
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
      const [{ createWorker, OEM }, core, model] = await Promise.all([import('tesseract.js'), fileBytes(coreFile), modelBytes()]);
      // Everything is handed to Tesseract from memory, so nothing is fetched by its worker: the
      // engine as a blob (the "#.js" tells Tesseract it's the file itself, not a folder), and the
      // English model through a small wrapper that answers the worker's request for it.
      const blobUrl = (data: BlobPart, type: string) => URL.createObjectURL(new Blob([data], { type }));
      const coreUrl = `${blobUrl(core, 'text/javascript')}#core.wasm.js`;
      const langUrl = blobUrl(model.bytes, model.packed ? 'application/gzip' : 'application/octet-stream');
      const realWorker = new URL(workerUrl, location.href).href;
      const wrapper = blobUrl(
        `const f = self.fetch.bind(self);
self.fetch = (u, o) => (String(u).endsWith('/eng.traineddata.gz') || String(u).endsWith('/eng.traineddata') ? f(${JSON.stringify(langUrl)}) : f(u, o));
importScripts(${JSON.stringify(realWorker)});`,
        'text/javascript',
      );
      return createWorker('eng', OEM.LSTM_ONLY, {
        workerPath: wrapper,
        corePath: coreUrl,
        langPath: 'https://reader.restock.invalid',
        cacheMethod: 'none',
        gzip: model.packed,
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
