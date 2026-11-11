import { isLocalOnlyShop, isPressOnlyShop } from '../shops';
import { costco } from '../stores/costco';
import type { StoreAdapter } from '../stores/types';
import type { Product } from '../types';
import { addReading, nowIso, readingsFor, updateProduct } from './db';
import { background } from './undo';
import { localDay } from './verdict';

// 0.9.6 (review L1): the ONLY way a Costco product's price is checked again. The person presses
// "Check at Costco" on that item's page: one search (one page) for the product's item number, through
// the Costco reader's own gentle limit (stores/costco.ts Gate). "Check now" for everything, the
// background check, widgets, alerts and recalls never ask Costco (check.ts, PriceChecker.java).

/** What "Check at Costco" says when it is done (or could not be done). */
export interface CostcoCheck {
  ok: boolean;
  text: string;
}

/** Products on an item that "Check at Costco" can check: Costco's, with an item number. */
export const costcoCheckable = <P extends Pick<Product, 'chain' | 'storeProductId'>>(products: readonly P[]): P[] =>
  products.filter((p) => isPressOnlyShop(p.chain) && !!p.storeProductId);

/**
 * Check one Costco product's price now, because the person pressed "Check at Costco". `reader` is
 * for tests; the app always uses the Costco reader itself.
 */
export async function checkAtCostco(p: Product, reader: StoreAdapter = costco): Promise<CostcoCheck> {
  if (!isLocalOnlyShop(p.chain) || !p.storeProductId) return { ok: false, text: 'Restock can’t check this one at Costco.' };
  let found;
  try {
    found = await reader.search(p.storeProductId);
  } catch (e) {
    return { ok: false, text: e instanceof Error ? e.message : String(e) };
  }
  const hit = found.find((x) => x.storeProductId === p.storeProductId);
  if (!hit || hit.price === undefined) return { ok: false, text: `Costco didn’t show a price for ${p.name} just now.` };
  const prev = ((await readingsFor([p.id])).get(p.id) ?? []).slice(-1)[0];
  const same = !!prev && localDay(prev.date) === localDay(nowIso()) && prev.price === hit.price;
  if (!same)
    // A price check is never part of an action someone is doing (no Undo), as in check.ts.
    await background(async () => {
      await addReading({
        productId: p.id,
        date: nowIso(),
        price: hit.price!,
        wasPrice: hit.wasPrice,
        isSpecial: hit.isSpecial,
        memberOnly: hit.memberOnly,
        promo: hit.promo,
        source: 'auto',
      });
      if (hit.inStock !== undefined) await updateProduct(p.id, { inStock: hit.inStock, stockAt: nowIso() });
    });
  const how = hit.costco?.delivery === 'checkout' ? 'Online price, shipping added at checkout.' : 'Online price, includes delivery.';
  return { ok: true, text: `Checked at Costco: ${p.name}, $${hit.price.toFixed(2)}. ${how}` };
}
