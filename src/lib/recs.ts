import { stockKnown, type Product, type Settings } from '../types';
import { customShop, priceSource, sectionOn, shopDef, tabsOf } from '../shops';
import { allGroups, cardChains, getProducts, getProductsByBarcode, getSettings, groupProductIds, readingsFor } from './db';
import { hasSize } from './unitPrice';
import { recommend, type Recommendation } from './verdict';

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
  // 0.9.6: a product with no size can copy it from the same barcode anywhere in the catalogue.
  const codes = productRows.filter((p) => p.barcode && !hasSize(p)).map((p) => p.barcode!);
  const same = codes.length ? (await getProductsByBarcode(codes)).filter((p) => !products.has(p.id)) : [];
  return groups.map((g) => recommend(g, products, readings, cards, now, on, same));
}
