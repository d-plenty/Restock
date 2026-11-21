// 0.12.8: adding another product to an item you already have. Tapping + adds that one product
// straight away (with Undo); there's no "check it, then add" sheet in between any more.
import type { Group } from '../../types';

export type Role = 'main' | 'alt';

/** The change to an item that adds these (saved) products as what you buy there, or as Also happy with. */
export function attachPatch(g: Group, ids: string[], as: Role, chains: string[] = []): Partial<Group> | undefined {
  if (as === 'alt') {
    const all = new Set([g.usualProductId, ...g.sameProductIds, ...g.altProductIds]);
    const fresh = ids.filter((id) => !all.has(id));
    return fresh.length ? { altProductIds: [...g.altProductIds, ...fresh] } : undefined;
  }
  // One you'd also take, ticked as a product you buy, moves over (0.8.9).
  const mains = new Set([g.usualProductId, ...g.sameProductIds]);
  const fresh = [...new Set(ids)].filter((id) => !mains.has(id));
  const at = new Set(chains);
  const notAt = (g.notAt ?? []).filter((c) => !at.has(c));
  if (!fresh.length && notAt.length === (g.notAt ?? []).length) return undefined;
  const usual = g.usualProductId ?? fresh[0];
  return {
    // A product ticked at a shop marked "Not at this shop" puts the shop back in (0.8.9).
    notAt,
    usualProductId: usual,
    sameProductIds: [...g.sameProductIds, ...fresh.filter((id) => id !== usual)],
    altProductIds: g.altProductIds.filter((id) => !fresh.includes(id)),
  };
}

/** Which of an item's products is which, by "shop:product number", for ticking them in search results. */
export function rolesIn(g: Group, products: { id: string; chain: string; storeProductId?: string }[]): Map<string, Role> {
  const alts = new Set(g.altProductIds);
  const out = new Map<string, Role>();
  for (const p of products) if (p.storeProductId) out.set(`${p.chain}:${p.storeProductId}`, alts.has(p.id) ? 'alt' : 'main');
  return out;
}

/** No repeats: a shop sometimes sends the same product twice (it showed as two rows that ticked together). */
export function uniqueProducts<T extends { chain: string; storeProductId: string | number }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((p) => {
    const k = `${p.chain}:${p.storeProductId}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
