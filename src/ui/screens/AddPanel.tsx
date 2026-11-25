import { ChainDot, LoadingBar, Thumb } from '../components';
import { type ChainResult } from './addShared';
import { type NoteTone } from '../simple';
import { type RankQuery } from '../../stores/rank';
import { type Settings, chainName, searchStoreId } from '../../types';
import { type StoreChain } from '../../shops';
import { keyOf } from './addPicks';
import { money } from '../../lib/units';
import type { Dispatch, SetStateAction, RefObject, JSX } from 'react';
import type { Category } from '../../types';
import type { Nav } from '../nav';
import { NameFirst } from './NameFirst';
import { sameNameWords } from '../../lib/sameName';
import { type StoreProduct } from '../../stores';
import { COSTCO_LIST_NOTE } from '../../lib/costcoLocal';
import { type AlertLevel, type Chain, type Group } from '../../types';
import { isLocalOnlyShop, SECTION_NAMES, SECTION_PLACE, type Section } from '../../shops';
import { Icon, Sheet } from '../components';
import { sheetOpenAfter } from './addPicks';
import { AlertPicker } from './ItemSheets';
import { CategoryPick } from './Categories';
import { AddBtn, AddPair, addButtonsNote, addToWord } from './addPickWords';
import { PickButtons } from './AddSheets';
import { TAP, type ForLine, type Target } from './addShared';

/** 0.15.1 (split from Add.tsx): the sheet to name what you ticked and add it: name, category, your pick at each shop, alerts, and the add buttons. */
export function AddPanel(p: {
  alertLevel: AlertLevel;
  alertPct: number;
  allowBulk: boolean;
  allowMulti: boolean;
  altGroup: false | JSX.Element;
  as: "main" | "alt";
  attachGroup: Group | undefined;
  busyAs: Target | undefined;
  catTouched: boolean;
  categories: Category[] | undefined;
  categoryId: string;
  cheapestChain: () => Chain | undefined;
  forLine: ForLine | undefined;
  forList: boolean | undefined;
  havePick: Group | undefined;
  makesItem: boolean;
  matchCards: JSX.Element;
  matchShops: Chain[];
  name: string;
  nameBox: RefObject<HTMLInputElement | null>;
  nameIdea: string;
  nameMissing: boolean;
  nav: Nav;
  panelOpen: boolean;
  pickedCategory: string | undefined;
  picks: Map<string, StoreProduct>;
  save: (target: Target) => Promise<void>;
  saveAttach: () => Promise<void>;
  saving: boolean;
  section: Section;
  setAlertLevel: Dispatch<SetStateAction<AlertLevel>>;
  setAlertPct: Dispatch<SetStateAction<number>>;
  setAllowBulk: Dispatch<SetStateAction<boolean>>;
  setAllowMulti: Dispatch<SetStateAction<boolean>>;
  setCatTouched: Dispatch<SetStateAction<boolean>>;
  setCategoryId: Dispatch<SetStateAction<string>>;
  setName: Dispatch<SetStateAction<string>>;
  setNameMissing: Dispatch<SetStateAction<boolean>>;
  setPanelOpen: Dispatch<SetStateAction<boolean>>;
  sheetTitle: string;
  shownCategory: string;
  sureCategory: string;
  tabHidden: boolean;
  takenItem: Group | undefined;
  toPantry: boolean | undefined;
  trackedPick: Group | undefined;
  pickTracked: (g: Group) => Promise<void>;
}) {
  const { alertLevel, alertPct, allowBulk, allowMulti, altGroup, as, attachGroup, busyAs, catTouched, categories, categoryId, cheapestChain, forLine, forList, havePick, makesItem, matchCards, matchShops, name, nameBox, nameIdea, nameMissing, nav, panelOpen, pickedCategory, picks, save, saveAttach, saving, section, setAlertLevel, setAlertPct, setAllowBulk, setAllowMulti, setCatTouched, setCategoryId, setName, setNameMissing, setPanelOpen, sheetTitle, shownCategory, sureCategory, tabHidden, takenItem, toPantry, trackedPick, pickTracked } = p;
  return (
    <>
      {picks.size > 0 && panelOpen && (
        <Sheet title={sheetTitle} onClose={() => setPanelOpen((open) => sheetOpenAfter(open, { kind: 'close' }))}>
          {/* 0.12.0: your pick at each shop, with Change beside each (it was a list of what you'd ticked) */}
          {/* 0.12.5: the name and category first (they were folded away under the picks), then your picks, then alerts */}
          {!attachGroup && (
            <div className="review-top">
              {/* 0.12.7: you name it. The box is first, bigger, and starts empty; one short idea sits under it to tap. */}
              <NameFirst
                value={name}
                onChange={(n) => {
                  setName(n);
                  if (n.trim()) setNameMissing(false);
                }}
                idea={nameIdea}
                missing={nameMissing}
                inputRef={nameBox}
                taken={takenItem && (forLine || !forList) ? sameNameWords(takenItem) : undefined}
                onOpenTaken={
                  takenItem && !forLine
                    ? { label: `Open ${takenItem.name}`, open: () => nav.push({ name: 'item', groupId: takenItem.id }) }
                    : undefined
                }
                placeholder={forLine ? 'e.g. Chopsticks' : forList ? 'e.g. Coffee' : 'e.g. Honey'}
                help={
                  forLine
                    ? 'What it is called in your pantry.'
                    : forList
                      ? 'What it is called on your Shopping list.'
                      : `What it is called in ${SECTION_PLACE[section]} and on your Shopping list. Short is best.`
                }
              />
              {(forLine || !forList) && (
                <CategoryPick
                  section={section}
                  categories={categories ?? []}
                  value={shownCategory}
                  onChange={(id) => {
                    setCatTouched(true);
                    setCategoryId(id);
                  }}
                />
              )}
              {(forLine || !forList) && !catTouched && !categoryId && sureCategory && (
                <span className="small">Restock chose this category from what it is. Change it if it's wrong.</span>
              )}
            </div>
          )}
          {makesItem ? (
            <div className="eyebrow">Products I buy</div>
          ) : (
            <p className="small" style={{ margin: 0 }}>
              {matchShops.length > 1 ? 'Your picks at each shop. Check them, then add.' : 'Check it, then add.'}
            </p>
          )}
          {matchCards}
          {altGroup}
          {/* 0.12.10: a pick that's already one of your items says so before it's added a second time
              (a barcode scanned for something you already track at a shop with no barcodes). */}
          {havePick && (
            <div className="banner grey" style={{ fontSize: 14 }}>
              <span>
                You already have this in {SECTION_PLACE[(havePick.section ?? section) as Section]} as <strong>{havePick.name}</strong>.
              </span>
              <button className="btn small" style={TAP} onClick={() => nav.push({ name: 'item', groupId: havePick.id })}>
                Open {havePick.name}
              </button>
            </div>
          )}
          {forLine ? (
            <>
              {trackedPick && (
                <div className="banner grey" style={{ fontSize: 14 }}>
                  <span>
                    You already have this in your pantry as <strong>{trackedPick.name}</strong>.
                  </span>
                  <button className="btn small" style={TAP} disabled={saving} onClick={() => void pickTracked(trackedPick)}>
                    Use {trackedPick.name}
                  </button>
                </div>
              )}
              <details className="explain">
                <summary>
                  <Icon name="bell" size={18} />
                  <span>Alerts</span>
                </summary>
                <div className="explain-body">
                  <AlertPicker level={alertLevel} pct={alertPct} onChange={(l, p) => (setAlertLevel(l), setAlertPct(p))} />
                </div>
              </details>
              <PickButtons forLine={forLine} section={section} saving={saving} busy={busyAs} onSave={(t) => void save(t)} />
            </>
          ) : (
            forList && !attachGroup ? (
              <>
                  <AddBtn target="list" busy={busyAs} className="btn primary" onClick={() => void save('list')}>
                  <Icon name="cart" size={18} /> Add to list
                </AddBtn>
                <p className="small" style={{ margin: 0 }}>
                  Just for this trip, at the cheapest of your picks. It doesn't go in your pantry, and Restock won't keep watching its price.
                </p>
                {isLocalOnlyShop(cheapestChain()) && (
                  <p className="small" style={{ margin: 0 }}>
                    {COSTCO_LIST_NOTE}
                  </p>
                )}
              </>
            ) : attachGroup ? (
              <AddBtn target="pantry" busy={saving ? 'pantry' : undefined} className="btn primary" onClick={() => void saveAttach()}>
                {as === 'alt' ? 'Add to Also happy with' : `Add to ${attachGroup.name}`}
              </AddBtn>
            ) : (
              <>
                <details className="explain">
                  <summary>
                    <Icon name="bell" size={18} />
                    <span>Alerts and savings</span>
                  </summary>
                  <div className="explain-body">
                    <AlertPicker level={alertLevel} pct={alertPct} onChange={(l, p) => (setAlertLevel(l), setAlertPct(p))} />
                    <label className="check" style={{ padding: '4px 2px' }}>
                      <input type="checkbox" className="switch" checked={allowBulk} onChange={(e) => setAllowBulk(e.target.checked)} />
                      <span style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
                        <span className="title" style={{ fontSize: 15 }}>
                          Swap for bulk packs to save money
                        </span>
                        <span className="small">Let Restock suggest a bigger pack when it's cheaper per 100 g.</span>
                      </span>
                    </label>
                    <label className="check" style={{ padding: '4px 2px' }}>
                      <input type="checkbox" className="switch" checked={allowMulti} onChange={(e) => setAllowMulti(e.target.checked)} />
                      <span style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
                        <span className="title" style={{ fontSize: 15 }}>
                          Multi-buy to save money
                        </span>
                        <span className="small">Count deals like "2 for $12" when they're cheaper each.</span>
                      </span>
                    </label>
                  </div>
                </details>
                {tabHidden ? (
                  <div className="two">
                    <AddBtn target="list" busy={busyAs} className="btn primary" onClick={() => void save('list')}>
                      <Icon name="cart" size={18} /> Add to list
                    </AddBtn>
                    <AddBtn target="both" busy={busyAs} className="btn" onClick={() => void save('both')}>
                      <Icon name={section} size={18} /> Add to both
                    </AddBtn>
                  </div>
                ) : toPantry ? (
                  // 0.12.0: from "Add to pantry": the one button, and the list as well if you want it
                  <>
                    <AddBtn target="pantry" busy={busyAs} className="btn primary" onClick={() => void save('pantry')}>
                      <Icon name={section} size={18} /> Add to{' '}
                      {pickedCategory ? addToWord(pickedCategory) : section === 'pantry' ? 'pantry' : SECTION_NAMES[section]}
                    </AddBtn>
                    {/* 0.13.0: three buttons that say what each does (the second read "And put it on my list", which sounded
                        like the list alone, but it keeps the item too). The third is the list alone: no name
                        needed, nothing kept, for something you're buying once. */}
                    <AddBtn target="both" busy={busyAs} className="btn" onClick={() => void save('both')}>
                      <Icon name="cart" size={18} /> Add to {pickedCategory ? addToWord(pickedCategory) : section === 'pantry' ? 'pantry' : SECTION_NAMES[section]} and shopping list
                    </AddBtn>
                    <AddBtn target="list" busy={busyAs} className="btn" onClick={() => void save('list')}>
                      <Icon name="cart" size={18} /> Shopping list only, just this once
                    </AddBtn>
                  </>
                ) : (
                  // 0.12.0: from Home: pantry or list is asked here, once, with both underneath
                  <>
                    <AddPair section={section} category={pickedCategory} busy={busyAs} onPantry={() => void save('pantry')} onList={() => void save('list')} />
                    <AddBtn target="both" busy={busyAs} className="btn ghost" onClick={() => void save('both')}>
                      Add to both
                    </AddBtn>
                  </>
                )}
                <p className="small" style={{ margin: 0 }}>
                  {tabHidden
                    ? "Add to list puts it on your Shopping list for this trip only, at the price shown. Restock won't keep watching its price."
                    : toPantry
                      ? `The first two keep it in ${SECTION_PLACE[section]}, and Restock keeps watching its price. Just this once puts it on your Shopping list for this trip only: it isn't kept or watched, and it doesn't need a name.`
                      : addButtonsNote(SECTION_PLACE[section], pickedCategory)}
                </p>
              </>
            )
          )}
        </Sheet>
      )}
    </>
  );
}

/** 0.12.7: "Also happy with (alternative product)" while adding: one line per shop, your alternative there or Find one. */
export function AltGroup(p: {
  altPicks: StoreProduct[];
  matchShops: Chain[];
  photoFor: (sp: StoreProduct) => string | undefined;
  pickOne: (sp: StoreProduct) => void;
  results: Partial<Record<Chain, ChainResult>>;
  searched: StoreChain[];
  setAlts: Dispatch<SetStateAction<Set<string>>>;
  startChange: (c: Chain, asAlt?: boolean) => void;
}) {
  const { altPicks, matchShops, photoFor, pickOne, results, searched, setAlts, startChange } = p;
  return (
    <>
      <section className="alt-group" aria-label="Also happy with (alternative product)">
      <div className="alt-group-head">
        <span className="title">Also happy with (alternative product)</span>
        <span className="small">A second choice you'd accept. Restock uses it when yours is out of stock or not at the shop you're in.</span>
      </div>
      {matchShops.map((c) => {
        const here = altPicks.filter((x) => x.chain === c);
        const r = results[c as StoreChain];
        const canFind = (searched as Chain[]).includes(c) && r?.status === 'ok';
        return (
          <div key={c} className="alt-shop">
            <span className="match-lab">
              <ChainDot chain={c} />
              {chainName(c)}
            </span>
            {here.map((sp) => (
              <div key={keyOf(sp)} className="alt-pick">
                <Thumb src={sp.imageUrl ?? photoFor(sp)} />
                <span className="grow">
                  <span className="match-name">{sp.name}</span>
                  <span className="num match-price">{money(sp.price)}</span>
                </span>
                <span className="match-actions">
                  <button className="btn small" style={TAP} onClick={() => pickOne(sp)} aria-label={`Remove ${sp.name} from Also happy with`}>
                    Remove
                  </button>
                  <button
                    className="btn small"
                    style={TAP}
                    onClick={() => setAlts((a) => new Set([...a].filter((k) => k !== keyOf(sp))))}
                    aria-label={`Move ${sp.name} to Products I buy`}
                  >
                    Move to Products I buy
                  </button>
                </span>
              </div>
            ))}
            {canFind ? (
              <button className="btn small" style={TAP} onClick={() => startChange(c, true)} aria-label={`Find an alternative at ${chainName(c)}`}>
                <Icon name="search" size={16} /> {here.length ? 'Find another' : 'Find one'}
              </button>
            ) : (
              !here.length && <span className="small">{r?.status === 'error' ? "Couldn't check this shop just now." : 'Still searching…'}</span>
            )}
          </div>
        );
      })}
    </section>
    </>
  );
}

/** 0.12.0: your pick at each shop, with Change beside each. */
export function MatchCards(p: {
  anchorChain: Chain | undefined;
  attachTo: string | undefined;
  declined: Set<string>;
  forLine: ForLine | undefined;
  lastText: string;
  mainPicks: StoreProduct[];
  makesItem: boolean;
  matchShops: Chain[];
  notSoldAt: (c: Chain) => void;
  photoFor: (sp: StoreProduct) => string | undefined;
  pickLabel: (sp: StoreProduct) => { text: string; tone: NoteTone; };
  pickOne: (sp: StoreProduct) => void;
  rankQ: RankQuery;
  results: Partial<Record<Chain, ChainResult>>;
  searchChain: (chain: StoreChain, text: string, rq: RankQuery, storeId?: string) => Promise<void>;
  searched: StoreChain[];
  setAlts: Dispatch<SetStateAction<Set<string>>>;
  setDeclined: Dispatch<SetStateAction<Set<string>>>;
  settings: Settings | undefined;
  startChange: (c: Chain, asAlt?: boolean) => void;
  toggle: (sp: StoreProduct) => void;
}) {
  const { anchorChain, attachTo, declined, forLine, lastText, mainPicks, makesItem, matchShops, notSoldAt, photoFor, pickLabel, pickOne, rankQ, results, searchChain, searched, setAlts, setDeclined, settings, startChange, toggle } = p;
  return (
    <>
      <div className="match-list" role="list" aria-label="Your pick at each shop">
      {matchShops.map((c) => {
        const mine = mainPicks.filter((x) => x.chain === c);
        const r = results[c as StoreChain];
        const busy = !r || r.status === 'loading';
        const canChange = (searched as Chain[]).includes(c) && r?.status === 'ok';
        if (mine.length)
          return mine.map((sp) => {
            const lab = pickLabel(sp);
            return (
              <div key={keyOf(sp)} role="listitem" className={`match-card${c === anchorChain ? ' anchor' : ''}`}>
                <Thumb src={sp.imageUrl ?? photoFor(sp)} />
                <span className="grow">
                  <span className="match-lab">
                    <ChainDot chain={c} />
                    {chainName(c)}
                  </span>
                  <span className={`match-how ${lab.tone}`}>{lab.text}</span>
                  <span className="match-name">{sp.name}</span>
                  <span className="num match-price">{money(sp.price)}</span>
                </span>
                <span className="match-actions">
                  {attachTo || forLine ? (
                    // Adding to an item you have: several picks can stand, so each has its own Remove.
                    <button className="btn small" style={TAP} onClick={() => toggle(sp)} aria-label={`Remove ${sp.name} at ${chainName(c)}`}>
                      Remove
                    </button>
                  ) : (
                    <>
                      {/* 0.12.4: several picks can stand at a shop: each has Remove, and More opens that shop's results to tick others */}
                      <button className="btn small" style={TAP} onClick={() => pickOne(sp)} aria-label={`Remove ${sp.name} at ${chainName(c)}`}>
                        Remove
                      </button>
                      {/* 0.12.7: it's a second choice, not what you buy: one tap moves it to Also happy with */}
                      {makesItem && (
                        <button className="btn small" style={TAP} onClick={() => setAlts((a) => new Set([...a, keyOf(sp)]))} aria-label={`Make ${sp.name} an alternative`}>
                          Make it an alternative
                        </button>
                      )}
                      {sp === mine[mine.length - 1] && c !== anchorChain && (
                        <button className="btn small" style={TAP} onClick={() => notSoldAt(c)} aria-label={`Not sold at ${chainName(c)}`}>
                          Not sold here
                        </button>
                      )}
                      {sp === mine[mine.length - 1] && canChange && (
                        <button className="btn small" style={TAP} onClick={() => startChange(c)} aria-label={`Pick more at ${chainName(c)}`}>
                          <Icon name="plus" size={16} /> More
                        </button>
                      )}
                    </>
                  )}
                </span>
              </div>
            );
          });
        return (
          <div key={c} role="listitem" className="match-card none">
            <span className="grow">
              <span className="match-lab">
                <ChainDot chain={c} />
                {chainName(c)}
              </span>
              <span className="match-how plain">
                {busy ? 'Searching' : r?.status === 'error' ? "Couldn't check" : declined.has(c) ? 'Not sold here' : 'Not added'}
              </span>
              {busy ? (
                <span className="small" role="status">
                  Waiting for {chainName(c)}…
                  <LoadingBar seconds={15} />
                </span>
              ) : r?.status === 'error' ? (
                <span className="small">
                  {chainName(c)} didn't answer. Add it without {chainName(c)} and find it there later.
                </span>
              ) : declined.has(c) ? (
                <span className="small">Left out of this item: you said {chainName(c)} doesn't sell it.</span>
              ) : (
                // 0.12.6: nothing is picked for you; every shop you haven't ticked at reads the same.
                <span className="small">Nothing picked at {chainName(c)}. Find it there if you buy it there too.</span>
              )}
              {!busy && (
                <span className="match-actions">
                  {r?.status === 'error' && settings ? (
                    <button className="btn small" style={TAP} onClick={() => void searchChain(c as StoreChain, lastText, rankQ, searchStoreId(settings, c as StoreChain))}>
                      <Icon name="refresh" size={16} /> Try again
                    </button>
                  ) : declined.has(c) ? (
                    <button className="btn small" style={TAP} onClick={() => setDeclined((d) => new Set([...d].filter((x) => x !== c)))} aria-label={`Undo: ${chainName(c)} not sold here`}>
                      Undo
                    </button>
                  ) : (
                    <>
                      {canChange && (
                        <button className="btn small" style={TAP} onClick={() => startChange(c)} aria-label={`Find it at ${chainName(c)}`}>
                          <Icon name="search" size={16} /> Find it
                        </button>
                      )}
                      <button className="btn small" style={TAP} onClick={() => notSoldAt(c)} aria-label={`Not sold at ${chainName(c)}`}>
                        Not sold here
                      </button>
                    </>
                  )}
                </span>
              )}
            </span>
          </div>
        );
      })}
    </div>
    </>
  );
}
