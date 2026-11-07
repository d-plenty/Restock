import { addListEntry, allListEntries, nowIso, uid } from './db';
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
