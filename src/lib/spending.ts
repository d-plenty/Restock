import type { DataSeries, DataStats, Period, TopItem, TopPage } from '../server-mode/ui/houseData';
import type { SqlValue } from './sql/driver';
import { getKV, onBeforeListDelete, putKV, queryRows, runSql } from './db';
import { RestockNative } from './sql/native';
import { serverMode } from '../server-mode/flag';

// 0.9.14: Settings → Your data on a phone without a Restock server: spending from what you tick off,
// worked out on this phone the same way the server's Data tab does it (server/src/v3/data.mjs,
// ported): every tick is one purchase at the line's shop on the day it was ticked, priced from the
// line's own price, else the newest price of the item at that shop. Kept in spend_log (schema.ts
// SPEND_TABLE), on this phone only: never synced, backed up or sent anywhere.

const DAY = 86_400_000;
/** An untick within this long of the tick takes the purchase back (a mis-tap, or not bought). */
export const UNDO_MS = 2 * DAY;
const HISTORY_DAYS = 183;
const LIST_NAMES: Record<string, string> = { pantry: 'Groceries', keg: 'Keg', pharmacy: 'Health', general: 'General' };
const CHAIN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

type Row = Record<string, unknown>;
type Q = (sql: string, params?: SqlValue[]) => Promise<Row[]>;
type Run = (sql: string, params?: SqlValue[]) => Promise<void>;

const round2 = (n: number) => Math.round(n * 100) / 100;
const pad = (n: number) => String(n).padStart(2, '0');
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const iso = (t = Date.now()) => new Date(t).toISOString();
function median(values: number[]): number | undefined {
  if (!values.length) return undefined;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
/** The calendar day on this phone. */
function localDay(v: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v).slice(0, 10);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
const localMonth = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
};
/** The specials week a day is in (weeks start on Wednesday), as yyyy-mm-dd. */
export function weekOf(date: string): string {
  const [y, m, d] = localDay(date).split('-').map(Number);
  const from = new Date(Date.UTC(y, m - 1, d));
  from.setUTCDate(from.getUTCDate() - ((from.getUTCDay() + 7 - 3) % 7));
  return `${from.getUTCFullYear()}-${pad(from.getUTCMonth() + 1)}-${pad(from.getUTCDate())}`;
}
function jsonOr<T>(v: unknown, fallback: T): T {
  if (typeof v !== 'string') return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
}
const ids = (v: unknown): string[] => {
  const a = jsonOr<unknown>(v, null);
  return Array.isArray(a) ? a.filter((x): x is string => typeof x === 'string') : [];
};

export function makeSpending(q: Q, run: Run, now: () => number = Date.now) {
  async function priceAt(pid: string, at: number): Promise<Row | null> {
    const sql = 'SELECT date, price, was_price, is_special, member_only FROM prices WHERE product_id = ?';
    return (await q(sql + ' AND date <= ? ORDER BY date DESC LIMIT 1', [pid, iso(at)]))[0] ?? (await q(sql + ' ORDER BY date DESC LIMIT 1', [pid]))[0] ?? null;
  }

  async function usualOf(pid: string | null | undefined, at: number, memo?: Map<string, number | null>): Promise<number | null> {
    if (!pid) return null;
    const key = `${pid}|${localDay(iso(at))}`;
    if (memo?.has(key)) return memo.get(key)!;
    const rows = await q('SELECT date, price, was_price, is_special FROM prices WHERE product_id = ? AND date >= ? AND date <= ? ORDER BY date', [pid, iso(at - HISTORY_DAYS * DAY), iso(at)]);
    const byDay = new Map<string, Row>();
    for (const r of rows) byDay.set(localDay(String(r.date)), r);
    const readings = [...byDay.values()];
    let u = median(readings.filter((r) => !Number(r.is_special)).map((r) => Number(r.price)));
    if (u === undefined) u = median(readings.map((r) => num(r.was_price)).filter((v): v is number => v !== null && v > 0));
    if (u === undefined) {
      const m = (await q('SELECT m.normal FROM market m JOIN products p ON p.chain = m.chain AND p.store_product_id = m.store_product_id WHERE p.id = ? LIMIT 1', [pid]))[0];
      u = m && Number(m.normal) > 0 ? Number(m.normal) : undefined;
    }
    const out = u === undefined ? null : round2(u);
    memo?.set(key, out);
    return out;
  }

  async function productsOf(itemId: string): Promise<{ id: string; role: 'main' | 'alt'; chain: string }[]> {
    const it = (await q('SELECT usual_product_id, same_product_ids, alt_product_ids FROM items WHERE id = ?', [itemId]))[0];
    if (!it) return [];
    const order: { id: string; role: 'main' | 'alt' }[] = [];
    const seen = new Set<string>();
    const add = (id: unknown, role: 'main' | 'alt') => {
      if (typeof id === 'string' && id && !seen.has(id)) {
        seen.add(id);
        order.push({ id, role });
      }
    };
    add(it.usual_product_id, 'main');
    for (const id of ids(it.same_product_ids)) add(id, 'main');
    for (const id of ids(it.alt_product_ids)) add(id, 'alt');
    const chains = new Map<string, string>();
    if (order.length) for (const r of await q(`SELECT id, chain FROM products WHERE id IN (${order.map(() => '?').join(',')})`, order.map((o) => o.id))) chains.set(String(r.id), String(r.chain));
    return order.filter((o) => chains.has(o.id)).map((o) => ({ ...o, chain: chains.get(o.id)! }));
  }

  async function lineProduct(lp: { storeProductId?: unknown } | null, chain: string | null): Promise<string | null> {
    if (!lp || typeof lp.storeProductId !== 'string' || !chain) return null;
    const r = (await q('SELECT id FROM products WHERE chain = ? AND store_product_id = ? LIMIT 1', [chain, lp.storeProductId]))[0];
    return r ? String(r.id) : null;
  }

  /** What a ticked line cost: its own price, else the newest of the item at the line's shop (or the cheapest). */
  async function priceFor(l: Row, at: number, memo: Map<string, number | null>) {
    const item = l.item_id ? (await q('SELECT name, section FROM items WHERE id = ?', [String(l.item_id)]))[0] : undefined;
    const lp = jsonOr<{ chain?: unknown; storeProductId?: unknown } | null>(l.product, null);
    let chain = typeof l.chain === 'string' && CHAIN.test(l.chain) ? l.chain : lp && typeof lp.chain === 'string' && CHAIN.test(lp.chain) ? lp.chain : null;
    const shop = chain && chain !== 'other' ? chain : null;
    const base = { section: String(l.section ?? item?.section ?? 'pantry'), text: String(item?.name ?? l.text ?? '').slice(0, 200) };
    const own = num(l.price);
    if (own !== null && Number.isFinite(own) && own >= 0 && own < 100000) {
      let pid = await lineProduct(lp, shop);
      if (!pid && l.item_id && shop) pid = (await productsOf(String(l.item_id))).find((p) => p.chain === shop)?.id ?? null;
      const usual = await usualOf(pid, at, memo);
      return { ...base, chain, price: round2(own), usual, special: usual !== null && own < usual - 0.005 ? 1 : 0, product_id: pid };
    }
    let pick: { c: { id: string; chain: string | null }; p: Row } | null = null;
    if (l.item_id) {
      const cands = await productsOf(String(l.item_id));
      if (shop) {
        for (const c of cands.filter((x) => x.chain === shop)) {
          const p = await priceAt(c.id, at);
          if (p) {
            pick = { c, p };
            break;
          }
        }
      } else {
        const mains = cands.filter((x) => x.role === 'main');
        for (const c of mains.length ? mains : cands) {
          const p = await priceAt(c.id, at);
          if (p && (!pick || Number(p.price) < Number(pick.p.price))) pick = { c, p };
        }
        if (pick) chain = pick.c.chain;
      }
    } else {
      const pid = await lineProduct(lp, shop);
      const p = pid ? await priceAt(pid, at) : null;
      if (p && pid) pick = { c: { id: pid, chain: shop }, p };
    }
    if (pick) return { ...base, chain, price: round2(Number(pick.p.price)), usual: await usualOf(pick.c.id, at, memo), special: Number(pick.p.is_special) ? 1 : 0, product_id: pick.c.id };
    return { ...base, chain, price: null as number | null, usual: null as number | null, special: 0, product_id: null as string | null };
  }

  /**
   * Notes the ticks, as the server's sweep does: each ticked line (checked_at set) is a purchase keyed
   * by the line and its tick; an untick within UNDO_MS takes it back. A line cleared off the list keeps
   * its purchase. Running it again changes nothing. Sample items aren't counted.
   */
  async function recordTicks(): Promise<{ added: number; removed: number }> {
    const t = now();
    const memo = new Map<string, number | null>();
    const out = { added: 0, removed: 0 };
    const undo = async (id: string, at: number) => {
      const before = Number((await q('SELECT COUNT(*) AS n FROM spend_log WHERE entry_id = ? AND checked_at < ? AND checked_at > ?', [id, at, at - UNDO_MS]))[0]?.n ?? 0);
      if (before) await run('DELETE FROM spend_log WHERE entry_id = ? AND checked_at < ? AND checked_at > ?', [id, at, at - UNDO_MS]);
      return before;
    };
    const ticked = await q(
      "SELECT id, text, item_id, chain, section, qty, price, product, checked_at FROM list_entries WHERE checked = 1 AND checked_at IS NOT NULL AND id NOT LIKE 'demo-%' AND COALESCE(item_id, '') NOT LIKE 'demo-%'",
    );
    for (const l of ticked) {
      const at = Number(l.checked_at);
      if (!Number.isFinite(at) || at <= 0 || at > t + DAY) continue;
      if ((await q('SELECT 1 AS x FROM spend_log WHERE entry_id = ? AND checked_at = ?', [String(l.id), at])).length) continue;
      out.removed += await undo(String(l.id), at);
      const p = await priceFor(l, at, memo);
      const qty = Math.max(1, Math.min(10000, Math.trunc(Number(l.qty) || 1)));
      await run('INSERT OR REPLACE INTO spend_log (entry_id, checked_at, at, chain, section, item_id, product_id, text, qty, price, total, usual, special) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [
        String(l.id),
        at,
        iso(at),
        p.chain,
        p.section,
        l.item_id === null || l.item_id === undefined ? null : String(l.item_id),
        p.product_id,
        p.text,
        qty,
        p.price,
        p.price === null ? null : round2(p.price * qty),
        p.usual,
        p.special,
      ]);
      out.added++;
    }
    for (const l of await q('SELECT id, checked_at FROM list_entries WHERE checked = 0 AND checked_at IS NOT NULL')) {
      const at = Number(l.checked_at);
      if (Number.isFinite(at)) out.removed += await undo(String(l.id), at);
    }
    return out;
  }

  function periodOf(v: Period | undefined) {
    if (v === 'all') return { period: 'all' as const, fromMs: 0, from: null };
    const n = typeof v === 'number' && v >= 1 && v <= 120 ? v : 12;
    const d = new Date(now());
    const from = new Date(d.getFullYear(), d.getMonth() - (n - 1), 1).getTime();
    return { period: n, fromMs: from, from: iso(from) };
  }

  function monthsBetween(fromMs: number, toMs: number): string[] {
    const out: string[] = [];
    const d = new Date(fromMs);
    let y = d.getFullYear();
    let m = d.getMonth() + 1;
    for (let i = 0; new Date(y, m - 1, 1).getTime() <= toMs && i < 1300; i++) {
      out.push(`${y}-${pad(m)}`);
      if (++m > 12) {
        m = 1;
        y++;
      }
    }
    return out;
  }

  async function spendingMonths(fromMs: number) {
    const by = new Map<string, { n: number; total: number; unpriced: number }>();
    let first = Infinity;
    for (const r of await q('SELECT checked_at, total, price FROM spend_log WHERE checked_at >= ?', [fromMs])) {
      const at = Number(r.checked_at);
      if (!Number.isFinite(at)) continue;
      first = Math.min(first, at);
      const k = localMonth(at);
      const b = by.get(k) ?? { n: 0, total: 0, unpriced: 0 };
      b.n++;
      b.total += Number(r.total ?? 0) || 0;
      if (r.price === null || r.price === undefined) b.unpriced++;
      by.set(k, b);
    }
    const start = fromMs || (Number.isFinite(first) ? first : now());
    return monthsBetween(start, now()).map((m) => {
      const r = by.get(m);
      return { month: m, total: r ? round2(r.total) : 0, count: r ? r.n : 0, unpriced: r ? r.unpriced : 0 };
    });
  }

  async function cheapestOf(itemId: string) {
    let best: TopItem['cheapest'] = null;
    for (const c of await productsOf(itemId)) {
      const p = await priceAt(c.id, now());
      if (p && (!best || Number(p.price) < best.price)) best = { chain: c.chain, price: round2(Number(p.price)), productId: c.id, date: String(p.date) };
    }
    return best;
  }

  async function top(period: Period | undefined, offset = 0, limit = 10): Promise<TopPage> {
    const { fromMs } = periodOf(period);
    const keyExpr = "COALESCE(item_id, 'text:' || lower(trim(text)))";
    const total = Number((await q(`SELECT COUNT(DISTINCT ${keyExpr}) AS n FROM spend_log WHERE checked_at >= ?`, [fromMs]))[0]?.n ?? 0);
    const rows = await q(
      `SELECT ${keyExpr} AS k, MAX(item_id) AS item_id, MAX(text) AS text, COUNT(*) AS times, SUM(qty) AS qty, COALESCE(SUM(total), 0) AS total, MAX(checked_at) AS last
       FROM spend_log WHERE checked_at >= ? GROUP BY k ORDER BY times DESC, last DESC, k LIMIT ? OFFSET ?`,
      [fromMs, limit, offset],
    );
    const memo = new Map<string, number | null>();
    const items: TopItem[] = [];
    for (const r of rows) {
      const itemId = r.item_id === null || r.item_id === undefined ? null : String(r.item_id);
      const where = itemId ? 'item_id = ?' : "item_id IS NULL AND 'text:' || lower(trim(text)) = ?";
      const lp = (await q(`SELECT price, chain, checked_at, product_id FROM spend_log WHERE ${where} AND price IS NOT NULL ORDER BY checked_at DESC LIMIT 1`, [itemId ?? String(r.k)]))[0];
      const item = itemId ? (await q('SELECT name FROM items WHERE id = ?', [itemId]))[0] : undefined;
      const usualPid = itemId ? ((await productsOf(itemId)).find((p) => p.role === 'main')?.id ?? (lp?.product_id as string | undefined)) : (lp?.product_id as string | undefined);
      items.push({
        key: String(r.k),
        itemId,
        name: String(item?.name ?? r.text),
        times: Number(r.times),
        qty: Number(r.qty),
        total: round2(Number(r.total)),
        lastAt: iso(Number(r.last)),
        lastPaid: lp ? { price: Number(lp.price), chain: (lp.chain as string | null) ?? null, at: iso(Number(lp.checked_at)) } : null,
        usual: await usualOf(usualPid, now(), memo),
        cheapest: itemId ? await cheapestOf(itemId) : null,
      });
    }
    return { items, offset, limit, total };
  }

  async function stats(period: Period | undefined): Promise<DataStats> {
    const p = periodOf(period);
    const sum = (await q('SELECT COUNT(*) AS n, COALESCE(SUM(total), 0) AS total, SUM(CASE WHEN price IS NULL THEN 1 ELSE 0 END) AS unpriced FROM spend_log WHERE checked_at >= ?', [p.fromMs]))[0] ?? {};
    const shops = (
      await q('SELECT chain, COUNT(*) AS n, COALESCE(SUM(total), 0) AS total, SUM(CASE WHEN price IS NULL THEN 1 ELSE 0 END) AS unpriced FROM spend_log WHERE checked_at >= ? GROUP BY chain ORDER BY total DESC, n DESC', [p.fromMs])
    ).map((r) => ({ chain: (r.chain as string | null) ?? null, total: round2(Number(r.total)), count: Number(r.n), unpriced: Number(r.unpriced) }));
    const bySection = new Map<string, { section: string; name: string; total: number; count: number }>();
    for (const r of await q('SELECT section, COUNT(*) AS n, COALESCE(SUM(total), 0) AS total FROM spend_log WHERE checked_at >= ? GROUP BY section', [p.fromMs])) {
      const id = LIST_NAMES[String(r.section)] ? String(r.section) : 'pantry';
      const had = bySection.get(id) ?? { section: id, name: LIST_NAMES[id], total: 0, count: 0 };
      had.total = round2(had.total + Number(r.total));
      had.count += Number(r.n);
      bySection.set(id, had);
    }
    const sections = [...bySection.values()].sort((a, b) => b.total - a.total || b.count - a.count);
    const saved = (await q('SELECT COUNT(*) AS n, COALESCE(SUM((usual - price) * qty), 0) AS s FROM spend_log WHERE checked_at >= ? AND price IS NOT NULL AND usual IS NOT NULL AND usual > price', [p.fromMs]))[0] ?? {};
    const prices = (await q("SELECT COUNT(*) AS n, MIN(date) AS first FROM prices WHERE source <> 'demo'"))[0] ?? {};
    const inPeriod = (await q("SELECT COUNT(*) AS n, COUNT(DISTINCT product_id) AS products FROM prices WHERE source <> 'demo' AND date >= ?", [p.fromMs ? iso(p.fromMs) : '']))[0] ?? {};
    const items = (await q("SELECT COUNT(*) AS n FROM items WHERE id NOT LIKE 'demo-%'"))[0] ?? {};
    return {
      period: p.period,
      from: p.from,
      to: iso(now()),
      spending: { total: round2(Number(sum.total ?? 0)), count: Number(sum.n ?? 0), unpriced: Number(sum.unpriced ?? 0), months: await spendingMonths(p.fromMs) },
      shops,
      sections,
      saved: { total: round2(Number(saved.s ?? 0)), count: Number(saved.n ?? 0) },
      itemsTracked: Number(items.n ?? 0),
      productsTracked: Number(inPeriod.products ?? 0),
      prices: { count: Number(prices.n ?? 0), first: (prices.first as string | null) ?? null, inPeriod: Number(inPeriod.n ?? 0) },
      top: await top(period, 0, 10),
    };
  }

  async function series(itemId: string, period: Period | undefined): Promise<DataSeries> {
    const p = periodOf(period);
    const item = (await q('SELECT id, name FROM items WHERE id = ?', [itemId]))[0];
    if (!item) throw new Error("That item isn't on this phone.");
    const all = await productsOf(itemId);
    const mains = all.filter((x) => x.role === 'main');
    const use = mains.length ? mains : all;
    const memo = new Map<string, number | null>();
    const cells = new Map<string, DataSeries['weeks'][number]>();
    const fromIso = p.fromMs ? iso(p.fromMs) : '';
    for (const c of use) {
      // Sample items show their made-up prices (so the tour has a chart); nothing else counts them.
      const demo = itemId.startsWith('demo-') ? '' : " AND source <> 'demo'";
      for (const r of await q(`SELECT date, price, is_special FROM prices WHERE product_id = ? AND date >= ?${demo} ORDER BY date`, [c.id, fromIso])) {
        const k = `${weekOf(String(r.date))}|${c.chain}`;
        const had = cells.get(k);
        if (!had || Number(r.price) < had.price) cells.set(k, { week: weekOf(String(r.date)), chain: c.chain, price: round2(Number(r.price)), special: !!Number(r.is_special) });
      }
    }
    const weeks = [...cells.values()].sort((a, b) => a.week.localeCompare(b.week) || a.chain.localeCompare(b.chain));
    const chains: DataSeries['chains'] = [];
    for (const chain of [...new Set(use.map((c) => c.chain))]) {
      const pid = use.find((c) => c.chain === chain)!.id;
      chains.push({ chain, productId: pid, usual: await usualOf(pid, now(), memo) });
    }
    const paid = (await q('SELECT checked_at, chain, price, qty FROM spend_log WHERE item_id = ? AND checked_at >= ? AND price IS NOT NULL ORDER BY checked_at DESC LIMIT 200', [itemId, p.fromMs]))
      .map((r) => ({ at: iso(Number(r.checked_at)), chain: (r.chain as string | null) ?? null, price: Number(r.price), qty: Number(r.qty) }))
      .reverse();
    return { item: { id: String(item.id), name: String(item.name) }, period: p.period, from: p.from, usual: await usualOf(mains[0]?.id ?? use[0]?.id, now(), memo), chains, weeks, paid };
  }

  /** What's kept on this phone, counted. */
  async function stored() {
    const one = async (sql: string) => Number((await q(sql))[0]?.n ?? 0);
    return {
      items: await one("SELECT COUNT(*) AS n FROM items WHERE id NOT LIKE 'demo-%'"),
      products: await one("SELECT COUNT(*) AS n FROM products WHERE id NOT LIKE 'demo-%'"),
      prices: await one("SELECT COUNT(*) AS n FROM prices WHERE source <> 'demo'"),
      oldestPrice: ((await q("SELECT MIN(date) AS d FROM prices WHERE source <> 'demo'"))[0]?.d as string | null) ?? null,
      listLines: await one('SELECT COUNT(*) AS n FROM list_entries'),
      receipts: await one("SELECT COUNT(*) AS n FROM receipts WHERE id NOT LIKE 'demo-%'"),
      cards: await one('SELECT COUNT(*) AS n FROM cards'),
      purchases: await one('SELECT COUNT(*) AS n FROM spend_log'),
      shared: await one('SELECT COUNT(*) AS n FROM market'),
    };
  }

  return { recordTicks, stats, top, series, stored, priceFor };
}

/** This phone's own: its database. */
export const phoneSpending = () =>
  makeSpending(
    (sql, params = []) => queryRows<Row>(sql, params),
    (sql, params = []) => runSql(sql, params),
  );

/** Notes ticks now (after ticking, before clearing the list, when Restock opens). Quiet on failure. */
export async function noteTicks(): Promise<void> {
  if (serverMode) return;
  try {
    await phoneSpending().recordTicks();
  } catch {
    // the table isn't there yet (an older database), or a tick changed meanwhile: next time
  }
}

let timer: ReturnType<typeof setTimeout> | undefined;
/** After a tick: noted a moment later, so a few ticks in a row are one look. */
export function noteTicksSoon(): void {
  if (serverMode) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = undefined;
    void noteTicks();
  }, 1500);
}

// Before ticked lines are cleared off the list, their purchases are noted (phones only).
if (!serverMode) onBeforeListDelete(noteTicks);

/** 0.10.0: whether Your data shows the Restock server's figures (and this phone shares its spending there). */
export const spendingOnServer = (s: { yourData?: { server: boolean } }) => s.yourData?.server !== false;

/**
 * 0.10.0: Share my spending with the server: this phone's earlier spending (from before it joined,
 * or ticks the server never saw) goes to the server once, 500 at a time (the server's limit for a
 * request). The server keeps the ones it already has as they are. Resolves how many it added.
 */
export async function sendSpendingToServer(): Promise<number> {
  if (serverMode) return 0;
  if (await getKV<boolean>('spendSentToServer')) return 0;
  await noteTicks();
  const rows = await queryRows<Row>('SELECT entry_id, checked_at, chain, section, item_id, product_id, text, qty, price, usual, special FROM spend_log ORDER BY checked_at');
  let added = 0;
  for (let i = 0; i < rows.length; i += 500) added += (await RestockNative.serverSpend({ rows: rows.slice(i, i + 500) })).added;
  await putKV('spendSentToServer', true);
  return added;
}

/** At start: on a Restock server with Share my spending on, the earlier spending goes once. */
export async function maybeSendSpending(): Promise<void> {
  if (serverMode) return;
  try {
    const [{ syncInfo }, { getSettings }] = await Promise.all([import('./sync'), import('./db')]);
    const i = await syncInfo();
    if (i.server && i.serverApi === 3 && spendingOnServer(await getSettings())) await sendSpendingToServer();
  } catch {
    // the server is out of reach: next time
  }
}
