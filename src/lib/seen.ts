import type { StoreProduct } from '../stores/types';
import { KEEP_WEEKS, type Settings } from '../types';
import { getKV, putKV, queryRows, runOps } from './db';
import { serverMode } from '../server-mode/flag';
import { isNative } from '../stores/http';
import { RestockNative } from './sql/native';

// 0.11.0: what searches found. Every product a search or a scan turns up is remembered on this
// phone with the price the shop's website showed that day: one row for each product and day
// (schema.ts SEEN_TABLE). It's history only: a search always asks the shops again and shows what
// they say now, and nothing here is ever shown as today's price. Remembered results aren't
// re-checked by the automatic price check (that's only what's in your pantry and on your lists).
//
// Kept for as long as the phone's price history (Settings → Prices and deals), or a time of its
// own when "Keep search results for a different time" is on. On a phone in a Restock server
// household, the rows also go to that server (POST /api/v3/data/seen), a few minutes after a
// search. Only what a shop's website said: a price typed in by hand is never a search result.

export interface SeenRow {
  chain: string;
  store_product_id: string;
  day: string;
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
  in_stock: number | null;
}

const localDay = (ms = Date.now()) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** A search result as a row to remember, or undefined (no price, a sample or test product, an odd id). */
export function seenShape(p: StoreProduct, day = localDay()): SeenRow | undefined {
  const id = p.storeProductId;
  if (!id || id.length > 80 || !/^[a-z][a-z0-9_-]{0,39}$/.test(p.chain)) return undefined;
  if (id.startsWith('demo-') || id.startsWith('fake') || !(typeof p.price === 'number' && p.price > 0 && p.price < 100000) || !p.name?.trim()) return undefined;
  return {
    chain: p.chain,
    store_product_id: id,
    day,
    name: p.name.trim().slice(0, 200),
    brand: p.brand ? p.brand.slice(0, 80) : null,
    size: p.size ? p.size.slice(0, 60) : null,
    barcode: p.barcode && /^\d{8,14}$/.test(p.barcode) ? p.barcode : null,
    image_url: p.imageUrl && p.imageUrl.startsWith('https://') ? p.imageUrl.slice(0, 300) : null,
    price: p.price,
    was_price: p.wasPrice && p.wasPrice > p.price ? p.wasPrice : null,
    is_special: p.isSpecial ? 1 : 0,
    member_only: p.memberOnly ? 1 : 0,
    promo: p.promo ? p.promo.slice(0, 120) : null,
    in_stock: p.inStock === undefined ? null : p.inStock ? 1 : 0,
  };
}

const COLS = ['chain', 'store_product_id', 'day', 'name', 'brand', 'size', 'barcode', 'image_url', 'price', 'was_price', 'is_special', 'member_only', 'promo', 'in_stock'] as const;

let writing: Promise<void> = Promise.resolve();
let timer: ReturnType<typeof setTimeout> | undefined;
const SEND_AFTER_MS = 3 * 60_000;

/** Remembers what a search showed (the newest reading of the day wins). Never throws. */
export function noteSeen(products: StoreProduct[], day = localDay()): Promise<void> {
  if (serverMode || !products.length) return writing;
  const rows = products.map((p) => seenShape(p, day)).filter((r): r is SeenRow => !!r);
  if (!rows.length) return writing;
  writing = writing
    .then(() =>
      runOps(
        rows.map((r) => ({
          sql: `INSERT OR REPLACE INTO seen_prices (${COLS.join(', ')}, at) VALUES (${COLS.map(() => '?').join(', ')}, ?)`,
          params: [...COLS.map((c) => r[c]), Date.now()],
        })),
      ),
    )
    .catch(() => undefined);
  if (isNative()) {
    timer ??= setTimeout(() => {
      timer = undefined;
      void sendSeenToServer();
    }, SEND_AFTER_MS);
  }
  return writing;
}

export interface SeenBefore {
  price: number;
  day: string;
  special: boolean;
}

/**
 * The last time each of these was seen before today, at a different price: "was $7.00 on 25 Oct".
 * Keyed "chain|storeProductId". Products never seen before, or seen at the same price, aren't in it.
 */
export async function seenBefore(products: Pick<StoreProduct, 'chain' | 'storeProductId' | 'price'>[], today = localDay()): Promise<Map<string, SeenBefore>> {
  const out = new Map<string, SeenBefore>();
  if (serverMode) return out;
  await writing;
  const byChain = new Map<string, string[]>();
  for (const p of products) if (p.storeProductId) byChain.set(p.chain, [...(byChain.get(p.chain) ?? []), p.storeProductId]);
  for (const [chain, ids] of byChain) {
    for (let i = 0; i < ids.length; i += 200) {
      const part = ids.slice(i, i + 200);
      const rows = await queryRows<SeenRow>(
        `SELECT s.* FROM seen_prices s WHERE s.chain = ? AND s.store_product_id IN (${part.map(() => '?').join(',')}) AND s.day < ?
           AND s.day = (SELECT MAX(q.day) FROM seen_prices q WHERE q.chain = s.chain AND q.store_product_id = s.store_product_id AND q.day < ?)`,
        [chain, ...part, today, today],
      ).catch(() => []);
      for (const r of rows) out.set(`${r.chain}|${r.store_product_id}`, { price: Number(r.price), day: r.day, special: !!r.is_special });
    }
  }
  for (const p of products) {
    const k = `${p.chain}|${p.storeProductId}`;
    const was = out.get(k);
    if (was && typeof p.price === 'number' && Math.abs(was.price - p.price) < 0.005) out.delete(k);
  }
  return out;
}

/** The newest remembered reading of each product at a shop that was on special, since `sinceDay`. */
export async function seenSpecials(chain: string, sinceDay: string): Promise<SeenRow[]> {
  if (serverMode) return [];
  await writing;
  return queryRows<SeenRow>(
    `SELECT s.* FROM seen_prices s WHERE s.chain = ? AND s.day >= ? AND s.is_special = 1
       AND s.day = (SELECT MAX(q.day) FROM seen_prices q WHERE q.chain = s.chain AND q.store_product_id = s.store_product_id)
     ORDER BY s.name LIMIT 500`,
    [chain, sinceDay],
  ).catch(() => []);
}

/** How long search results are kept, in weeks: the phone's price history, or their own time. */
export const seenKeepWeeks = (s: Pick<Settings, 'historyWeeks' | 'searchKeepWeeks'>): number =>
  s.searchKeepWeeks !== undefined && (KEEP_WEEKS as readonly number[]).includes(s.searchKeepWeeks) ? s.searchKeepWeeks : s.historyWeeks;

/** Deletes remembered results older than the time they're kept for. Resolves how many went. */
export async function pruneSeen(s: Pick<Settings, 'historyWeeks' | 'searchKeepWeeks'>, now = Date.now()): Promise<number> {
  if (serverMode) return 0;
  const weeks = seenKeepWeeks(s);
  // only ever a real choice: a nonsense number deletes nothing (as pruneHistory)
  if (!(KEEP_WEEKS as readonly number[]).includes(weeks) || !Number.isFinite(now)) return 0;
  await writing;
  const cutoff = localDay(now - weeks * 7 * 86_400_000);
  const [{ n }] = await queryRows<{ n: number }>('SELECT COUNT(*) AS n FROM seen_prices WHERE day < ?', [cutoff]);
  if (Number(n) > 0) await runOps([{ sql: 'DELETE FROM seen_prices WHERE day < ?', params: [cutoff] }]);
  return Number(n);
}

/** How many are remembered, and from when ("Remembering 1,240 prices of 310 products, since 3 Nov"). */
export async function seenCount(): Promise<{ rows: number; products: number; oldest?: string }> {
  if (serverMode) return { rows: 0, products: 0 };
  await writing;
  const [r] = await queryRows<{ n: number; p: number; d: string | null }>(
    "SELECT COUNT(*) AS n, COUNT(DISTINCT chain || '|' || store_product_id) AS p, MIN(day) AS d FROM seen_prices",
  );
  return { rows: Number(r?.n ?? 0), products: Number(r?.p ?? 0), oldest: r?.d ?? undefined };
}

const CURSOR = 'seenServerCursor';

/**
 * On a phone in a Restock server household: sends what's been remembered since last time to that
 * server, 500 rows a request. Quietly does nothing without a server, on an older server (it answers
 * 404 and the rows wait), or offline. Resolves how many the server took.
 */
export async function sendSeenToServer(): Promise<number> {
  if (serverMode || !isNative()) return 0;
  try {
    const { syncInfo } = await import('./sync');
    const i = await syncInfo();
    if (!i.server || i.serverApi !== 3) return 0;
    await writing;
    const where = i.serverHome ?? 'server';
    const cur = (await getKV<{ where: string; at: number }>(CURSOR)) ?? { where, at: 0 };
    let at = cur.where === where ? cur.at : 0;
    let taken = 0;
    for (let n = 0; n < 40; n++) {
      const rows = await queryRows<SeenRow & { at: number }>(`SELECT ${COLS.join(', ')}, at FROM seen_prices WHERE at > ? ORDER BY at LIMIT 500`, [at]);
      if (!rows.length) break;
      const r = await RestockNative.serverSeen({ rows: rows.map(({ at: _at, ...row }) => row) });
      taken += r.added;
      at = rows[rows.length - 1].at;
      await putKV(CURSOR, { where, at });
      if (rows.length < 500) break;
    }
    return taken;
  } catch {
    return 0; // out of reach, or a server from before 0.11.0: next time
  }
}
