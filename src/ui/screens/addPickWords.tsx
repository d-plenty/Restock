// 0.9.11: the words and the tick at the end of "Pick my coconut cream", shared by the phone (Add.tsx)
// and the web page (WebShopSearch.tsx) without loading the whole Add tab there.
import type { ReactNode } from 'react';
import { SECTION_NAMES, type Section } from '../../shops';
import { Icon } from '../components';

export type AddTarget = 'both' | 'pantry' | 'list';

/**
 * 0.10.7: one of the Add buttons. While one is saving, only that one changes (a spinner and
 * "Adding…"); the others keep their colours and just can't be pressed until it's done. Before, they
 * all went grey, and it looked like the wrong one had been pressed. `blocked` (nothing to add yet)
 * is the only time a button greys out.
 */
export function AddBtn({
  target,
  busy,
  blocked,
  className,
  onClick,
  children,
}: {
  target: AddTarget;
  busy?: AddTarget;
  blocked?: boolean;
  className: string;
  onClick: () => void;
  children: ReactNode;
}) {
  const mine = busy === target;
  const held = !!busy && !mine;
  return (
    <button
      type="button"
      className={`${className}${mine ? ' is-busy' : ''}${held ? ' held' : ''}`}
      disabled={blocked}
      aria-disabled={busy ? true : undefined}
      aria-busy={mine || undefined}
      onClick={() => {
        if (!busy) onClick();
      }}
    >
      {mine ? (
        <>
          <span className="spinner" aria-hidden="true" /> Adding…
        </>
      ) : (
        children
      )}
    </button>
  );
}

/** The words under the three buttons, the same on the phone and the web page. 0.10.4: in the buttons' order (Both, Pantry, List). */
export const pickButtonsNote = (place: string) =>
  `Both: kept in ${place}, and the line on your list becomes it. ${placeWord(place)}: kept in ${place}, and the line comes off your list. List: just the line, at the cheapest shop.`;

/** "your Health list" → "Health list", "your pantry" → "Pantry". */
const placeWord = (place: string) => place.replace(/^your /, '').replace(/^./, (c) => c.toUpperCase());

/** 0.10.4: under Add to both / Add to pantry / Add to list when adding something new, in the buttons' order. */
// 0.10.7: shorter
export const addButtonsNote = (place: string) =>
  `${placeWord(place)}: Restock keeps watching its price. List: just for this trip. Both: the two together.`;

/**
 * 0.10.4: the pair under the big green "Add to both": Add to pantry on the left (filled navy),
 * Add to list on the right (white). Keg and Health say "Add to keg" / "Add to health". The same
 * on the phone's Add tab, the Pick sheet and the web page.
 */
export function AddPair({
  section,
  disabled,
  busy,
  onPantry,
  onList,
}: {
  section: Section;
  /** Nothing to add yet: greyed. */
  disabled?: boolean;
  /** 0.10.7: which button is saving right now. */
  busy?: AddTarget;
  onPantry: () => void;
  onList: () => void;
}) {
  return (
    <div className="two add-pair">
      <AddBtn target="pantry" busy={busy} blocked={disabled} className="btn pantry" onClick={onPantry}>
        <Icon name={section} size={18} /> Add to {SECTION_NAMES[section].toLowerCase()}
      </AddBtn>
      <AddBtn target="list" busy={busy} blocked={disabled} className="btn listbtn" onClick={onList}>
        <Icon name="cart" size={18} /> Add to list
      </AddBtn>
    </div>
  );
}

/** 0.10.2: under the one button of a line's "Add to pantry", the same on the phone and the web page. */
export const toPantryNote = (place: string) =>
  `Kept in ${place} with what you ticked, and the line stays on your list as it, at whichever shop is cheapest.`;

/** "Next time "coconut cream" is added to your list, use this item." Shown once per screen. */
export function AlwaysTick({ forLine }: { forLine: { always: boolean; onAlways: (on: boolean) => void; word: string } }) {
  return (
    <label className="check" style={{ padding: '4px 2px', minHeight: 44 }}>
      <input type="checkbox" checked={forLine.always} onChange={(e) => forLine.onAlways(e.target.checked)} />
      <span>{alwaysWords(forLine.word)}</span>
    </label>
  );
}

export const alwaysWords = (word: string) => `Next time "${word}" is added to your list, use this item.`;
