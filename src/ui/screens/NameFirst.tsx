// 0.12.7: the name of a new item, on the phone's Add screen and the web page's search alike. You
// name it: the box is first and bigger, starts empty, and has to be filled in before it can be
// added (Restock used to fill it in, and got it wrong: a dressing named "Sugar"). One short idea
// sits under it to tap ("Use Strawberry jam"): no brand, no size, so it can be said out loud.
import type { RefObject } from 'react';

export function NameFirst({
  value,
  onChange,
  idea,
  missing,
  help,
  placeholder = 'e.g. Honey',
  inputRef,
  taken,
  onOpenTaken,
}: {
  value: string;
  onChange: (name: string) => void;
  /** The name on offer, or '' for none. Shown only while the box is empty. */
  idea: string;
  /** Add was pressed with no name. */
  missing: boolean;
  /** Where the name is used ("What it is called in your pantry and on your Shopping list."). */
  help: string;
  placeholder?: string;
  inputRef?: RefObject<HTMLInputElement | null>;
  /** 0.12.10: another item already has this name (sameNameWords): it can't be added under it. */
  taken?: string;
  /** With `taken`: open the item that has the name. */
  onOpenTaken?: { label: string; open: () => void };
}) {
  const empty = !value.trim();
  const bad = (missing && empty) || !!taken;
  return (
    <>
      <label className={`field name-first${bad ? ' missing' : ''}`}>
        <span>Name this item</span>
        <input
          ref={inputRef}
          className="input"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          aria-invalid={bad}
          aria-describedby="name-first-help"
          enterKeyHint="done"
        />
      </label>
      <span id="name-first-help" className={`small name-first-help${bad ? ' missing' : ''}`} role={bad ? 'alert' : undefined}>
        {taken ? taken : bad ? 'Give it a name first. Short is best: it is what you search for and say.' : help}
      </span>
      {taken && onOpenTaken && (
        <button type="button" className="btn small" style={{ alignSelf: 'flex-start' }} onClick={onOpenTaken.open}>
          {onOpenTaken.label}
        </button>
      )}
      {empty && idea && (
        <button type="button" className="chip name-idea" onClick={() => onChange(idea)} aria-label={`Use the name ${idea}`}>
          Use "{idea}"
        </button>
      )}
    </>
  );
}
