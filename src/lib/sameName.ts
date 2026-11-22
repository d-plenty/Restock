// 0.12.10: two items can't have the same name. "Rinse aid" and "Rinse Aid" sat side by side in the
// pantry: one was scanned in again and nothing said it was already there. Names are compared without
// capitals, extra spaces or a full stop on the end. Items that were already doubled stay as they are
// (and can still be edited): only a new item, or a rename onto another item's name, is refused.
import { SECTION_PLACE, type Section } from '../shops';

/** A name as it is compared: "  Rinse   Aid. " and "rinse aid" are the same. */
export function nameKey(name: string): string {
  return name
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.!,;:]+$/, '')
    .trim()
    .toLocaleLowerCase('en-AU');
}

/**
 * The item that already has this name, if any. `self`: the item being renamed, which may keep its
 * own name (also when it shares that name with an older double).
 */
export function sameNameItem<G extends { id: string; name: string }>(groups: readonly G[] | undefined, name: string, self?: { id: string; name: string }): G | undefined {
  const key = nameKey(name);
  if (!key || !groups) return undefined;
  if (self && nameKey(self.name) === key) return undefined;
  return groups.find((g) => g.id !== self?.id && nameKey(g.name) === key);
}

/** What the name box says ("You already have Rinse aid in your pantry. Give this one a different name."). */
export function sameNameWords(g: { name: string; section?: Section }): string {
  return `You already have ${g.name} in ${SECTION_PLACE[g.section ?? 'pantry']}. Give this one a different name.`;
}
