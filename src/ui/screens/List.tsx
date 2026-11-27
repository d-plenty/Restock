import { useResetOn } from '../useResetOn';
import { useChunks } from '../useChunks';
import { CheckStockButton } from '../CheckStock';
import type { StockItem } from '../../lib/stockWhere';
import { noteTicksSoon } from '../../lib/spending';
import { countTicks } from '../../lib/inventory';
import { useFullRefresh } from '../refresh';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { clearTrip, loadTrip, reopensTrip, resumeAsked, subscribeTrip, takeResume, type SavedTrip } from '../../lib/trip';
import { nameHasSize } from '../../lib/naming';
import { lookupBarcode, scanBarcode } from '../../lib/barcode';
import { serverMode, serverUi } from '../../server-mode/flag';
import { PhoneOnlyNote } from '../../server-mode/ui/PhoneOnly';
import { cleanSearch } from '../../lib/searchText';
import { addListEntry, allCategories, allGroups, allListEntries, checkEntriesOp, deleteListEntries, findProductByBarcode, groupProductIds, nowIso, runOps, uid, updateListEntry, updateSettings, cachedSettings } from '../../lib/db';
import { buzz, scannedLine, splitCount } from '../../lib/listActions';
import { loadRecommendations } from '../../lib/recs';
import { bothPrices, lineCost, type Option } from '../../lib/verdict';
import { isNative } from '../../stores/http';
import { aroundPlan, cheaperThan, shopTotals, type ShopTotals } from '../../lib/shopTotals';
import { act } from '../../lib/undo';
import { Stepper } from '../Stepper';
import { money, tidySize } from '../../lib/units';
import { kiloPrice } from '../../lib/unitPrice';
import { useLive, useSettings } from '../../lib/useLive';
import type { Recommendation } from '../../lib/verdict';
import { chainName, type Chain, type ListEntry, type Settings } from '../../types';
import { stockPlaces } from '../../lib/stockWhere';
import { ChainDot, ChainName, DetailsPanel, Hold, useBackHandler, Icon, previewFromOption, type PreviewProduct, ProductPreview, RowInfo, SelectBar, Sheet, stockWhere, storePageUrl, Thumb, ScreenWaiting } from '../components';
import { MemberInfoTag, MultiInfoTag, StockInfoTag, SwapInfoTag, VerdictInfoTag } from '../tagInfo';
import { SendToShopSheet } from './SendToShop';
import { PickItemSheet } from './PickItem';
import { MoveManySheet, MoveToSheet } from './MoveTo';
import { linesToPick, pickWord } from '../../lib/homeAssistant';
import { useNav } from '../nav';
import { enabledIn, isLocalOnlyShop, LIST_NAMES, SECTION_NAMES, LIST_PLACE, listSectionsOn, priceSource, searchChainsIn, SECTIONS, type ListSection, type Section, type StoreChain, withCustom } from '../../shops';
import { ShopTotalsCard } from '../shopTotalsCard';
import { TripShops, ShoppingMode } from './ShoppingMode';

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
const lineFor = (c: Ctx, e: ListEntry) => (e.groupId ? c.totals.pickFor.get(e.groupId) : undefined);
export const dealFor = (c: Ctx, e: ListEntry) => lineFor(c, e)?.pick;
export const shopOf = (c: Ctx, e: ListEntry): ShopKey => e.chain ?? dealFor(c, e)?.product.chain ?? 'any';
export const qtyOf = (e: ListEntry) => Math.max(1, e.qty ?? 1);
/** "3 × " for an Any size item that takes several packs (0.8.9). */
export const packsOf = (c: Ctx, e: ListEntry) => {
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
    await countTicks([e.id], checked).catch(() => undefined); // 0.13.1: what's at home follows (inventory.ts)
    noteTicksSoon(); // 0.9.14: Your data's spending (spending.ts)
  });
/** 0.9.5 (undo): lines off the list, as one undoable action. */
const removeEntries = (ids: string[], label: string) => act(label, () => deleteListEntries(ids));

// 0.13.0: the stepper has its own file (a tab's rows use it too).
export { Stepper, setQty } from '../Stepper';

/**
 * A line whose pick is out of stock where you're shopping: in stock at your second Coles (go there
 * for it), or out at both / online (skip it today, or get it somewhere else).
 */
export function stockNote(c: Ctx, e: ListEntry): { kind: 'second' | 'out'; text: string } | undefined {
  const line = lineFor(c, e);
  if (!line?.outOfStock || e.checked) return undefined;
  const p = line.pick.product;
  // 0.10.7: where it was checked (stockWhere.ts): your branch, and your second Coles
  const places = stockPlaces(cachedSettings(), p.chain);
  const first = places.where ?? chainName(p.chain);
  const second = places.where2;
  if (second && p.inStock2 === true) return { kind: 'second', text: `Out at ${first} · in stock at ${second}` };
  if (second && p.inStock2 === false) return { kind: 'out', text: `Out of stock at ${first} and ${second}` };
  return { kind: 'out', text: `Out of stock ${stockWhere(p.chain, true)}` };
}

const LIST_TITLE: Record<ListSection, string> = withCustom<string, ListSection>(
  { pantry: 'Shopping list', keg: 'Bottle shop list', pharmacy: 'Chemist list', general: 'General list' },
  (n) => `${n} list`,
);

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
  // 0.10.7: what Check stock asks about: what you'd buy for each open line, at its shop.
  const stockItems: StockItem[] = entries
    .filter((e) => !e.checked)
    .flatMap((e): StockItem[] => {
      const p = lineFor(c, e)?.pick.product;
      const name = recFor(c, e)?.group.name ?? e.text;
      if (p?.chain && p.storeProductId) return [{ name, chain: p.chain, productName: p.name, storeProductId: p.storeProductId, productId: p.id }];
      if (e.product?.storeProductId) return [{ name, chain: e.product.chain, productName: e.product.name, storeProductId: e.product.storeProductId }];
      return [];
    });
  return { sectionsOn, section, groupSection, entries, recs, shops, totals, picks, names, c, stockItems };
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
    // 0.12.6: voice typing's full stop on the end isn't part of the name.
    const { text: t, qty: n } = splitCount(cleanSearch(value));
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
  const typed = cleanSearch(text).toLowerCase();
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
  const settings = useSettings();
  const [picked0, setSection] = useState<ListSection>(nav.section);
  // Opening the list from Home picks the grocery list even when the List tab is already open.
  useResetOn([nav.section], () => setSection(nav.section));
  const [view, setView] = useState<'all' | 'shop' | 'aisle'>('shop');
  const [sending, setSending] = useState<'woolworths' | 'coles'>();
  const [editing, setEditing] = useState<ListEntry>();
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState(false);
  // 0.10.6: a shop card's Share for Woolworths or Coles: their app, or as text.
  const [sharing, setSharing] = useState<'woolworths' | 'coles'>();
  // 0.10.5: the list picker is a dropdown under the list's name (it was a row of pills).
  const [switching, setSwitching] = useState(false);
  // 0.10.5: Compare shops (the "where to shop" card) is a sheet off the summary card.
  const [comparing, setComparing] = useState(false);
  // 0.10.5: ticked items fold down to one line until opened.
  const [showDone, setShowDone] = useState(false);
  // Start shopping: first which shops you're going to today, then the in-store view for those.
  const [choosingShops, setChoosingShops] = useState(false);
  // 0.10.2: Change shops from shopping mode: closing the sheet goes back to that trip.
  const [shopping, setShopping] = useState<StoreChain[]>();
  const [skipToday, setSkipToday] = useState<Set<string>>(new Set());
  // 0.12.10: the trip is kept on this phone (lib/trip), so it can be picked up after leaving the app.
  const trip = useSyncExternalStore(subscribeTrip, () => loadTrip(), () => undefined);
  const wantResume = useSyncExternalStore(subscribeTrip, resumeAsked, () => false);
  const [resumed, setResumed] = useState<SavedTrip>();
  // The list has to be showing the trip's own list before the trip opens on it.
  const [pendingTrip, setPendingTrip] = useState<SavedTrip>();
  const reopened = useRef(false);
  const ready = !!(allEntries && allRecs && allCats && settings);
  useEffect(() => {
    if (!ready) return;
    // Opened again soon after being closed mid-shop (once), or "Resume shopping" pressed on Home.
    const first = !reopened.current;
    reopened.current = true;
    const t = loadTrip();
    const asked = takeResume();
    if (!t || shopping) return;
    if (!asked && !(first && reopensTrip(t, Date.now()))) return;
    setSection(t.section as ListSection);
    setPendingTrip(t);
  }, [ready, wantResume]); // eslint-disable-line react-hooks/exhaustive-deps
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
  /** Pick the kept trip up where it was: the same shops, the ones done, the page you were on. */
  const resumeWith = (t: SavedTrip, now: NonNullable<typeof sums>) => {
    const still = t.chosen.filter((x) => now.shops.includes(x as StoreChain)) as StoreChain[];
    // Nothing left to get on that list (ticked or removed since): the trip is over.
    if (now.section !== t.section || !now.entries.some((e) => !e.checked)) {
      clearTrip();
      return;
    }
    setSkipToday(new Set(t.skip));
    setResumed(t);
    setShopping(still.length ? still : now.shops);
  };
  useEffect(() => {
    if (!pendingTrip || !sums || picked0 !== pendingTrip.section) return;
    // Taken once: resuming may also end the kept trip (stored outside React).
    // eslint-disable-next-line react/set-state-in-effect
    setPendingTrip(undefined);
    resumeWith(pendingTrip, sums);
  }, [pendingTrip, sums, picked0]); // eslint-disable-line react-hooks/exhaustive-deps
  const adder = useListAdd(sums?.entries ?? [], sums?.recs ?? [], sums?.section ?? 'pantry');
  // 0.10.7: Back while picking items stops picking (one step), instead of leaving the list.
  useBackHandler(() => {
    setSelecting(false);
    setPicked(new Set());
    return true;
  }, selecting);
  // 0.18.1: in parts with the Simple design (useChunks.tsx)
  const chunks = useChunks();
  if (!allEntries || !allRecs || !allCats || !settings || !sums) return <ScreenWaiting back={false} name="The list" />;
  const { sectionsOn, section, groupSection, entries, recs, shops, totals, names, c, stockItems } = sums;
  const categories = allCats.filter((x) => x.section === section);
  const openCount = (sec: ListSection) => allEntries.filter((e) => !e.checked && entrySection(e, groupSection) === sec).length;
  // 0.12.6: the General list's things come along when you shop for groceries (they were easy to
  // forget on a list of their own): a folded card here, and a group at the bottom of every shop's
  // page in shopping mode. They stay on the General list, and out of this list's totals.
  // 0.12.7: with any list (it was Groceries only), so they're seen whichever list you shop from.
  const generalToo = section !== 'general' && sectionsOn.includes('general') ? allEntries.filter((e) => entrySection(e, groupSection) === 'general') : [];
  const generalOpen = generalToo.filter((e) => !e.checked);

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
  // 0.10.5: the summary card: shopping around against the best single shop, as Compare shops says.
  const plan = aroundPlan(totals, totals.by, settings.shopAroundMin ?? 1);
  const stopCount = shopsInList.filter((x) => x !== 'any' && x !== 'other').length;

  /** What a list line is, for its photo and the product sheet: its pantry item's product, or a one-off buy's snapshot. */
  const previewOf = (e: ListEntry): PreviewProduct | undefined => {
    const o = dealFor(c, e) ?? recFor(c, e)?.options[0];
    if (o) return previewFromOption(o);
    return e.product ? { ...e.product, price: e.price } : undefined;
  };

  /**
   * 0.10.5: what moved off the row into its sheet: how many, both prices, the multi-buy, every tag,
   * cheaper swap explained, and stock at your other branch.
   */
  const entryDetails = (e: ListEntry): ReactNode => {
    const latest = entries.find((x) => x.id === e.id) ?? e;
    const rec = recFor(c, latest);
    const deal = dealFor(c, latest);
    const line = lineFor(c, latest);
    const p = priceOf(c, latest);
    const member = deal?.stats.current?.memberOnly;
    const onSale = deal && (deal.verdict.kind === 'great' || deal.verdict.kind === 'good' || deal.verdict.kind === 'small');
    const swap =
      rec?.alt && deal && rec.alt.product.id !== deal.product.id && cheaperThan(rec.alt, deal, c.totals.by, qtyOf(latest)) ? rec.alt : undefined;
    const note = stockNote(c, latest);
    return (
      <>
        {deal && bothPrices(deal) && <span className="small num">{bothPrices(deal)}{p !== undefined && qtyOf(latest) > 1 ? ` · ${money(p)} for ${qtyOf(latest)}` : ''}</span>}
        {!latest.checked && (
          <div className="entry-qty">
            <span className="title">How many</span>
            <Stepper e={latest} />
          </div>
        )}
        {deal?.multi && !line?.packs && qtyOf(latest) < deal.multi.n && !latest.checked && (
          <span className="small" style={{ color: 'var(--green-ink)', fontWeight: 600 }}>
            Get {deal.multi.n} for {money(deal.multi.total)}: tap + to add {deal.multi.n - qtyOf(latest)} more
          </span>
        )}
        {deal && (swap || line?.outOfStock || onSale || member || deal.multi) && (
          <span className="tags">
            {line?.outOfStock ? <StockInfoTag o={deal} /> : onSale ? <VerdictInfoTag o={deal} /> : null}
            {swap && line && <SwapInfoTag label="CHEAPER SWAP" line={{ ...line, pick: swap, yours: deal, packs: undefined, qty: qtyOf(latest) }} />}
            <MultiInfoTag o={deal} />
            {member && <MemberInfoTag chain={deal.product.chain} hasCard={!deal.locked} short />}
          </span>
        )}
        {swap && deal && (
          <div className="banner blue" style={{ fontSize: 14 }}>
            <strong>Cheaper swap</strong>
            <span>
              {swap.product.name} at {chainName(swap.product.chain)} is {money(swap.price)}, one you said you'd also take. Tap SWAP &amp; SAVE to see why.
            </span>
          </div>
        )}
        {note && (
          <span className="small" style={{ color: note.kind === 'second' ? 'var(--green-ink)' : 'var(--amber-ink)', fontWeight: 600 }}>
            {note.text}
          </span>
        )}
      </>
    );
  };

  const renderRow = (e: ListEntry, space = true) => {
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
    // Cheaper swap (0.8.9): one you'd also take is on sale for less than your pick. Your pick stays on the list.
    const swap =
      rec?.alt && deal && rec.alt.product.id !== deal.product.id && cheaperThan(rec.alt, deal, c.totals.by, qtyOf(e)) ? rec.alt : undefined;
    // 0.10.5: a line opens its sheet (how many, both prices, cheaper swap, move, remove); the pantry
    // item's page is one tap further, from the sheet.
    const openRow = () => {
      if (selecting) pick(e.id);
      else setEditing(e);
    };
    const unpicked = !selecting && !e.groupId && !e.checked;
    const qtyOnRow = !selecting && !e.checked;
    // 0.10.5: at most one tag on the row, the one that matters most; the rest are in the sheet.
    const tag = !deal ? null : line?.outOfStock ? (
      <StockInfoTag o={deal} />
    ) : swap && line ? (
      <SwapInfoTag label="CHEAPER SWAP" line={{ ...line, pick: swap, yours: deal, packs: undefined, qty: qtyOf(e) }} />
    ) : onSale ? (
      <VerdictInfoTag o={deal} />
    ) : deal.multi ? (
      <MultiInfoTag o={deal} />
    ) : member ? (
      <MemberInfoTag chain={deal.product.chain} hasCard={!deal.locked} />
    ) : null;
    return (
      <Hold key={e.id} onLong={() => previewOf(e) && !selecting && setPreview(e)}>
        <div className={`row list-row${isPicked ? ' selected' : ''}${e.checked && !selecting ? ' got' : ''}`}>
          {selecting ? (
            // 0.10.6: a finger-sized button around the little box (it was only the 24 px box).
            <button className="tick-hit pick-hit" onClick={() => pick(e.id)} aria-pressed={isPicked} aria-label={`Select ${title}`}>
              <span className={`pick${isPicked ? ' on' : ''}`} aria-hidden>
                {isPicked && <Icon name="check" size={16} />}
              </span>
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
              // 0.12.5: the photo is just the photo (its little i moved beside the price); tapping it opens the line, as its name does
              <button type="button" className="thumb-btn" tabIndex={-1} aria-hidden onClick={openRow}>
                <Thumb src={previewOf(e)!.imageUrl} />
              </button>
            ) : space ? (
              // No photo: keep the space, so every name in the group lines up (0.7.3). 0.12.6: only
              // when something in the group has a photo; a group with none had an empty gap down its left.
              <span className="thumb-space" aria-hidden />
            ) : null)}
          <div className="grow list-row-text">
            <button className="list-row-main" onClick={openRow} aria-label={`${title}: details and options`}>
              <span className="title clip">
                {qtyOf(e) > 1 && !qtyOnRow && <span className="num">{qtyOf(e)} × </span>}
                {title}
              </span>
              {deal ? (
                <span className="small clip">
                  {view !== 'shop' ? `${chainName(deal.product.chain)} · ` : ''}
                  {line?.packs && line.packs > 1 ? <span className="num">{line.packs} × </span> : null}
                  {deal.product.name}
                  {size}
                </span>
              ) : rec ? (
                <span className="small">No price yet</span>
              ) : (
                view !== 'shop' && shop !== 'any' && <span className="small">{chainName(shop)}</span>
              )}
              {stockNote(c, e)?.kind === 'second' && <span className="small list-row-good">{stockNote(c, e)!.text}</span>}
            </button>
            {!e.checked && tag && <span className="tags">{tag}</span>}
            {/* Not a pantry item: pick the one you buy at your shops (0.9.3 "Pick my milk"). */}
            {unpicked && (
              <button className="linkish list-row-pick" onClick={() => setPicking(e)}>
                Pick my {pickWord(e.text)} <Icon name="chevron" size={13} />
              </button>
            )}
          </div>
          {/* 0.12.5: the blue i sits beside the price, as on a pantry row, and opens the line's one page */}
          {!selecting && <RowInfo name={title} onOpen={openRow} />}
          {p !== undefined && (
            <span className="num list-row-price">
              {/* 0.12.8: loose fruit and veg by the kilo, as on the shelf ticket, with the shop's price for one (or for how many) under it */}
              {(deal && !deal.multi && kiloPrice(deal.product, deal.price)?.main) || money(p)}
              {deal && !deal.multi && kiloPrice(deal.product, deal.price, qtyOf(e))?.each && (
                <span className="small list-row-each kilo-each">{kiloPrice(deal.product, deal.price, qtyOf(e))!.each}</span>
              )}
              {!(deal && !deal.multi && kiloPrice(deal.product, deal.price)) && qtyOf(e) > 1 && deal?.price !== undefined && Math.abs(deal.price * qtyOf(e) - p) < 0.005 && (
                <span className="small list-row-each">
                  {qtyOf(e)} × {money(deal.price)}
                </span>
              )}
            </span>
          )}
          {/* 0.12.5: how many, on the line itself (it was only inside the line's sheet): its own row, under the price */}
          {qtyOnRow && (
            <div className="list-row-qty">
              <span className="small">How many</span>
              <Stepper e={e} />
            </div>
          )}
        </div>
      </Hold>
    );
  };

  // 0.12.7: Start shopping asks "Which shops today?" first, with none chosen for you (TripShops),
  // then "Where are you first?". (0.10.10 went straight in at every shop on the list, and shopping at
  // fewer was a small Change shops button inside shopping mode.) With one shop there's nothing to ask.
  const resumeTrip = (t: SavedTrip) => resumeWith(t, sums);
  /** A trip you stepped out of, for this list, with things still to get. */
  const paused = !shopping && trip && trip.section === section && open.length > 0 ? trip : undefined;
  const startShopping = () => {
    clearTrip();
    setResumed(undefined);
    setSkipToday(new Set());
    // Nothing on the list is tied to a shop's product (hand-written lines only): there's nothing to
    // plan, so it goes straight to the one list.
    if (shops.length > 1 && totals.linked > 0) setChoosingShops(true);
    else setShopping(shops);
  };

  return (
    <div className="screen" {...full.props}>
      {full.indicator}
      {/* 0.12.4: the navy top every screen has: which list (Change), the add box, then Edit and the view options */}
      <div className="navy-top">
      {/* 0.10.5: the list's name is the list picker (a dropdown). 0.10.6: then Edit, and the view options. */}
      <div className="list-top">
        {/* 0.12.7: "Shopping list" is the big white title, as Pantry and More are; under it, in gold with
            its icon, is which list (the part Change switches). It was the other way round: a small gold
            "Shopping list" over a big "Groceries". */}
        {sectionsOn.length > 1 && <h1 className="list-title">Shopping list</h1>}
        <div className="list-top-row">
          {sectionsOn.length > 1 && !selecting ? (
            <button
              className="list-switch which-list"
              aria-haspopup="menu"
              aria-expanded={switching}
              aria-label={`Which list: ${LIST_NAMES[section]}, ${open.length} item${open.length === 1 ? '' : 's'}. Tap to switch list`}
              onClick={() => setSwitching((x) => !x)}
            >
              <Icon name={section} size={20} />
              <span className="list-switch-name">{LIST_NAMES[section]}</span>
              <span className="list-switch-pill">
                {/* 0.12.4: "Change" with its arrow, so it reads as the way to another list (Edit moved to the row below) */}
                Change <span className={switching ? 'turn-up' : 'turn-down'}><Icon name="chevron" size={16} /></span>
              </span>
            </button>
          ) : sectionsOn.length > 1 ? (
            // Picking items (Edit): the list's name, no Change
            <span className="list-switch which-list still">
              <Icon name={section} size={20} />
              <span className="list-switch-name">{LIST_NAMES[section]}</span>
            </span>
          ) : (
            <h1 style={{ flex: 1, margin: 0 }}>{LIST_TITLE[section]}</h1>
          )}
        </div>
        {switching && !selecting && (
          <div className="list-switch-menu" role="menu" aria-label="Pick a list">
            {sectionsOn.map((sec) => (
              <button
                key={sec}
                role="menuitemradio"
                aria-checked={sec === section}
                className={sec === section ? 'on' : ''}
                onClick={() => {
                  setSection(sec);
                  setSwitching(false);
                }}
              >
                <Icon name={sec} size={20} />
                <span className="grow">{LIST_NAMES[sec]}</span>
                <span className="num count">
                  {openCount(sec)} item{openCount(sec) === 1 ? '' : 's'}
                </span>
                {sec === section && <Icon name="check" size={18} />}
              </button>
            ))}
          </div>
        )}
      </div>

      <form
        onSubmit={(ev) => {
          ev.preventDefault();
          // A name you already track adds that item, not a blank copy of it.
          void (exactPantry ? addFromPantry(exactPantry) : add(text));
        }}
        style={{ display: 'flex', gap: 8 }}
      >
        {/* 0.12.0: it says what it does: "Add to shopping list", with its own Add button */}
        <input className="input" placeholder={(settings.a11y?.text ?? 1) >= 1.3 || serverMode ? 'Add to list' : 'Add to shopping list'} aria-label="Add to shopping list" value={text} onChange={(e) => setText(e.target.value)} />
        <button type="submit" className="btn primary" aria-label="Add to shopping list" disabled={!text.trim()} style={{ width: 52, minWidth: 52, flexShrink: 0, padding: 0 }}>
          <Icon name="plus" />
        </button>
        {!serverMode && (
          <button type="button" className="btn" aria-label="Scan a barcode to add" style={{ width: 52, minWidth: 52, flexShrink: 0, padding: 0 }} onClick={scanToList}>
            <Icon name="scan" />
          </button>
        )}
        {/* 0.9.5 (web search): on a Restock server's web page (an iPhone), its camera Scan, by the add box. */}
        {serverMode && webSearch && <webSearch.Scan section={searchTabOf(section) ?? 'pantry'} />}
      </form>
      {entries.length > 0 && (
        <div className="navy-tools">
          <span className="num">
            {selecting ? 'Pick items' : `${open.length} to get`}
          </span>
          {selecting ? (
              <button className="btn small primary" onClick={stopSelecting}>
                Done
              </button>
            ) : (
              // 0.10.6: Edit (pick items to move, delete or tick) out where it's seen, and the view
              // options behind the sliders.
              <>
                <button className="btn small edit-btn" aria-label="Edit the list: pick items" onClick={() => setSelecting(true)}>
                  <Icon name="pencil" size={16} /> Edit
                </button>
                <button className="icon-btn" aria-label="View options: by shop, aisle group, one list" onClick={() => setMenu(true)}>
                  <Icon name="sliders" size={20} />
                </button>
              </>
            )}
        </div>
      )}
      </div>
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
      {/* 0.10.5: one summary card: the total, what shopping around saves, and Compare. 0.10.10: Compare
          shops is a big green button in the card (it was green words off to one side), with Check
          stock beside it, smaller (it sat on its own under the card, with nothing beside it). */}
      {open.length > 0 &&
        (totals.linked > 0 && plan.priced && !selecting ? (
          <section className="card list-sum" aria-label="Your list's total">
            <span className="list-sum-text">
              <span className="small">
                {open.length} item{open.length === 1 ? '' : 's'}
                {stopCount > 0 ? ` · ${stopCount} shop${stopCount === 1 ? '' : 's'}` : ''} · {settings.listCompare === 'unit' ? 'Best value' : 'Lowest price'}
              </span>
              <span className="list-sum-total num">{total > 0 ? `about ${money(total)}` : 'No prices yet'}</span>
              {plan.pick === 'around' && plan.saving !== undefined && plan.saving >= 0.005 ? (
                <span className="list-sum-note">Shopping around saves {money(plan.saving)} vs one shop</span>
              ) : plan.pick !== 'around' ? (
                <span className="list-sum-note">Cheapest in one trip: {chainName(plan.pick.chain)}</span>
              ) : null}
            </span>
            <span className="list-sum-btns">
              <button className="btn primary list-sum-go" onClick={() => setComparing(true)}>
                <Icon name="chart" size={18} /> Compare shops
              </button>
              <CheckStockButton items={stockItems} compact />
            </span>
          </section>
        ) : (
          <span className="sub num">
            {open.length} item{open.length === 1 ? '' : 's'}
            {total > 0 ? ` · about ${money(total)}` : ''}
          </span>
        ))}
      {/* 0.10.7: stock, only when asked. 0.10.10: in the summary card when there is one. */}
      {open.length > 0 && !selecting && !(totals.linked > 0 && plan.priced) && (
        <div className="list-stock-row">
          <CheckStockButton items={stockItems} />
        </div>
      )}

      {firstTime && (
        <div className="card hint">
          <span style={{ flex: 1 }}>
            {/* 0.10.10: three short sentences (it was a paragraph; Best value and Lowest price are explained in Compare shops) */}
            <strong>This list is just this trip.</strong> Each line shows the cheapest of your picks, and where. Tap a tag to see why.
          </span>
          <button className="icon-btn" aria-label="Got it" onClick={() => updateSettings({ seenHints: [...settings.seenHints, 'list'] })}>
            <Icon name="close" size={16} />
          </button>
        </div>
      )}

      {/* 0.9.5 (web search): what the shops have for what was typed or scanned. */}
      {webSearch && <webSearch.ListPanel list={section} onAdded={() => setText('')} />}

      {!entries.length && (
        <div className="empty">
          <p>This list is empty. Type anything above, scan a barcode, or tap the cart next to anything in {LIST_PLACE[section]}.</p>
        </div>
      )}

      {view === 'all' && open.length > 0 && (
        <>
          <div className="card flush">{open.slice(0, chunks.limit).map((e) => renderRow(e, open.some((x) => !!previewOf(x))))}</div>
          {chunks.more(open.length)}
        </>
      )}

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
              {g.items.map((e) => renderRow(e, g.items.some((x) => !!previewOf(x))))}
            </section>
          ))}

      {/* 0.10.6: Open all / Close all, out where it's seen (it was in the ⋯ menu). */}
      {view === 'shop' && shopsInList.length > 1 && !selecting && (
        <div className="list-head">
          <span className="eyebrow" style={{ margin: 0 }}>
            Your list by shop
          </span>
          <button className="linkish" onClick={() => setOpenShops(allOpen ? new Set() : new Set(shopsInList))}>
            {allOpen ? 'Close all' : 'Open all'} <span className={allOpen ? 'turn-up' : 'turn-down'}><Icon name="chevron" size={14} /></span>
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
                      {shop === 'any' && sub === 0 ? ' · no price yet' : ''}
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
                {/* 0.10.6: every shop's list has Share again. Woolworths and Coles ask: their app, or as text. */}
                {!selecting && (
                  <button
                    className="icon-btn"
                    style={{ flex: 'none' }}
                    aria-label={`Share the ${shop === 'any' ? 'any shop' : chainName(shop)} list`}
                    onClick={async () => {
                      if (shop === 'woolworths' || shop === 'coles') return setSharing(shop);
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
                    style={{ flex: 'none' }}
                    aria-label={`${isOpen ? 'Fold' : 'Open'} ${shop === 'any' ? 'any shop' : chainName(shop)}`}
                    aria-expanded={isOpen}
                    onClick={toggle}
                  >
                    <span className={isOpen ? 'turn-up' : 'turn-down'}><Icon name="chevron" size={16} /></span>
                  </button>
                )}
              </div>
              {isOpen && items.map((e) => renderRow(e, items.some((x) => !!previewOf(x))))}
            </div>
          );
        })}

      {/* 0.12.6: what's on the General list, folded: it comes along when you shop */}
      {generalOpen.length > 0 && !selecting && (
        <details className="card flush fold list-general">
          <summary className="fold-head">
            <span className="grow">
              <span className="title">General list</span>
              <span className="small">
                {generalOpen.length} item{generalOpen.length === 1 ? '' : 's'} to get anywhere · shown at every shop when you start shopping
              </span>
            </span>
            <span className="fold-arrow">
              <Icon name="chevron" size={16} />
            </span>
          </summary>
          <div className="fold-body">
            <ul className="list-general-names">
              {generalOpen.map((e) => (
                <li key={e.id}>
                  {qtyOf(e) > 1 && <span className="num">{qtyOf(e)} × </span>}
                  {e.text}
                  {e.chain && <span className="small"> · {chainName(e.chain)}</span>}
                </li>
              ))}
            </ul>
            <button className="btn block" onClick={() => setSection('general')}>
              Open the General list
            </button>
          </div>
        </details>
      )}

      {/* 0.10.5: ticked items fold down to one line, with Clear. */}
      {done.length > 0 && (
        <div className={`card flush list-done${showDone || selecting ? ' open' : ''}`}>
          <div className="row list-done-head">
            <button className="grow list-done-toggle" aria-expanded={showDone || selecting} onClick={() => setShowDone((x) => !x)}>
              <Icon name="check" size={18} />
              <span className="title">
                Got it · {done.length} item{done.length === 1 ? '' : 's'}
              </span>
              <span className={showDone || selecting ? 'turn-up' : 'turn-down'}>
                <Icon name="chevron" size={16} />
              </span>
            </button>
            {!selecting && (
              <button
                className="linkish"
                onClick={async () => {
                  const n = done.length;
                  await removeEntries(
                    done.map((e) => e.id),
                    `Cleared ${n} ticked item${n === 1 ? '' : 's'}`,
                  );
                }}
              >
                Clear
              </button>
            )}
          </div>
          {(showDone || selecting) && done.map((e) => renderRow(e, done.some((x) => !!previewOf(x))))}
        </div>
      )}

      {selecting && (
        <SelectBar
          count={picked.size}
          total={entries.length}
          onAll={() => setPicked(new Set(entries.map((e) => e.id)))}
          onNone={() => setPicked(new Set())}
        >
          <button
            className="btn small"
            disabled={!picked.size}
            onClick={async () => {
              // 0.9.0: one write for all of them, so the list reloads once, not once per item.
              const ids = [...picked];
              await act(`${ids.length} marked as got`, async () => {
                // 0.13.1: only the ones that weren't ticked already count towards what's at home
                const fresh = entries.filter((e) => picked.has(e.id) && !e.checked).map((e) => e.id);
                await runOps([checkEntriesOp(ids)]);
                await countTicks(fresh, true).catch(() => undefined);
              });
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
          {paused ? (
            // 0.12.10: a trip you stepped out of: carry on with it, or begin again
            <div className="two trip-pair">
              <button className="btn primary" onClick={() => resumeTrip(paused)}>
                Resume shopping
              </button>
              <button className="btn" onClick={startShopping}>
                Start fresh
              </button>
            </div>
          ) : (
            <button className="btn primary block" onClick={startShopping}>
              <Icon name="cart" size={18} /> Start shopping{total > 0 ? ` · about ${money(total)}` : ''}
            </button>
          )}
        </div>
      )}

      {comparing && (
        <Sheet title="Compare shops" onClose={() => setComparing(false)}>
          <div className="seg" role="group" aria-label="Pick the cheapest by">
            <button aria-pressed={settings.listCompare === 'unit'} onClick={() => updateSettings({ listCompare: 'unit' })}>
              Best value
            </button>
            <button aria-pressed={settings.listCompare === 'price'} onClick={() => updateSettings({ listCompare: 'price' })}>
              Lowest price
            </button>
          </div>
          <p className="small" style={{ margin: 0 }}>
            <strong>Best value</strong> picks the cheapest per 100 g, litre or item. <strong>Lowest price</strong> picks the cheapest on the shelf.
          </p>
          <ShopTotalsCard
            totals={totals}
            min={settings.shopAroundMin ?? 1}
            onOpenItem={(groupId) => {
              setComparing(false);
              nav.push({ name: 'item', groupId });
            }}
            onFindAt={(groupId, chain, query) => {
              setComparing(false);
              nav.push({ name: 'add', attachTo: groupId, as: 'main', chain, query });
            }}
          />
          <button
            className="btn primary block"
            onClick={() => {
              setComparing(false);
              startShopping();
            }}
          >
            <Icon name="cart" size={18} /> Start shopping{total > 0 ? ` · about ${money(total)}` : ''}
          </button>
        </Sheet>
      )}

      {menu && (
        <Sheet title="View options" onClose={() => setMenu(false)}>
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
          {/* 0.10.10: Best value or Lowest price is set in one place, Compare shops (it was here too) */}
          <button
            className="btn"
            onClick={async () => {
              const how = await shareText(listAsText(c, open));
              setMenu(false);
              nav.toast(how === 'shared' ? 'Shared' : 'Copied the list, ready to paste');
            }}
          >
            <Icon name="share" size={18} /> Share the whole list as text
          </button>
        </Sheet>
      )}

      {sharing && (
        <Sheet title={`Share the ${chainName(sharing)} list`} onClose={() => setSharing(undefined)}>
          <button
            className="btn primary block"
            onClick={() => {
              const shop = sharing;
              setSharing(undefined);
              setSending(shop);
            }}
          >
            <Icon name="cartPlus" size={18} /> Send to the {chainName(sharing)} app
          </button>
          <button
            className="btn block"
            onClick={async () => {
              const shop = sharing;
              setSharing(undefined);
              const how = await shareText(listAsText(c, open, shop));
              nav.toast(how === 'shared' ? 'Shared' : 'Copied, ready to paste');
            }}
          >
            <Icon name="share" size={18} /> Share as text
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
        <TripShops
          shops={shops}
          entries={entries}
          recs={recs}
          totals={totals}
          compare={settings.listCompare}
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
          general={generalToo}
          categories={categories}
          section={section}
          recs={recs}
          resume={resumed}
          onClose={() => {
            setShopping(undefined);
            setResumed(undefined);
          }}
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
          details={entryDetails(editing)}
        />
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
  details,
  alternative,
}: {
  /** 0.12.7: the product showing is an "Also happy with" one, standing in on this trip. */
  alternative?: boolean;
  /** 0.10.5: the line's how many, prices, tags and cheaper swap (worked out by the list). */
  details?: ReactNode;
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
  // 0.12.5: Shop, Category, Pantry item, Move to and Remove are folded under "Edit this item"
  const [editOpen, setEditOpen] = useState(false);
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
  const shown: PreviewProduct | undefined = deal ? previewFromOption(deal) : oneOff;
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
              {(!deal.multi && kiloPrice(deal.product, deal.price)?.main) || money(deal.price)}
            </span>
            {!deal.multi && kiloPrice(deal.product, deal.price)?.each && <span className="small num kilo-each">{kiloPrice(deal.product, deal.price)!.each}</span>}
            {linked && (
              <span className="tags">
                {/* 0.12.7: a trip can offer an alternative as the one to get: it's still tagged as one */}
                <span className={`tag ${deal.role === 'alt' || alternative ? 'alt' : 'normal'}`}>{deal.role === 'alt' || alternative ? 'ALSO HAPPY WITH' : 'MY PICK'}</span>
              </span>
            )}
          </span>
        </div>
      ) : null}
      {details}
      {/* 0.12.5: one page: the product's details open here (they were two taps away), with the shop's own page */}
      {shown && <DetailsPanel product={shown} />}
      {shown && storePageUrl(shown) && (
        <a className="btn" href={storePageUrl(shown)} target="_blank" rel="noreferrer" style={{ textDecoration: 'none' }}>
          <Icon name="external" size={18} /> See it on the {chainName(shown.chain)} website
        </a>
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
      {/* 0.12.8: straight to the item itself (it was a small "Pantry item" button folded under Edit this item) */}
      {linked && (
        <button
          className="btn"
          onClick={() => {
            onClose();
            nav.push({ name: 'item', groupId: entry.groupId! });
          }}
        >
          <Icon name={tab} size={18} /> Open in {SECTION_NAMES[tab]}
        </button>
      )}
      <details className="explain entry-edit" open={editOpen} onToggle={(ev) => setEditOpen((ev.currentTarget as HTMLDetailsElement).open)}>
        <summary>
          <Icon name="pencil" size={18} />
          <span>Edit this item</span>
        </summary>
        <div className="explain-body">
      {!deal && !linked && (
        <label className="field">
          <span>Item</span>
          <input className="input" value={text} onChange={(e) => setText(e.target.value)} />
        </label>
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
      {/* 0.10.5: Pantry item and Move to side by side. */}
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
        </div>
      </details>
      {/* The main button: Save once the edit box is open (the shop, category or name may have changed), else Done */}
      <button className="btn primary" onClick={editOpen ? save : onClose}>
        {editOpen ? 'Save' : 'Done'}
      </button>
    </Sheet>
  );
}
