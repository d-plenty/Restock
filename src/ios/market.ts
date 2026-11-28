// Shared price history on iPhone and iPad ("Judge new items from day one"): what MarketData.java,
// MarketParser.java and Deals.summarise do on Android. Downloads restock-prices' day-one files
// (Restock's own collection, published on GitHub) for the shops this device uses and keeps one short
// summary per product in the market table. The files are the same for everyone, so nothing about
// what you track is sent anywhere. The full history isn't kept, only the summary.
import { gunzipSync, strFromU8 } from 'fflate';

const SOURCE = 'restock-prices';
export const WINDOW_BASE = 'https://raw.githubusercontent.com/d-plenty/restock-prices/main/window/';
const WINDOWS = [56, 182, 365];
const DAY = 86_400_000;
const LEARNING_DAYS = 25;
/** A lower price that lasts longer than this is treated as the old shelf price, not a special. */
const MAX_SALE_DAYS = 42;
/** The most change points kept per product, so one broken entry can't run away. */
const MAX_POINTS = 400;
/** Give up on a file bigger than this, packed or unpacked (it would mean something unexpected is being served). */
export const MAX_BYTES = 150 * 1024 * 1024;
const REFRESH_MS = 7 * DAY;

interface Summary {
  normal: number;
  sale?: number;
  saleShare: number;
  low: number;
  cycleWeeks?: number;
  days: number;
  latest?: number;
}

/** "2026-11-05" or a full ISO time → milliseconds at the start of that day (UTC). */
const dayStart = (date: string) => Date.parse(`${date.slice(0, 10)}T00:00:00Z`);

/**
 * Summarises a product's price history (change points: each price holds until the next date) over
 * the last `windowDays`. Normal = the price it sat at longest among the higher half of its prices;
 * on sale = 3% or more below normal for at most MAX_SALE_DAYS. Undefined with under LEARNING_DAYS of
 * history. The same steps, in the same order, as Deals.summarise.
 */
export function summarise(dates: string[], prices: number[], now: number, windowDays: number): Summary | undefined {
  const n = Math.min(dates.length, prices.length);
  if (!n) return undefined;
  const start = dates.slice(0, n).map(dayStart);
  const order = start.map((_, i) => i).sort((a, b) => start[a] - start[b]);
  const from = now - windowDays * DAY;
  const segs: [number, number][] = []; // [price, days]
  for (let k = 0; k < n; k++) {
    const i = order[k];
    const s0 = Math.max(start[i], from);
    let s1 = k + 1 < n ? start[order[k + 1]] : now;
    if (s1 > now) s1 = now;
    if (s1 <= s0 || !(prices[i] > 0)) continue;
    segs.push([prices[i], (s1 - s0) / DAY]);
  }
  const total = segs.reduce((a, s) => a + s[1], 0);
  if (!segs.length || total < LEARNING_DAYS) return undefined;

  // Duration-weighted median, then the longest-held price at or above it.
  const byPrice = [...segs].sort((a, b) => a[0] - b[0]);
  let acc = 0;
  let mid = byPrice[byPrice.length - 1][0];
  for (const sg of byPrice) {
    acc += sg[1];
    if (acc >= total / 2) {
      mid = sg[0];
      break;
    }
  }
  const held = new Map<number, number>();
  for (const sg of segs) {
    if (sg[0] < mid - 1e-9) continue;
    const cents = Math.round(sg[0] * 100);
    held.set(cents, (held.get(cents) ?? 0) + sg[1]);
  }
  let bestCents = -1;
  let bestDays = -1;
  for (const [cents, days] of held) {
    if (days > bestDays + 1e-9 || (Math.abs(days - bestDays) <= 1e-9 && cents > bestCents)) {
      bestCents = cents;
      bestDays = days;
    }
  }
  const normal = bestCents / 100;

  let saleDays = 0;
  let low = Number.MAX_VALUE;
  let runs = 0;
  let inSale = false;
  const salePrices: [number, number][] = [];
  for (const sg of segs) {
    low = Math.min(low, sg[0]);
    // Specials last weeks. A lower price held for longer is an old shelf price, not a sale.
    const sale = sg[0] <= normal * 0.97 && sg[1] <= MAX_SALE_DAYS;
    if (sale) {
      saleDays += sg[1];
      salePrices.push(sg);
      if (!inSale) runs++;
    }
    inSale = sale;
  }
  const m: Summary = { normal, low, saleShare: saleDays / total, days: Math.round(total), latest: segs[segs.length - 1][0] };
  if (salePrices.length) {
    salePrices.sort((a, b) => a[0] - b[0]);
    const half = saleDays / 2;
    let a2 = 0;
    for (const sg of salePrices) {
      a2 += sg[1];
      if (a2 >= half) {
        m.sale = sg[0];
        break;
      }
    }
  }
  if (runs >= 2) m.cycleWeeks = Math.max(1, Math.round(total / runs / 7));
  return m;
}

const addDays = (from: string, days: number) => new Date(dayStart(from) + days * DAY).toISOString().slice(0, 10);

/** [[day, cents, flags?], …] into dates ("2026-11-10") and prices (dollars), as MarketParser.readPoints. */
export function readPoints(points: unknown, from: string): { dates: string[]; prices: number[] } {
  const dates: string[] = [];
  const prices: number[] = [];
  if (!Array.isArray(points)) return { dates, prices };
  for (const p of points) {
    if (!Array.isArray(p)) continue;
    const day = typeof p[0] === 'number' && Number.isInteger(p[0]) ? p[0] : -1;
    const cents = typeof p[0] === 'number' && typeof p[1] === 'number' ? Math.trunc(p[1]) : -1;
    if (day < 0 || day > 4000 || cents <= 0 || cents > 10_000_000 || dates.length >= MAX_POINTS) continue;
    dates.push(addDays(from, day));
    prices.push(cents / 100);
  }
  return { dates, prices };
}

/** A day-one file's products, each summarised. Throws on anything that isn't one. */
export function parseWindow(json: string, now: number, windowDays: number): { id: string; m: Summary }[] {
  const o = JSON.parse(json) as { format?: unknown; from?: unknown; products?: unknown };
  if (typeof o.format === 'string' && o.format !== 'restock-window') throw new Error('not a restock-prices day-one file');
  const out: { id: string; m: Summary }[] = [];
  if (!o.products || typeof o.products !== 'object' || Array.isArray(o.products)) return out;
  if (typeof o.from !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.from)) throw new Error('the file has no start date');
  for (const [id, points] of Object.entries(o.products as Record<string, unknown>)) {
    const { dates, prices } = readPoints(points, o.from);
    if (!dates.length) continue;
    const m = summarise(dates, prices, now, windowDays);
    if (m) out.push({ id, m });
  }
  return out;
}

/** The file as text: gzip (its first two bytes say so) or already unpacked on the way. */
export function unpack(bytes: Uint8Array): string {
  if (bytes.length > MAX_BYTES) throw new Error('the file is unexpectedly large');
  const packed = bytes[0] === 0x1f && bytes[1] === 0x8b;
  const out = packed ? gunzipSync(bytes) : bytes;
  if (out.length > MAX_BYTES) throw new Error('the file is unexpectedly large');
  return strFromU8(out);
}

// ---------- settings ----------

interface MarketSettings {
  historyWeeks?: number;
  enabledChains?: readonly string[];
  sharePrices?: string;
  marketData?: { enabled?: boolean; wifiOnly?: boolean; days?: number; every?: string };
}

/** How far back: the weeks of prices this device keeps (8, 26 or 52), and so the day-one file it gets. */
export function windowDays(s: MarketSettings | undefined): number {
  const weeks = s?.historyWeeks ?? 0;
  if (weeks >= 52) return 365;
  if (weeks >= 26) return 182;
  if (weeks > 0) return 56;
  const d = s?.marketData?.days ?? 56;
  return WINDOWS.includes(d) ? d : 56;
}
const daily = (s: MarketSettings | undefined) => s?.marketData?.every === 'daily';

/** The shops this device uses, each once. */
export function chainsOf(s: MarketSettings | undefined): string[] {
  const out: string[] = [];
  for (const c of s?.enabledChains ?? []) if (/^[a-z0-9_-]{2,40}$/.test(c) && !out.includes(c)) out.push(c);
  return out;
}

interface WindowIndex {
  format?: string;
  shops?: Record<string, { to?: string; full?: string }>;
}
export interface LastImport {
  at?: string;
  days?: number;
  index?: Record<string, { to?: string; full?: string }>;
}

/** Whether there's something new for these shops since the last download: weekly, a newer full collection; daily, anything newer. */
export function newer(index: WindowIndex | undefined, last: LastImport | undefined, chains: string[], isDaily: boolean): boolean {
  const shops = index?.shops;
  if (!shops) return false;
  const key = isDaily ? 'to' : 'full';
  for (const c of chains) {
    const now = shops[c];
    if (!now) continue;
    const was = last?.index?.[c];
    const a = now[key] ?? now.to ?? '';
    const b = was ? (was[key] ?? was.to ?? '') : '';
    if (a > b) return true;
  }
  return false;
}

/** After a price check: is a download due? (MarketData.maybeRefresh's rules; `index` is only read when it's needed.) */
export async function refreshDue(s: MarketSettings, last: LastImport | undefined, readIndex: () => Promise<WindowIndex | undefined>, now = Date.now()): Promise<boolean> {
  if (!s.marketData?.enabled || s.sharePrices === 'no') return false;
  const at = last?.at ?? '';
  const since = at ? now - Date.parse(at) : Number.MAX_SAFE_INTEGER;
  // A day at least between downloads, even on "every day".
  if (since < 20 * 3_600_000) return false;
  const changedLength = !!last && (last.days ?? windowDays(s)) !== windowDays(s);
  if (at && !changedLength) {
    const index = await readIndex();
    if (!index) return since >= REFRESH_MS; // can't tell: the old weekly rule
    return newer(index, last, chainsOf(s), daily(s));
  }
  return true;
}

// ---------- the download ----------

export interface MarketDeps {
  /** A file's bytes. `status` 404 means there's no such file (a shop the collector doesn't publish). */
  get(url: string): Promise<{ status: number; bytes: Uint8Array }>;
  /** All in one transaction. */
  write(ops: { sql: string; params?: (string | number | null)[] }[]): Promise<void>;
  putKV(key: string, value: unknown): Promise<void>;
  progress?(chain: string, bytes: number, products: number): void;
  now?: () => number;
}

interface MarketResult {
  products: number;
  bytes: number;
  byChain: Record<string, number>;
  errors: Record<string, string>;
  missing: string[];
}

export async function readIndex(d: Pick<MarketDeps, 'get'>): Promise<WindowIndex | undefined> {
  try {
    const r = await d.get(`${WINDOW_BASE}index.json`);
    if (r.status !== 200 || r.bytes.length > 256 * 1024) return undefined;
    const o = JSON.parse(strFromU8(r.bytes)) as WindowIndex;
    return o.format === 'restock-window-index' ? o : undefined;
  } catch {
    return undefined;
  }
}

const INSERT =
  'INSERT OR REPLACE INTO market (chain, store_product_id, normal, sale, sale_share, low, cycle_weeks, days, source, updated_at, latest) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';

/** Downloads and summarises every shop this device uses, as MarketData.importAll. */
export async function importAll(s: MarketSettings, d: MarketDeps): Promise<MarketResult> {
  const result: MarketResult = { products: 0, bytes: 0, byChain: {}, errors: {}, missing: [] };
  const now = (d.now ?? Date.now)();
  const stamp = new Date(now).toISOString();
  const days = windowDays(s);
  const chains = chainsOf(s);
  const index = await readIndex(d);
  const listed = index?.shops;
  // A shop this device stopped using, and anything from before (another source), goes.
  await d.write([
    chains.length ? { sql: `DELETE FROM market WHERE chain NOT IN (${chains.map(() => '?').join(', ')})`, params: chains } : { sql: 'DELETE FROM market' },
    { sql: 'DELETE FROM market WHERE source != ?', params: [SOURCE] },
  ]);
  for (const chain of chains) {
    // A shop the collector doesn't publish (bottle shops, chemists, or nothing yet).
    if (index && !(listed && chain in listed)) {
      result.missing.push(chain);
      await d.write([{ sql: 'DELETE FROM market WHERE chain = ?', params: [chain] }]);
      continue;
    }
    try {
      const r = await d.get(`${WINDOW_BASE}${chain}-${days}d.json.gz`);
      if (r.status === 404) {
        result.missing.push(chain);
        await d.write([{ sql: 'DELETE FROM market WHERE chain = ?', params: [chain] }]);
        continue;
      }
      if (r.status !== 200) throw new Error(`${SOURCE} returned HTTP ${r.status}`);
      d.progress?.(chain, r.bytes.length, 0);
      // Download and summarise first (the slow part), then write in one short transaction.
      const rows = parseWindow(unpack(r.bytes), now, days);
      if (!rows.length) throw new Error(`${SOURCE} sent no usable prices for ${chain}`);
      await d.write([
        { sql: 'DELETE FROM market WHERE chain = ?', params: [chain] },
        ...rows.map(({ id, m }) => ({
          sql: INSERT,
          params: [chain, id, m.normal, m.sale ?? null, m.saleShare, m.low, m.cycleWeeks ?? null, m.days, SOURCE, stamp, m.latest ?? null],
        })),
      ]);
      result.byChain[chain] = rows.length;
      result.products += rows.length;
      result.bytes += r.bytes.length;
      d.progress?.(chain, r.bytes.length, rows.length);
    } catch (e) {
      result.errors[chain] = e instanceof RangeError ? 'the file was too big for this device' : e instanceof Error ? e.message : String(e);
    }
  }
  // What was published then, so the next check knows whether there's anything newer.
  const seen: Record<string, { to: string; full: string }> = {};
  if (listed) for (const c of chains) if (listed[c] && !(c in result.errors)) seen[c] = { to: listed[c].to ?? '', full: listed[c].full ?? listed[c].to ?? '' };
  await d.putKV('marketImport', { at: stamp, products: result.products, bytes: result.bytes, errors: result.errors, days, missing: result.missing, index: seen, published: !!index });
  return result;
}
