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

// 0.9.6: "Move to" another list (Groceries, Keg, Health, General), with Undo: moveLine.ts.
export { moveAll, moveTo } from './moveLine';

/**
 * 0.9.12: "2 coconut cream", "coconut cream x2" or "3x milk" typed on a list is that many: the
 * count comes off the words. "2 minute noodles", "3 in 1 coffee", "7up" and "2L milk" stay as typed.
 */
export function splitCount(typed: string): { text: string; qty: number } {
  const t = typed.trim().replace(/\s+/g, ' ');
  const lead = /^(\d{1,2})\s*[x×]?\s+(.+)$/i.exec(t);
  if (lead && !/^(in|of|for|pack|packs|minute|minutes|ply|way|by|to|and|x)\b/i.test(lead[2])) {
    const n = Number(lead[1]);
    if (n >= 1 && n <= 50) return { text: lead[2], qty: n };
  }
  const tail = /^(.+?)\s+[x×]\s*(\d{1,2})$/i.exec(t) ?? /^(.+?)\s+(\d{1,2})\s*[x×]$/i.exec(t);
  if (tail) {
    const n = Number(tail[2]);
    if (n >= 1 && n <= 50) return { text: tail[1], qty: n };
  }
  return { text: t, qty: 1 };
}
