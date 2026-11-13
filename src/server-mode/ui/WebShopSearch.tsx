// 0.9.5 (web search): the shop search on the web, when the household turned on "Let the web page
// search the shops" (webSearch.ts). It looks and works like the phone's Add tab: each shop's results,
// best first, with photos, price, usual price and on special; a shop that turned the server away
// says so. A tap ticks a result into the bar at the bottom ("1 ticked · tap to add"), and only the
// bar's green arrow opens the details sheet (name, which list incl. General, Picked for you at your
// other shops, category), then Track, Add to list, or both. The server saves it all (the price the
// shop gave it), and this browser's copy gets it at the sync that follows.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { allCategories, deleteListEntries } from '../../lib/db';
import { pickItemFor, pickItemOffList } from '../../lib/listPicks';
import { nameHasSize } from '../../lib/naming';
import { money, tidySize } from '../../lib/units';
import { useLive } from '../../lib/useLive';
import { SECTION_NAMES, SECTION_PLACE, type ListSection, type Section, type StoreChain } from '../../shops';
import type { StoreProduct } from '../../stores/types';
import { chainName, type ListEntry } from '../../types';
import { ChainDot, ChainName, Icon, LoadingBar, MemberTag, Sheet, Thumb } from '../../ui/components';
import { keyOf, sheetOpenAfter, tickMessage, togglePick } from '../../ui/screens/addPicks';
import { AlwaysTick, pickButtonsNote, toPantryNote } from '../../ui/screens/addPickWords';
import { useNav } from '../../ui/nav';
import { ScanButton } from '../pwa/WebScanner';
import { syncNow } from '../live';
import { act } from '../../lib/undo';
import { offerUndo, productIdsHere } from './searchUndo';
import { ItemPhoto, photoUrl } from './deskShared';
import { ADMIN_NOTE } from './houseData';
import {
  addBody,
  addedText,
  addFromSearch,
  askShops,
  canChangeWebSearch,
  findProduct,
  isGone,
  listChoices,
  listLabel,
  saveWebSearch,
  picksForYou,
  searchErrorText,
  searchTabFor,
  tabOfChain,
  searchingText,
  searchShops,
  shopNote,
  shownItems,
  suggestedName,
  tickedShops,
  type AddAnswer,
  type FoundProduct,
  type SearchAnswer,
  type Target,
  useShopAsk,
  useWebSearchOn,
  TURN_ON_LINK,
  PICK_OFF_TEXT,
  WEB_SEARCH_TEXT,
  WEB_SEARCH_TITLE,
} from './webSearch';

const FIRST_PAGE = 5;
const MORE_PAGE = 10;
const TAP = { minHeight: 44 };

/** From the Pick sheet: the new pantry item becomes this list line ("Always use this for chopsticks"). */
export interface WebForLine {
  entry: ListEntry;
  word: string;
  always: boolean;
  onAlways: (on: boolean) => void;
  /** 0.10.2: the line sheet's "Add to pantry": one button, the item made and the line kept as it. */
  toPantry?: boolean;
}

/** The server saved it; this browser's copy has it once a sync has run (one may already be under way). */
async function fetchIt(): Promise<void> {
  await syncNow();
  await syncNow();
}

export function WebShopSearch({
  query,
  barcode,
  tab,
  list,
  only,
  wantId,
  forLine,
  wide,
  initial,
  onDone,
}: {
  /** What was already found for this (a special's Track): shown without searching again. */
  initial?: SearchAnswer;
  query: string;
  barcode?: string;
  /** Whose shops to search (Groceries', Keg's or Health's). */
  tab: Section;
  /** The list Add to list puts it on at first (General from the General list). */
  list?: ListSection;
  /** Just this shop (a special's). */
  only?: StoreChain;
  /** Tick this product when it's found (a special's own product). */
  wantId?: string;
  forLine?: WebForLine;
  /** Shops side by side (the desktop list). */
  wide?: boolean;
  /** Added (what to say), or closed (undefined). */
  onDone: (said: string | undefined, a?: AddAnswer) => void;
}) {
  const [answer, setAnswer] = useState<SearchAnswer>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [picks, setPicks] = useState<Map<string, StoreProduct>>(new Map());
  const [anchor, setAnchor] = useState<StoreProduct>();
  const [panelOpen, setPanelOpen] = useState(false);
  const [said, setSaid] = useState('');
  const [showing, setShowing] = useState<Partial<Record<string, number>>>({});
  const [specialsOnly, setSpecialsOnly] = useState(false);
  const [preview, setPreview] = useState<FoundProduct>();
  const [name, setName] = useState('');
  const [listPick, setListPick] = useState<ListSection>(list === 'general' ? 'general' : tab);
  const [categoryId, setCategoryId] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string>();
  const cats = useLive(async () => (await allCategories()).filter((c) => c.section === tab), [tab]);
  const asked = useRef('');

  const run = async (force = false) => {
    const key = JSON.stringify([query, barcode, tab, only]);
    // Once per search (React's strict mode runs effects twice; each search counts on the server).
    if (!force && asked.current === key) return;
    asked.current = key;
    setBusy(true);
    setError(undefined);
    setSaveError(undefined);
    setPicks(new Map());
    setAnchor(undefined);
    setShowing({});
    try {
      const a = !force && initial ? initial : await searchShops({ q: query, section: tab, chain: only, barcode });
      if (asked.current !== key) return;
      setAnswer(a);
      // A special's own product, or the barcode's exact match at each shop: ticked for you.
      const tick = new Map<string, StoreProduct>();
      for (const s of a.shops) {
        if (s.status !== 'ok') continue;
        const hit = wantId ? s.items.find((p) => String(p.storeProductId) === String(wantId)) : barcode ? s.items.find((p) => p.barcode === barcode) : undefined;
        if (hit) tick.set(keyOf(hit), hit);
      }
      if (tick.size) {
        setPicks(tick);
        setName(suggestedName(tick.values(), forLine?.word));
      }
    } catch (e) {
      if (asked.current === key) setError(searchErrorText(e));
    } finally {
      if (asked.current === key) setBusy(false);
    }
  };
  useEffect(() => {
    void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, barcode, tab, only]);

  // While something's ticked the tick bar is the one at the bottom (the phone layout's Start shopping steps aside).
  const ticking = picks.size > 0;
  useEffect(() => {
    document.documentElement.classList.toggle('web-ticking', ticking);
    return () => document.documentElement.classList.remove('web-ticking');
  }, [ticking]);
  // As the phone: ticking never opens the sheet by itself; the bar's arrow does.
  useEffect(() => setPanelOpen((open) => sheetOpenAfter(open, { kind: 'picks', size: picks.size })), [picks.size]);
  const lastPicks = useRef(picks);
  useEffect(() => {
    const msg = tickMessage(lastPicks.current, picks);
    lastPicks.current = picks;
    if (msg) setSaid(msg);
  }, [picks]);

  const toggle = (sp: StoreProduct) => {
    const next = togglePick(picks, sp);
    if (next.has(keyOf(sp)) && !picks.size) {
      setAnchor(sp);
      if (!name) setName(suggestedName([sp], forLine?.word));
    }
    if (!next.size) setAnchor(undefined);
    setPicks(next);
  };

  const shops = answer?.shops ?? [];
  const recs = anchor && picks.has(keyOf(anchor)) ? picksForYou(anchor, shops, answer?.text ?? query) : [];
  const pickedChains = new Set([...picks.values()].map((p) => p.chain));
  const recShops = recs.filter((r) => !pickedChains.has(r.chain)).map((r) => r.chain);
  const trackedPick = [...picks.values()].map((p) => p as FoundProduct).find((p) => p.itemId);

  const save = async (target: Target) => {
    if (!answer || !picks.size) return;
    setSaving(true);
    setSaveError(undefined);
    try {
      const itemName = name.trim() || suggestedName(picks.values(), forLine?.word);
      // 0.9.11: from the Pick sheet "both" makes the item and the line becomes it, so the server only makes the item.
      const sent: Target = forLine && target === 'both' ? 'pantry' : target;
      const body = addBody(answer.search, picks.values(), { target: sent, tab, list: forLine || target === 'pantry' ? tab : listPick, name: itemName, categoryId });
      const had = await productIdsHere();
      const a = await addFromSearch(body);
      await fetchIt();
      // 0.9.5 (final review): with an Undo (searchUndo.ts), whose toast says what happened.
      await offerUndo(a, had, async () => {
        // 0.9.11: "Add to list" from the Pick sheet: the new line takes the old one's place.
        if (forLine && target === 'list') await deleteListEntries([forLine.entry.id]);
        if (forLine && a.item) {
          const off = target === 'pantry';
          const linked = await (off ? pickItemOffList : pickItemFor)(forLine.entry, a.item, forLine.always);
          const what = `${a.item.name} added to ${SECTION_PLACE[tab]}${off ? ' and off your list' : ''}`;
          return !linked ? `${what}. That line isn't on the list any more` : forLine.always ? `${what}. "${forLine.word}" is ${a.item.name} from now on` : what;
        }
        return addedText(a, a.item?.name ?? itemName, tab);
      });
      onDone(undefined, a);
    } catch (e) {
      setSaveError(searchErrorText(e));
      if (isGone(e)) setAnswer(undefined);
    } finally {
      setSaving(false);
    }
  };

  /** Pick sheet: a ticked product already in the pantry: the line can just be that item. */
  const useTracked = async (p: FoundProduct) => {
    if (!forLine || !p.itemId) return;
    setSaving(true);
    try {
      // 0.9.5 (final review): with an Undo, as on the phone's Pick sheet.
      const linked = await act(
        (l: boolean) => (l ? `${p.itemName ?? p.name} it is` : null),
        () => pickItemFor(forLine.entry, { id: p.itemId!, name: p.itemName ?? p.name }, forLine.always),
      );
      onDone(linked ? undefined : "That line isn't on the list any more");
    } finally {
      setSaving(false);
    }
  };

  const row = (sp: FoundProduct, top: Set<string>) => {
    const k = keyOf(sp);
    const picked = picks.has(k);
    return (
      <label key={k} className={`row${picked ? ' selected' : ''}`}>
        <input type="checkbox" checked={picked} onChange={() => toggle(sp)} aria-label={`Tick ${sp.name} at ${chainName(sp.chain)}, ${money(sp.price)}`} />
        <button
          type="button"
          className="thumb-btn"
          aria-label={`See ${sp.name} bigger`}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setPreview(sp);
          }}
        >
          <Thumb src={photoUrl(sp.imageUrl)} />
          <span className="info-dot" aria-hidden>
            <Icon name="info" size={12} />
          </span>
        </button>
        <span className="grow" style={{ minWidth: 0 }}>
          <span className="title" style={{ fontSize: 15 }}>
            {sp.name}
          </span>
          {sp.size && !nameHasSize(sp.name, sp.size) && <span className="small">{tidySize(sp.size, sp.name)}</span>}
          <span className="tags">
            {barcode && sp.barcode === barcode && <span className="tag good">EXACT MATCH</span>}
            {!barcode && top.has(sp.storeProductId) && <span className="tag good">RECOMMENDED</span>}
            {sp.itemId && <span className="tag normal">IN YOUR PANTRY</span>}
            {sp.isSpecial && !sp.memberOnly && (
              <span className="tag wait">{sp.halfPrice ? 'HALF PRICE' : sp.wasPrice ? `ON SPECIAL · SAVE ${money(sp.wasPrice - (sp.price ?? sp.wasPrice))}` : 'ON SPECIAL'}</span>
            )}
            {sp.isSpecial && sp.promo && <span className="tag normal">{sp.promo.toUpperCase()}</span>}
            {sp.memberOnly && <MemberTag chain={sp.chain} />}
          </span>
        </span>
        <span style={{ textAlign: 'right', flex: 'none' }}>
          <span className="num" style={{ fontWeight: 600, display: 'block' }}>
            {money(sp.price)}
          </span>
          {sp.unitText && (
            <span className="small num" style={{ display: 'block', fontWeight: 600, color: 'var(--ink-2)' }}>
              {sp.unitText}
            </span>
          )}
          {sp.wasPrice ? (
            <span className="small" style={{ display: 'block' }}>
              usual price{' '}
              <span className="num" style={{ textDecoration: 'line-through' }}>
                {money(sp.wasPrice)}
              </span>
            </span>
          ) : null}
        </span>
      </label>
    );
  };

  const picksForYouBlock = recs.length > 0 && anchor && (
    <div role="group" aria-label="Picked for you at your other shops" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div className="eyebrow green">Picked for you at your other shops</div>
      <span className="small">
        Like the {anchor.name} you ticked at {chainName(anchor.chain)} ({money(anchor.price)}). Tick the ones you want here, or close this and tick your own in
        each shop's results.
      </span>
      {recs.map((r) => {
        const rows = [...(r.same ? [r.same] : []), ...r.like];
        return (
          <div key={r.chain} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span className="small" style={{ fontWeight: 700, display: 'flex', alignItems: 'center', gap: 6 }}>
              <ChainDot chain={r.chain} /> {r.same ? `Same product at ${chainName(r.chain)}` : `Most like it at ${chainName(r.chain)}`}
            </span>
            <div className="card flush" style={{ boxShadow: 'none' }}>
              {rows.map((sp) => (
                <label key={keyOf(sp)} className={`row${picks.has(keyOf(sp)) ? ' selected' : ''}`}>
                  <input type="checkbox" checked={picks.has(keyOf(sp))} onChange={() => toggle(sp)} aria-label={`Tick ${sp.name} at ${chainName(sp.chain)}`} />
                  <Thumb src={photoUrl(sp.imageUrl)} />
                  <span className="grow" style={{ minWidth: 0 }}>
                    <span className="title" style={{ fontSize: 15 }}>
                      {sp.name}
                    </span>
                    {sp.unitText && <span className="small">{sp.unitText}</span>}
                    {sp === r.same && <span className="tag great">Same product</span>}
                  </span>
                  <span className="num" style={{ fontWeight: 700, flex: 'none' }}>
                    {money(sp.price)}
                  </span>
                </label>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );

  const categorySelect = listPick !== 'general' && (cats?.length ?? 0) > 0 && (
    <label className="field">
      <span>Category</span>
      <select className="input" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
        <option value="">No category</option>
        {cats!.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <div className="web-shop-search" style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
      <div className="sr-only" role="status" aria-live="polite">
        {said}
      </div>
      {busy && (
        <div className="card" role="status" style={{ gap: 8 }}>
          <span className="small">{searchingText(only ? [only] : [])}</span>
          <LoadingBar seconds={12} />
        </div>
      )}
      {error && (
        <div className="banner amber" role="alert" style={{ fontSize: 14 }}>
          <span>{error}</span>
          <button className="btn small" style={TAP} onClick={() => void run(true)}>
            <Icon name="refresh" size={16} /> Search again
          </button>
        </div>
      )}
      {answer && !busy && (
        <>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <p className="small" style={{ margin: 0, flex: '1 1 260px' }}>
              {forLine
                ? `Tick what you'd buy as "${forLine.word}" at each shop, then tap the bar at the bottom to add it to your pantry.`
                : 'Tick what you buy at each shop (it can be a different product at each one), then tap the bar at the bottom to add it.'}{' '}
              Searched by your server for <strong>{answer.text}</strong>.
            </p>
            <button className="chip" aria-pressed={specialsOnly} onClick={() => setSpecialsOnly((v) => !v)}>
              On special only
            </button>
          </div>
          <div
            style={
              wide
                ? { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 16, alignItems: 'start' }
                : { display: 'flex', flexDirection: 'column', gap: 16 }
            }
          >
            {shops.map((s) => {
              const limit = showing[s.chain] ?? FIRST_PAGE;
              const { list: shown, left, total } = shownItems(s, picks, specialsOnly, limit);
              const note = shopNote(s);
              const top = new Set(s.status === 'ok' ? s.top : []);
              return (
                <section key={s.chain} aria-label={`${s.name} results`} style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
                  <div className="eyebrow">
                    <ChainName chain={s.chain} />
                  </div>
                  {s.status === 'blocked' || s.status === 'error' ? (
                    <div className="banner amber" style={{ fontSize: 13 }}>
                      {note}
                    </div>
                  ) : s.status === 'skipped' ? (
                    <p className="small">{note}</p>
                  ) : note ? (
                    <p className="small">{note}</p>
                  ) : total === 0 ? (
                    <p className="small">Nothing on special at {s.name}.</p>
                  ) : (
                    <div className="card flush">{shown.map((p) => row(p, top))}</div>
                  )}
                  {left > 0 && (
                    <button className="btn ghost small" style={TAP} onClick={() => setShowing((m) => ({ ...m, [s.chain]: limit + MORE_PAGE }))}>
                      Show more ({left})
                    </button>
                  )}
                </section>
              );
            })}
          </div>
        </>
      )}
      {saveError && !panelOpen && (
        <div className="banner amber" role="alert" style={{ fontSize: 14 }}>
          <span>{saveError}</span>
          {!answer && (
            <button className="btn small" style={TAP} onClick={() => void run(true)}>
              Search again
            </button>
          )}
        </div>
      )}

      {picks.size > 0 && (
        <button
          className="card add-mini"
          onClick={() => setPanelOpen((open) => sheetOpenAfter(open, { kind: 'arrow', size: picks.size }))}
          aria-haspopup="dialog"
          aria-expanded={panelOpen}
          aria-label={`${picks.size} ticked at ${tickedShops(picks.values())}. Tap to add.`}
        >
          <span className="grow add-mini-text">
            <span className="title" style={{ fontSize: 15 }}>
              {picks.size} ticked · tap to add
            </span>
            <span className="small clip">{tickedShops(picks.values())}</span>
            {recShops.length > 0 && <span className="small clip">Picked for you at {recShops.map((c) => chainName(c)).join(' and ')}</span>}
          </span>
          <span className="add-mini-arrow" aria-hidden="true">
            <span style={{ display: 'inline-flex', transform: 'rotate(-90deg)' }}>
              <Icon name="chevron" size={26} />
            </span>
          </span>
        </button>
      )}

      {picks.size > 0 && panelOpen && (
        <Sheet title={forLine ? 'Add to your pantry' : 'Add what you ticked'} onClose={() => setPanelOpen((open) => sheetOpenAfter(open, { kind: 'close' }))}>
          <div className="small picked-list" style={{ minWidth: 0 }} aria-label="Ticked" role="list">
            {[...picks.values()].map((p) => (
              <div key={keyOf(p)} className="picked-line" role="listitem">
                <ChainDot chain={p.chain} />
                <span className="clip grow">{p.name}</span>
                <span className="num picked-price">{money(p.price)}</span>
              </div>
            ))}
          </div>
          {picks.size > 6 && <p className="banner amber small">Tick 6 or fewer, then add.</p>}
          {saveError && (
            <p className="banner amber small" role="alert">
              {saveError}
            </p>
          )}
          {forLine ? (
            <>
              {trackedPick && (
                <div className="banner grey" style={{ fontSize: 14 }}>
                  <span>
                    You already have this in your pantry as <strong>{trackedPick.itemName ?? trackedPick.name}</strong>.
                  </span>
                  <button className="btn small" style={TAP} disabled={saving} onClick={() => void useTracked(trackedPick)}>
                    Use {trackedPick.itemName ?? trackedPick.name}
                  </button>
                </div>
              )}
              <label className="field">
                <span>Name in your pantry</span>
                <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Chopsticks" />
              </label>
              {picksForYouBlock}
              {categorySelect}
              {/* 0.9.11: the same three buttons and tick as the phone's Pick sheet. */}
              <AlwaysTick forLine={forLine} />
              {forLine.toPantry ? (
                // 0.10.2: from the line's "Add to pantry", as on the phone: one button.
                <>
                  <button className="btn primary" onClick={() => void save('both')} disabled={saving || picks.size > 6}>
                    <Icon name={tab} size={18} /> Add to {SECTION_NAMES[tab].toLowerCase()}
                  </button>
                  <p className="small" style={{ margin: 0 }}>
                    {toPantryNote(SECTION_PLACE[tab])}
                  </p>
                </>
              ) : (
              <>
              <button className="btn primary" onClick={() => void save('both')} disabled={saving || picks.size > 6}>
                <Icon name="cart" size={18} /> Add to both
              </button>
              <div className="two">
                <button className="btn" onClick={() => void save('list')} disabled={saving || picks.size > 6}>
                  <Icon name="cart" size={18} /> Add to list
                </button>
                <button className="btn" onClick={() => void save('pantry')} disabled={saving || picks.size > 6}>
                  <Icon name={tab} size={18} /> Add to {SECTION_NAMES[tab].toLowerCase()}
                </button>
              </div>
              <p className="small" style={{ margin: 0 }}>
                {pickButtonsNote(SECTION_PLACE[tab])}
              </p>
              </>
              )}
            </>
          ) : (
            <>
              <label className="field">
                <span>Name</span>
                <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Honey" />
              </label>
              <label className="field">
                <span>Which list</span>
                <select className="input" value={listPick} onChange={(e) => setListPick(e.target.value as ListSection)}>
                  {listChoices(tab).map((l) => (
                    <option key={l} value={l}>
                      {listLabel(l)}
                    </option>
                  ))}
                </select>
              </label>
              {picksForYouBlock}
              {categorySelect}
              {/* 0.9.12: the phone's words and layout: Add to both first, then list or pantry on their own. */}
              {listPick === 'general' ? (
                <div className="two">
                  <button className="btn primary" onClick={() => void save('list')} disabled={saving || picks.size > 6}>
                    <Icon name="cart" size={18} /> Add to list
                  </button>
                  <button className="btn" onClick={() => void save('both')} disabled={saving || picks.size > 6}>
                    <Icon name={tab} size={18} /> Add to both
                  </button>
                </div>
              ) : (
                <>
                  <button className="btn primary" onClick={() => void save('both')} disabled={saving || picks.size > 6}>
                    <Icon name="cart" size={18} /> Add to both
                  </button>
                  <div className="two">
                    <button className="btn" onClick={() => void save('list')} disabled={saving || picks.size > 6}>
                      <Icon name="cart" size={18} /> Add to list
                    </button>
                    <button className="btn" onClick={() => void save('pantry')} disabled={saving || picks.size > 6}>
                      <Icon name={tab} size={18} /> Add to {SECTION_NAMES[tab].toLowerCase()}
                    </button>
                  </div>
                </>
              )}
              <p className="small" style={{ margin: 0 }}>
                Add to {SECTION_NAMES[tab].toLowerCase()} puts it in {SECTION_PLACE[tab]}, so Restock watches its price. Add to list puts it on the list for this trip only, at the
                price shown.{listPick === 'general' ? ' General is a list only: Add to both also puts it in ' + SECTION_PLACE[tab] + '.' : ''}
              </p>
            </>
          )}
        </Sheet>
      )}

      {preview && (
        <Sheet title={chainName(preview.chain)} onClose={() => setPreview(undefined)}>
          <ItemPhoto src={photoUrl(preview.imageUrl)} name={preview.name} size="sheet" />
          <span className="title dk-sheet-name">{preview.name}</span>
          <div className="dk-sheet-price">
            <span className="num dk-sheet-now">{money(preview.price)}</span>
            {preview.wasPrice ? (
              <span className="small num">
                usual price <s>{money(preview.wasPrice)}</s>
              </span>
            ) : null}
            {preview.unitText && <span className="small num">{preview.unitText}</span>}
          </div>
          {preview.size && <p className="small">{tidySize(preview.size, preview.name)}</p>}
          <button
            className={`btn ${picks.has(keyOf(preview)) ? '' : 'primary'}`}
            onClick={() => {
              toggle(preview);
              setPreview(undefined);
            }}
          >
            <Icon name="check" size={18} /> {picks.has(keyOf(preview)) ? 'Untick this one' : 'Tick this one'}
          </button>
        </Sheet>
      )}
    </div>
  );
}

/**
 * Settings: the switch (off by default). Saved on the server at once, as the household's other
 * server settings here; only a browser signed in with the passphrase can change it.
 */
export function WebSearchSwitch({ Line }: { Line: (p: { title: string; sub?: ReactNode; children?: ReactNode; greyed?: boolean; htmlFor?: string }) => ReactNode }) {
  const on = useWebSearchOn();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string>();
  const can = canChangeWebSearch();
  return (
    <Line
      title={WEB_SEARCH_TITLE}
      htmlFor="dk-web-search"
      greyed={!can}
      sub={
        <>
          {WEB_SEARCH_TEXT}
          {!can && <> {ADMIN_NOTE}</>}
          {msg && (
            <span role="status" style={{ display: 'block', marginTop: 4 }}>
              {msg}
            </span>
          )}
        </>
      }
    >
      <input
        id="dk-web-search"
        type="checkbox"
        className="switch"
        disabled={!can || busy || on === undefined}
        checked={on === true}
        onChange={async (e) => {
          const v = e.target.checked;
          setBusy(true);
          setMsg(undefined);
          try {
            const now = await saveWebSearch(v);
            setMsg(now ? 'Saved. On: Search the shops works on this page now.' : 'Saved. Off: the server won’t contact any shop.');
          } catch (err) {
            setMsg(searchErrorText(err));
          } finally {
            setBusy(false);
          }
        }}
      />
    </Line>
  );
}

/**
 * Under the add box: "Search the shops for "honey"" when the setting is on; when it's off, a small
 * link to Settings. Nothing while nothing's typed (or the household isn't a v3 house).
 */
export function ShopSearchButton({ text, list, className = 'btn', short }: { text: string; list: ListSection; className?: string; short?: boolean }) {
  const nav = useNav();
  const on = useWebSearchOn();
  const t = text.trim();
  if (!t || on === undefined) return null;
  if (!on)
    return (
      <button type="button" className="dk-linkish small web-search-off" style={TAP} onClick={() => nav.push({ name: 'settings' })}>
        {TURN_ON_LINK}
      </button>
    );
  return (
    <button type="button" className={className} aria-label={short ? `Search the shops for "${t}"` : undefined} onClick={() => askShops({ q: t, list })}>
      <Icon name="search" size={18} /> <span className="clip">{short ? 'Search the shops' : `Search the shops for "${t}"`}</span>
    </button>
  );
}

/** The results of what was asked (typed or scanned), under the add box, until added or closed. */
export function ShopSearchPanel({ list, wide, onAdded }: { list: ListSection; wide?: boolean; onAdded?: () => void }) {
  const nav = useNav();
  const ask = useShopAsk();
  const on = useWebSearchOn();
  // Leaving the list (or the setting going off) ends the search shown.
  useEffect(() => () => askShops(undefined), []);
  if (!ask || on !== true) return null;
  const tab = searchTabFor(ask.list);
  return (
    <section className="card web-shop-panel" aria-labelledby="web-shop-head" style={{ gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <h2 id="web-shop-head" className="grow" style={{ margin: 0, fontSize: 17 }}>
          {ask.barcode ? `Shops for barcode ${ask.barcode}` : `Search the shops for "${ask.q}"`}
        </h2>
        <button className="icon-btn" aria-label="Close the shop search" onClick={() => askShops(undefined)}>
          <Icon name="close" size={18} />
        </button>
      </div>
      <WebShopSearch
        key={ask.n}
        query={ask.q}
        barcode={ask.barcode}
        tab={tab}
        list={ask.list === 'general' || ask.list === list ? ask.list : list}
        wide={wide}
        onDone={(said, a) => {
          askShops(undefined);
          // 0.9.5 (final review): an add says so in its Undo toast; `said` is only for anything else.
          if (said) nav.toast(said);
          if (said || a) onAdded?.();
        }}
      />
    </section>
  );
}

/** The Pick sheet on the web: Search the shops for "chopsticks" (setting on), or where to do it (off). */
export function PickSearchButton({
  typed,
  pantryShown,
  busy,
  onSearch,
  auto,
}: {
  typed: string;
  pantryShown: boolean;
  busy: boolean;
  onSearch: (q: string) => void;
  /** 0.10.2: a line's "Add to pantry": search straight away when the household has the web search on. */
  auto?: boolean;
}) {
  const on = useWebSearchOn();
  const went = useRef(false);
  useEffect(() => {
    if (!auto || !on || went.current) return;
    went.current = true;
    onSearch(typed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auto, on]);
  if (on === undefined) return null;
  if (!on)
    return (
      <div className="banner grey" role="note">
        <span style={{ fontSize: 14 }}>{PICK_OFF_TEXT}</span>
      </div>
    );
  return (
    <button className={`btn ${pantryShown ? '' : 'primary'}`} disabled={busy} onClick={() => onSearch(typed)}>
      <Icon name="search" size={18} /> <span className="clip">{pantryShown ? 'Not these? Search the shops' : `Search the shops for "${typed}"`}</span>
    </button>
  );
}

/** The Pick sheet's shop results on the web: adding makes the pantry item and the line becomes it. */
export function PickSearchResults({
  query,
  entry,
  word,
  always,
  onAlways,
  onDone,
  section = 'pantry',
  toPantry,
  wantId,
}: {
  query: string;
  section?: Section;
  entry: ListEntry;
  word: string;
  always: boolean;
  onAlways: (on: boolean) => void;
  onDone: (said: string | undefined) => void;
  toPantry?: boolean;
  wantId?: string;
}) {
  return <WebShopSearch query={query} tab={section} wantId={wantId} forLine={{ entry, word, always, onAlways, toPantry }} onDone={(said) => onDone(said)} />;
}

/** The phone layout's Shopping list on the web: Scan, as on the desktop list's add box. */
export function ListScan({ section }: { section: Section }) {
  const nav = useNav();
  return <ScanButton section={section} onSaid={(t) => nav.toast(t)} className="btn scan-btn" />;
}

/** For main.tsx: what the phone layout and the Pick sheet are handed (flag.ts serverUi.webSearch). */
export const webSearchUi = {
  PickButton: PickSearchButton,
  PickResults: PickSearchResults,
  // 0.9.5 (look): the main action, green as on the phone's list (Search the shops there too).
  ListButton: (p: { text: string; list: ListSection }) => <ShopSearchButton {...p} className="btn primary" short />,
  ListPanel: ShopSearchPanel,
  Scan: ListScan,
};

/**
 * 0.9.5 (web search): Track for a special you don't track yet (as the phone's). The server searches
 * the special's shop for its name and saves that product from its own search (prices come from the
 * server's search, never from this page). When the shop's answer doesn't have that very product,
 * what it found shows, to tick the right one.
 */
export function useTrackSpecial() {
  const nav = useNav();
  const on = useWebSearchOn();
  const [busy, setBusy] = useState<string>();
  const [choose, setChoose] = useState<{ p: StoreProduct; a: SearchAnswer; tab: Section }>();
  const track = async (p: StoreProduct) => {
    const k = keyOf(p);
    if (busy) return;
    setBusy(k);
    try {
      const tab = tabOfChain(p.chain);
      const a = await searchShops({ q: p.name.slice(0, 100), section: tab, chain: p.chain as StoreChain });
      const hit = findProduct(a, p.chain, p.storeProductId);
      if (!hit) return setChoose({ p, a, tab });
      const name = suggestedName([hit]);
      const had = await productIdsHere();
      const done = await addFromSearch(addBody(a.search, [hit], { target: 'pantry', tab, list: tab, name }));
      await fetchIt();
      // 0.9.5 (final review): "… · Undo" (searchUndo.ts).
      await offerUndo(done, had, async () => addedText(done, done.item?.name ?? name, tab));
    } catch (e) {
      nav.toast(searchErrorText(e));
    } finally {
      setBusy(undefined);
    }
  };
  const sheet = choose && (
    <Sheet title={`Track it: ${chainName(choose.p.chain)}`} onClose={() => setChoose(undefined)}>
      <p className="small" style={{ margin: 0 }}>
        {chainName(choose.p.chain)} didn't send back "{choose.p.name}" itself. Tick it among what it found, then tap the bar at the bottom.
      </p>
      <WebShopSearch
        query={choose.p.name.slice(0, 100)}
        tab={choose.tab}
        only={choose.p.chain as StoreChain}
        initial={choose.a}
        onDone={(said) => {
          setChoose(undefined);
          if (said) nav.toast(said);
        }}
      />
    </Sheet>
  );
  return { on: on === true, track, busy, sheet };
}
