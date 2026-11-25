// Shared prices on iPhone and iPad, sending: what PriceShare.java does on Android. The shelf prices
// this device read from Coles, Woolworths and Aldi go to Restock's shared price service:
//  - prices a price check here recorded from the shop (source "auto") since the last send, never ones
//    another phone or the Restock server synced here (that phone sends its own);
//  - what searches showed (lib/priceShare.ts keeps them in the "priceShareOutbox" store entry).
// Only what the shop's website said: never a price typed in or changed by hand, sample items, shops
// added by hand, or anything about the person. A random install number goes with it, only so the
// service can tell devices apart and limit how much one sends.
import { SHARED_PRICE_SHOPS } from '../shops';

export const SHARE_URL = 'https://restock-prices.plenty.family/share/prices';
const BATCH = 2000;
const MAX_ROWS = 8000;

export interface ShareDeps {
  getKV<T>(key: string): Promise<T | undefined>;
  putKV(key: string, value: unknown): Promise<void>;
  query<T>(sql: string, params?: (string | number)[]): Promise<T[]>;
  /** Posts JSON, and gives the status the service answered with. */
  post(url: string, body: string): Promise<number>;
  /** A new random id, for the install number. */
  uid(): string;
  now?: () => number;
}

interface PriceRow {
  id: number;
  chain: string;
  store_product_id: string;
  name: string;
  brand: string | null;
  size: string | null;
  barcode: string | null;
  image_url: string | null;
  price: number;
  was_price: number | null;
  is_special: number;
  member_only: number;
  promo: string | null;
  date: string;
}

const isShop = (chain: unknown): chain is string => typeof chain === 'string' && (SHARED_PRICE_SHOPS as readonly string[]).includes(chain);

/** "2026-11-12T22:30:00Z" → the day on this device's calendar ("2026-11-13" in Brisbane). */
export function localDay(iso: string, now = Date.now()): string {
  const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const t = Date.parse(iso);
  if (Number.isFinite(t) && /T/.test(iso)) return ymd(new Date(t));
  return iso && iso.length >= 10 ? iso.slice(0, 10) : ymd(new Date(now));
}

/** A price row in the shared price service's shape, exactly as Android sends it (PriceHelper.product). */
export function rowShape(r: PriceRow, now = Date.now()) {
  return {
    id: `${r.chain}:${r.store_product_id}`,
    chain: r.chain,
    store_product_id: r.store_product_id,
    name: r.name,
    ...(r.brand ? { brand: r.brand } : {}),
    ...(r.size ? { size: r.size } : {}),
    ...(r.barcode && /^\d{8,14}$/.test(r.barcode) ? { barcode: r.barcode } : {}),
    ...(r.image_url ? { image_url: r.image_url } : {}),
    price: {
      price: r.price,
      ...(r.was_price != null ? { was_price: r.was_price } : {}),
      is_special: !!r.is_special,
      member_only: !!r.member_only,
      ...(r.promo != null ? { promo: r.promo } : {}),
    },
    day: localDay(r.date, now),
  };
}

const PRICES_SQL = (own: boolean) =>
  'SELECT r.id AS id, p.chain AS chain, p.store_product_id AS store_product_id, p.name AS name, p.brand AS brand, p.size AS size, p.barcode AS barcode, p.image_url AS image_url,' +
  ' r.price AS price, r.was_price AS was_price, r.is_special AS is_special, r.member_only AS member_only, r.promo AS promo, r.date AS date' +
  ' FROM prices r JOIN products p ON p.id = r.product_id' +
  " WHERE r.id > ? AND r.source = 'auto' AND r.date >= ?" +
  " AND p.chain IN ('coles', 'woolworths', 'aldi') AND p.store_product_id IS NOT NULL AND p.store_product_id != '' AND p.id NOT LIKE 'demo-%'" +
  // Only what this device read itself: a price another phone (or the Restock server) synced here was
  // sent by that phone already, so it isn't sent twice (and can't count as a second phone).
  (own
    ? " AND NOT EXISTS (SELECT 1 FROM sync_log l WHERE l.tbl = 'prices' AND l.pk = r.product_id || '|' || r.date" +
      " AND l.device <> COALESCE((SELECT value FROM sync_meta WHERE key = 'device'), ''))"
    : '') +
  ` ORDER BY r.id LIMIT ${MAX_ROWS}`;

/** The install number (the app makes the same one for feedback), made here if it isn't there yet. */
export async function installOf(d: ShareDeps): Promise<string> {
  const have = await d.getKV<string>('installId');
  if (typeof have === 'string' && /^[\w-]{6,64}$/.test(have)) return have;
  const id = d.uid();
  await d.putKV('installId', id);
  return id;
}

let busy: Promise<number> | undefined;

/** Sends what's waiting. Returns how many prices went (0 when nothing is new or there's no signal). */
export function sendPrices(d: ShareDeps): Promise<number> {
  // One send at a time: a second ask while one is going gets that one's answer.
  busy ??= send(d).finally(() => (busy = undefined));
  return busy;
}

async function send(d: ShareDeps): Promise<number> {
  const now = (d.now ?? Date.now)();
  const at = new Date(now).toISOString();
  let sent = 0;
  let error: string | undefined;
  try {
    const cursorKv = await d.getKV<number>('priceShareCursor');
    const cursor = typeof cursorKv === 'number' ? cursorKv : -1;
    const since = new Date(now - 14 * 86_400_000).toISOString();
    const rows = await d.query<PriceRow>(PRICES_SQL(true), [cursor, since]).catch(() => d.query<PriceRow>(PRICES_SQL(false), [cursor, since]));
    const byChain = new Map<string, unknown[]>();
    const put = (chain: string, p: unknown) => byChain.set(chain, [...(byChain.get(chain) ?? []), p]);
    let last = cursor;
    for (const r of rows) {
      last = Math.max(last, Number(r.id));
      if (!(r.price > 0)) continue;
      put(r.chain, rowShape(r, now));
    }
    const waiting = (await d.getKV<{ chain?: string }[]>('priceShareOutbox')) ?? [];
    for (const p of Array.isArray(waiting) ? waiting : []) if (p && isShop(p.chain)) put(p.chain, p);
    if (!byChain.size) return 0;
    const install = await installOf(d);
    for (const [chain, all] of byChain) {
      for (let from = 0; from < all.length; from += BATCH) {
        const part = all.slice(from, from + BATCH);
        const code = await d.post(SHARE_URL, JSON.stringify({ format: 'restock-share', v: 1, install, chain, products: part }));
        // A 400 (something the service won't take) would never go: drop it. Anything else: try later.
        if (code !== 200 && code !== 400) throw new Error(code === 429 ? 'the shared price service has had enough for today' : `the shared price service answered ${code}`);
        sent += part.length;
      }
    }
    if (last > cursor) await d.putKV('priceShareCursor', last);
    // Only the ones read above: a search's prices added meanwhile wait for next time.
    const taken = Array.isArray(waiting) ? waiting.length : 0;
    const cur = (await d.getKV<unknown[]>('priceShareOutbox')) ?? [];
    await d.putKV('priceShareOutbox', Array.isArray(cur) ? cur.slice(taken) : []);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  } finally {
    try {
      const old = await d.getKV<{ total?: number; lastSentAt?: string }>('priceShare');
      const lastSentAt = sent > 0 ? at : old?.lastSentAt;
      await d.putKV('priceShare', { at, sent, ...(error ? { error } : {}), total: (old?.total ?? 0) + sent, ...(lastSentAt ? { lastSentAt } : {}) });
    } catch {
      // the status is only for the Privacy and sharing page
    }
  }
  return sent;
}
