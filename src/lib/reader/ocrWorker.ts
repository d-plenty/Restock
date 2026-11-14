/// <reference lib="webworker" />
// 0.10.7: the text reader's own worker, so reading a photo never freezes the screen. It runs
// PaddleOCR's PP-OCRv5 mobile models (Apache-2.0) with ONNX Runtime Web (MIT) through paddleocr.js
// (MIT). Everything it loads is part of the app: nothing is downloaded and no photo leaves the phone.
import * as ort from 'onnxruntime-web/wasm';
import { PaddleOcrService, parseRecognitionDictionary, type OrtModule } from 'paddleocr';

export interface WorkerFiles {
  det: string;
  rec: string;
  dict: string;
  wasm: string;
  mjs: string;
}
export type ToWorker = { id: number; files: WorkerFiles; width: number; height: number; data: Uint8ClampedArray };
export type RawLine = { text: string; confidence: number; points: { x: number; y: number }[] };
export type FromWorker = { id: number; lines?: RawLine[]; error?: string };

let service: Promise<PaddleOcrService> | undefined;

async function bytes(url: string): Promise<ArrayBuffer> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Couldn't load the text reader (${r.status}).`);
  return r.arrayBuffer();
}

function start(files: WorkerFiles): Promise<PaddleOcrService> {
  if (!service) {
    // One thread: a phone's WebView can't share memory between threads without special headers.
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.proxy = false;
    ort.env.wasm.wasmPaths = { wasm: new URL(files.wasm, self.location.href).href, mjs: new URL(files.mjs, self.location.href).href };
    service = (async () => {
      const [det, rec, dict] = await Promise.all([bytes(files.det), bytes(files.rec), fetch(files.dict).then((r) => r.text())]);
      return PaddleOcrService.createInstance({
        // paddleocr.js describes ONNX Runtime more narrowly than its own types do
        ort: ort as unknown as OrtModule,
        modelPreset: 'PP-OCRv5_mobile',
        detection: { modelBuffer: det },
        recognition: { modelBuffer: rec, charactersDictionary: parseRecognitionDictionary(dict) },
      });
    })();
    service.catch(() => (service = undefined));
  }
  return service;
}

self.onmessage = async (e: MessageEvent<ToWorker>) => {
  const { id, files, width, height, data } = e.data;
  try {
    const ocr = await start(files);
    const out = await ocr.recognize({ width, height, data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) });
    const lines: RawLine[] = out
      .filter((r) => r.text && r.text.trim())
      .map((r) => ({ text: r.text.trim(), confidence: r.confidence, points: r.box.points ?? [] }));
    (self as unknown as Worker).postMessage({ id, lines } satisfies FromWorker);
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: err instanceof Error ? err.message : String(err) } satisfies FromWorker);
  }
};
