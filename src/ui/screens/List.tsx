import { useEffect, useState } from 'react';
import { nameHasSize } from '../../lib/naming';
import { lookupBarcode, scanBarcode } from '../../lib/barcode';
import {
  addListEntry,
  allCards,
  allCategories,
  allGroups,
  allListEntries,
  deleteListEntries,
  findProductByBarcode,
  getSettings,
  groupProductIds,
  nowIso,
  uid,
  updateListEntry,
  updateSettings,
} from '../../lib/db';
import { buzz } from '../../lib/listActions';
import { loadRecommendations } from '../../lib/recs';
import { lineCost, type Option } from '../../lib/verdict';
import { isNative } from '../../stores/http';
import { recommendedStores, shopTotals, type ShopTotals } from '../../lib/shopTotals';
import { entryRows, undoable } from '../../lib/undo';
import { money, tidySize } from '../../lib/units';
import { useLive } from '../../lib/useLive';
import type { Recommendation } from '../../lib/verdict';
import { chainName, secondBranch, stockAtBranch, type Category, type Chain, type ListEntry, type LoyaltyCard } from '../../types';
import { cachedSettings } from '../../lib/db';
import {
  ChainDot,
  ChainName,
  Hold,
  Icon,
  MoreInfo,
  previewFromOption,
  type PreviewProduct,
  ProductPreview,
  SelectBar,
  Sheet,
  ShopTotalsCard,
  stockWhere,
  Thumb,
} from '../components';
import { MemberInfoTag, MultiInfoTag, StockInfoTag, SwapInfoTag, VerdictInfoTag } from '../tagInfo';
import { SendToShopSheet } from './SendToShop';
import { useNav } from '../nav';
import { activeSections, enabledIn, SECTION_NAMES, SECTION_PLACE, searchChainsIn, type Section, type StoreChain } from '../../shops';
import { CardBarcode, PROGRAMS } from './Cards';

type ShopKey = Chain | 'any';

/** Context every row needs, worked out once per render. */
interface Ctx {
  totals: ShopTotals;
  recs: Recommendation[];
  /** The order to show shops in: this list's shops, then Other, then Any shop. */
  order: ShopKey[];
  /** "Shopping list", "Bottle shop list" or "Pharmacy list". */
  title: string;
}

/** Which list a line is on: its pantry item's tab, or the tab it was added from. */
export const entrySection = (e: ListEntry, groups: Map<string, Section>): Section =>
  (e.groupId ? groups.get(e.groupId) : undefined) ?? e.section ?? 'pantry';
const recFor = (c: Ctx, e: ListEntry) => (e.groupId ? c.recs.find((r) => r.group.id === e.groupId) : undefined);
/** What to buy: the cheapest of your product and its alternatives, in stock, by the chosen measure. */
const lineFor = (c: Ctx, e: ListEntry) => (e.groupId ? c.totals.pickFor.get(e.groupId) : undefined);
const dealFor = (c: Ctx, e: ListEntry) => lineFor(c, e)?.pick;
const shopOf = (c: Ctx, e: ListEntry): ShopKey => e.chain ?? dealFor(c, e)?.product.chain ?? 'any';
const qtyOf = (e: ListEntry) => Math.max(1, e.qty ?? 1);
const priceOf = (c: Ctx, e: ListEntry) => {
  const d = dealFor(c, e);
  if (!d && e.price !== undefined) return Math.round(e.price * qtyOf(e) * 100) / 100;
  return d?.price === undefined ? undefined : lineCost(d, qtyOf(e));
};

/** The list as plain text, for sending to someone. */
function listAsText(c: Ctx, open: ListEntry[], only?: ShopKey): string {
  const lines = [only ? `${c.title}: ${only === 'any' ? 'any shop' : chainName(only)} (from Restock)` : `${c.title} (from Restock)`, ''];
  for (const shop of c.order) {
    if (only && shop !== only) continue;
    const items = open.filter((e) => shopOf(c, e) === shop);
    if (!items.length) continue;
    lines.push(shop === 'any' ? 'Any shop' : chainName(shop));
    for (const e of items) {
      const d = dealFor(c, e);
      const name = recFor(c, e)?.group.name ?? e.text;
      const q = qtyOf(e) > 1 ? `${qtyOf(e)} × ` : '';
      lines.push(`- ${q}${name}${d ? ` (${d.product.name}, ${money(d.price)})` : ''}`);
    }
    lines.push('');
  }
  return lines.join('\n').trim();
}

async function shareText(text: string): Promise<'shared' | 'copied'> {
  try {
    if (isNative()) {
      const { Share } = await import('@capacitor/share');
      await Share.share({ title: 'Shopping list', text });
      return 'shared';
    }
  } catch {
    // fall through to copying
  }
  await navigator.clipboard?.writeText(text).catch(() => undefined);
  return 'copied';
}

function Stepper({ e }: { e: ListEntry }) {
  const q = qtyOf(e);
  return (
    <span className="stepper" role="group" aria-label={`How many ${e.text}`}>
      <button aria-label="One fewer" disabled={q <= 1} onClick={() => updateListEntry(e.id, { qty: q - 1 })}>
        −
      </button>
      <span className="num">{q}</span>
      <button aria-label="One more" onClick={() => updateListEntry(e.id, { qty: q + 1 })}>
        +
      </button>
    </span>
  );
}

/**
 * A line whose pick is out of stock where you're shopping: in stock at your second Coles (go there
 * for it), or out at both / online (skip it today, or get it somewhere else).
 */
function stockNote(c: Ctx, e: ListEntry): { kind: 'second' | 'out'; text: string } | undefined {
  const line = lineFor(c, e);
  if (!line?.outOfStock || e.checked) return undefined;
  const p = line.pick.product;
  const s = cachedSettings();
  const first = stockAtBranch(s, p.chain);
  const second = p.chain === 'coles' ? secondBranch(s) : undefined;
  if (second && p.inStock2 === true) return { kind: 'second', text: `Out at ${first} · in stock at ${second}` };
  if (second && p.inStock2 === false) return { kind: 'out', text: `Out of stock at ${first} and ${second}` };
  return { kind: 'out', text: `Out of stock ${stockWhere(p.chain, true)}` };
}

const LIST_TITLE: Record<Section, string> = { pantry: 'Shopping list', keg: 'Bottle shop list', pharmacy: 'Pharmacy list' };
/** What to type in the add box, for each list. */
const ADD_HINT: Record<Section, string> = {
  pantry: 'Add anything — e.g. bananas',
  keg: 'Add anything — e.g. a bag of ice',
  pharmacy: 'Add anything — e.g. sunscreen',
};

export function ListScreen() {
  const nav = useNav();
  const allEntries = useLive(allListEntries, []);
  const allRecs = useLive(loadRecommendations, []);
  const allCats = useLive(allCategories, []);
  const settings = useLive(getSettings, []);
  const [picked0, setSection] = useState<Section>(nav.section);
  // Opening the list from Home picks the grocery list even when the List tab is already open.
  useEffect(() => setSection(nav.section), [nav.section]);
  const [text, setText] = useState('');
  const [view, setView] = useState<'all' | 'shop'>('shop');
  const [sending, setSending] = useState<'woolworths' | 'coles'>();
  const [editing, setEditing] = useState<ListEntry>();
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState(false);
  // Start shopping: first which shops you're going to today, then the in-store view for those.
  const [choosingShops, setChoosingShops] = useState(false);
  const [shopping, setShopping] = useState<StoreChain[]>();
  const [skipToday, setSkipToday] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<ListEntry>();

  if (!allEntries || !allRecs || !allCats || !settings) return <div className="screen" />;
  // One list per tab (Pantry, Keg, Pharmacy), each with its own shops.
  const sectionsOn = activeSections(settings);
  const section: Section = sectionsOn.includes(picked0) ? picked0 : 'pantry';
  const groupSection = new Map(allRecs.map((r) => [r.group.id, r.group.section ?? 'pantry']));
  const entries = allEntries.filter((e) => entrySection(e, groupSection) === section);
  const recs = allRecs.filter((r) => (r.group.section ?? 'pantry') === section);
  const categories = allCats.filter((x) => x.section === section);
  const shops = searchChainsIn(settings.enabledChains, section);
  const openCount = (sec: Section) => allEntries.filter((e) => !e.checked && entrySection(e, groupSection) === sec).length;
  // Store totals count what's still to buy; the per-row picks include ticked rows too, so
  // a ticked item keeps its shop and price (and counts towards the trolley total).
  const totals = shopTotals(entries, recs, shops, settings.listCompare);
  const picks = shopTotals(
    entries.map((e) => ({ ...e, checked: false })),
    recs,
    shops,
    settings.listCompare,
  );
  const order: ShopKey[] = [...shops, ...enabledIn(settings.enabledChains, section).filter((x) => !shops.includes(x)), 'other', 'any'];
  const c: Ctx = { totals: picks, recs, order, title: LIST_TITLE[section] };

  const pick = (id: string) =>
    setPicked((p) => {
      const n = new Set(p);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const stopSelecting = () => {
    setSelecting(false);
    setPicked(new Set());
  };

  const add = async (value: string, groupId?: string) => {
    const t = value.trim();
    if (!t) return;
    const existing = groupId ? entries.find((e) => !e.checked && e.groupId === groupId) : undefined;
    if (existing) await updateListEntry(existing.id, { qty: qtyOf(existing) + 1 });
    else
      await addListEntry({
        id: uid(),
        text: t,
        groupId,
        qty: 1,
        section,
        checked: false,
        createdAt: nowIso(),
      });
    buzz();
    setText('');
  };

  // Typing in "Add anything": your own pantry items that match come first (0.7.4), so "Nescafe"
  // adds the Nescafe you track, with its photo and cheapest shop, not a blank line.
  const typed = text.trim().toLowerCase();
  const words = typed.split(/\s+/).filter((w) => w.length > 1);
  const pantryMatches = typed
    ? recs
        .filter((r) => {
          const hay = `${r.group.name} ${r.options.map((o) => o.product.name).join(' ')}`.toLowerCase();
          return words.length ? words.every((w) => hay.includes(w)) : hay.includes(typed);
        })
        .sort(
          (a, b) =>
            Number(!a.group.name.toLowerCase().startsWith(typed)) - Number(!b.group.name.toLowerCase().startsWith(typed)) ||
            a.group.name.localeCompare(b.group.name),
        )
        .slice(0, 4)
    : [];
  const exactPantry = recs.find((r) => r.group.name.trim().toLowerCase() === typed);
  const addFromPantry = async (r: (typeof recs)[number]) => {
    await add(r.group.name, r.group.id);
    nav.toast(`${r.group.name} added from your pantry`);
  };

  const scanToList = async () => {
    const out = await scanBarcode('Scan to add to your shopping list');
    if (!out.ok) return;
    const product = await findProductByBarcode(out.code);
    if (product) {
      const group = (await allGroups()).find((g) => groupProductIds(g).includes(product.id));
      if (group) {
        await add(group.name, group.id);
        nav.toast(`${group.name} added`);
        return;
      }
    }
    const info = await lookupBarcode(out.code);
    await add(info.name ?? `Item ${out.code}`);
    nav.toast(info.name ? `${info.name} added` : 'Added. Tap it to rename.');
  };

  // A to Z by default (0.7.4), within each shop.
  const az = (a: ListEntry, b: ListEntry) => labelOf(a).localeCompare(labelOf(b), undefined, { sensitivity: 'base' });
  const labelOf = (e: ListEntry) => recs.find((r) => r.group.id === e.groupId)?.group.name ?? e.text;
  const open = entries.filter((e) => !e.checked).sort(az);
  const done = entries.filter((e) => e.checked).sort(az);
  const total = open.reduce((s, e) => s + (priceOf(c, e) ?? 0), 0);
  const firstTime = !settings.seenHints.includes('list');

  /** What a list line is, for its photo and the product sheet: its pantry item's product, or a one-off buy's snapshot. */
  const previewOf = (e: ListEntry): PreviewProduct | undefined => {
    const o = dealFor(c, e) ?? recFor(c, e)?.options[0];
    if (o) return previewFromOption(o);
    return e.product ? { ...e.product, price: e.price } : undefined;
  };

  const renderRow = (e: ListEntry) => {
    const rec = recFor(c, e);
    // Pantry items always show their current name, so renaming in the pantry renames here too.
    const title = rec?.group.name ?? e.text;
    const deal = dealFor(c, e);
    const p = priceOf(c, e);
    const shop = shopOf(c, e);
    const member = deal?.stats.current?.memberOnly;
    const isPicked = picked.has(e.id);
    const size =
      deal?.product.size && !nameHasSize(deal.product.name, deal.product.size) ? ` · ${tidySize(deal.product.size, deal.product.name)}` : '';
    const onSale = deal && (deal.verdict.kind === 'great' || deal.verdict.kind === 'good' || deal.verdict.kind === 'small');
    const line = lineFor(c, e);
    // Pantry items open their page, so you can see exactly which product, brand and size to buy.
    const openRow = () => {
      if (selecting) pick(e.id);
      else if (rec) nav.push({ name: 'item', groupId: rec.group.id });
      else setEditing(e);
    };
    return (
      <Hold key={e.id} onLong={() => previewOf(e) && !selecting && setPreview(e)}>
        <div className={`row${isPicked ? ' selected' : ''}`} style={e.checked && !selecting ? { opacity: 0.55 } : undefined}>
          {selecting ? (
            <button className={`pick${isPicked ? ' on' : ''}`} onClick={() => pick(e.id)} aria-pressed={isPicked} aria-label={`Select ${title}`}>
              {isPicked && <Icon name="check" size={16} />}
            </button>
          ) : (
            <input
              type="checkbox"
              checked={e.checked}
              onChange={(ev) => updateListEntry(e.id, { checked: ev.target.checked })}
              aria-label={`Got ${title}`}
            />
          )}
          {!selecting &&
            (previewOf(e) ? (
              <MoreInfo src={previewOf(e)!.imageUrl} name={previewOf(e)!.name} onOpen={() => setPreview(e)} />
            ) : (
              // No photo: keep the space, so every name on the list lines up (0.7.3).
              <span className="thumb-space" aria-hidden />
            ))}
          <div className="grow" style={{ gap: 6 }}>
            <button
              style={{
                border: 'none',
                background: 'none',
                padding: 0,
                textAlign: 'left',
                display: 'flex',
                flexDirection: 'column',
                color: 'inherit',
                font: 'inherit',
              }}
              onClick={openRow}
            >
              <span
                className="title"
                style={{
                  fontSize: 15,
                  textDecoration: e.checked ? 'line-through' : undefined,
                }}
              >
                {qtyOf(e) > 1 && <span className="num">{qtyOf(e)} × </span>}
                {title}
              </span>
              {deal && (
                <span className="small">
                  {view === 'all' ? `${chainName(deal.product.chain)} · ` : ''}
                  {deal.product.name}
                  {size}
                </span>
              )}
              {!deal && view === 'all' && shop !== 'any' && <span className="small">{chainName(shop)}</span>}
              {!deal && rec && <span className="small">No price yet</span>}
              {deal?.multi && qtyOf(e) < deal.multi.n && !e.checked && (
                <span className="small" style={{ color: 'var(--green)' }}>
                  Get {deal.multi.n} for {money(deal.multi.total)}: tap + to add {deal.multi.n - qtyOf(e)} more
                </span>
              )}
            </button>
            {deal && (deal.role === 'alt' || line?.outOfStock || onSale || member || deal.multi) && (
              <span className="tags" style={{ marginTop: -3 }}>
                {line?.outOfStock ? <StockInfoTag o={deal} /> : onSale ? <VerdictInfoTag o={deal} /> : null}
                {deal.role === 'alt' && line && <SwapInfoTag line={line} />}
                <MultiInfoTag o={deal} />
                {member && <MemberInfoTag chain={deal.product.chain} hasCard={!deal.locked} />}
              </span>
            )}
            {stockNote(c, e)?.kind === 'second' && (
              <span className="small" style={{ color: 'var(--green-ink)', fontWeight: 600 }}>
                {stockNote(c, e)!.text}
              </span>
            )}
            {!selecting && !e.checked && <Stepper e={e} />}
          </div>
          {p !== undefined && (
            <span className="num" style={{ fontWeight: 600, minWidth: 52, textAlign: 'right' }}>
              {money(p)}
            </span>
          )}
          {/* Not a pantry item: search the shops for it in one tap (also in the ⋯ menu). 0.7.4 */}
          {!selecting && !e.groupId && (
            <button
              className="icon-btn"
              aria-label={`Find the cheapest ${title}`}
              onClick={() => nav.push({ name: 'add', query: e.text, forList: true, replaceEntry: e.id, section: e.section })}
              style={{ width: 36, height: 36 }}
            >
              <Icon name="search" size={18} />
            </button>
          )}
          {!selecting && (
            <button
              className="icon-btn"
              aria-label={`Details and options for ${title}`}
              onClick={() => setEditing(e)}
              style={{ width: 36, height: 36 }}
            >
              <Icon name="more" size={18} />
            </button>
          )}
        </div>
      </Hold>
    );
  };

  return (
    <div className="screen">
      <div className="topbar">
        <h1>{LIST_TITLE[section]}</h1>
        {entries.length > 0 && !selecting && (
          <button className="icon-btn" aria-label="View options" onClick={() => setMenu(true)}>
            <Icon name="sliders" size={18} />
          </button>
        )}
        {entries.length > 0 && (
          <button className="btn small" onClick={() => (selecting ? stopSelecting() : setSelecting(true))}>
            {selecting ? 'Done' : 'Edit'}
          </button>
        )}
      </div>
      {sectionsOn.length > 1 && (
        <div className="seg" role="tablist" aria-label="Which list">
          {sectionsOn.map((sec) => (
            <button key={sec} role="tab" aria-selected={sec === section} className={sec === section ? 'on' : ''} onClick={() => setSection(sec)}>
              <Icon name={sec} size={17} /> {sec === 'pantry' ? 'Groceries' : SECTION_NAMES[sec]}
              {openCount(sec) > 0 && <span className="count">{openCount(sec)}</span>}
            </button>
          ))}
        </div>
      )}
      <span className="sub num" style={{ marginTop: sectionsOn.length > 1 ? 0 : -8 }}>
        {open.length} item{open.length === 1 ? '' : 's'}
        {total > 0 ? ` · about ${money(total)}` : ''}
        {totals.linked > 0 ? ` · ${settings.listCompare === 'unit' ? 'best value' : 'lowest price'}` : ''}
      </span>

      {totals.linked > 0 && !selecting && (
        <div className="compare-switch">
          <div className="seg" role="group" aria-label="Pick the cheapest by">
            <button aria-pressed={settings.listCompare === 'unit'} onClick={() => updateSettings({ listCompare: 'unit' })}>
              Best value
            </button>
            <button aria-pressed={settings.listCompare === 'price'} onClick={() => updateSettings({ listCompare: 'price' })}>
              Lowest price
            </button>
          </div>
        </div>
      )}

      {firstTime && (
        <div className="card hint">
          <span style={{ flex: 1 }}>
            <strong>How this list works.</strong> Your pantry is everything Restock watches; this list is just this trip. Each line shows the cheapest
            version to get, and where. <strong>Best value</strong> picks the cheapest per 100 g, litre or item (it can pick a bigger pack for items
            that allow it). <strong>Lowest price</strong> picks the cheapest on the shelf. Tap any tag to see why.
          </span>
          <button className="icon-btn" aria-label="Got it" onClick={() => updateSettings({ seenHints: [...settings.seenHints, 'list'] })}>
            <Icon name="close" size={16} />
          </button>
        </div>
      )}

      <form
        onSubmit={(ev) => {
          ev.preventDefault();
          // A name you already track adds that item, not a blank copy of it.
          void (exactPantry ? addFromPantry(exactPantry) : add(text));
        }}
        style={{ display: 'flex', gap: 8 }}
      >
        <input className="input" placeholder={ADD_HINT[section]} aria-label="Add an item" value={text} onChange={(e) => setText(e.target.value)} />
        <button type="button" className="btn" aria-label="Scan a barcode to add" style={{ width: 52, padding: 0 }} onClick={scanToList}>
          <Icon name="scan" />
        </button>
      </form>
      {/* Typed something: add just the name, or look it up at your shops for this trip (0.7.3). */}
      {pantryMatches.length > 0 && (
        <div className="card flush pantry-matches" role="list" aria-label="In your pantry">
          {pantryMatches.map((r) => (
            <button key={r.group.id} role="listitem" className="row" onClick={() => void addFromPantry(r)}>
              <Thumb src={(r.best ?? r.options[0])?.product.imageUrl} />
              <span className="grow">
                <span className="title clip" style={{ fontSize: 14 }}>
                  {r.group.name}
                </span>
                <span className="small clip">
                  In your pantry
                  {(r.best ?? r.options[0])
                    ? ` · ${chainName((r.best ?? r.options[0])!.product.chain)} ${money((r.best ?? r.options[0])!.price)}`
                    : ''}
                </span>
              </span>
              <span className="btn small primary" aria-hidden>
                <Icon name="plus" size={16} /> Add
              </span>
            </button>
          ))}
        </div>
      )}
      {text.trim() && (
        <div className="two add-choices">
          <button className="btn" onClick={() => void add(text)}>
            <Icon name="plus" size={18} /> <span className="clip">Add "{text.trim()}"</span>
          </button>
          <button
            className="btn primary"
            onClick={() => {
              nav.push({ name: 'add', query: text.trim(), forList: true, section });
              setText('');
            }}
          >
            <Icon name="search" size={18} /> Find cheapest
          </button>
        </div>
      )}

      {!entries.length && (
        <div className="empty">
          <p>This list is empty. Type anything above, scan a barcode, or tap the cart next to anything in {SECTION_PLACE[section]}.</p>
        </div>
      )}

      {view === 'all' && open.length > 0 && <div className="card flush">{open.map((e) => renderRow(e))}</div>}

      {view === 'shop' &&
        c.order.map((shop) => {
          const items = open.filter((e) => shopOf(c, e) === shop);
          if (!items.length) return null;
          const sub = items.reduce((s, e) => s + (priceOf(c, e) ?? 0), 0);
          return (
            <div className="card flush" key={shop}>
              <div
                className="row"
                style={{
                  minHeight: 44,
                  borderBottom: '1px solid var(--line-soft)',
                }}
              >
                <span className="grow title">{shop === 'any' ? 'Any shop' : <ChainName chain={shop} />}</span>
                <span className="num small">{sub > 0 ? money(sub) : ''}</span>
                {(shop === 'woolworths' || shop === 'coles') && (
                  <button
                    className="icon-btn"
                    style={{ width: 36, height: 36 }}
                    aria-label={`Send the ${chainName(shop)} list to the ${chainName(shop)} app`}
                    onClick={() => setSending(shop)}
                  >
                    <Icon name="cartPlus" size={16} />
                  </button>
                )}
                <button
                  className="icon-btn"
                  style={{ width: 36, height: 36 }}
                  aria-label={`Share the ${shop === 'any' ? 'any shop' : chainName(shop)} list as text`}
                  onClick={async () => {
                    const how = await shareText(listAsText(c, open, shop));
                    nav.toast(how === 'shared' ? 'Shared' : 'Copied, ready to paste');
                  }}
                >
                  <Icon name="share" size={16} />
                </button>
              </div>
              {items.map((e) => renderRow(e))}
            </div>
          );
        })}

      {open.length > 0 && !selecting && (
        <ShopTotalsCard
          totals={totals}
          by={settings.listCompare}
          onShowLowest={() => void updateSettings({ listCompare: 'price' })}
          onOpenItem={(groupId) => nav.push({ name: 'item', groupId })}
          onFindAt={(groupId, chain, query) =>
            nav.push({
              name: 'add',
              attachTo: groupId,
              as: 'alt',
              chain,
              query,
            })
          }
        />
      )}

      {done.length > 0 && (
        <>
          <div className="eyebrow">Got it</div>
          <div className="card flush">{done.map((e) => renderRow(e))}</div>
          <button
            className="btn"
            onClick={async () => {
              const n = done.length;
              const undo = await undoable(() => deleteListEntries(done.map((e) => e.id)), entryRows(done.map((e) => e.id)));
              nav.toast(`Cleared ${n} ticked item${n === 1 ? '' : 's'}`, undo);
            }}
          >
            Clear {done.length} ticked item{done.length === 1 ? '' : 's'}
          </button>
        </>
      )}

      {selecting && (
        <SelectBar
          count={picked.size}
          total={entries.length}
          onAll={() => setPicked(new Set(entries.map((e) => e.id)))}
          onNone={() => setPicked(new Set())}
          onDone={stopSelecting}
        >
          <button
            className="btn small"
            disabled={!picked.size}
            onClick={async () => {
              for (const id of picked) await updateListEntry(id, { checked: true });
              nav.toast(`${picked.size} marked as got`);
              stopSelecting();
            }}
          >
            <Icon name="check" size={18} /> Got them
          </button>
          <button
            className="btn small danger"
            disabled={!picked.size}
            onClick={async () => {
              const n = picked.size;
              const ids = [...picked];
              const undo = await undoable(() => deleteListEntries(ids), entryRows(ids));
              nav.toast(`${n} removed from your shopping list`, undo);
              stopSelecting();
            }}
          >
            <Icon name="trash" size={18} /> Remove
          </button>
        </SelectBar>
      )}

      {open.length > 0 && !selecting && (
        <div className="sticky-cta">
          <button className="btn primary block" onClick={() => setChoosingShops(true)}>
            <Icon name="cart" size={18} /> Start shopping{total > 0 ? ` · about ${money(total)}` : ''}
          </button>
        </div>
      )}

      {menu && (
        <Sheet title="View" onClose={() => setMenu(false)}>
          <div className="field">
            <span>Show</span>
            <div className="seg" role="group" aria-label="View">
              <button aria-pressed={view === 'shop'} onClick={() => setView('shop')}>
                By shop
              </button>
              <button aria-pressed={view === 'all'} onClick={() => setView('all')}>
                All together
              </button>
            </div>
          </div>
          <button
            className="btn"
            onClick={async () => {
              const how = await shareText(listAsText(c, open));
              setMenu(false);
              nav.toast(how === 'shared' ? 'Shared' : 'Copied the list, ready to paste');
            }}
          >
            <Icon name="external" size={18} /> Share the list as text
          </button>
        </Sheet>
      )}

      {sending && (
        <SendToShopSheet
          chain={sending}
          onClose={() => setSending(undefined)}
          lines={open
            .filter((e) => shopOf(c, e) === sending)
            .map((e) => {
              const d = dealFor(c, e);
              return {
                name: recFor(c, e)?.group.name ?? e.text,
                qty: qtyOf(e),
                id: d && d.product.chain === sending ? d.product.storeProductId : undefined,
                productName: d?.product.name,
              };
            })}
        />
      )}

      {preview && previewOf(preview) && (
        <ProductPreview
          product={previewOf(preview)!}
          onClose={() => setPreview(undefined)}
          action={
            preview.groupId ? (
              <button
                className="btn primary"
                onClick={() => {
                  const id = preview.groupId!;
                  setPreview(undefined);
                  nav.push({ name: 'item', groupId: id });
                }}
              >
                Open {recFor(c, preview)?.group.name ?? preview.text}
              </button>
            ) : undefined
          }
        />
      )}
      {choosingShops && (
        <PickShops
          shops={shops}
          entries={entries}
          recs={recs}
          totals={totals}
          compare={settings.listCompare}
          start={c.totals.around.chains}
          onClose={() => setChoosingShops(false)}
          onStart={(chosen, skip) => {
            setChoosingShops(false);
            setSkipToday(skip);
            setShopping(chosen);
          }}
        />
      )}
      {shopping && (
        <ShoppingMode
          c={c}
          shops={shops}
          chosen={shopping}
          skip={skipToday}
          compare={settings.listCompare}
          entries={entries}
          categories={categories}
          onChangeShops={() => {
            setShopping(undefined);
            setChoosingShops(true);
          }}
          onClose={() => setShopping(undefined)}
        />
      )}
      {editing && (
        <EditEntry
          entry={editing}
          categories={categories}
          shops={enabledIn(settings.enabledChains, section)}
          deal={dealFor(c, editing) ?? recFor(c, editing)?.options[0]}
          name={recFor(c, editing)?.group.name}
          onClose={() => setEditing(undefined)}
        />
      )}
    </div>
  );
}

/** Each item's products at these shops only (your product and alternatives), for shopping at just those. */
const onlyAt = (recs: Recommendation[], chains: StoreChain[]): Recommendation[] =>
  recs.map((r) => ({ ...r, options: r.options.filter((o) => chains.includes(o.product.chain as StoreChain)) }));

/**
 * Before shopping: anything out of stock where you're going. In stock at your other Coles says so;
 * out everywhere is listed so you can skip it today (it stays on your list for next time).
 */
function StockCheck({
  entries,
  recs,
  plan,
  skip,
  onSkip,
}: {
  entries: ListEntry[];
  recs: Recommendation[];
  plan: ShopTotals;
  skip: Set<string>;
  onSkip: (s: Set<string>) => void;
}) {
  const c: Ctx = { totals: plan, recs, order: [], title: '' };
  const notes = entries
    .map((e) => ({ e, n: stockNote(c, e) }))
    .filter((x): x is { e: ListEntry; n: NonNullable<ReturnType<typeof stockNote>> } => !!x.n);
  if (!notes.length) return null;
  const name = (e: ListEntry) => recFor(c, e)?.group.name ?? e.text;
  return (
    <div className="card flush">
      <div className="section-head" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 2 }}>
        <span className="title">Out of stock ({notes.length})</span>
        <span className="small">Tick the ones to skip today. They stay on your list for next time.</span>
      </div>
      {notes.map(({ e, n }) => (
        <label key={e.id} className="check">
          <input
            type="checkbox"
            checked={skip.has(e.id)}
            onChange={() => {
              const next = new Set(skip);
              if (next.has(e.id)) next.delete(e.id);
              else next.add(e.id);
              onSkip(next);
            }}
            aria-label={`Skip ${name(e)} today`}
          />
          <span style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
            <span className="title" style={{ fontSize: 14 }}>
              {name(e)}
            </span>
            <span className="small" style={{ color: n.kind === 'second' ? 'var(--green-ink)' : 'var(--amber-ink)' }}>
              {n.text}
            </span>
          </span>
        </label>
      ))}
    </div>
  );
}

/**
 * Before shopping: which shops you're going to today. Each shop says how much of the list it has
 * and what it comes to; the total is worked out again for the shops picked.
 */
function PickShops({
  shops,
  entries,
  recs,
  totals,
  compare,
  start,
  onClose,
  onStart,
}: {
  shops: StoreChain[];
  entries: ListEntry[];
  recs: Recommendation[];
  totals: ShopTotals;
  compare: 'unit' | 'price';
  /** Ticked to begin with: the shops the list is split across now. */
  start: StoreChain[];
  onClose: () => void;
  onStart: (chosen: StoreChain[], skip: Set<string>) => void;
}) {
  const [skip, setSkip] = useState<Set<string>>(new Set());
  const recommended = recommendedStores(totals).recommended?.chain as StoreChain | undefined;
  const [chosen, setChosen] = useState<StoreChain[]>(start.length ? start.filter((x) => shops.includes(x)) : shops);
  const n = totals.linked;
  const plan = chosen.length ? shopTotals(entries, onlyAt(recs, chosen), chosen as never, compare) : undefined;
  const flip = (x: StoreChain) =>
    setChosen((cur) => (cur.includes(x) ? cur.filter((y) => y !== x) : shops.filter((y) => y === x || cur.includes(y))));
  const names = (list: StoreChain[]) => list.map((x) => chainName(x)).join(list.length === 2 ? ' and ' : ', ');
  return (
    <Sheet title="Where are you shopping today?" onClose={onClose}>
      <p className="small">Tick the shops you're going to. Restock puts each item at the cheapest of those, and tells you what they don't have.</p>
      <div className="chips">
        {recommended && (
          <button className="chip" aria-pressed={chosen.length === 1 && chosen[0] === recommended} onClick={() => setChosen([recommended])}>
            Just {chainName(recommended)}
          </button>
        )}
        <button className="chip" aria-pressed={chosen.length === shops.length} onClick={() => setChosen(shops)}>
          All {shops.length}
        </button>
      </div>
      <div className="card flush">
        {shops.map((x) => {
          const st = totals.stores.find((t) => t.chain === x);
          return (
            <label key={x} className="check">
              <input type="checkbox" checked={chosen.includes(x)} onChange={() => flip(x)} aria-label={`Shopping at ${chainName(x)}`} />
              <ChainDot chain={x} />
              <span style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
                <span className="title" style={{ fontSize: 15 }}>
                  {chainName(x)} {x === recommended && <span className="badge">RECOMMENDED</span>}
                </span>
                {st && n > 0 && (
                  <span className="small">
                    {st.missing.length ? `Has ${st.lines.length} of ${n}` : n === 1 ? 'Has your item' : `Has all ${n}`}
                    {st.lines.length ? ` · ${money(st.total)}` : ''}
                    {st.missing.length && st.lines.length && st.missing.every((m) => m.elsewhere)
                      ? ` · about ${money(st.totalWithElsewhere)} with the other ${st.missing.length === 1 ? 'one' : st.missing.length} elsewhere`
                      : ''}
                  </span>
                )}
              </span>
            </label>
          );
        })}
      </div>
      {plan && plan.around.missing.length > 0 && (
        <div className="banner amber" style={{ fontSize: 13, gap: 4 }}>
          <strong>
            Not at {names(chosen)} ({plan.around.missing.length})
          </strong>
          <ul className="missing-list">
            {plan.around.missing.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
          <span>No alternative there either. They'll be listed separately while you shop, so you don't forget them.</span>
        </div>
      )}
      {plan && <StockCheck entries={entries} recs={recs} plan={plan} skip={skip} onSkip={setSkip} />}
      <button className="btn primary block" disabled={!chosen.length} onClick={() => onStart(chosen, skip)}>
        <Icon name="cart" size={18} />{' '}
        {chosen.length
          ? `Start shopping at ${chosen.length === shops.length && shops.length > 2 ? 'all of them' : names(chosen)}${plan && plan.around.total > 0 ? ` · about ${money(plan.around.total)}` : ''}`
          : 'Tick a shop'}
      </button>
    </Sheet>
  );
}

/** Big, simple, in-store view: tick things off, see the trolley total, show your card. */
function ShoppingMode({
  c: all,
  shops,
  chosen,
  skip,
  compare,
  entries: allEntries,
  categories,
  onChangeShops,
  onClose,
}: {
  c: Ctx;
  shops: StoreChain[];
  /** The shops you're going to today. */
  chosen: StoreChain[];
  /** Out of stock, and skipped for this trip. */
  skip: Set<string>;
  compare: 'unit' | 'price';
  entries: ListEntry[];
  categories: Category[];
  onChangeShops: () => void;
  onClose: () => void;
}) {
  // ⓘ on a line: what the product looks like, to find it on the shelf (0.7.3).
  const [info, setInfo] = useState<PreviewProduct>();
  // Everything priced at only the shops picked (ticked rows too, so they keep their shop and price).
  const entries = allEntries.filter((e) => !skip.has(e.id));
  const skipped = allEntries.filter((e) => skip.has(e.id));
  const recs = onlyAt(all.recs, chosen);
  const c: Ctx = {
    ...all,
    recs,
    totals: shopTotals(
      entries.map((e) => ({ ...e, checked: false })),
      recs,
      chosen as never,
      compare,
    ),
    order: [...chosen, 'other', 'any'],
  };
  const elsewhere = (e: ListEntry) => (e.groupId ? !dealFor(c, e) : !!e.chain && e.chain !== 'other' && !chosen.includes(e.chain as StoreChain));
  const cards = useLive(allCards, []);
  const [card, setCard] = useState<LoyaltyCard>();

  // Keep the screen on while shopping.
  useEffect(() => {
    let lock: { release: () => Promise<void> } | undefined;
    const nav = navigator as Navigator & {
      wakeLock?: {
        request: (t: 'screen') => Promise<{ release: () => Promise<void> }>;
      };
    };
    nav.wakeLock
      ?.request('screen')
      .then((l) => (lock = l))
      .catch(() => undefined);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => {
      void lock?.release().catch(() => undefined);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const order = new Map(categories.map((cat, i) => [cat.id, i]));
  const catOf = (e: ListEntry) => recFor(c, e)?.group.categoryId ?? e.categoryId;
  const byAisle = (a: ListEntry, b: ListEntry) => (order.get(catOf(a) ?? '') ?? 99) - (order.get(catOf(b) ?? '') ?? 99);
  const inTrolley = entries.filter((e) => e.checked && !elsewhere(e)).reduce((s, e) => s + (priceOf(c, e) ?? 0), 0);
  const notHere = entries.filter((e) => elsewhere(e));
  const left = entries.filter((e) => !e.checked);
  const toast = useNav().toast;

  /** Scan something going into the trolley: tick it off, and say if the price matches. */
  const scanToTick = async () => {
    const out = await scanBarcode('Scan to tick it off');
    if (!out.ok) return;
    const match = left.find((e) => {
      const r = recFor(c, e);
      return !!r && r.options.some((o) => o.product.barcode === out.code);
    });
    if (!match) {
      toast("That isn't on this list.");
      return;
    }
    await updateListEntry(match.id, { checked: true });
    const r = recFor(c, match)!;
    const o = r.options.find((x) => x.product.barcode === out.code);
    const want = dealFor(c, match);
    const name = r.group.name;
    if (o && want && o.product.id !== want.product.id)
      toast(`${name} ticked. Restock picked ${want.product.name}, ${money(want.price)}, at ${chainName(want.product.chain)}.`);
    else toast(`${name} ticked${want?.price !== undefined ? `, ${money(want.price)}` : ''}.`);
  };

  const shelfLook = (e: ListEntry): PreviewProduct | undefined => {
    const o = dealFor(c, e) ?? recFor(c, e)?.options[0];
    if (o) return previewFromOption(o);
    return e.product ? { ...e.product, price: e.price } : undefined;
  };

  return (
    <div className="shopmode" role="dialog" aria-label="Shopping">
      <div className="shopmode-top">
        <div style={{ flex: 1 }}>
          <div className="title" style={{ fontSize: 18 }}>
            Shopping
          </div>
          <div className="small num">
            In the trolley: <strong>{money(inTrolley)}</strong> · {left.length} to go
          </div>
          {chosen.length < shops.length && (
            <button className="linkish small" style={{ padding: 0 }} onClick={onChangeShops}>
              At {chosen.map((x) => chainName(x)).join(', ')} · change
            </button>
          )}
        </div>
        <button className="icon-btn" aria-label="Scan to tick off" onClick={() => void scanToTick()}>
          <Icon name="scan" size={20} />
        </button>
        <button className="btn small primary" onClick={onClose}>
          Done
        </button>
      </div>
      {cards && cards.length > 0 && (
        <div className="chips shopmode-cards">
          {cards.map((k) => (
            <button key={k.id} className="chip" onClick={() => setCard(k)}>
              <Icon name="card" size={16} /> Show {k.program === 'other' ? k.label : PROGRAMS[k.program].name}
            </button>
          ))}
        </div>
      )}
      <div className="shopmode-list">
        {info && <ProductPreview product={info} onClose={() => setInfo(undefined)} />}
        {c.order.map((shop) => {
          const items = entries.filter((e) => !elsewhere(e) && shopOf(c, e) === shop).sort(byAisle);
          if (!items.length) return null;
          return (
            <section key={shop}>
              <div
                className="eyebrow"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '12px 16px 4px',
                }}
              >
                {shop !== 'any' && <ChainDot chain={shop} />} {shop === 'any' ? 'Any shop' : chainName(shop)}
              </div>
              {items.map((e) => {
                const d = dealFor(c, e);
                const name = recFor(c, e)?.group.name ?? e.text;
                return (
                  <label key={e.id} className={`shoprow${e.checked ? ' got' : ''}`}>
                    <input
                      type="checkbox"
                      checked={e.checked}
                      onChange={(ev) => {
                        buzz(10);
                        void updateListEntry(e.id, {
                          checked: ev.target.checked,
                        });
                      }}
                    />
                    <span
                      style={{
                        flex: 1,
                        display: 'flex',
                        flexDirection: 'column',
                      }}
                    >
                      <span className="title" style={{ fontSize: 18 }}>
                        {qtyOf(e) > 1 && <span className="num">{qtyOf(e)} × </span>}
                        {name}
                      </span>
                      {d ? <span className="small">{d.product.name}</span> : e.product && <span className="small">{e.product.name}</span>}
                      {stockNote(c, e) && (
                        <span
                          className="small"
                          style={{ color: stockNote(c, e)!.kind === 'second' ? 'var(--green-ink)' : 'var(--amber-ink)', fontWeight: 600 }}
                        >
                          {stockNote(c, e)!.text}
                        </span>
                      )}
                    </span>
                    {priceOf(c, e) !== undefined && (
                      <span className="num" style={{ fontWeight: 700, fontSize: 16 }}>
                        {money(priceOf(c, e))}
                      </span>
                    )}
                    {shelfLook(e) && (
                      <button
                        type="button"
                        className="info-btn shop-info"
                        aria-label={`What ${name} looks like`}
                        onClick={(ev) => {
                          ev.preventDefault();
                          ev.stopPropagation();
                          setInfo(shelfLook(e));
                        }}
                      >
                        <Icon name="info" size={22} />
                      </button>
                    )}
                  </label>
                );
              })}
            </section>
          );
        })}
        {skipped.length > 0 && (
          <p className="small" style={{ padding: '12px 16px 0', margin: 0 }}>
            Skipped today (out of stock): {skipped.map((e) => recFor(all, e)?.group.name ?? e.text).join(', ')}. Still on your list.
          </p>
        )}
        {notHere.length > 0 && (
          <section>
            <div className="eyebrow" style={{ padding: '12px 16px 4px', color: 'var(--amber-ink, inherit)' }}>
              Not at {chosen.map((x) => chainName(x)).join(' or ')}
            </div>
            <p className="small" style={{ padding: '0 16px', margin: 0 }}>
              {chosen.length === 1 ? `${chainName(chosen[0])} doesn't` : "These shops don't"} sell these, and you haven't added an alternative that{' '}
              {chosen.length === 1 ? 'it does' : 'they do'}. Tick them off if you find them anyway.
            </p>
            {notHere.map((e) => {
              const best = dealFor(all, e);
              const name = recFor(all, e)?.group.name ?? e.text;
              return (
                <label key={e.id} className={`shoprow${e.checked ? ' got' : ''}`}>
                  <input
                    type="checkbox"
                    checked={e.checked}
                    onChange={(ev) => {
                      buzz(10);
                      void updateListEntry(e.id, { checked: ev.target.checked });
                    }}
                  />
                  <span style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
                    <span className="title" style={{ fontSize: 18 }}>
                      {qtyOf(e) > 1 && <span className="num">{qtyOf(e)} × </span>}
                      {name}
                    </span>
                    <span className="small">
                      {best ? `At ${chainName(best.product.chain)}: ${best.product.name}, ${money(best.price)}` : 'No price at any of your shops yet'}
                    </span>
                  </span>
                </label>
              );
            })}
          </section>
        )}
      </div>
      {card && (
        <Sheet title={card.program === 'other' ? card.label : PROGRAMS[card.program].name} onClose={() => setCard(undefined)}>
          <div className="barcode-panel">
            <CardBarcode value={card.number} />
            <span className="num" style={{ letterSpacing: 2 }}>
              {card.number}
            </span>
          </div>
          <p className="small">Turn your screen brightness up if the scanner struggles.</p>
        </Sheet>
      )}
    </div>
  );
}

/**
 * A shopping list line's details and options: the product photo and what it is, which shop (best
 * price, picked for you, unless you choose one), its category, open the pantry item, or take it off
 * the list. A pantry item's name comes from the pantry, so it isn't changed here.
 */
function EditEntry({
  entry,
  categories,
  shops,
  onClose,
  deal,
  name,
}: {
  entry: ListEntry;
  categories: { id: string; name: string }[];
  shops: StoreChain[];
  onClose: () => void;
  deal?: Option;
  /** The pantry item's name, for a line linked to one. */
  name?: string;
}) {
  const nav = useNav();
  const [looking, setLooking] = useState(false);
  // Only a hand-written line (not a pantry item) can be renamed: it has nothing else to go by.
  const [text, setText] = useState(entry.text);
  const [chain, setChain] = useState<string>(entry.chain ?? '');
  const [categoryId, setCategoryId] = useState(entry.categoryId ?? '');
  const linked = !!entry.groupId;
  const save = async () => {
    await updateListEntry(entry.id, {
      ...(linked ? {} : { text: text.trim() || entry.text }),
      chain: (chain || undefined) as Chain | undefined,
      categoryId: categoryId || undefined,
      // The price was that shop's; a different shop means it's not known any more.
      ...((chain || undefined) !== entry.chain ? { price: undefined } : {}),
    });
    onClose();
  };
  // A one-off buy found at a shop keeps what it is, so it has a photo and details too (0.7.3).
  const oneOff = !deal && entry.product ? { ...entry.product, price: entry.price } : undefined;
  if (looking && deal) return <ProductPreview product={previewFromOption(deal)} onClose={() => setLooking(false)} />;
  if (looking && oneOff) return <ProductPreview product={oneOff} onClose={() => setLooking(false)} />;
  return (
    <Sheet title={name ?? entry.text} onClose={onClose}>
      {deal ? (
        <div className="list-product">
          <button type="button" className="list-product-photo" onClick={() => setLooking(true)} aria-label={`Bigger photo of ${deal.product.name}`}>
            <Thumb src={deal.product.imageUrl} />
          </button>
          <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span className="small" style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 700 }}>
              <ChainDot chain={deal.product.chain} /> {chainName(deal.product.chain)}
            </span>
            <span className="title" style={{ fontSize: 15 }}>
              {deal.product.name}
            </span>
            {deal.product.size && !nameHasSize(deal.product.name, deal.product.size) && <span className="small">{deal.product.size}</span>}
            <span className="num" style={{ fontWeight: 700 }}>
              {money(deal.price)}
            </span>
          </span>
        </div>
      ) : (
        !linked && (
          <label className="field">
            <span>Item</span>
            <input className="input" value={text} onChange={(e) => setText(e.target.value)} />
          </label>
        )
      )}
      {(deal || oneOff) && (
        <button className="btn" onClick={() => setLooking(true)}>
          <Icon name="info" size={18} /> Product details
        </button>
      )}
      {!linked && (
        <button
          className="btn"
          onClick={() => {
            onClose();
            nav.push({ name: 'add', query: entry.text, forList: true, replaceEntry: entry.id, section: entry.section });
          }}
        >
          <Icon name="search" size={18} /> {oneOff ? 'Find a cheaper one' : 'Find the cheapest'}
        </button>
      )}
      <div className="two">
        <label className="field">
          <span>Shop</span>
          <select className="input" value={chain} onChange={(e) => setChain(e.target.value)}>
            <option value="">{linked ? 'Best price (auto)' : 'Any shop'}</option>
            {shops.map((x) => (
              <option key={x} value={x}>
                {chainName(x)}
              </option>
            ))}
            <option value="other">Other</option>
          </select>
        </label>
        <label className="field">
          <span>Category</span>
          <select className="input" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            <option value="">None</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      {linked && (
        <button
          className="btn"
          onClick={() => {
            onClose();
            nav.push({ name: 'item', groupId: entry.groupId! });
          }}
        >
          Open item
        </button>
      )}
      <button className="btn primary" onClick={save}>
        Save
      </button>
      <button
        className="btn danger"
        onClick={async () => {
          const undo = await undoable(() => deleteListEntries([entry.id]), entryRows([entry.id]));
          onClose();
          nav.toast('Removed from your shopping list', undo);
        }}
      >
        <Icon name="trash" size={18} /> Remove from shopping list
      </button>
    </Sheet>
  );
}
