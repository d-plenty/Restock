// 0.9.6: Import on the web's Data tab, without React (docs/restock-import.md): reading a file the
// person picked (the full export file .json, or the CSV files .zip the Data tab downloads), refusing
// one that carries anything secret, turning its products and prices into the chunks the server takes
// (server/src/v3/import.mjs: under its 256 KB request cap), and the words of the dry run and the end.
// The server checks every field again: this only reads the file and keeps the page honest.
import { strFromU8, unzipSync } from 'fflate';

/** The caps (IMPORT_LIMITS in server/src/v3/import.mjs, docs/restock-import.md "Limits"). */
export const LIMITS = {
  fileMb: 100,
  unzippedMb: 300,
  products: 25_000,
  prices: 500_000,
  pricesPerProduct: 5_000,
  // Smaller than the server takes (2,000 products, 5,000 prices, 256 KB a request), so each request
  // is a fraction of a second's work for the server and it answers everyone else in between.
  chunkProducts: 500,
  chunkPrices: 2_500,
  chunkBytes: 200 * 1024,
  serverProducts: 50_000,
};

/** The shop never imported or exported (Declan, 11 Nov 2026). */
export const NEVER_SHOP = 'costco';

/** A price as sent. */
export interface ImportPrice {
  date: string;
  price: number;
  was_price?: number;
  is_special?: boolean;
  member_only?: boolean;
  promo?: string;
}
/** A product as sent (the server's PRODUCT_KEYS). */
export interface ImportProduct {
  ref?: string;
  chain: string;
  store_product_id?: string;
  barcode?: string;
  name: string;
  brand?: string;
  size?: string;
  image_url?: string;
  qty?: number;
  qty_unit?: string;
  /** The rest of a product an earlier chunk started. */
  more?: true;
  prices: ImportPrice[];
}

export interface ReadFile {
  /** What was read: the full export file, or the CSV files. */
  kind: 'json' | 'csv';
  products: ImportProduct[];
  priceCount: number;
  /** Rows it couldn't read, by why (the server adds its own). */
  problems: Record<string, number>;
  costco: { products: number; prices: number };
  /** Tables in the file an import doesn't take (items, the list, receipts…), by their names. */
  notTaken: string[];
}

export class ImportRefused extends Error {}

// ---------- secrets: a file with any of them is refused whole ----------

/** Field names that mean a secret (a card number, a PIN, a password, a key) or a receipt's words or photos. */
const SECRET_FIELD = /^(number|card_?number|card_?no|pin|pin_?code|cvv|cvc|password|passphrase|pass|secret|token|access_?token|api_?key|key|private_?key|priv|recovery|recovery_?key|login_?key|session|text|receipt_?text|photo|pages|image_?data)$/i;
/** Table (or top-level) names that only hold secrets. */
const SECRET_TABLE = /^(cards?|loyalty(_?cards?)?|gift_?cards?|keys?|vault|sessions?|secrets?|passwords?|accounts?|recovery)$/i;
/** A photo carried in the file itself. */
const DATA_URL = /^data:/i;

const TAKEN = new Set(['products', 'prices']);
const KNOWN_NAMES: Record<string, string> = {
  items: 'pantry items',
  list: 'the shopping list',
  receipts: 'receipts',
  categories: 'categories',
  shops: 'shops',
  settings: 'settings',
  aliases: 'words for items',
  spending: 'spending',
  ticked: 'what was ticked off',
};

/** Throws ImportRefused when the file holds a secret anywhere: a field, a table, a photo. */
export function refuseSecrets(tables: Record<string, unknown>, top: Record<string, unknown> = {}): void {
  for (const k of Object.keys(top)) if (SECRET_TABLE.test(k)) throw new ImportRefused(secretWords(k));
  for (const [name, v] of Object.entries(tables)) {
    if (SECRET_TABLE.test(name)) throw new ImportRefused(secretWords(name));
    if (!Array.isArray(v)) continue;
    for (const row of v) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
      for (const [k, x] of Object.entries(row as Record<string, unknown>)) {
        // The export's own receipts say how many photos a receipt has (`photos`, a count), never one.
        if (SECRET_FIELD.test(k) && !(name === 'receipts' && k === 'photos' && typeof x === 'number')) {
          if (x === null || x === undefined || x === '' || (name === 'list' && k === 'text') || (name === 'ticked' && k === 'text')) continue;
          throw new ImportRefused(secretWords(k));
        }
        if (typeof x === 'string' && DATA_URL.test(x)) throw new ImportRefused('This file has a picture or photo inside it. Restock imports products and prices only: take the photos out and try again.');
        // A product's own prices, written in the product row.
        if (k === 'prices' && Array.isArray(x)) refuseSecrets({ [`${name}.prices`]: x });
      }
    }
  }
}
const secretWords = (what: string) =>
  `This file has "${what.slice(0, 40)}" in it. Restock never imports card numbers, PINs, passwords, keys, or receipt words and photos: take them out of the file and try again.`;

// ---------- reading ----------

const n = (v: unknown): number | undefined => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string' && v.trim() !== '' && /^-?\d+(\.\d+)?$/.test(v.trim().replace(/^\$/, ''))) return Number(v.trim().replace(/^\$/, ''));
  return undefined;
};
const s = (v: unknown): string | undefined => {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v !== 'string') return undefined;
  // The CSV download puts ' in front of text a spreadsheet would run as a formula.
  const t = /^'[=+\-@\t\r]/.test(v) ? v.slice(1) : v;
  return t.trim() === '' ? undefined : t;
};
const b = (v: unknown): boolean | undefined => {
  if (v === true || v === 1 || v === '1' || (typeof v === 'string' && /^(true|yes)$/i.test(v.trim()))) return true;
  if (v === false || v === 0 || v === '0' || v === null || v === undefined || v === '' || (typeof v === 'string' && /^(false|no)$/i.test(v.trim()))) return false;
  return undefined;
};

const bump = (p: Record<string, number>, k: string, by = 1) => (p[k] = (p[k] ?? 0) + by);

/** A price row (from the export's prices table, a product's own `prices`, or a CSV line) as sent; undefined if it can't be. */
function priceOf(r: Record<string, unknown>, problems: Record<string, number>): ImportPrice | undefined {
  const date = s(r.date);
  const price = n(r.price);
  if (!date) {
    bump(problems, 'date');
    return undefined;
  }
  if (price === undefined) {
    bump(problems, 'price');
    return undefined;
  }
  const out: ImportPrice = { date: date.trim(), price };
  const was = n(r.was_price);
  if (was !== undefined) out.was_price = was;
  const special = b(r.is_special);
  const member = b(r.member_only);
  if (special === undefined || member === undefined) {
    bump(problems, 'flag');
    return undefined;
  }
  if (special) out.is_special = true;
  if (member) out.member_only = true;
  const promo = s(r.promo);
  if (promo) out.promo = promo;
  return out;
}

/**
 * The products of a restock-export's tables (products, and prices by product_id; or a product row's
 * own `prices`), one per product: rows for the same shop and shop number (or barcode) are one.
 */
export function productsOf(tables: Record<string, unknown>, kind: 'json' | 'csv'): ReadFile {
  refuseSecrets(tables);
  const problems: Record<string, number> = {};
  const costco = { products: 0, prices: 0 };
  const productRows = Array.isArray(tables.products) ? tables.products : [];
  const priceRows = Array.isArray(tables.prices) ? tables.prices : [];
  if (!Array.isArray(tables.products)) throw new ImportRefused("This file has no products in it (a table called products). See How to make a file for one.");
  if (productRows.length > LIMITS.products * 2) throw new ImportRefused(tooMany(productRows.length, 'products'));
  if (priceRows.length > LIMITS.prices) throw new ImportRefused(tooMany(priceRows.length, 'prices'));

  const byRef = new Map<string, ImportProduct>();
  const byKey = new Map<string, ImportProduct>();
  const out: ImportProduct[] = [];
  const costcoRefs = new Set<string>();
  for (const r0 of productRows) {
    if (!r0 || typeof r0 !== 'object' || Array.isArray(r0)) {
      bump(problems, 'row');
      continue;
    }
    const r = r0 as Record<string, unknown>;
    const chain = (s(r.chain) ?? '').trim().toLowerCase();
    const ref = s(r.id ?? r.ref)?.trim();
    const own = Array.isArray(r.prices) ? (r.prices as unknown[]) : [];
    if (chain === NEVER_SHOP) {
      costco.products++;
      costco.prices += own.length;
      if (ref) costcoRefs.add(ref);
      continue;
    }
    const name = s(r.name);
    const p: ImportProduct = { chain, name: name ?? '', prices: [] };
    if (ref) p.ref = ref.slice(0, 80);
    const shopId = s(r.store_product_id ?? r.shop_product_id);
    if (shopId) p.store_product_id = shopId.trim();
    const barcode = s(r.barcode);
    if (barcode) p.barcode = barcode.trim();
    for (const f of ['brand', 'size', 'image_url'] as const) {
      const v = s(r[f]);
      if (v) p[f] = v;
    }
    const qty = n(r.qty);
    const unit = s(r.qty_unit);
    if (qty !== undefined && unit) {
      p.qty = qty;
      p.qty_unit = unit;
    }
    // One product per shop and shop number (else barcode, else the file's id).
    const key = p.store_product_id ? `${chain}|s|${p.store_product_id}` : p.barcode ? `${chain}|b|${p.barcode}` : undefined;
    const had = key ? byKey.get(key) : undefined;
    const into = had ?? p;
    if (!had) {
      out.push(p);
      if (key) byKey.set(key, p);
    }
    if (ref && !byRef.has(ref)) byRef.set(ref, into);
    for (const x of own) {
      if (!x || typeof x !== 'object' || Array.isArray(x)) {
        bump(problems, 'row');
        continue;
      }
      const pr = priceOf(x as Record<string, unknown>, problems);
      if (pr) into.prices.push(pr);
    }
  }
  if (out.length > LIMITS.products) throw new ImportRefused(tooMany(out.length, 'products'));
  for (const r0 of priceRows) {
    if (!r0 || typeof r0 !== 'object' || Array.isArray(r0)) {
      bump(problems, 'row');
      continue;
    }
    const r = r0 as Record<string, unknown>;
    const pid = s(r.product_id)?.trim();
    if (pid && costcoRefs.has(pid)) {
      costco.prices++;
      continue;
    }
    const into = pid ? byRef.get(pid) : undefined;
    if (!into) {
      bump(problems, 'no-product');
      continue;
    }
    const pr = priceOf(r, problems);
    if (pr) into.prices.push(pr);
  }
  let priceCount = 0;
  const kept: ImportProduct[] = [];
  for (const p of out) {
    if (p.prices.length > LIMITS.pricesPerProduct) {
      bump(problems, 'too-many-prices');
      bump(problems, 'product-ignored-prices', p.prices.length);
      continue;
    }
    p.prices.sort((a, c) => (a.date < c.date ? -1 : a.date > c.date ? 1 : 0));
    priceCount += p.prices.length;
    kept.push(p);
  }
  if (priceCount > LIMITS.prices) throw new ImportRefused(tooMany(priceCount, 'prices'));
  const notTaken = Object.entries(tables)
    .filter(([k, v]) => !TAKEN.has(k) && ((Array.isArray(v) && v.length > 0) || (!!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length > 0)))
    .map(([k]) => KNOWN_NAMES[k] ?? k);
  return { kind, products: kept, priceCount, problems, costco, notTaken };
}

const fmt = (v: number) => v.toLocaleString('en-AU');
const tooMany = (count: number, what: 'products' | 'prices') =>
  `This file has ${fmt(count)} ${what}. One import takes up to ${fmt(what === 'products' ? LIMITS.products : LIMITS.prices)}: split it into smaller files and import them one after another.`;

/** RFC 4180 CSV (quotes, "" inside quotes, CRLF or LF), a BOM dropped: rows of fields. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  for (; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

/** A CSV table as rows keyed by its header. */
export function csvRows(text: string): Record<string, string>[] {
  const [head, ...rest] = parseCsv(text);
  if (!head) return [];
  const cols = head.map((h) => h.trim());
  return rest.map((r) => Object.fromEntries(cols.map((c, i) => [c, r[i] ?? ''])));
}

const ZIP = [0x50, 0x4b, 0x03, 0x04];
const isZip = (b: Uint8Array) => ZIP.every((x, i) => b[i] === x);
const baseName = (path: string) => path.split('/').pop()!.toLowerCase();

/**
 * The file the person picked, read: a restock-export .json, or the Data tab's CSV .zip (Products.csv
 * and Prices.csv; the other CSV files are listed as not taken). A spreadsheet (.xlsx) is refused with
 * what to use instead. Throws ImportRefused with words to show.
 */
export function readImport(bytes: Uint8Array, fileName = ''): ReadFile {
  if (bytes.length > LIMITS.fileMb * 1024 * 1024) throw new ImportRefused(`That file is ${Math.round(bytes.length / 1024 / 1024)} MB. Import takes files up to ${LIMITS.fileMb} MB: split it into smaller files.`);
  if (!bytes.length) throw new ImportRefused('That file is empty.');
  if (isZip(bytes)) {
    let total = 0;
    let names: string[] = [];
    const files = (() => {
      try {
        return unzipSync(bytes, {
          filter: (f) => {
            names.push(f.name);
            const want = /\.csv$/i.test(f.name) && !f.name.includes('..');
            if (want) total += f.originalSize;
            if (total > LIMITS.unzippedMb * 1024 * 1024) throw new ImportRefused(`Unzipped, that file is over ${LIMITS.unzippedMb} MB. Split it into smaller files.`);
            return want && ['products.csv', 'prices.csv'].includes(baseName(f.name));
          },
        });
      } catch (e) {
        if (e instanceof ImportRefused) throw e;
        throw new ImportRefused("That zip file couldn't be opened.");
      }
    })();
    names = names.map(baseName);
    for (const x of names) if (SECRET_TABLE.test(x.replace(/\.csv$/, ''))) throw new ImportRefused(secretWords(x));
    if (names.includes('[content_types].xml') || names.some((x) => x === 'workbook.xml'))
      throw new ImportRefused("Spreadsheets (.xlsx) can't be imported. Use the Full export file (.json) or the CSV files (.zip) instead.");
    const tables: Record<string, unknown> = {};
    for (const [path, data] of Object.entries(files)) tables[baseName(path).replace(/\.csv$/, '')] = csvRows(strFromU8(data));
    if (!tables.products) throw new ImportRefused('That zip has no Products.csv in it. Use the CSV files (.zip) the Data tab downloads, or a full export file (.json).');
    if (!tables.prices) tables.prices = [];
    const r = productsOf(tables, 'csv');
    r.notTaken = names.filter((x) => /\.csv$/.test(x) && !['products.csv', 'prices.csv'].includes(x)).map((x) => x.replace(/\.csv$/, '').replace(/[-_]+/g, ' '));
    return r;
  }
  if (/\.xlsx$/i.test(fileName)) throw new ImportRefused("Spreadsheets (.xlsx) can't be imported. Use the Full export file (.json) or the CSV files (.zip) instead.");
  let v: unknown;
  try {
    v = JSON.parse(strFromU8(bytes).replace(/^\ufeff/, ''));
  } catch {
    throw new ImportRefused("That isn't a Restock export file. Pick the Full export file (.json) or the CSV files (.zip).");
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new ImportRefused("That isn't a Restock export file.");
  const o = v as Record<string, unknown>;
  if (o.format !== 'restock-export') throw new ImportRefused('That file doesn\'t say "format": "restock-export". See How to make a file.');
  if (typeof o.v !== 'number' || !Number.isInteger(o.v) || o.v < 1) throw new ImportRefused('That file doesn\'t say which version of the format it is ("v": 1).');
  if (o.v > 1) throw new ImportRefused('That file was made by a newer Restock. Update this server, then import it.');
  if (!o.tables || typeof o.tables !== 'object' || Array.isArray(o.tables)) throw new ImportRefused('That file has no tables in it.');
  refuseSecrets(o.tables as Record<string, unknown>, o);
  return productsOf(o.tables as Record<string, unknown>, 'json');
}

// ---------- chunks ----------

const enc = new TextEncoder();
const sizeOf = (v: unknown) => enc.encode(JSON.stringify(v)).length;

/** A product's prices in pieces of at most `max`, cut between days where it can (a day's prices stay together). */
function piecesOf(prices: ImportPrice[], max: number): ImportPrice[][] {
  if (prices.length <= max) return [prices];
  const out: ImportPrice[][] = [];
  let i = 0;
  while (i < prices.length) {
    let end = Math.min(prices.length, i + max);
    if (end < prices.length) {
      const day = prices[end].date.slice(0, 10);
      let back = end;
      while (back > i + 1 && prices[back - 1].date.slice(0, 10) === day) back--;
      if (back > i + 1) end = back;
    }
    out.push(prices.slice(i, end));
    i = end;
  }
  return out;
}

/** The products as the requests to send: each under the server's caps (products, prices, bytes). */
export function chunksOf(products: ImportProduct[], limits = LIMITS): ImportProduct[][] {
  const chunks: ImportProduct[][] = [];
  let cur: ImportProduct[] = [];
  let curPrices = 0;
  let curBytes = 40;
  const flush = () => {
    if (cur.length) chunks.push(cur);
    cur = [];
    curPrices = 0;
    curBytes = 40;
  };
  for (const p of products) {
    const { prices, ...rest } = p;
    const bare = sizeOf(rest) + 16;
    // About how many prices fit in a request with this product, by their size.
    const each = prices.length ? Math.ceil(sizeOf(prices.slice(0, 50)) / Math.min(50, prices.length)) + 2 : 0;
    const room = Math.max(1, Math.min(limits.chunkPrices, Math.floor((limits.chunkBytes - 40 - bare) / Math.max(1, each))));
    piecesOf(prices, room).forEach((piece, i) => {
      const x: ImportProduct = { ...rest, prices: piece, ...(i > 0 ? { more: true as const } : {}) };
      const bytes = bare + piece.length * each;
      if (cur.length && (cur.length >= limits.chunkProducts || curPrices + piece.length > limits.chunkPrices || curBytes + bytes > limits.chunkBytes)) flush();
      cur.push(x);
      curPrices += piece.length;
      curBytes += bytes;
    });
  }
  flush();
  return chunks;
}

// ---------- the answers, added up, and their words ----------

export interface CheckAnswer {
  products: { add: number; matched: number };
  prices: { add: number; skipped: number };
  costco: { products: number; prices: number };
  problems: Record<string, number>;
}
export interface ChunkAnswer {
  products: { added: number; matched: number };
  prices: { added: number; skipped: number; toPhones?: number };
  costco: { products: number; prices: number };
  problems: Record<string, number>;
}

/** What the dry run (or the import) comes to: products and prices added, skipped, and what it couldn't read. */
export interface Tally {
  products: number;
  matched: number;
  prices: number;
  skipped: number;
  costco: { products: number; prices: number };
  problems: Record<string, number>;
}
export const emptyTally = (read?: ReadFile): Tally => ({
  products: 0,
  matched: 0,
  prices: 0,
  skipped: 0,
  costco: { products: read?.costco.products ?? 0, prices: read?.costco.prices ?? 0 },
  problems: { ...(read?.problems ?? {}) },
});
export function addCheck(t: Tally, a: CheckAnswer): Tally {
  const out = { ...t, costco: { ...t.costco }, problems: { ...t.problems } };
  out.products += Number(a.products?.add) || 0;
  out.matched += Number(a.products?.matched) || 0;
  out.prices += Number(a.prices?.add) || 0;
  out.skipped += Number(a.prices?.skipped) || 0;
  out.costco.products += Number(a.costco?.products) || 0;
  out.costco.prices += Number(a.costco?.prices) || 0;
  for (const [k, v] of Object.entries(a.problems ?? {})) bump(out.problems, k, Number(v) || 0);
  return out;
}
export const addChunk = (t: Tally, a: ChunkAnswer): Tally =>
  addCheck(t, { products: { add: a.products?.added, matched: a.products?.matched }, prices: { add: a.prices?.added, skipped: a.prices?.skipped }, costco: a.costco, problems: a.problems } as CheckAnswer);

/** Notes, not rows left out: the product went in without that barcode or picture. */
const NOTES = new Set(['barcode-left-out', 'picture-left-out']);
export const ignoredOf = (t: Tally) => Object.entries(t.problems).reduce((s2, [k, v]) => (NOTES.has(k) ? s2 : s2 + v), 0);

const plural = (v: number, one: string, many = `${one}s`) => `${fmt(v)} ${v === 1 ? one : many}`;

/** "Will add 12,000 products and 90,000 prices, skip 300 already there, ignore 12 it couldn't read." */
export function dryRunLine(t: Tally): string {
  const parts = [`Will add ${plural(t.products, 'product')} and ${plural(t.prices, 'price')}`];
  if (t.skipped) parts.push(`skip ${fmt(t.skipped)} already there`);
  const bad = ignoredOf(t);
  if (bad) parts.push(`ignore ${fmt(bad)} it couldn't read`);
  return parts.join(', ') + '.';
}

/** "Added 12,000 products and 90,000 prices, skipped 300 already there, ignored 12 it couldn't read." */
export function doneLine(t: Tally): string {
  const parts = [`Added ${plural(t.products, 'product')} and ${plural(t.prices, 'price')}`];
  if (t.skipped) parts.push(`skipped ${fmt(t.skipped)} already there`);
  const bad = ignoredOf(t);
  if (bad) parts.push(`ignored ${fmt(bad)} it couldn't read`);
  return parts.join(', ') + '.';
}

const WHY: Record<string, (v: number) => string> = {
  shop: (v) => `${plural(v, 'product')} at a shop Restock doesn't know (or "other").`,
  name: (v) => `${plural(v, 'product')} without a name, or with one over 200 characters.`,
  date: (v) => `${plural(v, 'price')} with a date it couldn't read, from before 2000, or in the future.`,
  price: (v) => `${plural(v, 'price')} that aren't a number from $0.01 to $10,000.`,
  flag: (v) => `${plural(v, 'price')} where on special or member only isn't true or false.`,
  'shop-number': (v) => `${plural(v, 'product')} whose shop product number isn't text or a number.`,
  'too-many-prices': (v) => `${plural(v, 'product')} with over ${fmt(LIMITS.pricesPerProduct)} prices.`,
  full: (v) => `${plural(v, 'new product')} past the ${fmt(LIMITS.serverProducts)} the server holds.`,
  'product-ignored-prices': (v) => `${plural(v, 'price')} of those products.`,
  'no-product': (v) => `${plural(v, 'price')} for a product that isn't in the file.`,
  row: (v) => `${plural(v, 'row')} that aren't a product or a price.`,
  'barcode-left-out': (v) => `${plural(v, 'barcode')} left out (not 8, 12, 13 or 14 digits). Their products go in without one.`,
  'picture-left-out': (v) => `${plural(v, 'picture')} left out (only pictures from where your shops' products already show them).`,
};

/** A line for each kind of row left out (and the notes), for Step 1 and the end. */
export function problemLines(t: Tally): string[] {
  return Object.entries(t.problems)
    .filter(([, v]) => v > 0)
    .sort(([a], [c]) => Number(NOTES.has(a)) - Number(NOTES.has(c)))
    .map(([k, v]) => (WHY[k] ? WHY[k](v) : `${plural(v, 'row')} left out (${k}).`));
}

/** Costco's, left out: said plainly. Empty when there were none. */
export function costcoLine(t: Tally): string {
  const { products, prices } = t.costco;
  if (!products && !prices) return '';
  const what = [products ? plural(products, 'Costco product') : '', prices ? plural(prices, 'Costco price') : ''].filter(Boolean).join(' and ');
  return `Left out ${what}: Costco prices never go into Restock imports or exports.`;
}

// ---------- the steps ----------

export type Phase = 'idle' | 'reading' | 'checking' | 'review' | 'pass' | 'importing' | 'done' | 'stopped';

export interface ImportState {
  phase: Phase;
  file?: string;
  read?: ReadFile;
  chunks: number;
  /** Chunks sent so far (the dry run's or the import's). */
  at: number;
  check: Tally;
  done: Tally;
  pass: string;
  busy: boolean;
  cancel: boolean;
  error?: string;
  message?: string;
}

export const firstImport = (): ImportState => ({ phase: 'idle', chunks: 0, at: 0, check: emptyTally(), done: emptyTally(), pass: '', busy: false, cancel: false });

export type ImportAction =
  | { t: 'reading'; file: string }
  | { t: 'read'; read: ReadFile; chunks: number }
  | { t: 'checked'; at: number; answer: CheckAnswer }
  | { t: 'review' }
  | { t: 'continue' }
  | { t: 'back' }
  | { t: 'pass'; v: string }
  | { t: 'start' }
  | { t: 'sent'; at: number; answer: ChunkAnswer }
  | { t: 'cancel' }
  | { t: 'finished'; how: 'finished' | 'cancelled' | 'failed'; message?: string }
  | { t: 'fail'; error: string }
  /** The passphrase was refused (or another import is going): back to Step 2, nothing imported. */
  | { t: 'refused'; error: string }
  | { t: 'close' };

/**
 * The import's steps: read the file, the dry run (chunk by chunk), Step 1 (what it will add), Step 2
 * (the passphrase), the import (chunk by chunk, Cancel stops after the chunk being sent), then done
 * or stopped. Import only from Step 2 with a passphrase; Cancel only while checking or importing.
 */
export function importReducer(s: ImportState, a: ImportAction): ImportState {
  switch (a.t) {
    case 'reading':
      return { ...firstImport(), phase: 'reading', file: a.file, busy: true };
    case 'read':
      return { ...s, phase: 'checking', read: a.read, chunks: a.chunks, at: 0, check: emptyTally(a.read), done: emptyTally(a.read), busy: true, cancel: false, error: undefined };
    case 'checked':
      return s.phase === 'checking' ? { ...s, at: a.at, check: addCheck(s.check, a.answer) } : s;
    case 'review':
      return s.phase === 'checking' ? { ...s, phase: s.cancel ? 'idle' : 'review', busy: false } : s;
    case 'continue':
      return s.phase === 'review' && s.check.products + s.check.prices > 0 ? { ...s, phase: 'pass', error: undefined } : s;
    case 'back':
      return s.phase === 'pass' && !s.busy ? { ...s, phase: 'review', error: undefined } : s;
    case 'pass':
      return s.busy ? s : { ...s, pass: a.v.slice(0, 1024), error: undefined };
    case 'start':
      return s.phase === 'pass' && !s.busy && s.pass.length > 0 ? { ...s, phase: 'importing', busy: true, at: 0, cancel: false, error: undefined } : s;
    case 'sent':
      return s.phase === 'importing' ? { ...s, at: a.at, done: addChunk(s.done, a.answer) } : s;
    case 'cancel':
      return s.phase === 'checking' || s.phase === 'importing' ? { ...s, cancel: true } : s;
    case 'finished':
      return { ...s, phase: a.how === 'finished' ? 'done' : 'stopped', busy: false, pass: '', message: a.message };
    case 'fail':
      // Before the import (reading, the dry run, the passphrase): back to where it can be fixed.
      if (s.phase === 'pass') return { ...s, busy: false, phase: 'pass', error: a.error };
      return { ...s, busy: false, phase: s.phase === 'importing' ? 'stopped' : 'idle', error: a.error, pass: '' };
    case 'refused':
      return s.phase === 'importing' && s.at === 0 ? { ...s, phase: 'pass', busy: false, error: a.error } : s;
    case 'close':
      return s.busy ? s : firstImport();
    default:
      return s;
  }
}

/** "Stopped. 4,000 products and 30,000 prices went in before it stopped…" */
export function stoppedLine(t: Tally): string {
  return `Stopped. ${plural(t.products, 'product')} and ${plural(t.prices, 'price')} went in before it stopped; the rest didn't. Importing the same file again skips what's already there.`;
}
