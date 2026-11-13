import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { allCategories, allGroups, getSettings } from '../../lib/db';
import { searchItems } from '../../lib/haMatch';
import { keepAsWords, pickItemFor, pickWord } from '../../lib/homeAssistant';
import { act } from '../../lib/undo'; // 0.9.5 (undo)
import { useLive } from '../../lib/useLive';
import { enabledIn, SECTION_PLACE, type Section } from '../../shops';
import { isNative } from '../../stores/http';
import { serverMode, serverUi } from '../../server-mode/flag'; // 0.9.5 (web search)
import type { ListEntry } from '../../types';
import { Icon, Sheet, useBackLayer, SearchField } from '../components';
import { useNav } from '../nav';
import type { ForLine } from './Add';
import { alwaysWords } from './addPickWords';
import { pickedWords } from './addSave';

// Loaded when first needed: the web app on a Restock server uses this sheet too, and never searches
// the shops from it.
const AddScreen = lazy(() => import('./Add').then((m) => ({ default: m.AddScreen })));
const ManualSheet = lazy(() => import('./Add').then((m) => ({ default: m.ManualSheet })));

/** Whether the phone thinks it's online (searching the shops needs the internet; nothing else here does). */
function useOnline(): boolean {
  const [on, setOn] = useState(() => typeof navigator === 'undefined' || navigator.onLine !== false);
  useEffect(() => {
    const up = () => setOn(true);
    const down = () => setOn(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);
  return on;
}

/**
 * 0.9.3: "Pick my milk" on a line that came from Home Assistant without one pantry item to be:
 * pick which of your pantry items it is (and, if you like, always use it for those words), or
 * keep it as just the words.
 *
 * 0.9.5: a line that matches nothing in the pantry ("chopsticks") can search the shops for it, the
 * same search, ticks and bar as the Add tab. Adding makes the pantry item, with what was ticked as
 * its picks, and the line becomes it ("Always use this for chopsticks" saved for the new item). Or
 * add it by hand, which works offline.
 */
/**
 * 0.9.11: every "Pick my coconut cream" opens this sheet: the line's search button, the button under
 * a Home Assistant line, and the one in the line's ⋯ sheet. Its own list's items (a Keg or Health
 * line looks in those), and the "next time" tick starts ticked.
 */
export function PickItemSheet({
  entry,
  onClose,
  fromHa = true,
  toPantry = false,
}: {
  entry: ListEntry;
  onClose: () => void;
  fromHa?: boolean;
  /**
   * 0.10.2: the line sheet's "Add to pantry" (a line added to the list only): straight to the shop
   * search, the shop's product the line came from ticked again, and one button that makes the item
   * and keeps the line on the list as it. Back still goes to picking one of your items.
   */
  toPantry?: boolean;
}) {
  const nav = useNav();
  const word = pickWord(entry.text);
  const section: Section = !entry.section || entry.section === 'general' ? 'pantry' : entry.section;
  const place = SECTION_PLACE[section];
  const [query, setQuery] = useState(word);
  const [always, setAlways] = useState(true);
  const [busy, setBusy] = useState(false);
  /** The words searched at the shops, while that search is showing. */
  // In the app (online) it searches straight away; on the web page once it knows the household's
  // web search is on (web.PickButton's `auto`).
  const [shopsFor, setShopsFor] = useState<string | undefined>(() =>
    toPantry && isNative() && (typeof navigator === 'undefined' || navigator.onLine !== false) ? word : undefined,
  );
  const [byHand, setByHand] = useState(false);
  const online = useOnline();
  const native = isNative();
  // 0.9.5 (web search): on a Restock server's web page, its shop search (when the household turned it on).
  const web = !native && serverMode ? serverUi.current?.webSearch : undefined;
  const pantry = useLive(async () => (await allGroups()).filter((g) => (g.section ?? 'pantry') === section), [section]);
  const extras = useLive(async () => {
    const [cats, s] = await Promise.all([allCategories(), getSettings()]);
    return { categories: cats.filter((c) => c.section === section), shops: enabledIn(s.enabledChains, section) };
  }, [section]);
  const shown = pantry ? searchItems(query, pantry).slice(0, 40) : [];
  const typed = query.trim() || word;
  const top = useRef<HTMLDivElement>(null);

  // Back from the shop search goes back to the pantry list, not out of the sheet.
  useBackLayer(() => setShopsFor(undefined), shopsFor !== undefined);
  // Focus goes to the sheet's heading whenever it switches between the pantry and the shops.
  useEffect(() => {
    top.current?.closest('.sheet')?.querySelector<HTMLElement>('.sheet-title')?.focus({ preventScroll: true });
  }, [shopsFor]);

  const done = (g: { id: string; name: string }, linked: boolean, made: boolean) => {
    // 0.9.5 (final review): a new item made here already says so, with its Undo (addItemForLineUndoable).
    if (!made) nav.toast(pickedWords(g.name, { made, linked, always, word }));
    onClose();
  };

  const pick = async (g: { id: string; name: string }) => {
    setBusy(true);
    try {
      // 0.9.5 (undo): picking an item for the line can be undone.
      const linked = await act(
        (l: boolean) => (l ? (always ? `${g.name} it is. "${word}" is ${g.name} from now on` : `${g.name} it is`) : null),
        () => pickItemFor(entry, g, always),
      );
      if (linked) onClose();
      else done(g, linked, false);
    } finally {
      setBusy(false);
    }
  };

  const forLine: ForLine = {
    entry,
    word,
    always,
    onAlways: setAlways,
    onDone: (g, made, linked) => done(g, linked, made),
    onListed: onClose,
    toPantry,
    preTick: toPantry ? entry.product : undefined,
  };

  if (shopsFor !== undefined)
    return (
      <Sheet title={toPantry ? `Add ${entry.text} to ${place}` : `Search the shops for "${shopsFor}"`} onClose={onClose}>
        <div ref={top} style={{ display: 'contents' }} />
        <button className="linkish" style={{ alignSelf: 'flex-start', minHeight: 44 }} onClick={() => setShopsFor(undefined)}>
          <span style={{ display: 'inline-flex', transform: 'rotate(180deg)' }}>
            <Icon name="chevron" size={16} />
          </span>{' '}
          Back to {place}
        </button>
        {web ? (
          // 0.9.5 (web search): the server searches the shops; the same ticks, bar and sheet.
          <web.PickResults
            section={section}
            key={shopsFor}
            query={shopsFor}
            entry={entry}
            word={word}
            always={always}
            onAlways={setAlways}
            toPantry={toPantry}
            wantId={toPantry ? entry.product?.storeProductId : undefined}
            onDone={(said) => {
              if (said) nav.toast(said);
              onClose();
            }}
          />
        ) : (
          <Suspense fallback={<p className="small">Getting the shop search ready…</p>}>
            <AddScreen key={shopsFor} query={shopsFor} section={section} forLine={forLine} />
          </Suspense>
        )}
      </Sheet>
    );

  /** What's under the pantry list: search the shops (online, in the app), or why not. */
  const shopAction = web ? (
    // 0.9.5 (web search): Search the shops (on), or where to do it (off).
    <web.PickButton typed={typed} pantryShown={!!pantry && shown.length > 0} busy={busy} onSearch={(q) => setShopsFor(q)} auto={toPantry} />
  ) : !native ? (
    <div className="banner grey">
      <strong>Shop search works in the Android app</strong>
      <span style={{ fontSize: 13 }}>Here you can still pick one of your items, or keep it as just the words.</span>
    </div>
  ) : !online ? (
    <>
      <div className="banner grey" role="status">
        <span style={{ fontSize: 14 }}>Searching the shops needs the internet. You can still pick one of your items or add it by hand.</span>
      </div>
      <button className="btn" disabled={busy} onClick={() => setByHand(true)}>
        Add "{word}" by hand
      </button>
    </>
  ) : (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <button className={`btn ${pantry && !shown.length ? 'primary' : ''}`} disabled={busy} onClick={() => setShopsFor(typed)}>
        <Icon name="search" size={18} /> <span className="clip">{pantry && shown.length ? 'Not these? Search the shops' : `Search the shops for "${typed}"`}</span>
      </button>
      <button className="btn ghost small" style={{ minHeight: 44, alignSelf: 'flex-start' }} disabled={busy} onClick={() => setByHand(true)}>
        Add it by hand
      </button>
    </div>
  );

  return (
    <Sheet title={`Pick my ${word}`} onClose={onClose}>
      <div ref={top} style={{ display: 'contents' }} />
      <p className="small" style={{ margin: 0 }}>
        {fromHa ? `"${entry.text}" came from Home Assistant. ` : ''}Which of the items in {place} is it? Or search the shops for it. Restock then shows its
        price and cheapest shop{fromHa ? ', and Home Assistant gets its name.' : '.'}
      </p>
      <SearchField value={query} placeholder={`Search ${place}`} aria-label={`Search ${place}`} onValue={setQuery} />
      <label className="check" style={{ padding: '4px 2px', minHeight: 44 }}>
        <input type="checkbox" checked={always} onChange={(e) => setAlways(e.target.checked)} />
        <span>{alwaysWords(word)}</span>
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
          <div className="row" role="status">
            <span className="small">
              Nothing in {place} matches "{query.trim()}". {native && online ? 'Try another word, or search the shops.' : 'Try another word.'}
            </span>
          </div>
        )}
      </div>
      {pantry && shopAction}
      {/* 0.9.12: only for a Home Assistant line (it stops asking). A line you typed is already just words. */}
      {fromHa && (
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
      )}
      {byHand && (
        <Suspense fallback={null}>
          <ManualSheet
            as="main"
            defaultName={typed.charAt(0).toUpperCase() + typed.slice(1)}
            categories={extras?.categories ?? []}
            section={section}
            shops={extras?.shops ?? []}
            forLine={forLine}
            onClose={() => setByHand(false)}
            onDone={() => setByHand(false)}
          />
        </Suspense>
      )}
    </Sheet>
  );
}
