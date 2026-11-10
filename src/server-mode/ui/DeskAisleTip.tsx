// 0.9.5: the web list's Aisle group view groups lines by category. When most of them land in Other
// (no category), a tip says so, with a quick way to give each one a category: the item's category
// for a pantry item (as Edit item sets it), the line's own for something typed.
import { useState } from 'react';
import { updateGroup, updateListEntry } from '../../lib/db';
import { act } from '../../lib/undo'; // 0.9.5 (undo)
import type { Group, ListEntry } from '../../types';
import { Icon, Sheet } from '../../ui/components';

/** At least this many lines before the tip shows (two lines in Other isn't "most of the list"). */
export const AISLE_TIP_MIN = 3;

/** The lines with no category the view knows, and whether that's most of the list (more than half). */
export function aisleTip<T>(lines: T[], categoryOf: (line: T) => string | undefined, categoryIds: Set<string>): { other: T[]; show: boolean } {
  const other = lines.filter((l) => {
    const c = categoryOf(l);
    return !c || !categoryIds.has(c);
  });
  return { other, show: lines.length >= AISLE_TIP_MIN && other.length * 2 > lines.length };
}

export function AisleTip({
  lines,
  categories,
  categoryOf,
  groupOf,
  labelOf,
}: {
  lines: ListEntry[];
  categories: { id: string; name: string }[];
  categoryOf: (e: ListEntry) => string | undefined;
  groupOf: (e: ListEntry) => Group | undefined;
  labelOf: (e: ListEntry) => string;
}) {
  const [open, setOpen] = useState(false);
  const { other, show } = aisleTip(lines, categoryOf, new Set(categories.map((c) => c.id)));
  if (!show && !open) return null;
  return (
    <>
      {show && (
        <div className="banner blue dk-aisle-tip" role="note">
          <span className="grow">
            <strong>Give items a category to sort them into aisle groups</strong>
            <span className="small-ink">
              {other.length} of {lines.length} lines are in Other.
            </span>
          </span>
          <button className="btn small dk-ink" onClick={() => setOpen(true)}>
            <Icon name="pencil" size={16} /> Set categories
          </button>
        </div>
      )}
      {open && <CategorySheet lines={other} categories={categories} groupOf={groupOf} labelOf={labelOf} onClose={() => setOpen(false)} />}
    </>
  );
}

function CategorySheet({
  lines,
  categories,
  groupOf,
  labelOf,
  onClose,
}: {
  lines: ListEntry[];
  categories: { id: string; name: string }[];
  groupOf: (e: ListEntry) => Group | undefined;
  labelOf: (e: ListEntry) => string;
  onClose: () => void;
}) {
  // The sheet keeps its lines while they're given categories (they'd leave Other one by one).
  const [shown] = useState(() => lines.slice(0, 40));
  const [set, setSet] = useState<Map<string, string>>(new Map());
  const pick = async (e: ListEntry, categoryId: string) => {
    const g = groupOf(e);
    const name = categories.find((c) => c.id === categoryId)?.name;
    // 0.9.5 (undo)
    await act(name ? `${labelOf(e)}: ${name}` : `${labelOf(e)}: no category`, async () => {
      if (g) await updateGroup(g.id, { categoryId: categoryId || undefined });
      else await updateListEntry(e.id, { categoryId: categoryId || undefined });
    });
    setSet((m) => new Map(m).set(e.id, categoryId));
  };
  return (
    <Sheet title="Give items a category" onClose={onClose}>
      {categories.length === 0 ? (
        <p className="small">This list has no categories yet. Add them in Settings, Categories, then pick them here.</p>
      ) : (
        <>
          <p className="small">Pick a category for each. A pantry item keeps it everywhere; something typed keeps it on this line.</p>
          <div className="card flush dk-cat-lines">
            {shown.map((e) => {
              const id = `dk-cat-${e.id}`;
              return (
                <div key={e.id} className="row dk-cat-line">
                  <label htmlFor={id} className="grow">
                    <span className="title">{labelOf(e)}</span>
                    <span className="small">{groupOf(e) ? 'Pantry item' : 'Typed on the list'}</span>
                  </label>
                  <select id={id} className="input" value={set.get(e.id) ?? ''} onChange={(ev) => void pick(e, ev.target.value)}>
                    <option value="">Other (no category)</option>
                    {categories.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </div>
              );
            })}
          </div>
          {lines.length > shown.length && <p className="small">And {lines.length - shown.length} more. Set these first, then open this again.</p>}
        </>
      )}
      <button className="btn primary" onClick={onClose}>
        Done
      </button>
    </Sheet>
  );
}
