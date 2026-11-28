import { type Product, type Settings } from '../types';
import { stockFresh, stockPlaces } from './stockWhere';
import { customShop, priceSource, sectionOn, shopDef, tabsOf } from '../shops';
import { allGroups, cardChains, getProducts, getProductsByBarcode, getSettings, groupProductIds, readingsFor } from './db';
import { hasSize } from './unitPrice';
import { recommend, type Recommendation } from './verdict';
import { processShelf, shelfNotes, type ShelfWatch } from './shelfWatch';
import { changeCount, poke } from './live';
import { noteSpeed } from './speedLog';

/**
 * The shops whose prices count (0.9.0): the ones switched on, on a tab that's switched on, and the
 * websites their prices come from (a Liquorland Warehouse product is saved under Liquorland). The
 * same shops the price check checks (check.ts, PriceChecker.java). Hand-typed prices ('other')
 * always count; recommend() lets them through.
 */
export function shopsOn(settings: Pick<Settings, 'enabledChains' | 'sections'> & Partial<Pick<Settings, 'costco' | 'shopTabs'>>): Set<string> {
  const on = new Set<string>();
  // 0.9.6: Costco is this phone's own switch (settings.costco), not one of the household's shops.
  if (settings.costco?.on) on.add('costco');
  for (const c of settings.enabledChains ?? []) {
    if (!shopDef(c) && !customShop(c)) continue;
    // 0.10.3: counts when any tab it's in is on.
    if (!tabsOf(c, settings.shopTabs ?? {}).some((t) => sectionOn(settings, t))) continue;
    on.add(c);
    on.add(priceSource(c));
  }
  return on;
}

// 0.15.1: worked out once per change to the database and shared: Home, the tabs, the list, an item's
// page and More each asked for them on every change, and Home asked twice.
// A minute at most, as well: what's on special, what's stale and this week's specials go by the clock too.
let shared: Shared | undefined;
const SHARE_MS = 60_000;

/** The recommendation for every pantry item (shared by every screen until the database changes). Don't change what it answers. */
export function loadRecommendations(): Promise<Recommendation[]> {
  const at = changeCount();
  const now = Date.now();
  // 0.18.2: the ones kept from last time, to every screen, until the first are worked out.
  if (opening) return Promise.resolve(opening);
  if (shared && shared.at === at && now - shared.when >= 0 && now - shared.when < SHARE_MS) return shared.run;
  // 0.18.2: while a price check is saving prices every few seconds, they're worked out again at most
  // every HELD_MS (they were worked out again at every lot it saved, for every screen); once it ends, at once.
  if (held && shared?.done && now - shared.when >= 0 && now - shared.when < HELD_MS) return shared.run;
  const run = workOutRecommendations();
  const entry: Shared = { at, when: now, run, done: false };
  shared = entry;
  const t0 = performance.now();
  // A failed run isn't kept: the next ask tries again.
  run.then(
    (recs) => {
      entry.done = true;
      noteSpeed('prices', performance.now() - t0);
      keepSnapshot(recs);
    },
    () => {
      if (shared === entry) shared = undefined;
    },
  );
  // 0.18.2: when Restock opens, the last ones it worked out (kept on this phone) show straight away,
  // while today's are worked out; the screens then show those.
  if (!snapshotUsed) {
    snapshotUsed = true;
    const snap = readSnapshot();
    if (snap) {
      opening = snap;
      const done = () => {
        opening = undefined;
        poke();
      };
      void run.then(done, done);
      return Promise.resolve(snap);
    }
  }
  return run;
}

type Shared = { at: number; when: number; run: Promise<Recommendation[]>; done: boolean };

/** 0.18.2: a price check is saving prices (check.ts): work them out at most every HELD_MS. */
let held = false;
const HELD_MS = 8_000;
export function holdRecs(on: boolean): void {
  held = on;
  if (!on) poke();
}

// ---------- 0.18.2: the last ones worked out, kept on this phone for the next time it opens ----------
const SNAP_KEY = 'restock.recsSnapshot.v1';
let snapshotUsed = false;
/** The ones kept from last time, while the first are worked out. */
let opening: Recommendation[] | undefined;
let snapSavedAt = 0;
let snapTimer: ReturnType<typeof setTimeout> | undefined;
let snapLatest: Recommendation[] | undefined;
const SNAP_EVERY_MS = 30_000;

function readSnapshot(): Recommendation[] | undefined {
  try {
    const t = globalThis.localStorage?.getItem(SNAP_KEY);
    if (!t) return undefined;
    const v = JSON.parse(t) as { v: number; recs: Recommendation[] };
    return v && v.v === 1 && Array.isArray(v.recs) ? v.recs : undefined;
  } catch {
    return undefined;
  }
}
function writeSnapshot(): void {
  snapTimer = undefined;
  if (!snapLatest) return;
  snapSavedAt = Date.now();
  try {
    globalThis.localStorage?.setItem(SNAP_KEY, JSON.stringify({ v: 1, recs: snapLatest }));
  } catch {
    // Too big for this browser's storage, or not allowed: the next open works them out first.
  }
}
/** Kept at most every half minute (and when Restock leaves the screen). */
function keepSnapshot(recs: Recommendation[]): void {
  snapLatest = recs;
  if (snapTimer) return;
  snapTimer = setTimeout(writeSnapshot, Math.max(0, SNAP_EVERY_MS - (Date.now() - snapSavedAt)));
}
if (typeof document !== 'undefined')
  document.addEventListener?.('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && snapTimer) {
      clearTimeout(snapTimer);
      writeSnapshot();
    }
  });
/** For the tests: forget the snapshot was used, and what's shared. */
export function resetRecsForTests(): void {
  snapshotUsed = false;
  opening = undefined;
  shared = undefined;
}

/** Work out the recommendation for every pantry item. */
async function workOutRecommendations(): Promise<Recommendation[]> {
  const [groups, cards, settings] = await Promise.all([allGroups(), cardChains(), getSettings()]);
  const ids = [...new Set(groups.flatMap(groupProductIds))];
  const [productRows, readings] = await Promise.all([getProducts(ids), readingsFor(ids)]);
  // Stock only counts when it's about your own store (Woolworths signed in, Coles with your branch).
  // 0.10.7: and only from a "Check stock" in the last few hours: it isn't checked in the background
  // any more, and older answers aren't shown (stock changes during the day).
  const products = new Map<string, Product>(
    productRows.map((p) => [p.id, stockFresh(p.stockAt) && !stockPlaces(settings, p.chain).cant ? p : { ...p, inStock: undefined, inStock2: undefined }]),
  );
  // Shops you've switched off don't count anywhere: Home, the tabs, item pages, the list, widgets (0.9.0).
  const on = shopsOn(settings);
  const now = Date.now();
  // 0.9.6: a product with no size can copy it from the same barcode anywhere in the catalogue.
  const codes = productRows.filter((p) => p.barcode && !hasSize(p)).map((p) => p.barcode!);
  // 0.19.0: an extra too: without it the items still show.
  const same = codes.length ? (await getProductsByBarcode(codes).catch(() => [] as Product[])).filter((p) => !products.has(p.id)) : [];
  // 0.11.3: packs that changed size and products a shop no longer lists (this phone's price checks).
  const watch = await processShelf().catch(() => ({}) as ShelfWatch);
  const watching = Object.keys(watch).length > 0;
  return groups.map((g) => {
    const rec = recommend(g, products, readings, cards, now, on, same);
    if (watching) rec.shelf = shelfNotes(rec.options.map((o) => o.product), watch);
    return rec;
  });
}
