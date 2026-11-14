import { useEffect, useRef } from 'react';
import { confirmAction } from '../lib/confirm';

// 0.10.7: "Leave without saving?" Screens with work under way that isn't saved yet (products ticked
// on Add, a receipt being checked, a card being typed in) say so here, and leaving them (Back, a
// tab, the Android back button) asks first instead of throwing the work away. Settings screens have
// their own question (settingsDraft.ts canLeave: Save, Discard, Keep editing).

type Guard = { dirty: () => boolean; what: () => string };
const guards = new Set<Guard>();

/**
 * While `dirty` is true, leaving this screen asks first. `what`: "adding Milk", "this receipt". A
 * function is asked at the moment of leaving (so a screen that has just saved can say it's done).
 */
export function useLeaveGuard(dirty: boolean | (() => boolean), what: string): void {
  const ref = useRef({ dirty, what });
  ref.current = { dirty, what };
  useEffect(() => {
    const g: Guard = { dirty: () => (typeof ref.current.dirty === 'function' ? ref.current.dirty() : ref.current.dirty), what: () => ref.current.what };
    guards.add(g);
    return () => void guards.delete(g);
  }, []);
}

/** The work that would be lost, or undefined when nothing would be. */
export function unsavedWork(): string | undefined {
  for (const g of [...guards].reverse()) if (g.dirty()) return g.what();
  return undefined;
}

/** True to go on: nothing would be lost, or the person said Leave. */
export async function okToLeave(): Promise<boolean> {
  const what = unsavedWork();
  if (!what) return true;
  return confirmAction('Leave without saving?', {
    detail: `You're in the middle of ${what}. If you leave now, it isn't kept.`,
    action: 'Leave',
    danger: true,
  });
}
