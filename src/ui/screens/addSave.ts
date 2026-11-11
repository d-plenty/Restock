// 0.9.5: saving what was ticked on the Add tab, shared with "Search the shops" in the Pick sheet
// (a Home Assistant line like "chopsticks" that matches nothing in the pantry). The same products,
// prices and pantry item either way; from the Pick sheet the list line is then linked to the new
// item, and "Always use this for chopsticks" saved for it.

import { addGroup, addProduct, addReading, findProductByStore, nowIso, uid, updateProduct } from '../../lib/db';
import { pickItemFor, pickItemOffList } from '../../lib/listPicks';
import { act } from '../../lib/undo';
import type { StoreProduct } from '../../stores';
import type { AlertLevel, Group, ListEntry, Product } from '../../types';
import type { Section } from '../../shops';

/** Each ticked product saved (or the one already kept reused), with today's price. Their ids, in order, once each. */
export async function saveStoreProducts(picks: Iterable<StoreProduct>, barcodeFor: (sp: StoreProduct) => string | undefined = (sp) => sp.barcode): Promise<string[]> {
  const ids: string[] = [];
  for (const sp of picks) {
    const existing = await findProductByStore(sp.chain, sp.storeProductId);
    let id = existing?.id;
    if (!id) {
      id = uid();
      const product: Product = {
        id,
        chain: sp.chain,
        name: sp.name,
        brand: sp.brand,
        size: sp.size,
        barcode: barcodeFor(sp),
        storeProductId: sp.storeProductId,
        imageUrl: sp.imageUrl,
        inStock: sp.inStock,
        stockAt: sp.inStock === undefined ? undefined : nowIso(),
        createdAt: nowIso(),
      };
      await addProduct(product);
    } else {
      // Always overwrite, so a stale "out of stock" is cleared when the shop stops saying so.
      await updateProduct(id, { inStock: sp.inStock, stockAt: sp.inStock === undefined ? undefined : nowIso() });
    }
    if (sp.price !== undefined) {
      await addReading({
        productId: id,
        date: nowIso(),
        price: sp.price,
        wasPrice: sp.wasPrice,
        isSpecial: sp.isSpecial,
        memberOnly: sp.memberOnly,
        promo: sp.promo,
        source: 'auto',
      });
    }
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

export interface NewItem {
  name: string;
  section: Section;
  categoryId?: string;
  alertLevel?: AlertLevel;
  alertPct?: number;
  allowBulk?: boolean;
  allowMulti?: boolean;
}

/** A new pantry (or Keg, or Health) item whose picks are the ticked products: the first is the usual one. */
export async function addItemFromPicks(picks: Iterable<StoreProduct>, item: NewItem, barcodeFor?: (sp: StoreProduct) => string | undefined): Promise<Group> {
  const ids = await saveStoreProducts(picks, barcodeFor);
  const alertLevel = item.alertLevel ?? 'good';
  const group: Group = {
    id: uid(),
    name: item.name,
    categoryId: item.categoryId || undefined,
    usualProductId: ids[0],
    sameProductIds: ids.slice(1),
    altProductIds: [],
    alertLevel,
    alertPct: alertLevel === 'custom' ? item.alertPct : undefined,
    allowBulk: item.allowBulk ?? false,
    allowMulti: item.allowMulti ?? true,
    section: item.section,
    createdAt: nowIso(),
  };
  await addGroup(group);
  return group;
}

/**
 * From the Pick sheet: the ticked products become a new pantry item, and the list line becomes that
 * item (pickItemFor, as picking a pantry item does). `always`: the line's words are that item from
 * now on. `linked` is false when the line had gone meanwhile (the item is still made).
 */
export async function addItemForLine(
  entry: ListEntry,
  picks: Iterable<StoreProduct>,
  item: NewItem,
  always: boolean,
  barcodeFor?: (sp: StoreProduct) => string | undefined,
  /** 0.9.11: "both" (the line becomes the item) or "pantry" (the line comes off the list). */
  target: 'both' | 'pantry' = 'both',
): Promise<{ group: Group; linked: boolean }> {
  const group = await addItemFromPicks(picks, item, barcodeFor);
  const linked = await (target === 'pantry' ? pickItemOffList : pickItemFor)(entry, group, always);
  return { group, linked };
}

/**
 * 0.9.5 (final review): addItemForLine as one action, so Undo takes it all back (the item, its
 * products and prices, the line as it was, and "Always use this for"). `said`: the words on the
 * Undo toast (pickedWords).
 */
export const addItemForLineUndoable = (
  entry: ListEntry,
  picks: Iterable<StoreProduct>,
  item: NewItem,
  always: boolean,
  said: (r: { group: Group; linked: boolean }) => string,
  barcodeFor?: (sp: StoreProduct) => string | undefined,
  target: 'both' | 'pantry' = 'both',
): Promise<{ group: Group; linked: boolean }> => act(said, () => addItemForLine(entry, picks, item, always, barcodeFor, target));

/** What the Pick sheet says once a line has its item ("Chopsticks added to your pantry. "chopsticks" is Chopsticks from now on"). */
export function pickedWords(name: string, opts: { made: boolean; linked: boolean; always: boolean; word: string; place?: string; off?: boolean }): string {
  const what = opts.made ? `${name} added to ${opts.place ?? 'your pantry'}${opts.off ? ' and off your list' : ''}` : `${name} it is`;
  if (!opts.linked) return `${what}. That line isn't on the list any more`;
  return opts.always ? `${what}. "${opts.word}" is ${name} from now on` : what;
}
