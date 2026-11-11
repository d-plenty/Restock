// 0.9.11: the words and the tick at the end of "Pick my coconut cream", shared by the phone (Add.tsx)
// and the web page (WebShopSearch.tsx) without loading the whole Add tab there.

/** The words under the three buttons, the same on the phone and the web page. */
export const pickButtonsNote = (place: string) =>
  `Both: kept in ${place}, and the line on your list becomes it. List: just the line, at the cheapest shop. ${place.replace(/^your /, '').replace(/^./, (c) => c.toUpperCase())}: kept in ${place}, and the line comes off your list.`;

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
