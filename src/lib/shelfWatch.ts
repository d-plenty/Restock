// 0.11.3: what a price check notices about a product besides its price: a pack that changed size
// under the same product number ("shrinkflation"), and a product the shop says it no longer has.
// PriceChecker.java writes what it saw (ShelfWatch.java, kv "shelfWatch"); this file works out what
// it means and what to say. Kept on this phone only, like aisle numbers: not synced, not shared.
//
// - Size: the shop gives another size for a product number Restock already keeps. When the amount
//   really differs (500 g → 450 g, not "500G" → "500 g"), the item says so, with how much dearer or
//   cheaper that makes it per 100 g, litre or item, and the product takes the new size so every
//   comparison uses it.
// - No longer sold: the shop itself answered that the product isn't there, on price checks on
//   separate days. Woolworths is asked for the product by its number, so "not found" is plain ("gone":
//   said after 2 checks). Coles and Aldi are looked up by searching for the product's name, so all
//   that's known is that the search stopped listing that number ("unlisted": said after 3 checks, in
//   softer words). Never from "out of stock", a block, a timeout or no price: those aren't answers.
//   Found again, it clears by itself.
import { chainName, type Chain, type Product } from '../types';
import { getKV, getProduct, putKV, updateProduct, allProducts } from './db';
import { readSize, sizeLabel } from './unitPrice';
import type { StoreProduct } from '../stores/types';

const KV = 'shelfWatch';

export interface Miss {
  /** The day (YYYY-MM-DD) it was first not found, and the last. */
  since: string;
  last: string;
  /** Days it was asked for and not found, in a row. */
  n: number;
  why: 'gone' | 'unlisted';
  /** "Keep watching": the notice is put away until it's found again (which wipes this). */
  hidden?: boolean;
}
export interface SizeChange {
  /** As shown: "500 g", "450 g". */
  from: string;
  to: string;
  fromQty: number;
  toQty: number;
  unit: string;
  at: string;
  /** The price when it was noticed. */
  price?: number;
}
export interface ShelfEntry {
  miss?: Miss;
  saw?: { size: string; name?: string; at: string; ok?: boolean };
  changed?: SizeChange;
}
export type ShelfWatch = Record<string, ShelfEntry>;

/** The shops watched: each has a way of asking that tells "not there" from "couldn't ask", and one product number is one pack. */
const WATCHED = ['woolworths', 'coles', 'aldi'] as const;
/** Checks on separate days before "no longer sold" is said. */
const MISS_CHECKS = { gone: 2, unlisted: 3 } as const;
/** A change smaller than this is rounding or a relabel, not a different pack. */
const REAL_CHANGE = 0.03;

type Kept = Pick<Product, 'name' | 'size' | 'qty' | 'qtyUnit'>;

/** The change from the size kept to the size the shop gives now, when the amount really differs. */
export function sizeChangeOf(kept: Kept, seen: { size: string; name?: string }, at: string, price?: number): SizeChange | undefined {
  // An amount you typed in yourself is yours: the shop's words don't change it.
  if (kept.qty && kept.qtyUnit) return undefined;
  const now = { name: seen.name || kept.name, size: seen.size };
  const a = readSize({ name: kept.name, size: kept.size }).size;
  const b = readSize(now).size;
  if (!a || !b || a.unit !== b.unit || !(a.qty > 0) || !(b.qty > 0)) return undefined;
  if (Math.abs(b.qty - a.qty) / a.qty < REAL_CHANGE) return undefined;
  return { from: sizeLabel({ name: kept.name, size: kept.size }), to: sizeLabel(now), fromQty: a.qty, toQty: b.qty, unit: b.unit, at, price };
}

/**
 * How much dearer (or cheaper, negative) each gram, millilitre or item is after the change, in per
 * cent: at the price it was noticed at when no earlier price is known (the same price for less).
 */
export function dearerPct(c: Pick<SizeChange, 'fromQty' | 'toQty'>, priceBefore?: number, priceNow?: number): number {
  const pb = priceBefore && priceBefore > 0 ? priceBefore : undefined;
  const pn = priceNow && priceNow > 0 ? priceNow : undefined;
  const before = (pb ?? pn ?? 1) / c.fromQty;
  const now = (pn ?? pb ?? 1) / c.toQty;
  return Math.round((now / before - 1) * 100);
}

/** "Woolworths' website", "Aldi's search" (as Specials writes them). */
const theirs = (shop: string) => `${shop}${/s$/i.test(shop) ? "'" : "'s"}`;
const perWord = (unit: string) => (unit === 'g' ? 'per 100 g' : unit === 'ml' ? 'per litre' : unit === 'sheet' ? 'per sheet' : 'each');
const day = (d: string) => {
  const t = Date.parse(d.length === 10 ? `${d}T12:00:00` : d);
  return Number.isFinite(t) ? new Date(t).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' }) : d;
};

/** "Woolworths' pack went from 500 g to 450 g (noticed 16 Nov). At the same price that's 11% more per 100 g." */
export function changeWords(chain: Chain | string, c: SizeChange): { title: string; text: string; smaller: boolean } {
  const smaller = c.toQty < c.fromQty;
  const pct = dearerPct(c);
  const shop = chainName(chain as Chain);
  return {
    smaller,
    title: smaller ? 'Smaller pack' : 'Bigger pack',
    text:
      `${shop} changed this from ${c.from} to ${c.to} (noticed ${day(c.at)}). ` +
      (smaller ? `At the same price that's ${pct}% more ${perWord(c.unit)}.` : `At the same price that's ${Math.abs(pct)}% less ${perWord(c.unit)}.`) +
      ' Restock compares it by the new size from now on.',
  };
}

/** The miss to tell the person about, or undefined (not enough checks yet, or put away). */
export const missToSay = (m: Miss | undefined): Miss | undefined => (m && !m.hidden && m.n >= MISS_CHECKS[m.why] ? m : undefined);

/** "Woolworths doesn't seem to sell this any more. Not found since 2 Nov (3 price checks)." */
export function missWords(chain: Chain | string, m: Miss): { title: string; text: string } {
  const shop = chainName(chain as Chain);
  return m.why === 'gone'
    ? { title: `${shop} doesn't seem to sell this any more`, text: `${theirs(shop)} website has answered "not found" for it since ${day(m.since)} (${m.n} price checks). That's about its website, not your local shelf.` }
    : {
        title: `${shop} may not sell this any more`,
        text: `${theirs(shop)} search hasn't listed it since ${day(m.since)} (${m.n} price checks). It may have been renamed or replaced by another size. That's about its website, not your local shelf.`,
      };
}

const readShelf = async (): Promise<ShelfWatch> => (await getKV<ShelfWatch>(KV).catch(() => undefined)) ?? {};

/**
 * Works through what the price check saw: a size that really changed becomes `changed` (and the
 * product takes the new size and name); one that's the same amount written another way is marked
 * looked-at. Answers the watch as it now stands.
 *
 * 0.18.4: answers straight away and saves in the background. The recommendations (and so Home, the
 * tabs and the list) waited for these saves, and on an iPhone or iPad a save can wait behind a sync
 * round: the screens stayed on "Loading…" for as long as that took.
 */
export async function processShelf(): Promise<ShelfWatch> {
  const watch = await readShelf();
  const sizes: { id: string; patch: { size: string; name?: string } }[] = [];
  let dirty = false;
  for (const [id, e] of Object.entries(watch)) {
    if (!e?.saw || e.saw.ok) continue;
    const product = await getProduct(id);
    if (!product) {
      delete watch[id];
      dirty = true;
      continue;
    }
    const change = sizeChangeOf(product, e.saw, e.saw.at);
    if (change) {
      e.changed = change;
      sizes.push({ id, patch: { size: e.saw.size, ...(e.saw.name ? { name: e.saw.name } : {}) } });
      delete e.saw;
    } else {
      e.saw.ok = true;
    }
    dirty = true;
  }
  if (dirty) {
    const save = async () => {
      for (const s of sizes) await updateProduct(s.id, s.patch);
      await putKV(KV, watch);
    };
    saving = saving.then(save, save).catch(() => undefined);
  }
  return watch;
}
/** 0.18.4: processShelf's saves, one lot after another. */
let saving: Promise<void> = Promise.resolve();
/** For the tests: when processShelf's saves are done. */
export const shelfSaved = (): Promise<void> => saving;

/**
 * A search just showed these: any that Restock already keeps (same shop, same product number) with
 * another amount is a pack that changed, and any that had stopped being found is back.
 */
export async function noteSearchSizes(results: StoreProduct[]): Promise<void> {
  // Only the shops the price check watches too (ShelfWatch.java watched): one product number is one pack there.
  const sized = results.filter((r) => r.storeProductId && (WATCHED as readonly string[]).includes(r.chain));
  if (!sized.length) return;
  const chains = new Set(sized.map((r) => r.chain));
  const kept = (await allProducts()).filter((p) => p.storeProductId && chains.has(p.chain as never));
  if (!kept.length) return;
  const byKey = new Map(kept.map((p) => [`${p.chain}|${p.storeProductId}`, p]));
  let watch: ShelfWatch | undefined;
  let dirty = false;
  const today = new Date().toLocaleDateString('en-CA');
  for (const r of sized) {
    const p = byKey.get(`${r.chain}|${r.storeProductId}`);
    if (!p) continue;
    watch ??= await readShelf();
    const e = watch[p.id];
    if (e?.miss) {
      delete e.miss;
      dirty = true;
    }
    if (!r.size) continue;
    const change = sizeChangeOf(p, { size: r.size, name: r.name }, today, r.price);
    if (!change) continue;
    watch[p.id] = { ...watch[p.id], changed: change };
    delete watch[p.id].saw;
    await updateProduct(p.id, { size: r.size, name: r.name });
    dirty = true;
  }
  if (watch && dirty) {
    for (const [id, e] of Object.entries(watch)) if (!e || Object.keys(e).length === 0) delete watch[id];
    await putKV(KV, watch).catch(() => undefined);
  }
}

const patch = async (id: string, fn: (e: ShelfEntry) => void) => {
  const watch = await readShelf();
  const e = watch[id];
  if (!e) return;
  fn(e);
  if (Object.keys(e).length === 0) delete watch[id];
  await putKV(KV, watch);
};
/** "Got it" on a pack-size notice. */
export const ackChange = (productId: string) => patch(productId, (e) => void delete e.changed);
/** "Keep watching" on a no-longer-sold notice: put away until it's found again. */
export const hideMiss = (productId: string) => patch(productId, (e) => void (e.miss && (e.miss.hidden = true)));
/** Found at the shop after all (Find a replacement turned it up): the count is wiped. */
export const foundAgain = (productId: string) => patch(productId, (e) => void delete e.miss);

/** What to say on an item, from its products: the picks whose pack changed, and the ones no longer found. */
export interface ShelfNotes {
  changed: { productId: string; chain: string; name: string; change: SizeChange }[];
  gone: { productId: string; chain: string; name: string; miss: Miss }[];
}
export function shelfNotes(products: Pick<Product, 'id' | 'chain' | 'name'>[], watch: ShelfWatch): ShelfNotes | undefined {
  const changed: ShelfNotes['changed'] = [];
  const gone: ShelfNotes['gone'] = [];
  for (const p of products) {
    const e = watch[p.id];
    if (!e) continue;
    if (e.changed) changed.push({ productId: p.id, chain: p.chain, name: p.name, change: e.changed });
    const miss = missToSay(e.miss);
    if (miss) gone.push({ productId: p.id, chain: p.chain, name: p.name, miss });
  }
  return changed.length || gone.length ? { changed, gone } : undefined;
}

/** The words to search a shop with for a product's replacement: its name without sizes and pack counts. */
export function replacementTerm(name: string): string {
  const t = name
    .replace(/\b\d+(?:\.\d+)?\s*(?:x|×)\s*\d+(?:\.\d+)?\s*(?:kg|g|ml|l|litres?|pack|pk)\b/gi, ' ')
    .replace(/\b\d+(?:\.\d+)?\s*(?:kg|g|mg|ml|l|litres?|sheets?|rolls?|packs?|pk|tablets?|capsules?|wipes?|cans?|bottles?|ea|each)\b/gi, ' ')
    .replace(/\b(?:x|×)\s*\d+\b/gi, ' ')
    .replace(/(?:^|\s)(?:x|×)(?=\s|$)/gi, ' ')
    .replace(/[|,()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length >= 3 ? t : name.trim();
}

/** How a replacement compares with the product it replaces: "450 g, was 500 g · 11% more per 100 g". */
export function replacementLine(old: Kept & { price?: number }, next: { name: string; size?: string; price?: number }): string | undefined {
  const a = readSize({ name: old.name, size: old.size, qty: old.qty, qtyUnit: old.qtyUnit }).size;
  const b = readSize({ name: next.name, size: next.size }).size;
  if (!a || !b || a.unit !== b.unit || !(a.qty > 0) || !(b.qty > 0)) return undefined;
  const same = Math.abs(b.qty - a.qty) / a.qty < REAL_CHANGE;
  const sizes = same ? 'Same size' : `${sizeLabel({ name: next.name, size: next.size })}, was ${sizeLabel(old)}`;
  if (!old.price || !next.price) return sizes;
  const pct = dearerPct({ fromQty: a.qty, toQty: b.qty }, old.price, next.price);
  return `${sizes} · ${pct === 0 ? `the same ${perWord(a.unit)}` : `${Math.abs(pct)}% ${pct > 0 ? 'more' : 'less'} ${perWord(a.unit)}`}`;
}
