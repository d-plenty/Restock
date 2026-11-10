// 0.9.5: what tapping a search result does on the Add tab (and in "Search the shops" from the Pick
// sheet). A tap only ticks the product into the bar at the bottom ("1 ticked · tap to add", the
// shops, the green arrow). The sheet to name it, pick its list and see "Picked for you at your other
// shops" opens only from that bar. 0.9.4 popped the sheet up for a second on every tick, then
// shrank it again, which looked like a flash.

import type { StoreProduct } from '../../stores';
import { chainName } from '../../types';

export const keyOf = (sp: Pick<StoreProduct, 'chain' | 'storeProductId'>) => `${sp.chain}:${sp.storeProductId}`;

/** A tap on a result: ticked if it wasn't, unticked if it was. Nothing else changes. */
export function togglePick(picks: ReadonlyMap<string, StoreProduct>, sp: StoreProduct): Map<string, StoreProduct> {
  const next = new Map(picks);
  const k = keyOf(sp);
  if (next.has(k)) next.delete(k);
  else next.set(k, sp);
  return next;
}

/**
 * Whether the details sheet is open after something happens:
 * - `picks`: the ticks changed (a tap, a best match ticked for you, "Tick them too"). The sheet
 *   stays as it was: shut stays shut. With nothing ticked it shuts.
 * - `arrow`: the bar at the bottom (with the green arrow) was tapped: it opens.
 * - `close`: closed (the X, back, or after adding).
 */
export type SheetEvent = { kind: 'picks'; size: number } | { kind: 'arrow'; size: number } | { kind: 'close' };
export function sheetOpenAfter(open: boolean, e: SheetEvent): boolean {
  if (e.kind === 'close' || e.size === 0) return false;
  return e.kind === 'arrow' ? true : open;
}

const ticks = (n: number) => `${n} ticked`;

/**
 * What a screen reader hears when the ticks change: "Ticked Fanta Orange 24 pack at Coles. 1 ticked.
 * Tap the bar at the bottom to add." Empty when nothing changed.
 */
export function tickMessage(prev: ReadonlyMap<string, StoreProduct>, next: ReadonlyMap<string, StoreProduct>): string {
  const added = [...next].filter(([k]) => !prev.has(k)).map(([, sp]) => sp);
  const removed = [...prev].filter(([k]) => !next.has(k)).map(([, sp]) => sp);
  if (!added.length && !removed.length) return '';
  const total = next.size ? `${ticks(next.size)}. Tap the bar at the bottom to add.` : 'Nothing ticked.';
  if (added.length === 1 && !removed.length) return `Ticked ${added[0].name} at ${chainName(added[0].chain)}. ${total}`;
  if (removed.length === 1 && !added.length) return `Unticked ${removed[0].name} at ${chainName(removed[0].chain)}. ${total}`;
  if (!removed.length) return `${added.length} more ticked for you. ${total}`;
  if (!next.size) return 'Nothing ticked.';
  return total;
}
