// 0.12.6: what was typed into a search box, tidied before it's used. Voice typing ends a word with a
// full stop ("Lemon."), which made a search that should match come up empty.

/** Trimmed, with any full stops, commas and the like on the end taken off. */
export function cleanSearch(typed: string): string {
  return typed.trim().replace(/[\s.,;:!?…]+$/u, '');
}
