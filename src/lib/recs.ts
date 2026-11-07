import { stockKnown, type Product } from '../types';
import { allGroups, cardChains, getProducts, getSettings, groupProductIds, readingsFor } from './db';
import { recommend, type Recommendation } from './verdict';

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
  return groups.map((g) => recommend(g, products, readings, cards));
}
