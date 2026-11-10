// 0.9.3: the shopping list at desktop widths: each shop in its own column with its total, then
// Anywhere. The same picks, totals and add box as the phone's list (List.tsx listSums, useListAdd).
import { useMemo, useState, type ReactNode } from 'react';
import { allCategories, allListEntries, getSettings, updateSettings } from '../../lib/db';
import { linesToPick, pickWord } from '../../lib/homeAssistant';
import { loadRecommendations } from '../../lib/recs';
import { money } from '../../lib/units';
import { useLive } from '../../lib/useLive';
import { LIST_NAMES, type ListSection } from '../../shops';
import { chainName, type ListEntry } from '../../types';
import { ChainName, Icon, Thumb } from '../../ui/components';
import { useNav } from '../../ui/nav';
import {
  dealFor,
  EditEntry,
  entrySection,
  lineFor,
  listAsText,
  listShops,
  listSums,
  priceOf,
  qtyOf,
  recFor,
  shareText,
  shopOf,
  Stepper,
  useListAdd,
  removeEntries, // 0.9.5 (undo)
  tickEntry, // 0.9.5 (undo)
  type Ctx,
  type ShopKey,
} from '../../ui/screens/List';
import { PickItemSheet } from '../../ui/screens/PickItem';
import { ShopTotalsCard } from '../../ui/shopTotalsCard';
import { PhoneOnlyNote } from './PhoneOnly';
import { DeskHead } from './deskShared';
import { AisleTip } from './DeskAisleTip';
import { thumbOf } from './DeskSpecials';
import { ScanButton } from '../pwa/WebScanner'; // 0.9.5 (PWA)
// 0.9.5 (web search): Search the shops from the add box (Let the web page search the shops).
import { ShopSearchButton, ShopSearchPanel } from './WebShopSearch';
import { askShops, enterDoes, useWebSearchOn } from './webSearch';

type View = 'shop' | 'aisle' | 'all';
const VIEWS: { id: View; label: string }[] = [
  { id: 'shop', label: 'By shop' },
  { id: 'aisle', label: 'Aisle group' },
  { id: 'all', label: 'One list' },
];

function loadView(): View {
  try {
    const v = localStorage.getItem('deskListView');
    if (v === 'shop' || v === 'aisle' || v === 'all') return v;
  } catch {
    // storage can be unavailable
  }
  return 'shop';
}

/** The add box, as on the phone's list: your pantry items that match come first. */
export function DeskAddBox({
  adder,
  label,
  placeholder,
  compact,
  shopSearch,
}: {
  adder: ReturnType<typeof useListAdd>;
  label: string;
  placeholder: string;
  compact?: boolean;
  /** 0.9.5 (web search): the list it adds to, so it can search the shops (when the setting is on). */
  shopSearch?: ListSection;
}) {
  const nav = useNav();
  const { text, setText, add, pantryMatches, exactPantry, addFromPantry } = adder;
  const id = compact ? 'dk-add-home' : 'dk-add-list';
  const searchOn = useWebSearchOn(); // 0.9.5 (web search)
  const submit = async () => {
    const t = text.trim();
    if (!t) return;
    // 0.9.5 (web search): Enter with nothing in the pantry like it searches the shops, when that's on.
    const does = enterDoes({ text: t, exactPantry: !!exactPantry, pantryMatches: pantryMatches.length, searchOn: shopSearch ? searchOn : false });
    // A name you already track adds that item, not a blank copy of it.
    if (does === 'pantry' && exactPantry) await addFromPantry(exactPantry);
    else if (does === 'search' && shopSearch) askShops({ q: t, list: shopSearch });
    else await add(t); // 0.9.5 (undo): add says so, with Undo
  };
  return (
    <div className={`dk-addbox${compact ? ' compact' : ''}`}>
      <form
        className="dk-addform"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label htmlFor={id} className="sr-only">
          {label}
        </label>
        <input
          id={id}
          className="input"
          autoComplete="off"
          placeholder={placeholder}
          value={text}
          onChange={(e) => setText(e.target.value)}
          aria-describedby={pantryMatches.length ? `${id}-matches` : undefined}
        />
        {/* 0.9.5 (PWA): scan a barcode with the camera. */}
        <ScanButton section={nav.section} onSaid={(t) => nav.toast(t)} />
        <button className="btn primary" type="submit">
          <Icon name="plus" size={18} /> Add
        </button>
      </form>
      {/* 0.9.5 (web search): Search the shops for what's typed, or (off) a link to the setting. */}
      {shopSearch && text.trim() && !exactPantry && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          {searchOn && (
            <button type="button" className="btn" onClick={() => void add(text) /* 0.9.5 (undo): add says so, with Undo */}>
              <Icon name="plus" size={18} /> <span className="clip">Add "{text.trim()}" as it is</span>
            </button>
          )}
          <ShopSearchButton text={text} list={shopSearch} className="btn primary" />
        </div>
      )}
      {pantryMatches.length > 0 && (
        <div className="card flush dk-matches" id={`${id}-matches`} role="group" aria-label="In your pantry">
          {pantryMatches.map((r) => {
            const o = r.best ?? r.options[0];
            return (
              <button key={r.group.id} className="row" onClick={() => void addFromPantry(r)}>
                <Thumb src={o?.product.imageUrl} />
                <span className="grow">
                  <span className="title clip">{r.group.name}</span>
                  <span className="small clip">In your pantry{o ? ` · ${chainName(o.product.chain)} ${money(o.price)}` : ''}</span>
                </span>
                <span className="btn small primary" aria-hidden>
                  <Icon name="plus" size={16} /> Add
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function DeskList() {
  const nav = useNav();
  const allEntries = useLive(allListEntries, []);
  const allRecs = useLive(loadRecommendations, []);
  const allCats = useLive(allCategories, []);
  const settings = useLive(getSettings, []);
  const toPick = useLive(linesToPick, []);
  const [picked, setPicked] = useState<ListSection>(nav.section);
  const [view, setViewState] = useState<View>(loadView);
  const [editing, setEditing] = useState<ListEntry>();
  const [picking, setPicking] = useState<ListEntry>();
  const setView = (v: View) => {
    setViewState(v);
    try {
      localStorage.setItem('deskListView', v);
    } catch {
      // fine
    }
  };
  const sums = useMemo(
    () => (!allEntries || !allRecs || !settings ? undefined : listSums(allEntries, allRecs, settings, picked)),
    [allEntries, allRecs, settings, picked],
  );
  const adder = useListAdd(sums?.entries ?? [], sums?.recs ?? [], sums?.section ?? 'pantry');
  const searchOn = useWebSearchOn(); // 0.9.5 (web search)
  if (!allEntries || !allRecs || !allCats || !settings || !sums) return <div className="dk-page" aria-busy="true" />;
  const { sectionsOn, section, groupSection, entries, totals, names, c } = sums;
  const categories = allCats.filter((x) => x.section === section);
  const labelOf = (e: ListEntry) => (e.groupId ? names.get(e.groupId) : undefined) ?? e.text;
  const az = (a: ListEntry, b: ListEntry) => labelOf(a).localeCompare(labelOf(b), undefined, { sensitivity: 'base' });
  const open = entries.filter((e) => !e.checked).sort(az);
  const done = entries.filter((e) => e.checked).sort(az);
  const total = open.reduce((s, e) => s + (priceOf(c, e) ?? 0), 0);
  const openCount = (sec: ListSection) => allEntries.filter((e) => !e.checked && entrySection(e, groupSection) === sec).length;
  const pickLines = open.filter((e) => !e.groupId && toPick?.has(e.id));

  const columns: { key: string; title: ReactNode; label: string; items: ListEntry[]; any?: boolean }[] =
    view === 'shop'
      ? c.order
          .map((shop: ShopKey) => ({
            key: shop,
            title: shop === 'any' ? 'Any shop' : <ChainName chain={shop} />,
            label: shop === 'any' ? 'Any shop' : chainName(shop),
            items: open.filter((e) => shopOf(c, e) === shop),
            any: shop === 'any',
          }))
          .filter((col) => col.items.length)
      : view === 'aisle'
        ? [
            ...categories.map((cat) => ({ key: cat.id, title: cat.name, label: cat.name, items: open.filter((e) => catOf(c, e) === cat.id) })),
            { key: 'other', title: 'Other', label: 'Other', items: open.filter((e) => !categories.some((cat) => cat.id === catOf(c, e))) },
          ].filter((col) => col.items.length)
        : open.length
          ? [{ key: 'all', title: 'Everything', label: 'Everything', items: open }]
          : [];

  const line = (e: ListEntry, showShop: boolean) => {
    const rec = recFor(c, e);
    const title = rec?.group.name ?? e.text;
    const deal = dealFor(c, e);
    const p = priceOf(c, e);
    const l = lineFor(c, e);
    const onSale = deal && (deal.verdict.kind === 'great' || deal.verdict.kind === 'good' || deal.verdict.kind === 'small');
    const shop = shopOf(c, e);
    const bits = [
      showShop ? (shop === 'any' ? 'Any shop' : chainName(shop)) : '',
      deal ? `${l?.packs && l.packs > 1 ? `${l.packs} × ` : ''}${deal.product.name}` : rec ? 'No price yet' : '',
    ].filter(Boolean);
    return (
      <div key={e.id} className={`dk-line${e.checked ? ' done' : ''}`}>
        {/* 0.9.4 (section 15): only the checkbox ticks; the name opens the product (or, for a typed line, its details). */}
        <label className="tick-hit">
          <input
            type="checkbox"
            id={`dk-got-${e.id}`}
            checked={e.checked}
            aria-label={`Got ${qtyOf(e) > 1 ? `${qtyOf(e)} × ` : ''}${title}`}
            onChange={(ev) => void tickEntry(e, ev.target.checked, title) /* 0.9.5 (undo) */}
          />
        </label>
        {rec?.best?.product.imageUrl || deal?.product.imageUrl ? <Thumb src={thumbOf((deal ?? rec?.best)?.product.imageUrl)} /> : null}
        <span className="grow">
          <button
            type="button"
            className="dk-line-title dk-line-open"
            onClick={() => (rec ? nav.push({ name: 'item', groupId: rec.group.id }) : setEditing(e))}
            aria-label={`${qtyOf(e) > 1 ? `${qtyOf(e)} × ` : ''}${title}, ${rec ? 'open the item' : 'details'}`}
          >
            {qtyOf(e) > 1 && <span className="num">{qtyOf(e)} × </span>}
            {title}
          </button>
          {bits.length > 0 && <span className="dk-sub">{bits.join(' · ')}</span>}
          {(p !== undefined || onSale) && (
            <span className={`dk-sub num${onSale ? ' dk-good' : ''}`}>
              {p !== undefined ? money(p) : ''}
              {onSale ? ` · ${deal!.verdict.kind === 'small' ? 'small saving' : 'on special'}` : ''}
            </span>
          )}
          {!e.groupId && !e.checked && toPick?.has(e.id) && (
            <span className="dk-sub dk-warn">
              From Home Assistant · not matched yet ·{' '}
              <button className="dk-linkish" onClick={() => setPicking(e)}>
                Pick my {pickWord(e.text)}
              </button>
            </span>
          )}
          {!e.checked && <Stepper e={e} />}
        </span>
        <button className="icon-btn dk-more" aria-label={`Details and options for ${title}`} onClick={() => setEditing(e)}>
          <Icon name="more" size={18} />
        </button>
      </div>
    );
  };

  return (
    <div className="dk-page">
      <DeskHead
        title={section === 'pantry' ? 'Shopping list' : `${LIST_NAMES[section]} list`}
        sub={
          <span className="num">
            {open.length} to buy{total > 0 ? ` · about ${money(total)}` : ''}
          </span>
        }
      >
        <div className="dk-seg" role="group" aria-label="Show the list">
          {VIEWS.map((v) => (
            <button key={v.id} aria-pressed={view === v.id} onClick={() => setView(v.id)}>
              {v.label}
            </button>
          ))}
        </div>
      </DeskHead>

      <div className="dk-toolbar">
        {sectionsOn.length > 1 && (
          <div className="dk-seg" role="group" aria-label="Which list">
            {sectionsOn.map((sec) => (
              <button key={sec} aria-pressed={sec === section} onClick={() => setPicked(sec)}>
                <Icon name={sec} size={16} /> {LIST_NAMES[sec]}
                {openCount(sec) > 0 && <span className="dk-pill">{openCount(sec)}</span>}
              </button>
            ))}
          </div>
        )}
        {totals.linked > 0 && (
          <div className="dk-seg" role="group" aria-label="Pick the cheapest by">
            <button aria-pressed={settings.listCompare === 'unit'} onClick={() => void updateSettings({ listCompare: 'unit' })}>
              Best value
            </button>
            <button aria-pressed={settings.listCompare === 'price'} onClick={() => void updateSettings({ listCompare: 'price' })}>
              Lowest price
            </button>
          </div>
        )}
      </div>

      <DeskAddBox adder={adder} label="Add to the list" placeholder="Add something: milk, 2 bread, dog food…" shopSearch={section} />
      <p className="small dk-tight">
        Matches your pantry as you type. Anything added here, on a phone or by voice in Home Assistant shows up everywhere.
      </p>
      {adder.text.trim() && !adder.exactPantry && searchOn !== true && <PhoneOnlyNote compact text="Finding the cheapest at your shops is done on a phone. Add it here as it is, or pick it from your pantry." />}
      {/* 0.9.5 (web search): what the shops have for what was typed or scanned. */}
      <ShopSearchPanel list={section} wide onAdded={() => adder.setText('')} />

      {pickLines.slice(0, 3).map((e) => (
        <div key={e.id} className="banner amber dk-ha">
          <span>
            <strong>"{e.text}" came from Home Assistant</strong> and isn't matched to a pantry item yet.
          </span>
          <button className="btn small dk-ink" onClick={() => setPicking(e)}>
            Pick my {pickWord(e.text)}
          </button>
        </div>
      ))}

      {!entries.length && (
        <div className="card">
          <p className="small">This list is empty. Type anything above, or use Add to list next to anything in your pantry.</p>
        </div>
      )}

      {/* 0.9.5 (task 184, DeskAisleTip.tsx): most lines in Other → a tip with a quick way to set categories. */}
      {view === 'aisle' && <AisleTip lines={open} categories={categories} categoryOf={(e) => catOf(c, e)} groupOf={(e) => recFor(c, e)?.group} labelOf={labelOf} />}
      {columns.length > 0 && (
        <div className={`dk-cols${view === 'all' ? ' one' : ''}`}>
          {columns.map((col) => {
            const sub = col.items.reduce((s, e) => s + (priceOf(c, e) ?? 0), 0);
            return (
              <section key={col.key} className={`card dk-col${col.any ? ' any' : ''}`} aria-label={col.label}>
                <div className="dk-col-head">
                  <h2>{col.title}</h2>
                  <span className="dk-sub num">
                    {col.items.length}
                    {sub > 0 ? ` · ${money(sub)}` : ''}
                  </span>
                </div>
                {col.items.map((e) => line(e, view !== 'shop'))}
              </section>
            );
          })}
        </div>
      )}

      {done.length > 0 && (
        <section className="card dk-done" aria-labelledby="dk-ticked">
          <div className="dk-col-head">
            <h2 id="dk-ticked">Ticked off</h2>
            <span className="dk-sub">{done.length}</span>
          </div>
          <div className="dk-done-lines">{done.map((e) => line(e, true))}</div>
        </section>
      )}

      <div className="dk-actions">
        {done.length > 0 && (
          <button
            className="btn"
            onClick={async () => {
              const n = done.length;
              // 0.9.5 (undo)
              await removeEntries(
                done.map((e) => e.id),
                `Cleared ${n} ticked item${n === 1 ? '' : 's'}`,
              );
            }}
          >
            Clear ticked off
          </button>
        )}
        {open.length > 0 && (
          <button
            className="btn"
            onClick={async () => {
              await shareText(listAsText(c, open));
              nav.toast('Copied the list, ready to paste');
            }}
          >
            <Icon name="share" size={18} /> Copy the list as text
          </button>
        )}
        {totals.linked > 0 && <span className="small">Shop around picked the cheapest shop for each item. Change it on any line with ⋯.</span>}
      </div>

      {open.length > 0 && totals.linked > 0 && (
        <div className="dk-compare">
          <ShopTotalsCard
            totals={totals}
            min={settings.shopAroundMin ?? 1}
            onOpenItem={(groupId) => nav.push({ name: 'item', groupId })}
            onFindAt={(groupId, chain, query) => nav.push({ name: 'add', attachTo: groupId, as: 'main', chain, query })}
          />
        </div>
      )}

      {picking && <PickItemSheet entry={picking} onClose={() => setPicking(undefined)} />}
      {editing && (
        <EditEntry
          entry={editing}
          categories={categories}
          shops={listShops(settings.enabledChains, section, sectionsOn)}
          deal={dealFor(c, editing) ?? recFor(c, editing)?.options[0]}
          name={recFor(c, editing)?.group.name}
          onClose={() => setEditing(undefined)}
        />
      )}
    </div>
  );
}

/** A line's aisle: its pantry item's category, or the one picked for it (as shopping mode sorts by). */
const catOf = (c: Ctx, e: ListEntry) => recFor(c, e)?.group.categoryId ?? e.categoryId;
