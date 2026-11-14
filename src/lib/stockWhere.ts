// 0.10.7: where stock can be checked, and how long an answer counts. Kept apart from the check
// itself (stockCheck.ts) so the pantry's sums don't pull in the shops.
import { chainName } from '../shops';
import { storeChoice, wooliesAccount, type Chain, type Settings } from '../types';

/** Stock is only shown for this long after it was checked: it changes during the day. */
export const STOCK_FRESH_MS = 3 * 60 * 60_000;
export const stockFresh = (at?: string, now = Date.now()) => !!at && now - Date.parse(at) < STOCK_FRESH_MS;

export type Stock = 'in' | 'out' | 'unknown';

export interface StockItem {
  /** What it's called on your list. */
  name: string;
  chain: Chain;
  /** The shop's name for it: what's searched. */
  productName: string;
  storeProductId?: string;
  /** Your product, so the answer is kept on it (the list and Start shopping use it). */
  productId?: string;
}

export interface ShopStock {
  chain: Chain;
  /** "Coles Aitkenvale", or the shop's name. */
  where: string;
  /** Your second store, when it was checked too. */
  where2?: string;
  /** Why this shop can't be checked, when it can't. */
  cant?: string;
  rows: { name: string; main: Stock; second?: Stock }[];
}

type S = Pick<Settings, 'stores' | 'accounts'> | undefined;

/** Can a shop's stock at your branch be checked, and where? Coles: your picked branch (and second). Woolworths: your signed-in store. */
export function stockPlaces(s: S, chain: Chain): { where?: string; where2?: string; cant?: string } {
  const name = chainName(chain);
  if (chain === 'coles') {
    const c = s ? storeChoice(s as Settings, 'coles') : {};
    if (!c.branchStoreNo) return { cant: 'Pick your Coles branch in Settings to check its stock.' };
    return { where: c.primary || 'your Coles', where2: c.branchStoreNo2 && c.branchStoreNo2 !== c.branchStoreNo ? c.secondary || 'your other Coles' : undefined };
  }
  if (chain === 'woolworths') {
    if (!wooliesAccount(s)) return { cant: 'Woolworths only shows stock if you’re signed in.' };
    const w = s?.accounts?.woolworths;
    return { where: w?.storeName ? `Woolworths ${w.storeName.replace(/^woolworths\s+/i, '')}` : 'your Woolworths' };
  }
  if (chain === 'aldi') return { cant: 'Aldi doesn’t say what’s in stock.' };
  if (chain === 'costco') return { cant: 'Costco doesn’t say what’s in stock at a warehouse.' };
  return { cant: `${name} doesn’t share stock at your branch.` };
}

