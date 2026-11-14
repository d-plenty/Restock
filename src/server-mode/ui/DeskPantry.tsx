// 0.9.3: Pantry, Keg and Pharmacy at desktop widths: a table with category filters and search, and
// the item picked in a side panel (its price history, Shop around, its alert, Add to list and Edit).
// The same recommendations and filters as the phone's tab (Pantry.tsx) and item page (Item.tsx).
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  allCategories,
  allListEntries,
  cardChains,
  getSettings,
  groupProductIds,
  readingsFor,
  updateGroup,
} from '../../lib/db';
import { addToList, takeOffList } from '../../lib/listActions'; // 0.9.5 (undo)
import { act } from '../../lib/undo'; // 0.9.5 (undo)
import { loadRecommendations } from '../../lib/recs';
import { money, parseMoney, tidySize } from '../../lib/units';
import { productLine, sizeLabel, type CompareStyle } from '../../lib/unitPrice';
import { useLive } from '../../lib/useLive';
import { ALERT_LEVELS, bothPrices, computeStats, HISTORY_DAYS, multiBuy, optionStyle, tiedWithBest, withMarket, type Option, type Recommendation } from '../../lib/verdict';
import { SECTION_NAMES, type Section, slots } from '../../shops';
import { chainName, type AlertLevel } from '../../types';
import { BETA_NOTE, BETA_SECTIONS, ChainName, Icon, PriceChart, Thumb, SearchField } from '../../ui/components';
import { useNav } from '../../ui/nav';
import { EditSheet, LastUpdated, PriceSheet } from '../../ui/screens/Item';
import { DEAL_RANK, underTarget } from '../../ui/screens/Pantry';
import { ActionInfoTag } from '../../ui/tagInfo';
import { PhoneOnlyNote } from './PhoneOnly';
import { DeskHead, firstPhoto, ItemPhoto, takeOpenItem } from './deskShared';
import { serverHistory } from '../live';
import type { PriceReading } from '../../types';

type Filter = 'all' | 'sale' | string;
type Sort = 'az' | 'sale' | 'recent';
const SORTS: { id: Sort; label: string }[] = [
  { id: 'az', label: 'A to Z' },
  { id: 'sale', label: 'Deals first' },
  { id: 'recent', label: 'Recently added' },
];
const SEARCH_HINT: Record<Section, string> = {
  pantry: 'Search the pantry',
  keg: 'Search the keg',
  pharmacy: 'Search your pharmacy items',
  baby: 'Search your baby things',
  pets: 'Search your pet things',
  ...slots('Search this tab'),
};
const EMPTY: Record<Section, string> = {
  pantry: 'Your pantry is empty. Add the things you buy on a phone, and Restock watches their prices.',
  keg: 'Nothing in the keg yet. Add the beer, wine or spirits you buy on a phone.',
  pharmacy: 'Nothing here yet. Add the medicine, first aid and personal care things you buy on a phone.',
  baby: 'Nothing here yet. Add the nappies, wipes and baby things you buy on a phone.',
  pets: 'Nothing here yet. Add the pet food, litter and treats you buy on a phone.',
  ...slots('Nothing here yet. Add the things you buy on a phone.'),
};
/** The same deals the phone's Pantry counts ("wait" isn't a deal yet). */
const onSale = (r: Recommendation) => r.action === 'buy' || r.action === 'alt' || r.action === 'small';
/** The weeks of history the chart shows: about three months, like the phone's "3 mths". */
const CHART_WEEKS = 13;

/** An item's photo: the deal shown, then your pick, the best, any other with one. */
export function recPhoto(r: Pick<Recommendation, 'options' | 'best' | 'group'>, deal?: Option): string | undefined {
  const usual = r.options.find((o) => o.product.id === r.group.usualProductId);
  return firstPhoto(deal?.product, usual?.product, r.best?.product, ...r.options.map((o) => o.product));
}

function alertText(r: Recommendation): string {
  if (r.group.targetPrice !== undefined) return `Under ${money(r.group.targetPrice)}`;
  if (r.group.alertLevel === 'never') return 'Off';
  if (r.group.alertLevel === 'custom') return `${r.group.alertPct ?? 30}% off`;
  // "Good sale (15%+)" → "Good sale": the table's column is narrow; the panel has the whole choice.
  return (ALERT_LEVELS.find((a) => a.id === r.group.alertLevel)?.label ?? '').replace(/\s*\(.*\)$/, '');
}

export function DeskPantry({ section }: { section: Section }) {
  const nav = useNav();
  const allRecs = useLive(loadRecommendations, []);
  const allCats = useLive(allCategories, []);
  const entries = useLive(allListEntries, []);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [sort, setSort] = useState<Sort>('az');
  const [open, setOpen] = useState<string | undefined>(takeOpenItem);
  const recs = useMemo(() => allRecs?.filter((r) => (r.group.section ?? 'pantry') === section), [allRecs, section]);
  if (!recs || !allCats || !entries) return <div className="dk-page" aria-busy="true" />;
  const categories = allCats.filter((c) => c.section === section);
  const catName = new Map(categories.map((c) => [c.id, c.name]));
  const onList = new Map(entries.filter((e) => !e.checked && e.groupId).map((e) => [e.groupId!, e.id]));

  const shown = recs
    .filter((r) => {
      if (q && !`${r.group.name} ${r.options.map((o) => o.product.name).join(' ')}`.toLowerCase().includes(q.toLowerCase())) return false;
      if (filter === 'sale') return onSale(r);
      if (filter !== 'all') return r.group.categoryId === filter;
      return true;
    })
    .sort((a, b) => {
      if (sort === 'az') return a.group.name.localeCompare(b.group.name);
      if (sort === 'recent') return b.group.createdAt.localeCompare(a.group.createdAt);
      return (DEAL_RANK[a.action] ?? 9) - (DEAL_RANK[b.action] ?? 9) || a.group.name.localeCompare(b.group.name);
    });
  const usedCats = categories.filter((c) => recs.some((r) => r.group.categoryId === c.id));

  return (
    <div className="dk-page">
      <div className={`dk-with-panel${open ? ' has-panel' : ''}`}>
        <section className="dk-wide" aria-label={SECTION_NAMES[section]}>
          {/* 0.10.0: Keg and Health are beta (components.tsx BETA_NOTE). */}
          <DeskHead title={SECTION_NAMES[section]} sub={`${recs.length} item${recs.length === 1 ? '' : 's'}${BETA_SECTIONS.includes(section) ? ' · Beta' : ''}`}>
            <div className="dk-search">
              <label htmlFor="dk-pq" className="sr-only">
                {SEARCH_HINT[section]}
              </label>
              <SearchField id="dk-pq" placeholder={SEARCH_HINT[section]} value={q} onValue={setQ} />
            </div>
          </DeskHead>
          {BETA_SECTIONS.includes(section) && <p className="small" style={{ margin: '0 0 12px' }}>{BETA_NOTE}</p>}
          {recs.length > 0 && (
            <div className="dk-toolbar">
              <div className="dk-chips" role="group" aria-label="Show">
                <button className="chip" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>
                  All {recs.length}
                </button>
                {usedCats.map((c) => (
                  <button key={c.id} className="chip" aria-pressed={filter === c.id} onClick={() => setFilter(c.id)}>
                    {c.name}
                  </button>
                ))}
                <button className="chip" aria-pressed={filter === 'sale'} onClick={() => setFilter('sale')}>
                  On special {recs.filter(onSale).length}
                </button>
              </div>
              <label className="dk-sort">
                <span className="small">Sort</span>
                <select className="input" value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
                  {SORTS.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}
          {!recs.length && (
            <div className="card">
              <p className="small">{EMPTY[section]}</p>
            </div>
          )}
          {recs.length > 0 && !shown.length && <p className="small">Nothing matches.</p>}
          {shown.length > 0 && (
            <div className="dk-table-wrap">
              <table className="dk-table dk-pick">
                <thead>
                  <tr>
                    <th scope="col">Item</th>
                    <th scope="col">Best now</th>
                    <th scope="col" className="dk-extra">
                      Usually
                    </th>
                    <th scope="col">Verdict</th>
                    <th scope="col" className="dk-extra">
                      Alert
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((r) => {
                    const deal = r.action === 'alt' ? r.alt : r.best;
                    const mains = r.options.filter((o) => o.role === 'main');
                    const size = deal?.product.sizing?.size ? sizeLabel(deal.product) : deal?.product.size ? tidySize(deal.product.size, deal.product.name) : undefined;
                    const isOpen = open === r.group.id;
                    return (
                      <tr key={r.group.id} className={isOpen ? 'on' : undefined} onClick={() => setOpen(r.group.id)}>
                        <td className="dk-item-cell">
                          <Thumb src={recPhoto(r, deal)} />
                          <span className="dk-item-words">
                          <button
                            className="dk-name"
                            aria-expanded={isOpen}
                            aria-controls="dk-item-panel"
                            onClick={(e) => {
                              e.stopPropagation();
                              setOpen(isOpen ? undefined : r.group.id);
                            }}
                          >
                            {r.group.name}
                          </button>
                          <span className="dk-sub clip">
                            {[size, r.group.categoryId ? catName.get(r.group.categoryId) : undefined, onList.has(r.group.id) ? 'on the list' : undefined]
                              .filter(Boolean)
                              .join(' · ')}
                          </span>
                          </span>
                        </td>
                        <td className="num dk-nowrap">
                          {deal?.price !== undefined ? (
                            <>
                              <strong>{money(deal.price)}</strong>
                              {/* 0.9.6: both prices, as on the phone: per item, then per litre or per 100 g. */}
                              {bothPrices(deal) && <span className="dk-sub">{bothPrices(deal)}</span>}
                              <span className="dk-sub">
                                {mains.length > 1 && r.action !== 'alt' && tiedWithBest(r).length + 1 >= mains.length ? 'same everywhere' : chainName(deal.product.chain)}
                              </span>
                            </>
                          ) : (
                            <span className="dk-sub-inline">No price yet</span>
                          )}
                        </td>
                        <td className="num dk-extra">{money(r.best?.stats.typical)}</td>
                        <td className="dk-tags">
                          {r.action !== 'none' ? (
                            <ActionInfoTag rec={r} action={r.action} great={r.best?.verdict.kind === 'great'} />
                          ) : (
                            <span className="tag normal">{r.best?.price === undefined ? 'NO PRICE YET' : 'USUAL PRICE'}</span>
                          )}
                          {underTarget(r) && <span className="tag good">UNDER {money(r.group.targetPrice)}</span>}
                        </td>
                        <td className={`dk-nowrap dk-extra${r.group.targetPrice === undefined && r.group.alertLevel === 'never' ? ' dk-muted' : ''}`}>{alertText(r)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className="small">Adding items and checking prices happen on your phones. Everything else about an item can be changed here.</p>
        </section>
        {open && <ItemPanel key={open} groupId={open} listed={onList.get(open)} onClose={() => setOpen(undefined)} nav={nav} />}
      </div>
    </div>
  );
}

/** The item picked in the table: its price history, Shop around, alert, Add to list and Edit. */
function ItemPanel({ groupId, listed, onClose, nav }: { groupId: string; listed?: string; onClose: () => void; nav: ReturnType<typeof useNav> }) {
  const data = useLive(async () => {
    const rec = (await loadRecommendations()).find((r) => r.group.id === groupId);
    if (!rec) return null;
    const [readings, categories, cards, settings] = await Promise.all([readingsFor(groupProductIds(rec.group)), allCategories(), cardChains(), getSettings()]);
    return { rec, readings, categories: categories.filter((c) => c.section === (rec.group.section ?? 'pantry')), cards, settings };
  }, [groupId]);
  const [picked, setPicked] = useState<string>();
  // 0.9.4, a house: the server keeps the older prices (phones and this browser only keep weeks).
  const [older, setOlder] = useState<Map<string, PriceReading[]>>(new Map());
  const [editing, setEditing] = useState(false);
  const [pricing, setPricing] = useState(false);
  const [target, setTarget] = useState<string>();
  const adding = useRef(false);
  const head = useRef<HTMLHeadingElement>(null);
  // Focus (and, where the panel sits under the table, scroll) to the item opened.
  useEffect(() => head.current?.focus(), [groupId, data === undefined]);
  const chartId = data ? (data.rec.options.find((o) => o.product.id === picked) ?? data.rec.best ?? data.rec.options[0])?.product.id : undefined;
  useEffect(() => {
    if (!chartId || older.has(chartId)) return;
    let live = true;
    void serverHistory(chartId, new Date(Date.now() - CHART_WEEKS * 7 * 86_400_000).toISOString()).then((rows) => live && setOlder((m) => new Map(m).set(chartId, rows)));
    return () => {
      live = false;
    };
  }, [chartId, older]);

  if (data === undefined) return <aside className="dk-panel" id="dk-item-panel" aria-busy="true" />;
  if (data === null)
    return (
      <aside className="dk-panel" id="dk-item-panel" aria-label="Item removed">
        <div className="dk-panel-head">
          <h2 ref={head} tabIndex={-1}>
            Item removed
          </h2>
          <button className="icon-btn" aria-label="Close" onClick={onClose}>
            <Icon name="close" size={20} />
          </button>
        </div>
      </aside>
    );

  const { rec, readings, categories, cards } = data;
  const group = rec.group;
  const mains = rec.options.filter((o) => o.role === 'main');
  const chartOpt = rec.options.find((o) => o.product.id === picked) ?? rec.best ?? mains[0] ?? rec.options[0];
  // The chart: the last three months, a multi-buy week at its price each (as the item page draws it).
  const from = Date.now() - CHART_WEEKS * 7 * 86_400_000;
  const local = chartOpt ? (readings.get(chartOpt.product.id) ?? []) : [];
  // The server's history and this browser's, once per day and price (the browser's copy wins).
  const seen = new Set(local.map((r) => `${r.date.slice(0, 16)}|${r.price}`));
  const fromServer = chartOpt ? (older.get(chartOpt.product.id) ?? []).filter((r) => !seen.has(`${r.date.slice(0, 16)}|${r.price}`)) : [];
  const all = fromServer.length ? [...local, ...fromServer].sort((a, b) => a.date.localeCompare(b.date)) : local;
  const shownReadings = all
    .filter((r) => Date.parse(r.date) >= from)
    .map((r) => {
      if (group.allowMulti === false) return r;
      const mb = multiBuy(r.promo);
      return mb && mb.total / mb.n < r.price - 0.004 ? { ...r, price: Math.round((mb.total / mb.n) * 100) / 100, isSpecial: true } : r;
    });
  const stats = chartOpt
    ? withMarket(computeStats(shownReadings, Date.now(), cards.has(chartOpt.product.chain), Math.max(HISTORY_DAYS, CHART_WEEKS * 7 + 1)), chartOpt.product.market)
    : undefined;
  // Shop around: your picks at each shop, cheapest first (the ones with no price last).
  const around = [...mains].sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity));
  const size = chartOpt?.product.sizing?.size ? sizeLabel(chartOpt.product) : chartOpt?.product.size ? tidySize(chartOpt.product.size, chartOpt.product.name) : undefined;
  const usual = rec.options.find((o) => o.product.id === group.usualProductId);
  const alts = rec.options.filter((o) => o.role === 'alt');
  const sub = [size, usual ? `My pick: ${usual.product.name}` : undefined, alts.length ? `Would also take ${alts.length} other${alts.length === 1 ? '' : 's'}` : undefined]
    .filter(Boolean)
    .join(' · ');

  const toggleList = async () => {
    if (listed) {
      await takeOffList([listed], group.name); // 0.9.5 (undo)
      return;
    }
    if (adding.current) return;
    adding.current = true;
    try {
      const added = await addToList(group); // 0.9.5 (undo)
      if (!added) nav.toast('Already on your shopping list');
    } finally {
      adding.current = false;
    }
  };
  const saveTarget = async () => {
    if (target === undefined) return;
    const t = target.trim() ? parseMoney(target) : undefined;
    if (target.trim() && (t === undefined || !(t > 0))) return nav.toast('Type a price, like 4.80');
    const next = t !== undefined ? Math.round(t * 100) / 100 : undefined;
    setTarget(undefined);
    if (next === group.targetPrice) return;
    // 0.9.5 (undo)
    await act(next !== undefined ? `We'll say when ${group.name} is ${money(next)} or less` : `Price alert cleared for ${group.name}`, () =>
      updateGroup(group.id, { targetPrice: next }),
    );
  };
  const setLevel = async (level: AlertLevel) => {
    // 0.9.5 (undo)
    await act(`Alerts changed for ${group.name}`, () =>
      updateGroup(group.id, { alertLevel: level, alertPct: level === 'custom' ? (group.alertPct ?? 30) : undefined }),
    );
  };

  return (
    <aside className="dk-panel" id="dk-item-panel" aria-label={group.name}>
      {/* 0.9.5: the item's big photo first, above its name (the letter if there's none). */}
      <ItemPhoto src={recPhoto(rec)} name={group.name} />
      <div className="dk-panel-head">
        <div className="grow">
          <h2 ref={head} tabIndex={-1}>
            {group.name}
          </h2>
          {sub && <span className="dk-sub">{sub}</span>}
        </div>
        <button className="icon-btn" aria-label={`Close ${group.name}`} onClick={onClose}>
          <Icon name="close" size={20} />
        </button>
      </div>

      <div className={`banner ${rec.action === 'buy' || rec.action === 'small' ? 'green' : rec.action === 'alt' ? 'blue' : rec.action === 'wait' ? 'amber' : rec.action === 'skip' ? 'red' : 'grey'} dk-verdict`}>
        <strong>{rec.headline}</strong>
        {rec.detail && <span className="small-ink">{rec.detail}</span>}
      </div>

      <div className="dk-panel-actions">
        <button className={`btn${listed ? '' : ' primary'}`} aria-pressed={!!listed} onClick={() => void toggleList()}>
          <Icon name={listed ? 'cartCheck' : 'cartPlus'} size={18} /> {listed ? 'On the list' : 'Add to list'}
        </button>
        <button className="btn" onClick={() => setEditing(true)}>
          <Icon name="pencil" size={18} /> Edit item
        </button>
        <button className="btn" onClick={() => nav.push({ name: 'item', groupId })}>
          Open the full page
        </button>
      </div>
      <section className="dk-panel-part" aria-labelledby="dk-ph">
        <div className="dk-section-head">
          <h3 id="dk-ph">Price, last 3 months</h3>
          {/* 0.9.6: when this product's price was last checked, top right (follows the shop picked). */}
          <LastUpdated readings={all} />
        </div>
        <span className="dk-sub">{fromServer.length ? 'older weeks from your server' : 'from your phones'}</span>
        {mains.length > 1 && (
          <div className="dk-chips" role="group" aria-label="Which shop's price">
            {mains.map((o) => (
              <button key={o.product.id} className="chip" aria-pressed={o === chartOpt} onClick={() => setPicked(o.product.id)}>
                <ChainName chain={o.product.chain} />
              </button>
            ))}
          </div>
        )}
        {chartOpt && stats ? <PriceChart readings={shownReadings.slice(-400)} typical={stats.typical} /> : <p className="small">No prices yet.</p>}
        {/* 0.9.6: a price seen on the shelf, for any shop, with its day. Entered by hand; undo or delete it. */}
        <button className="btn small" disabled={!rec.options.length} onClick={() => setPricing(true)}>
          <Icon name="tag" size={16} /> Enter a price
        </button>
      </section>

      <section className="dk-panel-part" aria-labelledby="dk-sa">
        <h3 id="dk-sa">Shop around</h3>
        {around.length === 0 && <p className="small">Not linked to a shop's product yet. Do that on a phone.</p>}
        <div className="dk-around">
          {around.map((o) => (
            <AroundRow key={o.product.id} o={o} best={o === rec.best && o.price !== undefined} style={optionStyle(rec.options)} />
          ))}
        </div>
      </section>

      <section className="dk-panel-part" aria-labelledby="dk-al">
        <h3 id="dk-al">Alert</h3>
        <div className="dk-form-row">
          <label htmlFor="dk-alert-level">Tell me when it's on special</label>
          <select id="dk-alert-level" className="input" value={group.alertLevel} onChange={(e) => void setLevel(e.target.value as AlertLevel)}>
            {ALERT_LEVELS.map((a) => (
              <option key={a.id} value={a.id}>
                {a.id === 'custom' ? `Custom (${group.alertPct ?? 30}% off or more)` : a.label}
              </option>
            ))}
          </select>
        </div>
        <form
          className="dk-form-row"
          onSubmit={(e) => {
            e.preventDefault();
            void saveTarget();
          }}
        >
          <label htmlFor="dk-alert-under">Tell me when it's under</label>
          <span className="dk-money">
            <span aria-hidden>$</span>
            <input
              id="dk-alert-under"
              className="input"
              inputMode="decimal"
              placeholder="e.g. 4.80"
              value={target ?? (group.targetPrice !== undefined ? group.targetPrice.toFixed(2) : '')}
              onChange={(e) => setTarget(e.target.value)}
              onBlur={() => void saveTarget()}
              aria-describedby="dk-alert-help"
            />
          </span>
        </form>
        <span id="dk-alert-help" className="dk-sub">
          At any of your shops, special or not. Leave it empty for no price alert. Your phones send the alerts.
        </span>
      </section>

      <PhoneOnlyNote compact text="Checking prices now happens on your phones." />
      {pricing && <PriceSheet options={rec.options} productId={chartOpt?.product.id} onClose={() => setPricing(false)} />}
      {editing && <EditSheet group={group} categories={categories} onClose={() => setEditing(false)} />}
    </aside>
  );
}

function AroundRow({ o, best, style }: { o: Option; best: boolean; style?: CompareStyle }) {
  const cur = o.stats.current;
  const special = cur?.isSpecial && o.verdict.stale !== 'ended';
  const note = o.product.inStock === false ? 'out of stock' : special ? 'special' : o.verdict.stale === 'ended' ? 'special, may have ended' : undefined;
  return (
    <div className={`dk-around-row${best ? ' best' : ''}`}>
      <span className="grow">
        <ChainName chain={o.product.chain} />
        {note && <span className="dk-sub-inline"> · {note}</span>}
        {best && <span className="sr-only"> (cheapest)</span>}
        {/* 0.9.6: both prices; a line with no size is left out of "cheapest". */}
        {productLine(o.product, o.price, style) && <span className="dk-sub num" style={{ display: 'block' }}>{productLine(o.product, o.price, style)}</span>}
      </span>
      <strong className="num">{money(o.multi ? o.shelfPrice : o.price)}</strong>
    </div>
  );
}
