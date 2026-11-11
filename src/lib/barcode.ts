// Barcode lookup and scanning — all open source, no Google Play services.
// Scanning uses zxing-cpp compiled to WebAssembly (zxing-wasm, MIT licence), bundled
// inside the app so nothing is downloaded from a CDN.

export interface BarcodeInfo {
  barcode: string;
  name?: string;
  brand?: string;
  size?: string;
  imageUrl?: string;
}

/** Look up a barcode on Open Food Facts (free, open database — no account, no tracking). */
export async function lookupBarcode(barcode: string): Promise<BarcodeInfo> {
  const info: BarcodeInfo = { barcode };
  try {
    const res = await fetch(
      `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(barcode)}.json?fields=product_name,product_name_en,brands,quantity,image_small_url`,
    );
    if (!res.ok) return info;
    const json = (await res.json()) as {
      status?: number;
      product?: { product_name?: string; product_name_en?: string; brands?: string; quantity?: string; image_small_url?: string };
    };
    if (json.status !== 1 || !json.product) return info;
    const p = json.product;
    info.name = (p.product_name_en || p.product_name || '').trim() || undefined;
    info.brand = p.brands?.split(',')[0]?.trim() || undefined;
    info.size = p.quantity?.trim() || undefined;
    info.imageUrl = p.image_small_url;
  } catch {
    // Offline or blocked: carry on with just the barcode.
  }
  return info;
}

// ---------- decoding ----------

type Reader = typeof import('zxing-wasm/reader');
let reader: Promise<Reader> | undefined;

/** Loads the decoder once, pointing it at the copy bundled with the app. */
export function loadReader(): Promise<Reader> {
  if (!reader) {
    reader = (async () => {
      const [mod, { default: wasmUrl }] = await Promise.all([import('zxing-wasm/reader'), import('zxing-wasm/reader/zxing_reader.wasm?url')]);
      mod.prepareZXingModule({
        overrides: { locateFile: (path: string, prefix: string) => (path.endsWith('.wasm') ? wasmUrl : prefix + path) },
      });
      return mod;
    })();
  }
  return reader;
}

export const SCAN_FORMATS = [
  'EAN13',
  'EAN8',
  'UPCA',
  'UPCE',
  'Code128',
  'Code39',
  'ITF',
  'QRCode',
  'MicroQRCode',
  'DataMatrix',
  'DataBar',
  'DataBarExpanded',
  // 0.9.11: what loyalty and gift cards use as well.
  'Code93',
  'Codabar',
  'PDF417',
  'Aztec',
] as const;

/**
 * Turns whatever a code contains into a product number (GTIN), or undefined if it isn't one.
 * Handles plain barcodes, GS1 element strings (DataBar and Data Matrix on fresh food, like
 * "(01)09300633603205(17)270101"), and GS1 Digital Link QR codes, the web links replacing
 * barcodes on newer packs ("https://id.gs1.org/01/09300633603205/10/ABC").
 */
export function productCode(raw: string): string | undefined {
  const text = raw.trim().replace(/^\]([A-Za-z]\d)/, ''); // drop a symbology prefix like "]Q3"
  const gtin = (digits: string) => {
    // GTIN-14 with a leading zero is the same product as the 13-digit barcode on the shelf.
    let d = digits;
    while (d.length > 13 && d.startsWith('0')) d = d.slice(1);
    return /^\d{8}$|^\d{12,14}$/.test(d) ? d : undefined;
  };
  // Plain barcode number.
  if (/^\d{8,14}$/.test(text)) return gtin(text);
  // GS1 Digital Link: a URL whose path has /01/<gtin> (or /gtin/<gtin>), optionally with more parts.
  const link = text.match(/^https?:\/\/[^/]+(?:\/[^?#]*)?\/(?:01|gtin)\/(\d{8,14})(?:[/?#]|$)/i);
  if (link) return gtin(link[1]);
  // GS1 element string, with brackets or with the group separator.
  const bracket = text.match(/^\(01\)(\d{14})/);
  if (bracket) return gtin(bracket[1]);
  const plain = text.match(/^01(\d{14})(?:\x1d|\d|$)/);
  if (plain) return gtin(plain[1]);
  return undefined;
}

/** Decode the first barcode in a camera frame, if there is one. qrOnly: just QR codes (sync pairing), trying harder. */
export async function decodeFrame(image: ImageData, qrOnly = false): Promise<string | undefined> {
  const { readBarcodes } = await loadReader();
  const results = await readBarcodes(image, {
    formats: qrOnly ? ['QRCode'] : [...SCAN_FORMATS],
    tryHarder: true,
    ...(qrOnly ? { tryInvert: true, tryRotate: true, tryDownscale: true } : {}),
    maxNumberOfSymbols: 1,
  });
  const hit = results.find((r) => r.isValid && r.text);
  return hit?.text;
}

/** Find a barcode or QR code in a photo (for "import from photos"). Tries a few sizes. */
export async function decodePhoto(file: Blob): Promise<string | undefined> {
  const { readBarcodes } = await loadReader();
  const bitmap = await createImageBitmap(file);
  try {
    for (const max of [1600, 1000, 2400]) {
      const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const results = await readBarcodes(ctx.getImageData(0, 0, canvas.width, canvas.height), {
        formats: [...SCAN_FORMATS],
        tryHarder: true,
        tryRotate: true,
        tryInvert: true,
        maxNumberOfSymbols: 4,
      });
      // Prefer something that's a product code, if the photo has more than one.
      const valid = results.filter((r) => r.isValid && r.text);
      const product = valid.find((r) => productCode(r.text));
      if (product) return product.text;
      if (valid[0]) return valid[0].text;
    }
    return undefined;
  } finally {
    bitmap.close();
  }
}

// ---------- the scanner overlay (rendered by <ScannerHost /> in App) ----------

export type ScanOutcome = { ok: true; code: string } | { ok: false; reason: 'cancelled' };

/** 0.8.0: a scan for something other than a product (the sync pairing code). */
export interface ScanKind {
  /** The code to hand back, or undefined if this isn't one. */
  accept: (text: string) => string | undefined;
  /** Said when a code is read that isn't one. */
  wrong: string;
  /** Hint in the "type it" box. */
  typeHint: string;
  /** A QR code rather than a barcode: square box, sharper look at the middle of the picture. */
  qr?: boolean;
}

/**
 * 0.9.11: a loyalty or gift card: any code at all, read as it is (numbers, letters, a QR code).
 * Never "not a product barcode": a card isn't a product. A website link in a QR code is kept too.
 */
export const CARD_SCAN: ScanKind = {
  accept: (text) => {
    const t = text.trim();
    return t ? t.slice(0, 120) : undefined;
  },
  wrong: "Couldn't read that code. Hold the card flat and closer, or type the number in.",
  typeHint: 'Card number',
};

export type ScanRequest = { title: string; kind?: ScanKind; resolve: (o: ScanOutcome) => void };
type Listener = (req: ScanRequest | undefined) => void;
let listener: Listener | undefined;

export function setScannerListener(fn: Listener | undefined) {
  listener = fn;
}

/** Opens the camera scanner and resolves with the code (or cancelled). */
export function scanBarcode(title = 'Scan a barcode', kind?: ScanKind): Promise<ScanOutcome> {
  return new Promise((resolve) => {
    if (!listener) return resolve({ ok: false, reason: 'cancelled' });
    listener({
      title,
      kind,
      resolve: (o) => {
        listener?.(undefined);
        resolve(o);
      },
    });
  });
}
