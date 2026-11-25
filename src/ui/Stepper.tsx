// 0.13.0: the minus / number / plus beside anything on your shopping list. It had its home in
// List.tsx; a tab's rows (Pantry, your own tabs) show it too once an item is on the list, so it
// lives here. Minus at 1 goes to 0, waits a moment, then takes the line off the list (with Undo):
// the quick way to say "actually, I don't want it" while shopping. Plus in that moment keeps it.
import { useLatest } from './useLatest';
import { useEffect, useRef, useState } from 'react';
import { deleteListEntries, updateListEntry } from '../lib/db';
import { act } from '../lib/undo';
import type { ListEntry } from '../types';

/** How long a line sits at 0 before it goes. */
export const ZERO_HOLD_MS = 2000;

/** 0.9.5 (undo): a new amount; pressing + a few times is one Undo. */
export const setQty = (e: { id: string; text: string }, qty: number, name = e.text) =>
  act(`${name}: ${qty} on your list`, () => updateListEntry(e.id, { qty }), { merge: `qty:${e.id}` });

export function Stepper({ e, name, small }: { e: ListEntry; /** What it's called in messages (a tab's row: the item's name). */ name?: string; /** A tab's row: a little narrower. */ small?: boolean }) {
  const q = Math.max(1, e.qty ?? 1);
  const label = name ?? e.text;
  const [zero, setZero] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const go = useLatest<(() => void) | undefined>(() => {
    timer.current = undefined;
    void act(`${label} taken off your shopping list`, () => deleteListEntries([e.id]));
  });
  // Leaving the screen while it sits at 0 still takes it off (that's what was asked for).
  useEffect(
    () => () => {
      if (timer.current === undefined) return;
      clearTimeout(timer.current);
      go.current?.();
    },
    [go],
  );
  const minus = () => {
    if (zero) return;
    if (q > 1) return void setQty(e, q - 1, label);
    setZero(true);
    timer.current = setTimeout(() => go.current?.(), ZERO_HOLD_MS);
  };
  const plus = () => {
    if (zero) {
      if (timer.current !== undefined) clearTimeout(timer.current);
      timer.current = undefined;
      return setZero(false);
    }
    void setQty(e, q + 1, label);
  };
  return (
    <span className={`stepper${zero ? ' going' : ''}${small ? ' compact' : ''}`} role="group" aria-label={`How many ${label}`}>
      <button aria-label={q > 1 ? 'One fewer' : `Take ${label} off your shopping list`} disabled={zero} onClick={minus}>
        −
      </button>
      <span className="num" aria-live="polite" aria-label={zero ? `0. ${label} is coming off your list. Tap plus to keep it` : undefined}>
        {zero ? 0 : q}
      </span>
      <button aria-label={zero ? `Keep ${label} on your list` : 'One more'} onClick={plus}>
        +
      </button>
    </span>
  );
}
