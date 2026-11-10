// 0.9.5 (final review): an Undo for adding from "Let the web page search the shops". The server
// makes the item, its products and prices, and the list line (search.mjs add); this browser gets
// them at the next sync. Undo takes away what that add made with ordinary writes here (they reach
// the server and the phones as any delete does). Products that were here before stay, with their
// price history.
import { allProducts, deleteGroup, deleteListEntries, getGroup, groupProductIds, updateGroup } from '../../lib/db';
import { act } from '../../lib/undo';
import type { AddAnswer } from './webSearch';

/** The products this browser has now (before an add, so Undo keeps them). */
export async function productIdsHere(): Promise<Set<string>> {
  return new Set((await allProducts()).map((p) => p.id));
}

/** Takes back what one add made: its line, and its new item with the products that came with it. */
export async function takeBackAdd(a: Pick<AddAnswer, 'item' | 'line'>, had: Set<string>): Promise<void> {
  if (a.line) await deleteListEntries([a.line.id]);
  if (!a.item) return;
  const g = await getGroup(a.item.id);
  if (!g) return;
  const all = groupProductIds(g);
  const mine = all.filter((id) => !had.has(id));
  // A product that was here before isn't the add's to delete: off the item first, so it stays.
  if (mine.length !== all.length) await updateGroup(g.id, { usualProductId: mine[0], sameProductIds: mine.slice(1), altProductIds: [] });
  await deleteGroup(g.id);
}

/**
 * Offers the Undo for an add the server made (`a`), as one action with whatever `more` does here
 * too (the Pick sheet's line becoming the new item). `more` answers what the Undo toast says.
 * Call it after this browser has the add (a sync), never from inside another action.
 */
export function offerUndo(a: Pick<AddAnswer, 'item' | 'line'>, had: Set<string>, more: () => Promise<string>): Promise<string> {
  return act(
    (said: string) => said,
    async (ctx) => {
      ctx.onUndo(() => takeBackAdd(a, had));
      return more();
    },
  );
}
