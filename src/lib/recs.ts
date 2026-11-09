import { stockKnown, type Product, type Settings } from '../types';
import { customShop, priceSource, sectionOf, sectionOn, shopDef } from '../shops';
import { allGroups, cardChains, getProducts, getSettings, groupProductIds, readingsFor } from './db';
import { recommend, type Recommendation } from './verdict';

/**
 * The shops whose prices count (0.9.0): the ones switched on, on a tab that's switched on, and the
 * websites their prices come from (a Liquorland Warehouse product is saved under Liquorland). The
 * same shops the price check checks (check.ts, PriceChecker.java). Hand-typed prices ('other')
 * always count; recommend() lets them through.
 */
export function shopsOn(settings: Pick<Settings, 'enabledChains' | 'sections'>): Set<string> {
  const on = new Set<string>();
  for (const c of settings.enabledChains ?? []) {
    if (!shopDef(c) && !customShop(c)) continue;
    if (!sectionOn(settings, sectionOf(c))) continue;
    on.add(c);
    on.add(priceSource(c));
  }
  return on;
}

/** Work out the recommendation for every pantry item. */
export async function loadRecommendations(): Promise<Recommendation[]> {
  const [groups, cards, settings] = await Promise.all([allGroups(), cardChains(), getSettings()]);
  const ids = [...new Set(groups.flatMap(groupProductIds))];
  const [productRows, readings] = await Promise.all([getProducts(ids), readingsFor(ids)]);
  // Stock only counts when it's about your own store (Woolworths signed in, Coles with your store
  // number). The shops' online stock isn't reliable for your store, so it's left out altogether.
  const products = new Map<string, Product>(
    productRows.map((p) => [p.id, stockKnown(settings, p.chain) ? p : { ...p, inStock: undefined, inStock2: undefined }]),
  );
  // Shops you've switched off don't count anywhere: Home, the tabs, item pages, the list, widgets (0.9.0).
  const on = shopsOn(settings);
  const now = Date.now();
  return groups.map((g) => recommend(g, products, readings, cards, now, on));
}
