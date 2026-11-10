import { useState } from 'react';
import { allGroups } from '../../lib/db';
import { searchItems } from '../../lib/haMatch';
import { keepAsWords, pickItemFor, pickWord } from '../../lib/homeAssistant';
import { useLive } from '../../lib/useLive';
import type { ListEntry } from '../../types';
import { Icon, Sheet } from '../components';
import { useNav } from '../nav';

/**
 * 0.9.3: "Pick my milk" on a line that came from Home Assistant without one pantry item to be:
 * pick which of your pantry items it is (and, if you like, always use it for those words), or
 * keep it as just the words.
 */
export function PickItemSheet({ entry, onClose }: { entry: ListEntry; onClose: () => void }) {
  const nav = useNav();
  const word = pickWord(entry.text);
  const [query, setQuery] = useState(word);
  const [always, setAlways] = useState(false);
  const [busy, setBusy] = useState(false);
  const pantry = useLive(async () => (await allGroups()).filter((g) => (g.section ?? 'pantry') === 'pantry'), []);
  const shown = pantry ? searchItems(query, pantry).slice(0, 40) : [];

  const pick = async (g: { id: string; name: string }) => {
    setBusy(true);
    try {
      const done = await pickItemFor(entry, g, always);
      if (!done) nav.toast(always ? `"${word}" is ${g.name} from now on. That line isn't on the list any more` : "That line isn't on the list any more");
      else nav.toast(always ? `"${word}" is ${g.name} from now on` : `${g.name} it is`);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet title={`Pick my ${word}`} onClose={onClose}>
      <p className="small" style={{ margin: 0 }}>
        "{entry.text}" came from Home Assistant. Which of your pantry items is it? Restock then shows its price and cheapest shop, and Home Assistant
        gets its name.
      </p>
      <div className="settings-search">
        <Icon name="search" size={18} />
        <input
          className="input"
          type="search"
          value={query}
          placeholder="Search your pantry"
          aria-label="Search your pantry"
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <label className="check" style={{ padding: '4px 2px', minHeight: 0 }}>
        <input type="checkbox" checked={always} onChange={(e) => setAlways(e.target.checked)} />
        <span>Always use this for "{word}"</span>
      </label>
      <div className="card flush">
        {shown.map((g) => (
          <button key={g.id} className="row" disabled={busy} onClick={() => void pick(g)}>
            <span className="grow">
              <span className="title">{g.name}</span>
            </span>
            <Icon name="chevron" size={18} />
          </button>
        ))}
        {pantry && !shown.length && (
          <div className="row">
            <span className="small">Nothing in your pantry matches "{query.trim()}". Try another word.</span>
          </div>
        )}
      </div>
      <button
        className="btn"
        disabled={busy}
        onClick={async () => {
          await keepAsWords(entry.id);
          onClose();
        }}
      >
        Keep it as just "{word}"
      </button>
    </Sheet>
  );
}
