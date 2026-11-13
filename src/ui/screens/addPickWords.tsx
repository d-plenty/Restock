// 0.9.11: the words and the tick at the end of "Pick my coconut cream", shared by the phone (Add.tsx)
// and the web page (WebShopSearch.tsx) without loading the whole Add tab there.
import { SECTION_NAMES, type Section } from '../../shops';
import { Icon } from '../components';

/** The words under the three buttons, the same on the phone and the web page. 0.10.4: in the buttons' order (Both, Pantry, List). */
export const pickButtonsNote = (place: string) =>
  `Both: kept in ${place}, and the line on your list becomes it. ${placeWord(place)}: kept in ${place}, and the line comes off your list. List: just the line, at the cheapest shop.`;

/** "your Health list" → "Health list", "your pantry" → "Pantry". */
const placeWord = (place: string) => place.replace(/^your /, '').replace(/^./, (c) => c.toUpperCase());

/** 0.10.4: under Add to both / Add to pantry / Add to list when adding something new, in the buttons' order. */
export const addButtonsNote = (place: string) =>
  `Both: kept in ${place} and on your list. ${placeWord(place)}: kept in ${place}, so Restock watches its price. List: on your list for this trip only, at the price shown. Restock won't keep watching its price.`;

/**
 * 0.10.4: the pair under the big green "Add to both": Add to pantry on the left (filled navy),
 * Add to list on the right (white). Keg and Health say "Add to keg" / "Add to health". The same
 * on the phone's Add tab, the Pick sheet and the web page.
 */
export function AddPair({ section, disabled, onPantry, onList }: { section: Section; disabled?: boolean; onPantry: () => void; onList: () => void }) {
  return (
    <div className="two add-pair">
      <button className="btn pantry" onClick={onPantry} disabled={disabled}>
        <Icon name={section} size={18} /> Add to {SECTION_NAMES[section].toLowerCase()}
      </button>
      <button className="btn listbtn" onClick={onList} disabled={disabled}>
        <Icon name="cart" size={18} /> Add to list
      </button>
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
