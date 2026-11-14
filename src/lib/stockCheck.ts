// 0.10.7: stock, only when you ask. Most people don't mind about stock, so the background price
// checks stopped asking for it, and the badges came off the pantry and the search results. On the
// shopping list, "Check stock" asks each shop about your branch for what's on the list, right then,
// and says what's out where: "Coles Aitkenvale: 3 not in stock". Your second store is only suggested
// when it has everything on your list for that shop; one that's missing other things isn't.
import { adapterFor } from '../stores';
import { colesAtStore } from '../stores/coles';
import { isNative } from '../stores/http';
import type { StoreProduct } from '../stores/types';
import { chainName } from '../shops';
import { nowIso, updateProduct } from './db';
import { storeChoice, type Chain, type Settings } from '../types';
import { stockPlaces, type ShopStock, type Stock, type StockItem } from './stockWhere';

export { STOCK_FRESH_MS, stockFresh, stockPlaces, type ShopStock, type Stock, type StockItem } from './stockWhere';

const find = (found: StoreProduct[], item: StockItem) =>
  found.find((p) => item.storeProductId && String(p.storeProductId) === String(item.storeProductId));

const stockOf = (p?: StoreProduct): Stock => (p?.inStock === true ? 'in' : p?.inStock === false ? 'out' : 'unknown');

/** Asks the shops now. Calls onStep with how far along it is. */
export async function checkStock(items: StockItem[], s: Pick<Settings, 'stores' | 'accounts'> | undefined, onStep?: (done: number, total: number) => void): Promise<ShopStock[]> {
  const byChain = new Map<Chain, StockItem[]>();
  for (const it of items) byChain.set(it.chain, [...(byChain.get(it.chain) ?? []), it]);
  const out: ShopStock[] = [];
  const total = items.length;
  let done = 0;
  for (const [chain, list] of byChain) {
    const places = stockPlaces(s, chain);
    const shop: ShopStock = { chain, where: places.where ?? chainName(chain), where2: places.where2, cant: places.cant, rows: [] };
    out.push(shop);
    if (places.cant || !isNative()) {
      if (!places.cant) shop.cant = 'Checking stock works in the Android app.';
      done += list.length;
      onStep?.(done, total);
      continue;
    }
    const c = s ? storeChoice(s as Settings, 'coles') : {};
    for (const it of list) {
      let main: Stock = 'unknown';
      let second: Stock | undefined;
      try {
        if (chain === 'coles') {
          main = stockOf(find(await colesAtStore(it.productName, c.branchStoreNo!), it));
          if (places.where2) second = stockOf(find(await colesAtStore(it.productName, c.branchStoreNo2!), it));
        } else {
          main = stockOf(find(await adapterFor(chain as never)!.search(it.productName), it));
        }
      } catch {
        // that shop didn't answer: unknown
      }
      shop.rows.push({ name: it.name, main, second });
      if (it.productId && main !== 'unknown')
        await updateProduct(it.productId, {
          inStock: main === 'in',
          inStock2: second === undefined || second === 'unknown' ? undefined : second === 'in',
          stockAt: nowIso(),
        }).catch(() => undefined);
      done++;
      onStep?.(done, total);
    }
  }
  return out;
}

/** "Coles Townsville City has everything on your list": only when the second store has every one in stock. */
export function secondHasAll(shop: ShopStock): boolean {
  if (!shop.where2 || !shop.rows.length) return false;
  const outAtMain = shop.rows.some((r) => r.main === 'out');
  return outAtMain && shop.rows.every((r) => r.second === 'in');
}
