import { useState } from 'react';
import { searchItems } from '../../lib/haMatch';
import { pickWord } from '../../lib/listPicks';
import { listOfLine, moveAll, moveFacts, moveNote, moveTo, pickableFor, pickMoved, planMove } from '../../lib/moveLine';
import { useLive } from '../../lib/useLive';
import { LIST_NAMES, type ListSection } from '../../shops';
import { chainName, type ListEntry } from '../../types';
import { Icon, Sheet, SearchField } from '../components';

/**
 * 0.9.6: "Move to" another list, from a line's details (phone and web, List.tsx EditEntry). Each
 * list says first what happens to the line (moveLine.ts moveNote). After a move to a list where its
 * words aren't one of the items, "Pick my …" from that list's items, or keep the words.
 */
export function MoveToSheet({ entry, name, lists, onClose }: { entry: ListEntry; name: string; lists: readonly ListSection[]; onClose: () => void }) {
  const facts = useLive(moveFacts, []);
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState<{ id: string; to: ListSection }>();
  const [query, setQuery] = useState(pickWord(name));

  if (picking && facts) {
    const word = pickWord(name);
    const shown = searchItems(query, pickableFor(picking.to, facts.groups)).slice(0, 40);
    return (
      <Sheet title={`Pick my ${word}`} onClose={onClose}>
        <p className="small" style={{ margin: 0 }}>
          "{name}" is on {LIST_NAMES[picking.to]} now. Which {LIST_NAMES[picking.to]} item is it? Restock then shows its price and cheapest shop.
        </p>
        <SearchField value={query} placeholder={`Search ${LIST_NAMES[picking.to]}`} aria-label={`Search ${LIST_NAMES[picking.to]} items`} onValue={setQuery} />
        <div className="card flush">
          {shown.map((g) => (
            <button
              key={g.id}
              className="row"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await pickMoved(picking.id, g);
                } finally {
                  setBusy(false);
                }
                onClose();
              }}
            >
              <span className="grow">
                <span className="title">{g.name}</span>
              </span>
              <Icon name="chevron" size={18} />
            </button>
          ))}
          {!shown.length && (
            <div className="row" role="status">
              <span className="small">Nothing on {LIST_NAMES[picking.to]} matches "{query.trim()}". Try another word.</span>
            </div>
          )}
        </div>
        <button className="btn" disabled={busy} onClick={onClose}>
          Keep it as just "{word}"
        </button>
      </Sheet>
    );
  }

  const here = facts ? listOfLine(entry, facts.groups) : undefined;
  const targets = lists.filter((l) => l !== here);
  return (
    <Sheet title={`Move ${name} to`} onClose={onClose}>
      <p className="small" style={{ margin: 0 }}>
        {here ? `It's on ${LIST_NAMES[here]} now. ` : ''}It keeps how many, and ticked or not. Undo puts it back.
      </p>
      <div className="card flush" role="group" aria-label="Move to">
        {facts &&
          targets.map((to) => {
            const plan = planMove(entry, to, facts);
            const note = plan ? moveNote(plan, chainName) : '';
            return (
              <button
                key={to}
                className="row"
                disabled={busy || !plan}
                onClick={async () => {
                  setBusy(true);
                  let next: { id: string; to: ListSection } | undefined;
                  try {
                    const m = await moveTo(entry.id, to, name);
                    if (m && !m.plan.item && m.plan.canPick) next = { id: m.id, to };
                  } finally {
                    setBusy(false);
                  }
                  if (next) setPicking(next);
                  else onClose();
                }}
              >
                <Icon name={to} size={20} />
                <span className="grow" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span className="title">{LIST_NAMES[to]}</span>
                  {note && <span className="small">{note}</span>}
                </span>
                <Icon name="chevron" size={18} />
              </button>
            );
          })}
      </div>
      <button className="btn" onClick={onClose}>
        Cancel
      </button>
    </Sheet>
  );
}

/** 0.9.6: Select on the list, then "Move to": several lines at once, one Undo. */
export function MoveManySheet({ ids, here, lists, onDone, onClose }: { ids: string[]; here: ListSection; lists: readonly ListSection[]; onDone: () => void; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <Sheet title={`Move ${ids.length} to`} onClose={onClose}>
      <p className="small" style={{ margin: 0 }}>
        They keep how many, and ticked or not. A line that's clearly one of that list's items becomes it. Lines moved to General keep their words only. Undo puts them back.
      </p>
      <div className="card flush" role="group" aria-label="Move to">
        {lists
          .filter((l) => l !== here)
          .map((to) => (
            <button
              key={to}
              className="row"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await moveAll(ids, to);
                } finally {
                  setBusy(false);
                }
                onDone();
              }}
            >
              <Icon name={to} size={20} />
              <span className="grow">
                <span className="title">{LIST_NAMES[to]}</span>
              </span>
              <Icon name="chevron" size={18} />
            </button>
          ))}
      </div>
      <button className="btn" onClick={onClose}>
        Cancel
      </button>
    </Sheet>
  );
}
