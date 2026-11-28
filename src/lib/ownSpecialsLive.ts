import type { StoreProduct } from '../stores/types';
import type { ListEntry } from '../types';
import { buildCatalogue } from './myCatalogue';
import { ownSpecials } from './ownSpecials';
import { seenSpecials } from './seen';
import { cachedSpecials } from './specials';
import { specialsWeekStart, type Recommendation } from './verdict';

/** The phone's own calendar day a specials week starts on ("2026-11-11"). */
export const weekDay = (ms = Date.now()) => {
  const d = new Date(specialsWeekStart(ms));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/**
 * 0.12.3: how many of your own things are on special at each shop, counted the way the shop's page
 * shows them (your items' sales, plus one-off list lines on special there). Nothing is fetched: the
 * shops' lists are the last ones the phone (or, on the web page, a phone) got.
 */
export async function ownCounts(recs: Recommendation[], chains: string[], entries: ListEntry[]): Promise<Map<string, number>> {
  const cat = buildCatalogue(recs, chains);
  const lists: Record<string, StoreProduct[]> = {};
  for (const l of await cachedSpecials()) lists[l.chain] = l.items;
  const lines = entries.some((e) => !e.checked && !e.groupId && e.product?.storeProductId);
  const since = weekDay();
  const out = new Map<string, number>();
  for (const chain of chains) {
    const page = cat.pages.find((p) => p.chain === chain && p.kind === 'sales');
    const seen = lines ? await seenSpecials(chain, since).catch(() => []) : [];
    out.set(chain, ownSpecials(page?.deals ?? [], lines ? (lists[chain] ?? []) : [], seen, entries).length);
  }
  return out;
}
