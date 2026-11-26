import { useFullRefresh } from '../refresh';
import { useEffect, useRef, useState } from 'react';
import { itemsToSort, sortTargets } from '../../lib/categoryGuess';
import { allCategories, allListEntries, cachedSettings, deleteGroup, updateGroup } from '../../lib/db';
import { addAllToList, addToList, buzz, takeOffList } from '../../lib/listActions';
import { act } from '../../lib/undo';
import { loadRecommendations } from '../../lib/recs';
import { useLive, useSettings } from '../../lib/useLive';
import { inventoryAsked, shouldAskInventory } from '../../lib/inventoryAsk';
import { type Recommendation } from '../../lib/verdict';
import { BetaTag, Hold, Icon, previewFromOption, ProductPreview, SelectBar, Sheet, SwipeRow, SearchField } from '../components';
import { BigAdd, NoneFound, RecRow } from '../simple';
import { picksOffered } from '../../lib/makerPicks';
import { PicksOffer } from './Picks';
import { HaveChip, HaveSheet, InventoryButton, useInventory } from '../Inventory';
import { haveState, INVENTORY_SECTIONS, setInventoryTab } from '../../lib/inventory';
import { cleanSearch } from '../../lib/searchText';
import { serverMode } from '../../server-mode/flag';
import { isMoreTab, useNav } from '../nav';
import { isMadeSection, SECTION_NAMES, type Section, slots } from '../../shops';
import { confirmAction } from '../../lib/confirm';

type Filter = 'all' | 'sale' | 'low' | string; // string = category id; 0.13.1: 'low' = running low or out (inventory)
type Sort = 'sale' | 'az' | 'recent';
const SORTS: { id: Sort; label: string }[] = [
  { id: 'az', label: 'A–Z' },
  { id: 'sale', label: 'Deals first' },
  { id: 'recent', label: 'Recently added' },
];
// Deals first: the order Home uses, best saving at the top.
const DEAL_RANK: Record<string, number> = { buy: 0, alt: 1, small: 2, wait: 3, skip: 4, none: 5 };

function loadSort(): Sort {
  try {
    const v = localStorage.getItem('pantrySort');
    if (v === 'sale' || v === 'az' || v === 'recent') return v;
  } catch {
    // storage can be unavailable
  }
  // A to Z unless you picked another order (0.7.4).
  return 'az';
}

function seenSwipe(): boolean {
  try {
    return localStorage.getItem('seenSwipe') === '1';
  } catch {
    return true;
  }
}
function markSwiped() {
  try {
    localStorage.setItem('seenSwipe', '1');
  } catch {
    // ignore
  }
}

/** "Add to pantry", "Add to Bottle shop", "Add to Pets". */
const ADD_LABEL = (s: Section) => (s === 'pantry' ? 'Add to pantry' : `Add to ${SECTION_NAMES[s]}`);
/** 0.13.0: what a tab's own page changes. */
const TAB_EDIT_WORDS = (s: Section) => (s === 'pantry' ? 'its shops' : 'name, icon and shops');
const MADE_EMPTY = 'Nothing here yet. Add the things you buy, and Restock watches the shops you picked for this tab.';
const EMPTY: Record<Section, string> = {
  pantry: 'Your pantry is empty. Add the things you buy so Restock can watch their prices.',
  // 0.13.0: every tab you made says the same thing (Bottle shop, Chemist, Baby and Pets had words of their own, which a rename left behind)
  keg: MADE_EMPTY,
  pharmacy: MADE_EMPTY,
  baby: MADE_EMPTY,
  pets: MADE_EMPTY,
  ...slots(MADE_EMPTY),
};
const SEARCH_HINT: Record<Section, string> = {
  pantry: 'Search your pantry',
  keg: 'Search this tab',
  pharmacy: 'Search this tab',
  baby: 'Search this tab',
  pets: 'Search this tab',
  ...slots('Search this tab'),
};

/** The Pantry, Keg or Pharmacy tab: the things you buy from that kind of shop. */
export function PantryScreen({ section = 'pantry' }: { section?: Section }) {
  const nav = useNav();
  const allRecs = useLive(loadRecommendations, []);
  const allCats = useLive(allCategories, []);
  const recs = allRecs?.filter((r) => (r.group.section ?? 'pantry') === section);
  const categories = allCats?.filter((c) => c.section === section);
  const entries = useLive(allListEntries, []);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [editing, setEditing] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [categorySheet, setCategorySheet] = useState(false);
  const [sort, setSortState] = useState<Sort>(loadSort);
  const [filterSheet, setFilterSheet] = useState(false);
  const [preview, setPreview] = useState<Recommendation>();
  // 0.13.1: inventory, when it's on for this tab: each row's "Have" box, and "Low or out" among the filters
  const inv = useInventory();
  const invOn = inv.tabs.has(section);
  const [haveFor, setHaveFor] = useState<Recommendation>();
  const isLow = (r: Recommendation) => invOn && haveState(inv.have.get(r.group.id)) !== 'ok';
  // 0.17.0: after a while, asked once whether to keep track of what's at home (inventoryAsk.ts)
  const settingsNow = useSettings();
  const asking = useRef(false);
  useEffect(() => {
    if (section !== 'pantry' || asking.current || serverMode || !shouldAskInventory(settingsNow, recs?.length ?? 0, inv.tabs.size > 0)) return;
    asking.current = true;
    void (async () => {
      await inventoryAsked();
      const yes = await confirmAction('Keep track of what you have at home?', {
        detail: 'Inventory counts what you have of each thing, adds it as you tick it off while shopping, and tells you when you’re running low. You can turn it on or off any time in Settings → Inventory.',
        action: 'Turn it on',
        danger: false,
      });
      if (yes) {
        await setInventoryTab('pantry', true);
        nav.toast('Inventory is on for your pantry. Tap Inventory at the top to start.');
      }
    })();
  }, [section, settingsNow, recs?.length, inv.tabs.size]); // eslint-disable-line react-hooks/exhaustive-deps
  const adding = useRef(false);
  // read each time the Pantry is drawn (it stays behind the picks page, and must notice they were added)
  const [picksNo, setPicksNo] = useState(false);
  const picksOn = !picksNo && picksOffered();
  const setSort = (v: Sort) => {
    setSortState(v);
    try {
      localStorage.setItem('pantrySort', v);
    } catch {
      // ignore
    }
  };

  const full = useFullRefresh();
  if (!recs || !categories || !entries) return <div className="screen" />;

  const onList = new Map(entries.filter((e) => !e.checked && e.groupId).map((e) => [e.groupId!, e.id]));
  // The same deals Home counts ("wait" isn't a deal yet).
  const onSale = (r: Recommendation) => r.action === 'buy' || r.action === 'alt' || r.action === 'small';
  // 0.12.6: "Lemon." (voice typing) finds lemon.
  const typed = cleanSearch(q);
  const matches = (r: Recommendation) => !typed || r.group.name.toLowerCase().includes(typed.toLowerCase());
  const shown = recs.filter((r) => {
    if (!matches(r)) return false;
    if (filter === 'sale') return onSale(r);
    if (filter === 'low') return isLow(r);
    if (filter !== 'all') return r.group.categoryId === filter;
    return true;
  });
  const sorted = [...shown].sort((a, b) => {
    if (sort === 'az') return a.group.name.localeCompare(b.group.name);
    if (sort === 'recent') return b.group.createdAt.localeCompare(a.group.createdAt);
    return (DEAL_RANK[a.action] ?? 9) - (DEAL_RANK[b.action] ?? 9) || a.group.name.localeCompare(b.group.name);
  });

  // Recently added reads best as one list; the other sorts keep the category sections.
  const sections =
    sort === 'recent'
      ? [{ id: 'all', name: 'Newest first', items: sorted }]
      : [
          ...categories.map((c) => ({ id: c.id, name: c.name, items: sorted.filter((r) => r.group.categoryId === c.id) })),
          { id: 'none', name: 'Other', items: sorted.filter((r) => !r.group.categoryId || !categories.some((c) => c.id === r.group.categoryId)) },
        ].filter((s) => s.items.length);

  const toggleList = async (r: Recommendation) => {
    const existing = onList.get(r.group.id);
    if (existing) {
      await takeOffList([existing], r.group.name); // 0.9.5 (undo)
    } else {
      // Checks the list itself (not what's on screen), and one add at a time, so a double tap adds it once.
      if (adding.current) return;
      adding.current = true;
      try {
        const added = await addToList(r.group); // 0.9.5 (undo)
        if (!added) nav.toast('Already on your shopping list');
      } finally {
        adding.current = false;
      }
    }
  };

  const deleteOne = async (r: Recommendation) => {
    // Swiping is quick to do by accident, so it asks first (0.9.0).
    const ok = await confirmAction(`Delete ${r.group.name} from ${SECTION_NAMES[section]}?`, {
      detail: 'Its products and price history go too. You can undo it straight after.',
      action: 'Delete',
    });
    if (!ok) return;
    await act(`${r.group.name} deleted`, () => deleteGroup(r.group.id)); // 0.9.5 (undo)
    buzz();
  };

  const pick = (id: string) =>
    setPicked((p) => {
      const n = new Set(p);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const stopEditing = () => {
    setEditing(false);
    setPicked(new Set());
  };

  // Only what's ticked and still showing: a search can hide things ticked earlier.
  const selected = shown.filter((r) => picked.has(r.group.id));

  const addSelectedToList = async () => {
    if (adding.current) return;
    adding.current = true;
    let added = 0;
    try {
      added = await addAllToList(selected.map((r) => r.group)); // 0.9.5 (undo)
    } finally {
      adding.current = false;
    }
    if (!added) nav.toast('Already on your shopping list');
    stopEditing();
  };

  const deleteSelected = async () => {
    const n = selected.length;
    const ids = selected.map((r) => r.group.id);
    await act(`${n} item${n === 1 ? '' : 's'} deleted`, async () => {
      for (const id of ids) await deleteGroup(id);
    }); // 0.9.5 (undo)
    stopEditing();
  };

  // 0.11.2: the items in "Other" whose names fit one of your categories, and where each would go.
  const toSort = itemsToSort(recs, categories, section);
  const sortOther = async () => {
    const n = toSort.length;
    await act(`${n} item${n === 1 ? '' : 's'} sorted into categories`, async () => {
      for (const x of toSort) await updateGroup(x.r.group.id, { categoryId: x.to });
    });
  };

  const moveSelected = async (categoryId: string) => {
    const n = selected.length;
    await act(`Category changed for ${n} item${n === 1 ? '' : 's'}`, async () => {
      for (const r of selected) await updateGroup(r.group.id, { categoryId: categoryId || undefined });
    }); // 0.9.5 (undo)
    setCategorySheet(false);
    stopEditing();
  };

  return (
    <div className="screen" {...full.props}>
      {full.indicator}
      {/* 0.12.4: the navy top every screen has: the title, the add button and the search box */}
      <div className="navy-top">
      <div className="topbar">
        {/* 0.11.0: Bottle shop, Chemist and your own sections open from More, so they have a way back to it */}
        {isMoreTab(section) && (
          <button className="icon-btn" aria-label="Back" onClick={() => nav.setTab('more')}>
            <Icon name="back" size={20} />
          </button>
        )}
        <h1 style={isMoreTab(section) ? { fontSize: 24 } : undefined}>
          {SECTION_NAMES[section]}
          {/* 0.11.3: a custom tab says Beta at the top */}
          {isMadeSection(section) && <> <BetaTag /></>}
        </h1>
        {/* 0.13.0: every tab has Edit at the top right, with items or without (0.12.10 gave it to an
            empty tab you made; Pantry, Bottle shop and Chemist had none until something was in them).
            With nothing in the tab, Edit goes straight to the tab's own page: its shops, categories
            and, for a tab you made, its name, colour and icon. */}
        {/* 0.13.1: Inventory, beside Edit, whether it's on for this tab or not (off: its page says what it is, with Turn on) */}
        {/* (the two stay side by side: on a tab with a long name they move under it together) */}
        <span className="topbar-actions">
        {/* 0.17.0: only once it's on for this tab (Restock asks about it after a while: inventoryAsk.ts) */}
        {!editing && invOn && INVENTORY_SECTIONS.includes(section) && <InventoryButton section={section} onOpen={() => nav.push({ name: 'inventory', section })} />}
        {recs.length === 0 && (
          <button className="btn small edit-btn" aria-label={`Edit this tab: ${TAB_EDIT_WORDS(section)}`} onClick={() => nav.push({ name: 'stores', section })}>
            <Icon name="pencil" size={16} /> Edit
          </button>
        )}
        {recs.length > 0 && (
          editing ? (
            <button className="btn small primary" onClick={stopEditing}>
              Done
            </button>
          ) : (
            // 0.10.10: Edit says Edit, as on an item's page (it was a bare pencil here)
            <button className="btn small edit-btn" aria-label="Edit: pick items to move or delete" onClick={() => setEditing(true)}>
              <Icon name="pencil" size={16} /> Edit
            </button>
          )
        )}
        </span>
      </div>
      {/* 0.11.3: Edit also opens this tab's categories (add, rename, reorder, delete) */}
      {editing && (
        <button className="btn small block edit-cats" onClick={() => nav.push({ name: 'categories', section })}>
          <Icon name="pencil" size={16} /> Edit categories
        </button>
      )}
      {editing && (
        <button className="btn small block edit-cats" onClick={() => nav.push({ name: 'stores', section })}>
          <Icon name="pencil" size={16} /> Edit this tab: {TAB_EDIT_WORDS(section)}
        </button>
      )}
      {/* 0.12.0: this tab's one add button, with the barcode beside it (it was a small + at the top and a tab in the bar) */}
      {!editing && (
        <BigAdd
          label={ADD_LABEL(section)}
          onAdd={() => nav.push({ name: 'add', section, toPantry: true })}
          onScan={serverMode ? undefined : () => nav.push({ name: 'add', section, toPantry: true, scan: true })}
        />
      )}
      {/* The web page: said before the tap, not after it (phone-only parts say where they work). */}
      {!editing && serverMode && (
        <p className="small" style={{ margin: 0 }}>
          Adding by shop search is done on a phone. Here you can look up a barcode among your household's products.
        </p>
      )}
      {recs.length > 0 && <SearchField placeholder={SEARCH_HINT[section]} aria-label={SEARCH_HINT[section]} value={q} onValue={setQ} />}
      </div>
      {recs.length > 0 && (
        <div className="chips" role="group" aria-label="Filter and sort">
          <button className="chip" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>
            All {recs.length}
          </button>
          <button className="chip" aria-pressed={filter === 'sale'} onClick={() => setFilter('sale')}>
            On special {recs.filter(onSale).length}
          </button>
          {(recs.some(isLow) || filter === 'low') && (
            <button className="chip" aria-pressed={filter === 'low'} onClick={() => setFilter('low')}>
              Low or out {recs.filter(isLow).length}
            </button>
          )}
          <button className="chip" aria-pressed={filter !== 'all' && filter !== 'sale' && filter !== 'low'} onClick={() => setFilterSheet(true)}>
            {categories.find((c) => c.id === filter)?.name ?? 'Category'}{' '}
            <span className="turn-down"><Icon name="chevron" size={12} /></span>
          </button>
        </div>
      )}
      {recs.length > 0 && !editing && !seenSwipe() && (
        <p className="small" style={{ margin: 0 }}>
          {/* 0.10.8: with No swiping on, the tip doesn't talk about swiping */}
          {cachedSettings()?.a11y?.noSwipe
            ? 'Tip: tap the cart to add an item to your list. Press and hold it for details.'
            : 'Tip: swipe right to add an item to your list, left to delete it. Press and hold it for details.'}
        </p>
      )}

      {!recs.length && (
        <div className="empty">
          <p>{EMPTY[section]}</p>
        </div>
      )}
      {/* 0.12.6: nothing found: say so, and offer the next step with what was typed carried over */}
      {recs.length > 0 &&
        !shown.length &&
        (typed && filter !== 'all' && recs.some(matches) ? (
          <div className="none-found" role="status">
            <p className="small">
              Nothing in this filter matches "{typed}", but something else in {section === 'pantry' ? 'your pantry' : SECTION_NAMES[section]} does.
            </p>
            <button className="btn block" onClick={() => setFilter('all')}>
              Show all
            </button>
          </div>
        ) : typed && !editing ? (
          <NoneFound
            text={`"${typed}" isn't in ${section === 'pantry' ? 'your pantry' : SECTION_NAMES[section]} yet.`}
            label={serverMode ? undefined : `Add ${typed} to ${section === 'pantry' ? 'pantry' : SECTION_NAMES[section]}`}
            onAdd={serverMode ? undefined : () => nav.push({ name: 'add', section, toPantry: true, query: typed })}
            phoneOnly={serverMode ? 'Adding by shop search is done on a phone.' : undefined}
          />
        ) : (
          <p className="small" role="status">
            Nothing matches.
          </p>
        ))}

      {sections.map((s) => (
        <section key={s.id} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div className="eyebrow">{s.name}</div>
          {s.id === 'none' && !editing && toSort.length >= 3 && (
            <div className="banner grey sort-other">
              <span>
                <strong>
                  {toSort.length} of these fit a category
                </strong>{' '}
                ({sortTargets(toSort, categories)}). You can move any of them
                afterwards with Edit.
              </span>
              <button className="btn small" onClick={() => void sortOther()}>
                Sort them into categories
              </button>
            </div>
          )}
          <div className="card flush">
            {s.items.map((r) => {
              const isPicked = picked.has(r.group.id);
              const listed = onList.has(r.group.id);
              return (
                <Hold key={r.group.id} onLong={() => !editing && setPreview(r)}>
                  <SwipeRow
                    disabled={editing}
                    className={`row irow-swipe${isPicked ? ' selected' : ''}`}
                    rightLabel={listed ? 'On your list' : 'Add to list'}
                    leftLabel="Delete"
                    onRight={() => {
                      markSwiped();
                      if (!listed) void toggleList(r);
                      else nav.toast(`${r.group.name} is already on your shopping list`);
                    }}
                    onLeft={() => {
                      markSwiped();
                      void deleteOne(r);
                    }}
                  >
                    {/* 0.12.0: the photo, the shop, one price and a word; the "i" has the rest (lib ../simple) */}
                    <RecRow
                      rec={r}
                      listed={onList.get(r.group.id)}
                      entry={entries.find((e) => !e.checked && e.groupId === r.group.id)}
                      hideActions={editing}
                      extra={invOn && !editing ? <HaveChip name={r.group.name} have={inv.have.get(r.group.id)} onEdit={() => setHaveFor(r)} /> : undefined}
                      openLabel={editing ? `Select ${r.group.name}` : r.group.name}
                      onOpen={editing ? () => pick(r.group.id) : undefined}
                      lead={
                        editing ? (
                          <span className={`pick${isPicked ? ' on' : ''}`} aria-hidden>
                            {isPicked && <Icon name="check" size={16} />}
                          </span>
                        ) : undefined
                      }
                    />
                  </SwipeRow>
                </Hold>
              );
            })}
          </div>
        </section>
      ))}

      {/* 0.11.0: how many items there are (before, ticking them all in Edit was the only way to count) */}
      {recs.length > 0 && (
        <p className="small pantry-count" role="status">
          {shown.length === recs.length
            ? `${recs.length.toLocaleString('en-AU')} item${recs.length === 1 ? '' : 's'}`
            : `Showing ${shown.length.toLocaleString('en-AU')} of ${recs.length.toLocaleString('en-AU')} item${recs.length === 1 ? '' : 's'}`}
        </p>
      )}

      {/* 0.13.0: a head start, offered at the bottom of the Pantry until it's used or turned down */}
      {section === 'pantry' && !editing && !serverMode && picksOn && <PicksOffer onNo={() => setPicksNo(true)} />}

      {editing && (
        <SelectBar
          count={selected.length}
          total={shown.length}
          onAll={() => setPicked(new Set(shown.map((r) => r.group.id)))}
          onNone={() => setPicked(new Set())}
        >
          <button className="btn small" disabled={!selected.length} onClick={addSelectedToList}>
            <Icon name="cartPlus" size={18} /> Shopping list
          </button>
          <button className="btn small" disabled={!selected.length} onClick={() => setCategorySheet(true)}>
            Category
          </button>
          <button className="btn small danger" disabled={!selected.length} onClick={deleteSelected}>
            <Icon name="trash" size={18} /> Delete
          </button>
        </SelectBar>
      )}

      {preview && (preview.best ?? preview.options[0]) && (
        <ProductPreview
          product={previewFromOption((preview.action === 'alt' ? preview.alt : preview.best) ?? preview.best ?? preview.options[0])}
          onClose={() => setPreview(undefined)}
          action={
            <button
              className="btn primary"
              onClick={() => {
                const id = preview.group.id;
                setPreview(undefined);
                nav.push({ name: 'item', groupId: id });
              }}
            >
              Open {preview.group.name}
            </button>
          }
        />
      )}

      {haveFor && <HaveSheet group={haveFor.group} have={inv.have.get(haveFor.group.id)} inv={inv} usualProductId={haveFor.group.usualProductId} onClose={() => setHaveFor(undefined)} />}

      {filterSheet && (
        <Sheet title="Sort and filter" onClose={() => setFilterSheet(false)}>
          <div className="field">
            <span>Sort by</span>
            <div className="seg" role="group" aria-label="Sort by">
              {SORTS.map((x) => (
                <button key={x.id} aria-pressed={sort === x.id} onClick={() => setSort(x.id)}>
                  {x.label}
                </button>
              ))}
            </div>
          </div>
          <div className="field">
            <span>Show</span>
            <div className="card flush">
              {[{ id: 'all', name: 'Everything' }, { id: 'sale', name: 'Deals only' }, ...categories].map((c) => (
                <button
                  key={c.id}
                  className="row"
                  onClick={() => {
                    setFilter(c.id);
                    setFilterSheet(false);
                  }}
                >
                  <span className="grow title">{c.name}</span>
                  {filter === c.id && <Icon name="check" size={18} />}
                </button>
              ))}
            </div>
          </div>
          <button
            className="btn small"
            onClick={() => {
              setFilterSheet(false);
              nav.push({ name: 'categories', section });
            }}
          >
            <Icon name="pencil" size={16} /> Edit categories
          </button>
        </Sheet>
      )}

      {categorySheet && (
        <Sheet title={`Move ${selected.length} to…`} onClose={() => setCategorySheet(false)}>
          <div className="card flush">
            {categories.map((c) => (
              <button key={c.id} className="row" onClick={() => moveSelected(c.id)}>
                <span className="grow title">{c.name}</span>
              </button>
            ))}
            <button className="row" onClick={() => moveSelected('')}>
              <span className="grow title">No category</span>
            </button>
          </div>
          <button
            className="btn small"
            onClick={() => {
              setCategorySheet(false);
              nav.push({ name: 'categories', section });
            }}
          >
            <Icon name="plus" size={16} /> New category
          </button>
        </Sheet>
      )}
    </div>
  );
}

