import { StockTag } from '../StockTag';
import { aisleLabel, aisleOf, byAisle as sortByAisle, getAisles, type AisleAt } from '../../lib/aisles';
import { noteTicksSoon } from '../../lib/spending';
import { branchAdvice, branchName, stockRows } from '../../lib/stock';
import { useFullRefresh } from '../refresh';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { nameHasSize } from '../../lib/naming';
import { lookupBarcode, scanBarcode } from '../../lib/barcode';
import { serverMode, serverUi } from '../../server-mode/flag';
import { PhoneOnlyNote } from '../../server-mode/ui/PhoneOnly';
import {
  addListEntry,
  allCards,
  allCategories,
  allGroups,
  allListEntries,
  checkEntriesOp,
  deleteListEntries,
  findProductByBarcode,
  getSettings,
  groupProductIds,
  nowIso,
  runOps,
  uid,
  updateListEntry,
  updateSettings,
  cachedSettings,
} from '../../lib/db';
import { buzz, scannedLine, splitCount } from '../../lib/listActions';
import { loadRecommendations } from '../../lib/recs';
import { bothPrices, lineCost, type Option } from '../../lib/verdict';
import { isNative } from '../../stores/http';
import { aroundPlan, cheaperThan, recommendedStores, shopTotals, type ShopTotals } from '../../lib/shopTotals';
import { act } from '../../lib/undo'; // 0.9.5 (undo)
import { money, tidySize } from '../../lib/units';
import { useLive } from '../../lib/useLive';
import type { Recommendation } from '../../lib/verdict';
import { chainName, secondBranch, stockAtBranch, type Category, type Chain, type ListEntry, type LoyaltyCard, type Settings } from '../../types';
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
  stockWhere,
  Thumb,
  useBackLayer,
} from '../components';
import { MemberInfoTag, MultiInfoTag, StockInfoTag, SwapInfoTag, VerdictInfoTag } from '../tagInfo';
import { SendToShopSheet } from './SendToShop';
import { PickItemSheet } from './PickItem';
import { MoveManySheet, MoveToSheet } from './MoveTo'; // 0.9.6 (Move to)
import { linesToPick, pickWord } from '../../lib/homeAssistant';
import { useNav } from '../nav';
import { enabledIn, isLocalOnlyShop, LIST_NAMES, SECTION_NAMES, LIST_PLACE, listSectionsOn, priceSource, searchChainsIn, SECTIONS, type ListSection, type Section, type StoreChain } from '../../shops';
import { CardBarcode, PROGRAMS } from './Cards';
import { ShopTotalsCard } from '../shopTotalsCard';

export type ShopKey = Chain | 'any';

/** Context every row needs, worked out once per render. */
export interface Ctx {
  totals: ShopTotals;
  recs: Recommendation[];
  /** The order to show shops in: this list's shops, then Other, then Any shop. */
  order: ShopKey[];
  /** "Shopping list", "Bottle shop list" or "Health list". */
  title: string;
}

/** Which list a line is on: its pantry item's tab, or the tab it was added from (0.9.5: or General). */
export const entrySection = (e: ListEntry, groups: Map<string, Section>): ListSection =>
  (e.groupId ? groups.get(e.groupId) : undefined) ?? e.section ?? 'pantry';
/**
 * The tab whose shops a line is searched at (Find the cheapest): its own, and for a General line the
 * supermarkets (what it's searched for becomes a pantry item, so it moves to Groceries).
 */
export const searchTabOf = (s: ListSection | undefined): Section | undefined => (s === 'general' ? 'pantry' : s);
/** The shops a list's lines can be put at by hand (a line's Shop): its tab's, and for General every tab's that is on. */
export function listShops(enabled: readonly string[], section: ListSection, on: readonly ListSection[]): StoreChain[] {
  if (section !== 'general') return enabledIn(enabled, section);
  return SECTIONS.filter((x) => on.includes(x)).flatMap((x) => enabledIn(enabled, x));
}
export const recFor = (c: Ctx, e: ListEntry) => (e.groupId ? c.recs.find((r) => r.group.id === e.groupId) : undefined);
/** What to buy: the cheapest of your picks, in stock, by the chosen measure (with "Any size", as many packs as it takes). */
export const lineFor = (c: Ctx, e: ListEntry) => (e.groupId ? c.totals.pickFor.get(e.groupId) : undefined);
export const dealFor = (c: Ctx, e: ListEntry) => lineFor(c, e)?.pick;
export const shopOf = (c: Ctx, e: ListEntry): ShopKey => e.chain ?? dealFor(c, e)?.product.chain ?? 'any';
export const qtyOf = (e: ListEntry) => Math.max(1, e.qty ?? 1);
/** "3 × " for an Any size item that takes several packs (0.8.9). */
const packsOf = (c: Ctx, e: ListEntry) => {
  const n = lineFor(c, e)?.packs;
  return n && n > 1 ? `${n} × ` : '';
};
export const priceOf = (c: Ctx, e: ListEntry) => {
  const l = lineFor(c, e);
  const d = l?.pick;
  if (!d && e.price !== undefined) return Math.round(e.price * qtyOf(e) * 100) / 100;
  return d?.price === undefined ? undefined : lineCost(d, l?.qty ?? qtyOf(e));
};

/** The list as plain text, for sending to someone. */
export function listAsText(c: Ctx, open: ListEntry[], only?: ShopKey): string {
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
      lines.push(`- ${q}${name}${d ? ` (${packsOf(c, e)}${d.product.name}, ${money(d.price)})` : ''}`);
    }
    lines.push('');
  }
  return lines.join('\n').trim();
}

export async function shareText(text: string): Promise<'shared' | 'copied'> {
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

/** 0.9.5 (undo): a list line's tick, as an undoable action ("Ticked Milk · Undo"). */
export const tickEntry = (e: { id: string; text: string }, checked: boolean, name = e.text) =>
  act(`${checked ? 'Ticked' : 'Unticked'} ${name}`, async () => {
    await updateListEntry(e.id, { checked });
    noteTicksSoon(); // 0.9.14: Your data's spending (spending.ts)
  });
/** 0.9.5 (undo): a new amount; pressing + a few times is one Undo. */
export const setQty = (e: { id: string; text: string }, qty: number, name = e.text) =>
  act(`${name}: ${qty} on your list`, () => updateListEntry(e.id, { qty }), { merge: `qty:${e.id}` });
/** 0.9.5 (undo): lines off the list, as one undoable action. */
export const removeEntries = (ids: string[], label: string) => act(label, () => deleteListEntries(ids));

export function Stepper({ e }: { e: ListEntry }) {
  const q = qtyOf(e);
  return (
    <span className="stepper" role="group" aria-label={`How many ${e.text}`}>
      <button aria-label="One fewer" disabled={q <= 1} onClick={() => void setQty(e, q - 1)}>
        −
      </button>
      <span className="num">{q}</span>
      <button aria-label="One more" onClick={() => void setQty(e, q + 1)}>
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

export const LIST_TITLE: Record<ListSection, string> = { pantry: 'Shopping list', keg: 'Bottle shop list', pharmacy: 'Health list', general: 'General list' };
/** What to type in the add box, for each list. */
export const ADD_HINT: Record<ListSection, string> = {
  pantry: 'Add anything, like bananas',
  keg: 'Add anything, like a bag of ice',
  pharmacy: 'Add anything, like sunscreen',
  general: 'Add anything, like batteries',
};

/**
 * One tab's list (Pantry, Keg or Health, each with its own shops) and its totals, worked out from
 * every line and item. `picked`: the list asked for (the grocery list if that tab isn't on).
 * 0.9.3: also what the web's desktop list shows. 0.9.5: or General, a list with no pantry items:
 * its lines go under Any shop unless one is picked for them, from any tab's shops.
 */
export function listSums(allEntries: ListEntry[], allRecs: Recommendation[], settings: Settings, picked: ListSection) {
  const sectionsOn = listSectionsOn(settings);
  const section: ListSection = sectionsOn.includes(picked) ? picked : 'pantry';
  const groupSection = new Map(allRecs.map((r) => [r.group.id, r.group.section ?? 'pantry']));
  const entries = allEntries.filter((e) => entrySection(e, groupSection) === section);
  const recs = allRecs.filter((r) => (r.group.section ?? 'pantry') === section);
  const all = listShops(settings.enabledChains, section, sectionsOn);
  const shops = section === 'general' ? [...new Set(all.map(priceSource))] : searchChainsIn(settings.enabledChains, section);
  // Store totals count what's still to buy; the per-row picks include ticked rows too, so
  // a ticked item keeps its shop and price (and counts towards the trolley total).
  const totals = shopTotals(entries, recs, shops, settings.listCompare);
  const picks = shopTotals(
    entries.map((e) => ({ ...e, checked: false })),
    recs,
    shops,
    settings.listCompare,
  );
  const names = new Map(recs.map((r) => [r.group.id, r.group.name]));
  const order: ShopKey[] = [...shops, ...all.filter((x) => !shops.includes(x)), 'other', 'any'];
  const c: Ctx = { totals: picks, recs, order, title: LIST_TITLE[section] };
  return { sectionsOn, section, groupSection, entries, recs, shops, totals, picks, names, c };
}

/**
 * "Add anything" on a list: what's typed, your own pantry items that match it, and adding a line
 * (or one more of a pantry item already on the list). 0.9.3: also the web's desktop list.
 */
export function useListAdd(entries: ListEntry[], recs: Recommendation[], section: ListSection) {
  const [text, setText] = useState('');
  /** `said`: the Undo toast's words, when not the usual "Milk added to your shopping list". */
  const add = async (value: string, groupId?: string, said?: string) => {
    // 0.9.12: "2 coconut cream" is two of them.
    const { text: t, qty: n } = splitCount(value);
    if (!t) return;
    // 0.9.5: a pantry item added on General (a scan) goes on its own tab's list, as it would anywhere.
    const item = groupId && section === 'general' ? (await allGroups()).find((g) => g.id === groupId) : undefined;
    const all = item ? await allListEntries() : entries;
    const existing = groupId ? all.find((e) => !e.checked && e.groupId === groupId) : undefined;
    // 0.9.5 (undo): "Milk added to your shopping list · Undo".
    const words = existing ? (n > 1 ? `${n} more ${t} on your shopping list` : `One more ${t} on your shopping list`) : `${n > 1 ? `${n} × ` : ''}${t} added to your shopping list`;
    await act(said ?? words, async () => {
      if (existing) await updateListEntry(existing.id, { qty: qtyOf(existing) + n });
      else
        await addListEntry({
          id: uid(),
          text: t,
          groupId,
          qty: n,
          section: item ? (item.section ?? 'pantry') : section,
          checked: false,
          createdAt: nowIso(),
        });
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
  const addFromPantry = async (r: Recommendation) => {
    await add(r.group.name, r.group.id);
  };
  return { text, setText, add, pantryMatches, exactPantry, addFromPantry };
}

export function ListScreen() {
  const nav = useNav();
  // 0.9.5 (web search): on a Restock server's web page, its shop search and camera Scan (main.tsx hands them in).
  const webSearch = serverMode ? serverUi.current?.webSearch : undefined;
  const allEntries = useLive(allListEntries, []);
  const allRecs = useLive(loadRecommendations, []);
  const allCats = useLive(allCategories, []);
  const settings = useLive(getSettings, []);
  const [picked0, setSection] = useState<ListSection>(nav.section);
  // Opening the list from Home picks the grocery list even when the List tab is already open.
  useEffect(() => setSection(nav.section), [nav.section]);
  const [view, setView] = useState<'all' | 'shop' | 'aisle'>('shop');
  const [sending, setSending] = useState<'woolworths' | 'coles'>();
  const [editing, setEditing] = useState<ListEntry>();
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState(false);
  // Start shopping: first which shops you're going to today, then the in-store view for those.
  const [choosingShops, setChoosingShops] = useState(false);
  // 0.10.2: Change shops from shopping mode: closing the sheet goes back to that trip.
  const [changingFrom, setChangingFrom] = useState<StoreChain[]>();
  const [shopping, setShopping] = useState<StoreChain[]>();
  const [skipToday, setSkipToday] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<ListEntry>();
  // Shops opened on the list (0.9.0): each starts folded down to one line.
  const [openShops, setOpenShops] = useState<Set<ShopKey>>(new Set());
  // 0.9.3: lines from Home Assistant to pick a pantry item for ("Pick my milk"), on every phone and the web (listPicks.ts).
  const toPick = useLive(linesToPick, []);
  const [picking, setPicking] = useState<ListEntry>();
  // 0.10.2: a line's "Add to pantry": the same Pick sheet, straight to the shop search.
  const [pantrying, setPantrying] = useState<ListEntry>();
  const [movingMany, setMovingMany] = useState(false); // 0.9.6 (Move to)

  const full = useFullRefresh();
  // 0.9.0: the list's totals are worked out again only when the list, the prices or the settings
  // change, not on every keystroke in "Add anything" (each one goes through every item and shop).
  const sums = useMemo(
    () => (!allEntries || !allRecs || !settings ? undefined : listSums(allEntries, allRecs, settings, picked0)),
    [allEntries, allRecs, settings, picked0],
  );
  const adder = useListAdd(sums?.entries ?? [], sums?.recs ?? [], sums?.section ?? 'pantry');
  if (!allEntries || !allRecs || !allCats || !settings || !sums) return <div className="screen" />;
  const { sectionsOn, section, groupSection, entries, recs, shops, totals, names, c } = sums;
  const categories = allCats.filter((x) => x.section === section);
  const openCount = (sec: ListSection) => allEntries.filter((e) => !e.checked && entrySection(e, groupSection) === sec).length;

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

  const { text, setText, add, pantryMatches, exactPantry, addFromPantry } = adder;

  const scanToList = async () => {
    const out = await scanBarcode('Scan to add to your shopping list');
    if (!out.ok) return;
    const product = await findProductByBarcode(out.code);
    if (product) {
      const group = (await allGroups()).find((g) => groupProductIds(g).includes(product.id));
      if (group) {
        await add(group.name, group.id);
        return;
      }
    }
    const info = await lookupBarcode(out.code);
    // 0.9.5 (final review): one toast, with its Undo ("Added. Tap it to rename · Undo").
    const line = scannedLine(info.name, out.code);
    await add(line.text, undefined, line.said);
  };

  // A to Z by default (0.7.4), within each shop.
  const az = (a: ListEntry, b: ListEntry) => labelOf(a).localeCompare(labelOf(b), undefined, { sensitivity: 'base' });
  const labelOf = (e: ListEntry) => (e.groupId ? names.get(e.groupId) : undefined) ?? e.text;
  const open = entries.filter((e) => !e.checked).sort(az);
  const shopsInList = c.order.filter((shop) => open.some((e) => shopOf(c, e) === shop));
  const allOpen = shopsInList.length > 0 && shopsInList.every((x) => openShops.has(x));
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
    // Swap & save (0.8.9): one you'd also take is on sale for less than your pick. Your pick stays on the list.
    const swap =
      rec?.alt && deal && rec.alt.product.id !== deal.product.id && cheaperThan(rec.alt, deal, c.totals.by, qtyOf(e)) ? rec.alt : undefined;
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
            <label className="tick-hit">
              <input
                type="checkbox"
                checked={e.checked}
                onChange={(ev) => void tickEntry(e, ev.target.checked, title)}
                aria-label={`Got ${title}`}
              />
            </label>
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
                  {view !== 'shop' ? `${chainName(deal.product.chain)} · ` : ''}
                  {line?.packs && line.packs > 1 ? <span className="num">{line.packs} × </span> : null}
                  {deal.product.name}
                  {size}
                </span>
              )}
              {!deal && view !== 'shop' && shop !== 'any' && <span className="small">{chainName(shop)}</span>}
              {!deal && rec && <span className="small">No price yet</span>}
              {/* 0.9.6: both prices: per item, then per litre or per 100 g. */}
              {deal && bothPrices(deal) && <span className="small num">{bothPrices(deal)}</span>}
              {deal?.multi && !line?.packs && qtyOf(e) < deal.multi.n && !e.checked && (
                <span className="small" style={{ color: 'var(--green)' }}>
                  Get {deal.multi.n} for {money(deal.multi.total)}: tap + to add {deal.multi.n - qtyOf(e)} more
                </span>
              )}
            </button>
            {deal && (swap || line?.outOfStock || onSale || member || deal.multi) && (
              <span className="tags" style={{ marginTop: -3 }}>
                {line?.outOfStock ? <StockInfoTag o={deal} /> : onSale ? <VerdictInfoTag o={deal} /> : null}
                {swap && line && <SwapInfoTag label="SWAP & SAVE" line={{ ...line, pick: swap, yours: deal, packs: undefined, qty: qtyOf(e) }} />}
                <MultiInfoTag o={deal} />
                {member && <MemberInfoTag chain={deal.product.chain} hasCard={!deal.locked} />}
              </span>
            )}
            {!selecting && !e.groupId && !e.checked && toPick?.has(e.id) && (
              <button className="btn small" style={{ alignSelf: 'flex-start' }} onClick={() => setPicking(e)}>
                Pick my {pickWord(e.text)}
              </button>
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
          {/* 0.9.12: not on a line already ticked off. */}
          {!selecting && !e.groupId && !e.checked && (
            <button
              className="icon-btn"
              aria-label={`Pick my ${pickWord(e.text)}`}
              onClick={() => setPicking(e)}
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
    <div className="screen" {...full.props}>
      {full.indicator}
      {full.status}
      <div className="topbar">
        <h1>{LIST_TITLE[section]}</h1>
        {entries.length > 0 && !selecting && (
          <button className="icon-btn" aria-label="View options" onClick={() => setMenu(true)}>
            <Icon name="sliders" size={18} />
          </button>
        )}
        {entries.length > 0 && (
          selecting ? (
            <button className="btn small primary" onClick={stopSelecting}>
              Done
            </button>
          ) : (
            <button className="icon-btn" aria-label="Edit" onClick={() => setSelecting(true)}>
              <Icon name="pencil" size={18} />
            </button>
          )
        )}
      </div>
      {sectionsOn.length > 1 && (
        <div className="seg" role="tablist" aria-label="Which list">
          {sectionsOn.map((sec) => (
            <button key={sec} role="tab" aria-selected={sec === section} className={sec === section ? 'on' : ''} onClick={() => setSection(sec)}>
              <Icon name={sec} size={17} /> {LIST_NAMES[sec]}
              {openCount(sec) > 0 && <span className="count">{openCount(sec)}</span>}
            </button>
          ))}
        </div>
      )}
      <span className="sub num" style={{ marginTop: sectionsOn.length > 1 ? 0 : -8 }}>
        {open.length} item{open.length === 1 ? '' : 's'}
        {total > 0 ? ` · about ${money(total)} at the till` : ''}
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
            of your picks to get, and where. <strong>Best value</strong> picks the cheapest per 100 g, litre or item (for Any size items, as many
            packs as it takes). <strong>Lowest price</strong> picks the cheapest on the shelf. Tap any tag to see why.
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
        <input className="input" placeholder={(settings.a11y?.text ?? 1) >= 1.3 ? 'Add anything' : ADD_HINT[section]} aria-label="Add an item" value={text} onChange={(e) => setText(e.target.value)} />
        {!serverMode && (
          <button type="button" className="btn" aria-label="Scan a barcode to add" style={{ width: 52, padding: 0 }} onClick={scanToList}>
            <Icon name="scan" />
          </button>
        )}
        {/* 0.9.5 (web search): on a Restock server's web page (an iPhone), its camera Scan, by the add box. */}
        {serverMode && webSearch && <webSearch.Scan section={searchTabOf(section) ?? 'pantry'} />}
      </form>
      {/* Typed something: add just the name, or look it up at your shops for this trip (0.7.3). */}
      {pantryMatches.length > 0 && (
        <div className="card flush pantry-matches" role="list" aria-label="In your pantry">
          {pantryMatches.map((r) => (
            <button key={r.group.id} role="listitem" className="row" onClick={() => void addFromPantry(r)}>
              <Thumb src={(r.best ?? r.options[0])?.product.imageUrl} />
              <span className="grow">
                <span className="title clip" style={{ fontSize: 15 }}>
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
          {serverMode ? (
            // 0.9.5 (web search): Search the shops (when the household turned it on), or a link to Settings.
            webSearch ? <webSearch.ListButton text={text} list={section} /> : <PhoneOnlyNote compact />
          ) : (
            <button
              className="btn primary"
              onClick={() => {
                nav.push({ name: 'add', query: text.trim(), forList: true, section: searchTabOf(section) });
                setText('');
              }}
            >
              <Icon name="search" size={18} /> Search the shops
            </button>
          )}
        </div>
      )}

      {/* 0.9.5 (web search): what the shops have for what was typed or scanned. */}
      {webSearch && <webSearch.ListPanel list={section} onAdded={() => setText('')} />}

      {!entries.length && (
        <div className="empty">
          <p>This list is empty. Type anything above, scan a barcode, or tap the cart next to anything in {LIST_PLACE[section]}.</p>
        </div>
      )}

      {view === 'all' && open.length > 0 && <div className="card flush">{open.map((e) => renderRow(e))}</div>}

      {/* 0.9.5: Aisle group, the same grouping as the web: each category in your order, then Other. */}
      {view === 'aisle' &&
        open.length > 0 &&
        [
          ...categories.map((cat) => ({ key: cat.id, name: cat.name, items: open.filter((e) => (recFor(c, e)?.group.categoryId ?? e.categoryId) === cat.id) })),
          {
            key: 'other',
            name: 'Other',
            items: open.filter((e) => !categories.some((cat) => cat.id === (recFor(c, e)?.group.categoryId ?? e.categoryId))),
          },
        ]
          .filter((g) => g.items.length)
          .map((g) => (
            <section className="card flush" key={g.key} aria-label={g.name}>
              <div className="row shop-head open">
                <span className="grow shop-head-main">
                  <span className="title">{g.name}</span>
                  <span className="small">
                    {g.items.length} item{g.items.length === 1 ? '' : 's'}
                  </span>
                </span>
              </div>
              {g.items.map((e) => renderRow(e))}
            </section>
          ))}

      {view === 'shop' && shopsInList.length > 1 && !selecting && (
        <div className="list-head">
          <span className="eyebrow" style={{ margin: 0 }}>
            Your list by shop
          </span>
          <button className="linkish" onClick={() => setOpenShops(allOpen ? new Set() : new Set(shopsInList))}>
            {allOpen ? 'Collapse all' : 'Expand all'} <span className={allOpen ? 'turn-up' : 'turn-down'}><Icon name="chevron" size={14} /></span>
          </button>
        </div>
      )}
      {view === 'shop' &&
        c.order.map((shop) => {
          const items = open.filter((e) => shopOf(c, e) === shop);
          if (!items.length) return null;
          const sub = items.reduce((s, e) => s + (priceOf(c, e) ?? 0), 0);
          // Folded down to one line until you open it (0.9.0); always open with one shop, or while selecting.
          const isOpen = selecting || shopsInList.length === 1 || openShops.has(shop);
          const toggle = () =>
            setOpenShops((was) => {
              const next = new Set(was);
              if (next.has(shop)) next.delete(shop);
              else next.add(shop);
              return next;
            });
          return (
            <div className="card flush" key={shop}>
              <div className={`row shop-head${isOpen ? ' open' : ''}`}>
                {shopsInList.length > 1 && !selecting ? (
                  <button className="grow shop-head-main" onClick={toggle} aria-expanded={isOpen}>
                    <span className="title">{shop === 'any' ? 'Any shop' : <ChainName chain={shop} />}</span>
                    <span className="small">
                      {items.length} item{items.length === 1 ? '' : 's'}
                    </span>
                  </button>
                ) : (
                  <span className="grow shop-head-main">
                    <span className="title">{shop === 'any' ? 'Any shop' : <ChainName chain={shop} />}</span>
                    <span className="small">
                      {items.length} item{items.length === 1 ? '' : 's'}
                    </span>
                  </span>
                )}
                <span className="num price-col">{sub > 0 ? money(sub) : ''}</span>
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
                {isOpen && (
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
                )}
                {shopsInList.length > 1 && !selecting && (
                  <button
                    className="icon-btn"
                    style={{ width: 36, height: 36 }}
                    aria-label={`${isOpen ? 'Fold' : 'Open'} ${shop === 'any' ? 'any shop' : chainName(shop)}`}
                    aria-expanded={isOpen}
                    onClick={toggle}
                  >
                    <span className={isOpen ? 'turn-up' : 'turn-down'}><Icon name="chevron" size={16} /></span>
                  </button>
                )}
              </div>
              {isOpen && items.map((e) => renderRow(e))}
            </div>
          );
        })}

      {open.length > 0 && !selecting && (
        <ShopTotalsCard
          totals={totals}
          min={settings.shopAroundMin ?? 1}
          onOpenItem={(groupId) => nav.push({ name: 'item', groupId })}
          onFindAt={(groupId, chain, query) =>
            nav.push({
              name: 'add',
              attachTo: groupId,
              as: 'main',
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
              await removeEntries(
                done.map((e) => e.id),
                `Cleared ${n} ticked item${n === 1 ? '' : 's'}`,
              );
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
              // 0.9.0: one write for all of them, so the list reloads once, not once per item.
              const ids = [...picked];
              await act(`${ids.length} marked as got`, () => runOps([checkEntriesOp(ids)]));
              stopSelecting();
            }}
          >
            <Icon name="check" size={18} /> Got them
          </button>
          {/* 0.9.6 (Move to): the picked lines to another list, one Undo. */}
          {sectionsOn.length > 1 && (
            <button className="btn small" disabled={!picked.size} onClick={() => setMovingMany(true)}>
              <Icon name="swap" size={18} /> Move to
            </button>
          )}
          <button
            className="btn small danger"
            disabled={!picked.size}
            onClick={async () => {
              const n = picked.size;
              const ids = [...picked];
              await removeEntries(ids, `${n} removed from your shopping list`);
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
              <button aria-pressed={view === 'aisle'} onClick={() => setView('aisle')}>
                Aisle group
              </button>
              <button aria-pressed={view === 'all'} onClick={() => setView('all')}>
                One list
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

      {picking && <PickItemSheet entry={picking} fromHa={!!toPick?.has(picking.id)} onClose={() => setPicking(undefined)} />}
      {pantrying && <PickItemSheet entry={pantrying} toPantry fromHa={false} onClose={() => setPantrying(undefined)} />}

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
                // With "Any size", the number of packs it takes.
                qty: lineFor(c, e)?.qty ?? qtyOf(e),
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
          min={settings.shopAroundMin ?? 1}
          start={(() => {
            if (changingFrom) return changingFrom;
            // The recommendation on the list: one store when it wins, otherwise the shops shopping around uses.
            const pick = aroundPlan(totals, totals.by, settings.shopAroundMin ?? 1).pick;
            return pick === 'around' ? totals.around.chains : [pick.chain];
          })()}
          onClose={() => {
            setChoosingShops(false);
            if (changingFrom) setShopping(changingFrom);
            setChangingFrom(undefined);
          }}
          onStart={(chosen, skip) => {
            setChoosingShops(false);
            setChangingFrom(undefined);
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
            setChangingFrom(shopping);
            setShopping(undefined);
            setChoosingShops(true);
          }}
          onClose={() => setShopping(undefined)}
        />
      )}
      {movingMany && (
        <MoveManySheet
          ids={[...picked]}
          here={section}
          lists={sectionsOn}
          onClose={() => setMovingMany(false)}
          onDone={() => {
            setMovingMany(false);
            stopSelecting();
          }}
        />
      )}
      {editing && (
        <EditEntry
          entry={editing}
          categories={categories}
          shops={listShops(settings.enabledChains, section, sectionsOn)}
          deal={dealFor(c, editing) ?? recFor(c, editing)?.options[0]}
          name={recFor(c, editing)?.group.name}
          lists={sectionsOn}
          onPick={setPicking}
          onAddToPantry={setPantrying}
          onClose={() => setEditing(undefined)}
        />
      )}
    </div>
  );
}

/** Each item's products at these shops only, for shopping at just those. */
const onlyAt = (recs: Recommendation[], chains: StoreChain[]): Recommendation[] =>
  recs.map((r) => ({ ...r, options: r.options.filter((o) => chains.includes(o.product.chain as StoreChain)) }));

/**
 * A line in shopping mode. On the phone the whole line ticks it (a big target in the shop). 0.9.4,
 * the web on a server (design 15): only the checkbox ticks, and the line opens its product.
 */
function ShopRow({ e, name, onOpen, extra, children }: { e: ListEntry; name: string; onOpen?: () => void; extra?: ReactNode; children: ReactNode }) {
  const tick = (ev: { target: { checked: boolean } }) => {
    buzz(10);
    void tickEntry(e, ev.target.checked, name);
  };
  if (!serverMode)
    return (
      <label className={`shoprow${e.checked ? ' got' : ''}`}>
        <input type="checkbox" checked={e.checked} onChange={tick} />
        {children}
        {extra}
      </label>
    );
  return (
    <div className={`shoprow${e.checked ? ' got' : ''}`}>
      <label className="tick-hit">
        <input type="checkbox" checked={e.checked} onChange={tick} aria-label={`Got ${name}`} />
      </label>
      {onOpen ? (
        <button type="button" className="shoprow-open" onClick={onOpen} aria-label={`${name}, open the item`}>
          {children}
        </button>
      ) : (
        children
      )}
      {extra}
    </div>
  );
}

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
            <span className="title" style={{ fontSize: 15 }}>
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
  min,
  start,
  onClose,
  onStart,
}: {
  shops: StoreChain[];
  entries: ListEntry[];
  recs: Recommendation[];
  totals: ShopTotals;
  compare: 'unit' | 'price';
  /** Settings → Shopping list: what shopping around has to save. */
  min: number;
  /** Ticked to begin with: the shops the list is split across now. */
  start: StoreChain[];
  onClose: () => void;
  onStart: (chosen: StoreChain[], skip: Set<string>) => void;
}) {
  const [skip, setSkip] = useState<Set<string>>(new Set());
  const recommended = recommendedStores(totals).recommended?.chain as StoreChain | undefined;
  // RECOMMENDED only when one store wins over shopping around, as on the list (0.9.0).
  const aroundPick = aroundPlan(totals, compare, min).pick;
  const oneWins = aroundPick === 'around' ? undefined : (aroundPick.chain as StoreChain);
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
                  {branchName(cachedSettings(), x)}{' '}
                  {x === oneWins ? (
                    <span className="badge">RECOMMENDED</span>
                  ) : (
                    x === recommended && !oneWins && <span className="tag info">BEST ONE STORE</span>
                  )}
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
          <span>None of your picks are there. They'll be listed separately while you shop, so you don't forget them.</span>
        </div>
      )}
      {/* 0.9.9: which branch to go to, by stock (Coles' two branches, Woolworths signed in). */}
      {(() => {
        const advice = branchAdvice(
          entries.filter((e) => !e.checked).map((e) => {
            const r = e.groupId ? recs.find((x) => x.group.id === e.groupId) : undefined;
            return r ? stockRows(r.options.filter((o) => o.role === 'main').map((o) => o.product), cachedSettings()) : [];
          }),
        );
        return advice ? (
          <div className="banner green" role="note" style={{ fontSize: 13 }}>
            {advice}
          </div>
        ) : null;
      })()}
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

  // Back (or Escape) closes shopping mode, unless a sheet is open on top of it.
  useBackLayer(onClose);

  // Keep the screen on while shopping: asked for once, let go when shopping mode closes.
  useEffect(() => {
    let lock: { release: () => Promise<void> } | undefined;
    let done = false;
    const nav = navigator as Navigator & {
      wakeLock?: {
        request: (t: 'screen') => Promise<{ release: () => Promise<void> }>;
      };
    };
    nav.wakeLock
      ?.request('screen')
      .then((l) => {
        if (done) void l.release().catch(() => undefined);
        else lock = l;
      })
      .catch(() => undefined);
    return () => {
      done = true;
      void lock?.release().catch(() => undefined);
    };
  }, []);

  const order = new Map(categories.map((cat, i) => [cat.id, i]));
  const catOf = (e: ListEntry) => recFor(c, e)?.group.categoryId ?? e.categoryId;
  const nameOf = (e: ListEntry) => recFor(c, e)?.group.name ?? e.text;
  const azOf = (a: ListEntry, b: ListEntry) => nameOf(a).localeCompare(nameOf(b), 'en-AU', { sensitivity: 'base' });
  const byCategory = (a: ListEntry, b: ListEntry) => (order.get(catOf(a) ?? '') ?? 99) - (order.get(catOf(b) ?? '') ?? 99) || azOf(a, b);

  // 0.10.2: each shop's lines by aisle (the default; 1 to 50, or 50 to 1), category, or A–Z. Your
  // pick is remembered (Settings → Shopping list and receipts, In shopping mode, start with).
  const live = useLive(getSettings, []) ?? cachedSettings();
  const [sort, setSortState] = useState<NonNullable<Settings['shopSort']>>(() => {
    const start = cachedSettings()?.shopSort ?? { by: 'aisle' };
    // The web has no aisle numbers: it starts with your categories instead.
    return serverMode && start.by === 'aisle' ? { by: 'category' } : start;
  });
  const setSort = (next: NonNullable<Settings['shopSort']>) => {
    setSortState(next);
    void updateSettings({ shopSort: next });
  };
  // Aisle numbers are noted by the phone's price check; the web has none (they stay on the phone).
  const aisles = useLive(getAisles, []);
  // 0.10.2: which Coles you're at, when you have two (aisles and the branch name follow it).
  const [colesSlot, setColesSlot] = useState<'1' | '2'>('1');
  const colesStoreNo = live?.localPrices ? (colesSlot === '1' ? live.stores?.coles?.branchStoreNo : live.stores?.coles?.branchStoreNo2) : undefined;
  const second = secondBranch(live);
  const aisleAt = (e: ListEntry): AisleAt | undefined => {
    const d = dealFor(c, e);
    if (!d || d.product.chain !== 'coles' || !colesStoreNo) return undefined;
    return aisleOf(aisles, d.product.id, colesSlot, colesStoreNo);
  };
  const sortShop = (items: ListEntry[]) =>
    sort.by === 'az' ? [...items].sort(azOf) : sort.by === 'category' ? [...items].sort(byCategory) : sortByAisle(items, aisleAt, nameOf, !!sort.down);
  const inTrolley = entries.filter((e) => e.checked && !elsewhere(e)).reduce((s, e) => s + (priceOf(c, e) ?? 0), 0);
  const notHere = entries.filter((e) => elsewhere(e));
  const left = entries.filter((e) => !e.checked);
  const nav = useNav();
  const toast = nav.toast;
  // 0.9.4, the web on a server: a line opens its product (only the checkbox ticks); see ShopRow.
  const openOf = (e: ListEntry) => {
    const g = recFor(all, e)?.group.id;
    return serverMode && g ? () => nav.push({ name: 'item', groupId: g }) : undefined;
  };

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
    const r = recFor(c, match)!;
    const o = r.options.find((x) => x.product.barcode === out.code);
    const want = dealFor(c, match);
    const name = r.group.name;
    // 0.9.5 (undo): the message comes with Undo.
    const said =
      o && want && o.product.id !== want.product.id
        ? `${name} ticked. Restock picked ${want.product.name}, ${money(want.price)}, at ${chainName(want.product.chain)}.`
        : `${name} ticked${want?.price !== undefined ? `, ${money(want.price)}` : ''}.`;
    await act(said, () => updateListEntry(match.id, { checked: true }));
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
          <div className="title" style={{ fontSize: 17 }}>
            Shopping
          </div>
          <div className="small num">
            In the trolley: <strong>{money(inTrolley)}</strong> · {left.length} to go
          </div>
          {entries.length > 0 && (
            <div className="shop-progress" aria-hidden>
              <span style={{ width: `${Math.round(((entries.length - left.length) / entries.length) * 100)}%` }} />
            </div>
          )}
        </div>
        {!serverMode && (
          <button className="icon-btn" aria-label="Scan to tick off" onClick={() => void scanToTick()}>
            <Icon name="scan" size={20} />
          </button>
        )}
        <button className="btn small primary" onClick={onClose}>
          Done
        </button>
      </div>
      {/* 0.10.2: Change shops is a button (it was a link under the total), beside your cards. */}
      {(shops.length > 1 || (cards && cards.length > 0)) && (
        <div className="chips shopmode-cards">
          {shops.length > 1 && (
            <button className="chip" onClick={onChangeShops} aria-label={`Change shops. Shopping at ${chosen.map((x) => chainName(x)).join(', ')}`}>
              <Icon name="cart" size={16} /> Change shops
            </button>
          )}
          {cards?.map((k) => (
            <button key={k.id} className="chip" onClick={() => setCard(k)}>
              <Icon name="card" size={16} /> Show {k.program === 'other' ? k.label : PROGRAMS[k.program].name}
            </button>
          ))}
        </div>
      )}
      <div className="shopmode-sort">
        <span className="small" style={{ fontWeight: 600 }}>
          Sort by
        </span>
        <div className="seg" role="group" aria-label="Sort each shop by">
          <button type="button" aria-pressed={sort.by === 'aisle'} disabled={serverMode} onClick={() => setSort({ ...sort, by: 'aisle' })}>
            Aisle
          </button>
          <button type="button" aria-pressed={sort.by === 'category'} onClick={() => setSort({ ...sort, by: 'category' })}>
            Category
          </button>
          <button type="button" aria-pressed={sort.by === 'az'} onClick={() => setSort({ ...sort, by: 'az' })}>
            A–Z
          </button>
        </div>
        {sort.by === 'aisle' && !serverMode && (
          <button
            type="button"
            className="btn small ghost"
            onClick={() => setSort({ ...sort, down: !sort.down })}
            aria-label={sort.down ? 'Aisles 50 to 1. Tap for 1 to 50' : 'Aisles 1 to 50. Tap for 50 to 1'}
          >
            <Icon name="sort" size={14} /> {sort.down ? '50→1' : '1→50'}
          </button>
        )}
      </div>
      {serverMode && <PhoneOnlyNote compact text="Aisle numbers are in shopping mode on the phone (they come from your Coles branch)." />}
      <div className="shopmode-list">
        {info && <ProductPreview product={info} onClose={() => setInfo(undefined)} />}
        {c.order.map((shop) => {
          const items = sortShop(entries.filter((e) => !elsewhere(e) && shopOf(c, e) === shop));
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
                {shop !== 'any' && <ChainDot chain={shop} />}{' '}
                {shop === 'any' ? 'Any shop' : shop === 'coles' && colesSlot === '2' && second ? second : branchName(cachedSettings(), shop)}
                {/* 0.10.2: at your other Coles today? Its aisles instead. */}
                {shop === 'coles' && second && !serverMode && (
                  <button type="button" className="linkish small" style={{ marginLeft: 'auto', padding: 0, textTransform: 'none', letterSpacing: 0 }} onClick={() => setColesSlot(colesSlot === '1' ? '2' : '1')}>
                    At {colesSlot === '1' ? second : branchName(cachedSettings(), 'coles')} instead
                  </button>
                )}
              </div>
              {items.map((e) => {
                const d = dealFor(c, e);
                const name = recFor(c, e)?.group.name ?? e.text;
                return (
                  <ShopRow
                    key={e.id}
                    e={e}
                    name={name}
                    onOpen={openOf(e)}
                    extra={
                      <>
                        {priceOf(c, e) !== undefined && (
                          <span className="num" style={{ fontWeight: 700, fontSize: 17 }}>
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
                      </>
                    }
                  >
                    <span
                      style={{
                        flex: 1,
                        display: 'flex',
                        flexDirection: 'column',
                      }}
                    >
                      <span className="title" style={{ fontSize: 17 }}>
                        {qtyOf(e) > 1 && <span className="num">{qtyOf(e)} × </span>}
                        {name}
                      </span>
                      {d ? (
                        <span className="small">
                          {packsOf(c, e)}
                          {d.product.name}
                        </span>
                      ) : e.product && <span className="small">{e.product.name}</span>}
                      {/* 0.10.2: where it is in the shop (shopping mode only). */}
                      {!e.checked && !serverMode && (
                        <span className="tags" style={{ marginTop: 3 }}>
                          <span className={`tag ${aisleAt(e) ? 'aisle' : 'aisle-unknown'}`}>{aisleLabel(aisleAt(e))}</span>
                        </span>
                      )}
                      {stockNote(c, e) && (
                        <span
                          className="small"
                          style={{ color: stockNote(c, e)!.kind === 'second' ? 'var(--green-ink)' : 'var(--amber-ink)', fontWeight: 600 }}
                        >
                          {stockNote(c, e)!.text}
                        </span>
                      )}
                      {/* 0.9.9: stock at each shop the item is bought at, a tap away. */}
                      {!e.checked && recFor(c, e) && (
                        <span className="tags" style={{ marginTop: 3 }}>
                          <StockTag products={recFor(c, e)!.options.filter((o) => o.role === 'main').map((o) => o.product)} name={name} />
                        </span>
                      )}
                    </span>
                  </ShopRow>
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
              {chosen.length === 1 ? `${chainName(chosen[0])} doesn't` : "These shops don't"} sell any of your picks for these. Tick them off if you find them anyway.
            </p>
            {notHere.map((e) => {
              const best = dealFor(all, e);
              const name = recFor(all, e)?.group.name ?? e.text;
              return (
                <ShopRow key={e.id} e={e} name={name} onOpen={openOf(e)}>
                  <span style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
                    <span className="title" style={{ fontSize: 17 }}>
                      {qtyOf(e) > 1 && <span className="num">{qtyOf(e)} × </span>}
                      {name}
                    </span>
                    <span className="small">
                      {best ? `At ${chainName(best.product.chain)}: ${best.product.name}, ${money(best.price)}` : 'No price at any of your shops yet'}
                    </span>
                  </span>
                </ShopRow>
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
export function EditEntry({
  entry,
  categories,
  shops,
  onClose,
  deal,
  name,
  lists,
  onPick,
  onAddToPantry,
}: {
  /** 0.9.11: "Pick my cordial" opens the Pick sheet, as the line's search button does. */
  onPick?: (e: ListEntry) => void;
  /** 0.10.2: "Add to pantry" at the top, for a line that isn't a pantry item yet (added to the list only). */
  onAddToPantry?: (e: ListEntry) => void;
  entry: ListEntry;
  categories: { id: string; name: string }[];
  shops: StoreChain[];
  onClose: () => void;
  deal?: Option;
  /** The pantry item's name, for a line linked to one. */
  name?: string;
  /** 0.9.6 (Move to): the lists that are on, to move the line to another. */
  lists?: readonly ListSection[];
}) {
  const nav = useNav();
  const [looking, setLooking] = useState(false);
  const [moving, setMoving] = useState(false); // 0.9.6 (Move to)
  // Only a hand-written line (not a pantry item) can be renamed: it has nothing else to go by.
  const [text, setText] = useState(entry.text);
  // 0.9.6 (review H1): a line an earlier build put at Costco shows (and saves) as Any shop.
  const [chain, setChain] = useState<string>(isLocalOnlyShop(entry.chain) ? '' : (entry.chain ?? ''));
  const [categoryId, setCategoryId] = useState(entry.categoryId ?? '');
  const linked = !!entry.groupId;
  const save = async () => {
    await act(`Changed ${name ?? entry.text}`, () => updateListEntry(entry.id, {
      ...(linked ? {} : { text: text.trim() || entry.text }),
      chain: (chain || undefined) as Chain | undefined,
      categoryId: categoryId || undefined,
      // The price was that shop's; a different shop means it's not known any more.
      ...((chain || undefined) !== entry.chain ? { price: undefined } : {}),
    }));
    onClose();
  };
  // A one-off buy found at a shop keeps what it is, so it has a photo and details too (0.7.3).
  const oneOff = !deal && entry.product ? { ...entry.product, price: entry.price } : undefined;
  if (looking && deal) return <ProductPreview product={previewFromOption(deal)} onClose={() => setLooking(false)} />;
  if (looking && oneOff) return <ProductPreview product={oneOff} onClose={() => setLooking(false)} />;
  if (moving && lists) return <MoveToSheet entry={entry} name={name ?? entry.text} lists={lists} onClose={onClose} />;
  // 0.10.2: added to the list only ("Add to list" by mistake)? It can still go in the pantry from here.
  const tab: Section = !entry.section || entry.section === 'general' ? 'pantry' : entry.section;
  const toPantry =
    !linked && onAddToPantry ? (
      <button
        type="button"
        className="btn primary small sheet-action"
        onClick={() => {
          onClose();
          onAddToPantry(entry);
        }}
      >
        <Icon name="plus" size={16} /> Add to {SECTION_NAMES[tab].toLowerCase()}
      </button>
    ) : undefined;
  return (
    <Sheet title={name ?? entry.text} onClose={onClose} action={toPantry}>
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
            if (onPick && !oneOff) onPick(entry);
            else nav.push({ name: 'add', query: entry.text, forList: true, replaceEntry: entry.id, section: searchTabOf(entry.section) });
          }}
        >
          <Icon name="search" size={18} /> {oneOff ? 'Find a cheaper one' : `Pick my ${pickWord(entry.text)}`}
        </button>
      )}
      {/* 0.9.10: the same words on the phone and the web page: "Pick my cordial", then what it does. */}
      {!linked && !oneOff && (
        <p className="small" style={{ margin: '-4px 0 0' }}>
          Search your shops and pick the one you buy. Restock then tracks where it's cheapest.
        </p>
      )}
      <div className="two">
        <label className="field">
          <span>Shop</span>
          <select className="input" value={chain} onChange={(e) => setChain(e.target.value)}>
            <option value="">{linked ? 'Best price (auto)' : 'Any shop'}</option>
            {/* 0.9.6 (review H1): a list line is shared, so never Costco (its prices stay on this phone). */}
            {shops.filter((x) => !isLocalOnlyShop(x)).map((x) => (
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
      {/* 0.9.6 (Move to): to Groceries, Keg, Health or General (MoveTo.tsx), with Undo. */}
      {lists && lists.length > 1 && (
        <button className="btn" onClick={() => setMoving(true)}>
          <Icon name="swap" size={18} /> Move to another list
        </button>
      )}
      <button
        className="btn danger"
        onClick={async () => {
          await removeEntries([entry.id], `${name ?? entry.text} removed from your shopping list`);
          onClose();
        }}
      >
        <Icon name="trash" size={18} /> Remove from shopping list
      </button>
    </Sheet>
  );
}
