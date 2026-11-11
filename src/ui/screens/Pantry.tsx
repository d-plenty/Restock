import { useFullRefresh } from '../refresh';
import { useRef, useState } from 'react';
import { allCategories, allListEntries, deleteGroup, updateGroup } from '../../lib/db';
import { addAllToList, addToList, buzz, takeOffList } from '../../lib/listActions';
import { act } from '../../lib/undo'; // 0.9.5 (undo)
import { loadRecommendations } from '../../lib/recs';
import { money } from '../../lib/units';
import { useLive } from '../../lib/useLive';
import { bothPrices, tiedWithBest, type Recommendation } from '../../lib/verdict';
import { chainName, LEARNING_DAYS } from '../../types';
import { Hold, Icon, MoreInfo, stockWhere, previewFromOption, ProductPreview, SelectBar, Sheet, SwipeRow, Thumb } from '../components';
import { ActionInfoTag } from '../tagInfo';
import { useNav } from '../nav';
import { SECTION_NAMES, type Section } from '../../shops';
import { confirmAction } from '../../lib/confirm';

type Filter = 'all' | 'sale' | string; // string = category id
type Sort = 'sale' | 'az' | 'recent';
const SORTS: { id: Sort; label: string }[] = [
  { id: 'az', label: 'A to Z' },
  { id: 'sale', label: 'Deals first' },
  { id: 'recent', label: 'Recently added' },
];
// Deals first: the order Home uses, best saving at the top.
export const DEAL_RANK: Record<string, number> = { buy: 0, alt: 1, small: 2, wait: 3, skip: 4, none: 5 };

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

const EMPTY: Record<Section, string> = {
  pantry: 'Your pantry is empty. Add the things you buy so Restock can watch their prices.',
  keg: 'Nothing in the keg yet. Add the beer, wine or spirits you buy, and Restock watches the bottle shops you picked.',
  pharmacy: 'Nothing here yet. Add the medicine, first aid and personal care things you buy, and Restock watches the chemists you picked.',
};
const SEARCH_HINT: Record<Section, string> = { pantry: 'Search your pantry', keg: 'Search your keg', pharmacy: 'Search your health items' };

/** At or under the item's "alert me under $X" price at its cheapest shop. */
export const underTarget = (r: Recommendation) =>
  r.group.targetPrice !== undefined && r.best?.price !== undefined && r.best.price <= r.group.targetPrice + 0.004 && !r.best.verdict.stale;

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
  const adding = useRef(false);
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
  const shown = recs.filter((r) => {
    if (q && !r.group.name.toLowerCase().includes(q.toLowerCase())) return false;
    if (filter === 'sale') return onSale(r);
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
      {full.status}
      <div className="topbar">
        <h1>{SECTION_NAMES[section]}</h1>
        {recs.length > 0 && (
          editing ? (
            <button className="btn small primary" onClick={stopEditing}>
              Done
            </button>
          ) : (
            <button className="icon-btn" aria-label="Edit" onClick={() => setEditing(true)}>
              <Icon name="pencil" size={18} />
            </button>
          )
        )}
        {!editing && (
          <button className="icon-btn" aria-label="Add an item" onClick={() => nav.setTab('add')}>
            <Icon name="plus" size={20} />
          </button>
        )}
      </div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, position: 'relative' }}>
        <span style={{ position: 'absolute', left: 14, color: 'var(--muted)', display: 'flex' }}>
          <Icon name="search" size={18} />
        </span>
        <input
          className="input"
          type="search"
          placeholder={SEARCH_HINT[section]}
          aria-label={SEARCH_HINT[section]}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          style={{ paddingLeft: 40 }}
        />
      </label>
      {recs.length > 0 && (
        <div className="chips" role="group" aria-label="Filter and sort">
          <button className="chip" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>
            All {recs.length}
          </button>
          <button className="chip" aria-pressed={filter === 'sale'} onClick={() => setFilter('sale')}>
            Deals {recs.filter(onSale).length}
          </button>
          <button className="chip" aria-pressed={filter !== 'all' && filter !== 'sale'} onClick={() => setFilterSheet(true)}>
            {categories.find((c) => c.id === filter)?.name ?? 'Category'} ▾
          </button>
          <button className="chip" onClick={() => setFilterSheet(true)} aria-label={`Sort: ${SORTS.find((x) => x.id === sort)?.label}`}>
            <Icon name="sliders" size={14} /> {SORTS.find((x) => x.id === sort)?.label}
          </button>
        </div>
      )}
      {recs.length > 0 && !editing && !seenSwipe() && (
        <p className="small" style={{ margin: 0 }}>
          Tip: swipe an item right to add it to your shopping list, left to delete it, or press and hold it for a bigger look and product details.
        </p>
      )}

      {!recs.length && (
        <div className="empty">
          <p>{EMPTY[section]}</p>
          <button className="btn primary" onClick={() => nav.setTab('add')}>
            <Icon name="plus" size={18} /> Add an item
          </button>
        </div>
      )}
      {recs.length > 0 && !shown.length && <p className="small">Nothing matches.</p>}

      {sections.map((s) => (
        <section key={s.id} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div className="eyebrow">{s.name}</div>
          <div className="card flush">
            {s.items.map((r) => {
              const mains = r.options.filter((o) => o.role === 'main');
              const altCount = r.group.altProductIds.length;
              const isPicked = picked.has(r.group.id);
              const listed = onList.has(r.group.id);
              const detail = [
                r.outOfStock && r.best
                  ? `Out of stock ${stockWhere(r.best.product.chain, true)}`
                  : r.best?.price !== undefined && mains.length > 1 && tiedWithBest(r).length + 1 >= mains.length
                    ? 'Same price everywhere'
                    : r.best?.price !== undefined
                      ? `Cheapest: ${chainName(r.best.product.chain)}`
                      : 'No price yet',
                mains.length > 1 ? `${mains.length} shops` : '',
                mains.length &&
                mains.every((o) => !/\(sample\)/i.test(o.product.name)) &&
                Math.max(...mains.map((o) => o.stats.spanDays)) < LEARNING_DAYS
                  ? 'still learning prices'
                  : '',
                altCount ? `${altCount} would also take` : '',
              ]
                .filter(Boolean)
                .join(' · ');
              return (
                <Hold key={r.group.id} onLong={() => !editing && setPreview(r)}>
                  <SwipeRow
                    disabled={editing}
                    className={`row${isPicked ? ' selected' : ''}`}
                    style={{ paddingRight: 8 }}
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
                    {!editing && <MoreInfo src={(r.best ?? mains[0])?.product.imageUrl} name={r.group.name} onOpen={() => setPreview(r)} />}
                    <button
                      className="row-main"
                      onClick={() => (editing ? pick(r.group.id) : nav.push({ name: 'item', groupId: r.group.id }))}
                      aria-pressed={editing ? isPicked : undefined}
                      aria-label={editing ? `Select ${r.group.name}` : undefined}
                    >
                      {editing && (
                        <span className={`pick${isPicked ? ' on' : ''}`} aria-hidden>
                          {isPicked && <Icon name="check" size={16} />}
                        </span>
                      )}
                      {editing && <Thumb src={(r.best ?? mains[0])?.product.imageUrl} />}
                      <span className="grow">
                        <span className="title clip">{r.group.name}</span>
                        <span className="small clip">{detail}</span>
                        {/* 0.9.6: both prices: per item, then the comparison price (per litre, per 100 g). */}
                        {bothPrices(r.action === 'alt' ? r.alt : r.best) && (
                          <span className="small clip num">{bothPrices(r.action === 'alt' ? r.alt : r.best)}</span>
                        )}
                        {(r.action !== 'none' || underTarget(r)) && (
                          <span className="tags" style={{ marginTop: 3 }}>
                            {r.action !== 'none' && <ActionInfoTag rec={r} action={r.action} great={r.best?.verdict.kind === 'great'} />}
                            {underTarget(r) && <span className="tag good">UNDER {money(r.group.targetPrice)}</span>}
                          </span>
                        )}
                      </span>
                      <span className="num small" style={{ fontWeight: 600 }}>
                        {money((r.action === 'alt' ? r.alt : r.best)?.price)}
                      </span>
                    </button>
                    {!editing && (
                      <button
                        className={`cart-btn${listed ? ' on' : ''}`}
                        aria-label={listed ? `${r.group.name} is on your shopping list. Tap to take it off` : `Add ${r.group.name} to shopping list`}
                        aria-pressed={listed}
                        onClick={() => toggleList(r)}
                      >
                        <Icon name={listed ? 'cartCheck' : 'cartPlus'} size={22} />
                      </button>
                    )}
                  </SwipeRow>
                </Hold>
              );
            })}
          </div>
        </section>
      ))}

      {editing && (
        <SelectBar
          count={selected.length}
          total={shown.length}
          onAll={() => setPicked(new Set(shown.map((r) => r.group.id)))}
          onNone={() => setPicked(new Set())}
          onDone={stopEditing}
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
        </Sheet>
      )}
    </div>
  );
}
