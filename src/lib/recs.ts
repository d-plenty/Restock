import { type Product, type Settings } from '../types';
import { stockFresh, stockPlaces } from './stockWhere';
import { customShop, priceSource, sectionOn, shopDef, tabsOf } from '../shops';
import { allGroups, cardChains, getProducts, getProductsByBarcode, getSettings, groupProductIds, readingsFor } from './db';
import { hasSize } from './unitPrice';
import { recommend, type Recommendation } from './verdict';
import { processShelf, shelfNotes, type ShelfWatch } from './shelfWatch';
import { changeCount } from './live';

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
let shared: { at: number; when: number; run: Promise<Recommendation[]> } | undefined;
const SHARE_MS = 60_000;

/** The recommendation for every pantry item (shared by every screen until the database changes). Don't change what it answers. */
export function loadRecommendations(): Promise<Recommendation[]> {
  const at = changeCount();
  const now = Date.now();
  if (shared && shared.at === at && now - shared.when >= 0 && now - shared.when < SHARE_MS) return shared.run;
  const run = workOutRecommendations();
  shared = { at, when: now, run };
  // A failed run isn't kept: the next ask tries again.
  run.catch(() => {
    if (shared?.run === run) shared = undefined;
  });
  return run;
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
  const same = codes.length ? (await getProductsByBarcode(codes)).filter((p) => !products.has(p.id)) : [];
  // 0.11.3: packs that changed size and products a shop no longer lists (this phone's price checks).
  const watch = await processShelf().catch(() => ({}) as ShelfWatch);
  const watching = Object.keys(watch).length > 0;
  return groups.map((g) => {
    const rec = recommend(g, products, readings, cards, now, on, same);
    if (watching) rec.shelf = shelfNotes(rec.options.map((o) => o.product), watch);
    return rec;
  });
}
