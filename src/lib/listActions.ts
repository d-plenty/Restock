import { addListEntry, allListEntries, deleteListEntries, nowIso, uid } from './db';
import { act } from './undo';
import type { Group } from '../types';

/** A tiny buzz to confirm a tap did something (needs the VIBRATE permission on Android). */
export function buzz(ms = 15) {
  try {
    navigator.vibrate?.(ms);
  } catch {
    // Not supported: no buzz.
  }
}

/** Put a pantry item on the shopping list unless it's already there. Returns false if it was. */
export async function addGroupToList(group: Group, qty = 1): Promise<boolean> {
  const open = (await allListEntries()).some((e) => !e.checked && e.groupId === group.id);
  if (open) return false;
  await addListEntry({
    id: uid(),
    text: group.name,
    groupId: group.id,
    categoryId: group.categoryId,
    qty,
    section: group.section ?? 'pantry',
    checked: false,
    createdAt: nowIso(),
  });
  buzz();
  return true;
}

// ---------- 0.9.5 (undo): the same, as actions with an Undo (undo.ts) ----------

/** "Milk added to your shopping list · Undo". False (and no Undo) if it was there already. */
export const addToList = (group: Group, qty = 1) =>
  act(
    (ok: boolean) => (ok ? `${group.name} added to your shopping list` : null),
    () => addGroupToList(group, qty),
  );

/** "Added 32 to your shopping list": one Undo takes them all off again. Returns how many went on. */
export const addAllToList = (groups: Group[]) =>
  act(
    (n: number) => (n ? `Added ${n} to your shopping list` : null),
    async () => {
      let n = 0;
      for (const g of groups) if (await addGroupToList(g)) n++;
      return n;
    },
  );

/**
 * 0.9.5 (final review): a scanned barcode that isn't one of your items: its line's words, and what
 * its Undo toast says. Nothing knew its name: "Added. Tap it to rename · Undo" (one toast, so the
 * Undo isn't covered by a second one).
 */
export function scannedLine(name: string | undefined, code: string): { text: string; said?: string } {
  const n = name?.trim();
  return n ? { text: n } : { text: `Item ${code}`, said: 'Added. Tap it to rename' };
}

/** "Milk taken off your shopping list · Undo". */
export const takeOffList = (ids: string[], name: string) => act(`${name} taken off your shopping list`, () => deleteListEntries(ids));
