import { RestockNative } from './sql/native';
import { isNative } from '../stores/http';
import { toLines, type ReadLine } from './reader/lines';
import type { FromWorker, ToWorker, WorkerFiles } from './reader/ocrWorker';
import { readerDownloaded, readerFiles } from './readerModels';
// The photo reader's engine and letter list are part of the app. Its two model files (PaddleOCR's
// PP-OCRv5 mobile, Apache-2.0; about 20 MB) are downloaded on first use in the phone and tablet apps
// (lib/readerModels.ts) and built into the Restock server's web pages (reader/bundled.ts). The engine
// is ONNX Runtime Web (MIT). See src/assets/reader/NOTICE.md.
import dictFile from '../assets/reader/ppocrv5-dict.txt?url';
import wasmFile from '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm?url';
import mjsFile from '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs?url';

// The text reader: reads receipts and the fronts of packs, on the phone (or in the browser, for
// the web page). 0.10.7: PaddleOCR in place of Tesseract, which was made for flat scanned pages
// and struggled with photos (shiny or curved packs, crumpled receipts, a crooked photo). It runs in
// its own worker so the screen keeps moving while it reads. Nothing is sent anywhere: the photo is
// read where it is.

export type { ReadLine };

/** Whether the reader can read: built in (the server's web pages), or its files have been downloaded. */
export async function readerInstalled(): Promise<boolean> {
  return readerDownloaded();
}

/** Thrown by readText when the reader's files aren't on the device yet. */
class ReaderMissing extends Error {
  constructor() {
    super('The photo reader isn’t downloaded yet.');
    this.name = 'ReaderMissing';
  }
}

/** The two model files (downloaded on first use, lib/readerModels.ts). */
async function modelFiles(): Promise<{ det: string | ArrayBuffer; rec: string | ArrayBuffer }> {
  const f = await readerFiles();
  if (!f) throw new ReaderMissing();
  return f;
}

/**
 * Before 0.7.4 the reader was a separate download into Restock's storage. Clears that old copy (it
 * isn't used any more) to free the space. Safe to call any time.
 */
export async function removeOldDownload(): Promise<void> {
  if (!isNative()) return;
  await RestockNative.deleteAppDir({ path: 'receipt-reader' }).catch(() => undefined);
}

/** `models`: the worker is starting, so it needs the model files too (a running one already has them). */
const files = async (models: boolean): Promise<WorkerFiles> => ({
  ...(models ? await modelFiles() : {}),
  dict: new URL(dictFile, location.href).href,
  wasm: new URL(wasmFile, location.href).href,
  mjs: new URL(mjsFile, location.href).href,
});

let worker: Worker | undefined;
let idle: ReturnType<typeof setTimeout> | undefined;
let next = 1;
const waiting = new Map<number, { ok: (lines: FromWorker['lines']) => void; fail: (e: Error) => void }>();

function getWorker(): Worker {
  if (idle) clearTimeout(idle);
  if (!worker) {
    worker = new Worker(new URL('./reader/ocrWorker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<FromWorker>) => {
      const w = waiting.get(e.data.id);
      if (!w) return;
      waiting.delete(e.data.id);
      if (e.data.error) {
        w.fail(new Error(e.data.error));
        // Start afresh next time (a new worker is handed the model files again).
        if (!waiting.size) stopReader();
      } else w.ok(e.data.lines ?? []);
    };
    worker.onerror = (e) => {
      for (const w of waiting.values()) w.fail(new Error(e.message || "The text reader stopped. Try again."));
      waiting.clear();
      stopReader();
    };
  }
  return worker;
}

/** Stops the reader to free its memory (it restarts when needed). */
function stopReader(): void {
  worker?.terminate();
  worker = undefined;
}

/** Big photos are read at this size at most: plenty for print, and far quicker on a phone. */
const MAX_SIDE = 2000;

function pixels(image: HTMLCanvasElement): { width: number; height: number; data: Uint8ClampedArray } {
  const k = Math.min(1, MAX_SIDE / Math.max(image.width, image.height));
  let c = image;
  if (k < 1) {
    c = document.createElement('canvas');
    c.width = Math.round(image.width * k);
    c.height = Math.round(image.height * k);
    c.getContext('2d')!.drawImage(image, 0, 0, c.width, c.height);
  }
  const d = c.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, c.width, c.height);
  return { width: d.width, height: d.height, data: d.data };
}

async function canvasFrom(image: Blob | HTMLCanvasElement): Promise<HTMLCanvasElement> {
  if (!(image instanceof Blob)) return image;
  const bmp = await createImageBitmap(image, {
    imageOrientation: 'from-image',
  });
  // 0.10.8: drawn straight at the reading size (a 12-megapixel photo at full size is ~48 MB of
  // memory for nothing, which an older phone may not have)
  const k = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * k);
  c.height = Math.round(bmp.height * k);
  c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close();
  return c;
}

/** Reads the words in a picture: the text line by line, and each line's size (for a pack's name). */
export async function readText(image: Blob | HTMLCanvasElement, onStatus?: (s: string) => void): Promise<{ text: string; lines: ReadLine[] }> {
  // Before anything else: without its files there's nothing to read with (the caller offers the download).
  if (!worker && !(await readerInstalled())) throw new ReaderMissing();
  onStatus?.('Reading the words…');
  const px = pixels(await canvasFrom(image));
  const starting = !worker;
  const f = await files(starting);
  const w = getWorker();
  const id = next++;
  const found = await new Promise<FromWorker['lines']>((ok, fail) => {
    waiting.set(id, { ok, fail });
    // The model files go across once, when the worker starts (handed over, not copied).
    const hand = [f.det, f.rec].filter((x): x is ArrayBuffer => x instanceof ArrayBuffer);
    w.postMessage({ id, files: f, ...px } satisfies ToWorker, [px.data.buffer, ...hand]);
  });
  // Keep it loaded for a minute in case there's another one; then let the memory go.
  idle = setTimeout(stopReader, 60_000);
  return toLines(found ?? []);
}
