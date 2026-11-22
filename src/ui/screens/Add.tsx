import { tidyItemName } from '../../lib/itemName';
import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { seenBefore, type SeenBefore } from '../../lib/seen';
import { cleanSearch } from '../../lib/searchText';
import { confidentCategoryId, guessCategoryId } from '../../lib/categoryGuess';
import { suggestName } from '../../lib/nameSuggest';
import { NameFirst } from './NameFirst';
import { sameNameItem, sameNameWords } from '../../lib/sameName';
import { kiloPrice } from '../../lib/unitPrice';
import { flavourBarNote, otherFlavours, varietyWord } from '../../lib/flavours';
import { act } from '../../lib/undo'; // 0.9.5 (undo)
import { productCode, scanBarcode, type BarcodeInfo } from '../../lib/barcode';
import { displayName, identifyBarcode, QUICK_PICKS, searchTermFor, weakName } from '../../lib/lookup';
import { PackReader } from '../PackReader';
import { markMatched, onScanLines, toMatch } from '../../lib/scanQueue';
import { okToLeave, useLeaveGuard } from '../leaveGuard';
import { logProblem } from '../../lib/diagnostics';
import {
  addGroup,
  addListEntry,
  deleteListEntries,
  addProduct,
  addReading,
  allCategories,
  allGroups,
  allProducts,
  findProductByBarcode,
  getGroup,
  getProducts,
  getSettings,
  groupProductIds,
  nowIso,
  readingsFor,
  uid,
  removeProductFromGroup,
  updateGroup,
  updateProduct,
  updateSettings,
} from '../../lib/db';
import { pickItemFor, pickItemOffList } from '../../lib/listPicks';
import { addToList } from '../../lib/listActions'; // 0.9.5 (undo)
import { genericName, nameHasSize } from '../../lib/naming';
import { shareTextFile } from '../../lib/backup';
import { slim } from '../../lib/searchTest';
import {
  bestMatches,
  bestScore,
  brandOnly,
  sameCode,
  type BestMatch,
  type Candidate,
  whichOne,
  UNLIKELY,
  likeThis,
  matchesFor,
  normaliseQuery,
  queryChanged,
  recentSearches,
  rememberSearch,
  clearRecentSearches,
  unitOf,
  unitTextOf,
  scoreAll,
  topPicks,
  intendedKind,
  weakShops,
  type Scored,
} from '../../lib/searchHelp';
import { money, packSize, parseMoney, tidySize } from '../../lib/units';
import { localDay } from '../../lib/verdict';
import { useLive } from '../../lib/useLive';
import { adapterFor, type StoreProduct } from '../../stores';
import { shopDetails } from '../../stores/details';
import { BlockedError, isNative, NativeOnlyError } from '../../stores/http';
import { CostcoLines } from '../CostcoLines';
import { COSTCO_LIST_NOTE } from '../../lib/costcoLocal';
import { isBlockedError, offerUnblock, recordHealth } from '../../lib/health';
import { UnblockButton } from '../Unblock';
import { isExactBarcode, rankAll, score, tokens, type RankQuery } from '../../stores/rank';
import { mentions } from '../../stores/rank';
import { chainName, mainProductIds, searchStoreId, type AlertLevel, type Chain, type Group, type ListEntry, type ListProduct } from '../../types';
import {
  activeSections,
  costcoIsOn,
  enabledIn,
  isLocalOnlyShop,
  SECTION_NAMES,
  SECTION_PLACE,
  SECTION_SHOPS,
  searchChainsIn,
  shopDef,
  type Section,
  type StoreChain,
  kindOf as shopKindOf, slots } from '../../shops';

// Short enough to show in full at 390 px wide with the largest text (0.9.5: "Or search a proc…").
const SEARCH_PLACEHOLDER: Record<Section, string> = {
  pantry: 'Search products',
  keg: 'Search drinks',
  pharmacy: 'Search Chemist',
  baby: 'Search Baby',
  pets: 'Search Pets',
  ...slots('Search products'),
};
/** Small buttons and links still get a 44 px target. */
const TAP: CSSProperties = { minHeight: 44 };
import { ChainDot, ChainName, Hold, Icon, useBackHandler, LoadingBar, MoreInfo, ProductPreview, RowInfo, Sheet, specialTag, Thumb, TopBar, type PreviewProduct, SearchField } from '../components';
import { useNav } from '../nav';
import { OtherSizesCard } from '../OtherSizes';
import { ItemRow, type NoteTone } from '../simple';
import { keyOf, sheetOpenAfter, tickMessage, togglePick } from './addPicks';
import { addItemForLineUndoable, addItemFromPicks, pickedWords, saveStoreProducts } from './addSave';
import { attachPatch, rolesIn, uniqueProducts } from './attachOne';
import { AlertPicker } from './Item';
import { CategoryPick } from './Categories';
import { AddBtn, AddPair, addButtonsNote, addToWord, AlwaysTick, pickButtonsNote, toPantryNote } from './addPickWords';

/**
 * 0.9.5: "Search the shops" from the Pick sheet, for a list line that matches nothing in the pantry
 * ("chopsticks" from Home Assistant). The Add tab's own search, ticks and bar; adding makes the
 * pantry item and links the line to it.
 */
export interface ForLine {
  entry: ListEntry;
  /** The line's words ("chopsticks"). */
  word: string;
  /** "Always use this for chopsticks". */
  always: boolean;
  onAlways: (on: boolean) => void;
  /** The line now is this item (`made`: a new one). `linked` false: the line had gone meanwhile. */
  onDone: (group: { id: string; name: string }, made: boolean, linked: boolean) => void;
  /** 0.9.11: "Add to list" (no pantry item): the line was replaced, so the sheet just closes. */
  onListed: () => void;
  /** 0.10.2: the line sheet's "Add to pantry": one button (PickButtons), the item made and the line kept as it. */
  toPantry?: boolean;
  /** 0.10.2: the shop's product the line came from, ticked again once that shop's results are in. */
  preTick?: ListProduct;
}

type ChainResult =
  | { status: 'loading' }
  | {
      status: 'ok';
      items: StoreProduct[];
      /** Best first, with how well each matched (0.8.5). */
      scored?: Scored[];
      /** The ones worth recommending (keys). */
      top?: string[];
      /** Pages fetched so far, and whether the shop has more. */
      page?: number;
      more?: boolean;
      loadingMore?: boolean;
    }
  | { status: 'error'; message: string; blocked?: boolean; unblock?: boolean };

/** A shop sending back fewer than this on a page has no more to send. */
const FULL_PAGE = 12;

type SortKey = 'relevant' | 'unit' | 'low' | 'high';
const SORTS: { id: SortKey; label: string }[] = [
  { id: 'relevant', label: 'Most relevant' },
  { id: 'unit', label: 'Best value (unit price)' },
  { id: 'low', label: 'Price: low to high' },
  { id: 'high', label: 'Price: high to low' },
];

function sorted(items: StoreProduct[], by: SortKey): StoreProduct[] {
  if (by === 'relevant') return items;
  if (by === 'unit') {
    const u = (p: StoreProduct) => unitOf(p)?.per ?? Infinity;
    return [...items].sort((a, b) => u(a) - u(b));
  }
  const price = (p: StoreProduct) => p.price ?? (by === 'low' ? Infinity : -Infinity);
  return [...items].sort((a, b) => (by === 'low' ? price(a) - price(b) : price(b) - price(a)));
}

const FIRST_PAGE = 5;
const MORE_PAGE = 10;
type Target = 'pantry' | 'list' | 'both';


/**
 * The same product at another shop, found by opening the shop's own page for its top few results:
 * the same barcode, or the same brand and size with the product type (from the scan or the product
 * you picked) in its description. Only on the phone, where the shops' pages can be read.
 */
async function matchByDetails(
  anchor: StoreProduct,
  items: StoreProduct[],
  kind: string,
  barcode: string | undefined,
  colesStore?: string,
): Promise<StoreProduct | undefined> {
  const size = packSize(anchor.size, anchor.name);
  const kindWords = tokens(kind);
  const sameSize = (p: StoreProduct) => {
    const q = packSize(p.size, p.name);
    return !!size && !!q && q.unit === size.unit && Math.abs(q.qty / size.qty - 1) <= 0.05;
  };
  const brand = tokens(anchor.brand ?? '');
  const hasBrand = (p: StoreProduct) => brand.length > 0 && brand.every((w) => tokens(`${p.brand ?? ''} ${p.name}`).includes(w));
  // Barcodes first; for descriptions, only same-brand, same-size products are worth opening.
  const look = items.filter((p) => barcode || (hasBrand(p) && sameSize(p))).slice(0, 5);
  for (const p of look) {
    const d = await shopDetails(p, colesStore);
    if (!d) continue;
    if (barcode && d.barcode && sameCode(d.barcode, barcode)) return { ...p, barcode: d.barcode };
    const words = tokens(`${d.description ?? ''} ${p.name}`);
    if (hasBrand(p) && sameSize(p) && kindWords.length && kindWords.every((w) => words.includes(w))) return p;
  }
  return undefined;
}

/** "25 Oct" (and the year when it isn't this one) for a remembered day, YYYY-MM-DD. */
const seenDay = (day: string) => {
  const d = new Date(`${day}T12:00:00`);
  return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', ...(d.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}) });
};

export function AddScreen({
  barcode,
  attachTo,
  as = 'main',
  another,
  query,
  onlyChain,
  section: sectionProp = 'pantry',
  forList,
  replaceEntry,
  overlay,
  forLine,
  fromScans,
  toPantry,
  scan,
  preTick: preTickProp,
}: {
  barcode?: string;
  attachTo?: string;
  as?: 'main' | 'alt';
  /** Another product you buy as this item: search every shop. */
  another?: boolean;
  query?: string;
  onlyChain?: StoreChain;
  /** Which tab's shops to search. Adding to an existing item always uses that item's tab. */
  section?: Section;
  /** From the shopping list: only "add to the list for this trip", nothing goes in the pantry. */
  forList?: boolean;
  replaceEntry?: string;
  overlay?: boolean;
  /** Inside the Pick sheet: make a pantry item for this list line (see ForLine). */
  forLine?: ForLine;
  /** 0.10.7: matching a barcode from Scan several: after saving, back to that list. */
  fromScans?: boolean;
  /** 0.12.0: from a tab's "Add to pantry": one button at the end. */
  toPantry?: boolean;
  /** 0.12.0: from a barcode button: the scanner opens straight away. */
  scan?: boolean;
  /** 0.12.0: from a special on Home: this product is picked once its shop answers. */
  preTick?: { chain: StoreChain; storeProductId: string; product?: StoreProduct };
}) {
  const nav = useNav();
  const settings = useLive(getSettings, []);
  const allCats = useLive(allCategories, []);
  const [pickedSection, setPickedSection] = useState<Section>(sectionProp);
  const attach = useLive(async () => {
    if (!attachTo) return undefined;
    const group = await getGroup(attachTo);
    if (!group) return undefined;
    const mains = await getProducts(mainProductIds(group));
    // 0.9.1: each pick's latest price, so "Other sizes of this" can compare with the usual one.
    const readings = await readingsFor(mains.map((p) => p.id));
    const latest = new Map([...readings].map(([id, rs]) => [id, rs[rs.length - 1]?.price]));
    // 0.12.8: which results are already this item's, so they show ticked.
    const inItem = rolesIn(group, [...mains, ...(await getProducts(group.altProductIds))]);
    return { group, mains, latest, inItem };
  }, [attachTo]);
  const attachGroup = attach?.group;
  // Adding to an item: its tab. Otherwise the tab you came from, or the one picked at the top.
  const section: Section = attachGroup?.section ?? pickedSection;
  const categories = allCats?.filter((c) => c.section === section);
  const sectionsOn = settings ? activeSections(settings) : (['pantry'] as Section[]);
  /** This tab is left out of the bottom bar: a one-off buy, so the shopping list comes first. */
  const tabHidden = section !== 'pantry' && !!settings?.hiddenTabs?.includes(section);

  const [term, setTerm] = useState(query ?? '');
  // 0.10.8: Find it from a photo, in a sheet (it used to open in the page, pushing everything down)
  const [photoFind, setPhotoFind] = useState(false);
  const [rankQ, setRankQ] = useState<RankQuery>({ text: query ?? '' });
  const [scanned, setScanned] = useState<BarcodeInfo>();
  const [lookingUp, setLookingUp] = useState(false);
  const [results, setResults] = useState<Partial<Record<Chain, ChainResult>>>({});
  // 0.11.0: what an earlier search saw each result at, when it was a different price (lib/seen.ts)
  const [before, setBefore] = useState<Map<string, SeenBefore>>(new Map());
  const [showing, setShowing] = useState<Partial<Record<Chain, number>>>({});
  const [sortBy, setSortBy] = useState<Partial<Record<Chain, SortKey>>>({});
  const [picks, setPicks] = useState<Map<string, StoreProduct>>(new Map());
  // From the shopping list, keep the name you typed there ("Nescafe").
  // 0.10.2: a line's "Add to pantry" keeps the line's name ("Eggs").
  const [name, setName] = useState(forLine?.toPantry ? forLine.entry.text : forList && query ? query : '');
  const [categoryId, setCategoryId] = useState('');
  // 0.12.7: the category is chosen for you when Restock is sure of it, until you choose one yourself.
  const [catTouched, setCatTouched] = useState(false);
  // 0.12.7: the name box starts empty and has to be filled in (Restock named a dressing "Sugar").
  const [nameMissing, setNameMissing] = useState(false);
  const nameBox = useRef<HTMLInputElement>(null);
  // 0.12.10: a name another item already has can't be used again ("Rinse aid" twice).
  const everyItem = useLive(allGroups, []);
  // 0.12.7: picks that are "Also happy with" (an alternative product), chosen while adding. `altMode`:
  // you tapped Find one under Also happy with, so what you tick on that shop's page is an alternative.
  const [alts, setAlts] = useState<Set<string>>(new Set());
  const [altMode, setAltMode] = useState(false);
  const [alertLevel, setAlertLevel] = useState<AlertLevel>('good');
  const [allowBulk, setAllowBulk] = useState(false);
  const [allowMulti, setAllowMulti] = useState(true);
  const [alertPct, setAlertPct] = useState<number>(30);
  const [manual, setManual] = useState(false);
  // 0.12.5: the other ways to add, folded under one button
  const [moreWays, setMoreWays] = useState(false);
  const [saving, setSaving] = useState(false);
  /** 0.10.7: which Add button is saving, so only that one shows it. */
  const [busyAs, setBusyAs] = useState<Target>();
  const [specialsOnly, setSpecialsOnly] = useState(false);
  const [searchedFor, setSearchedFor] = useState<string>();
  const [known, setKnown] = useState<Group>();
  const [whatIsIt, setWhatIsIt] = useState('');
  const [suggest, setSuggest] = useState<StoreProduct[]>([]);
  const [recent, setRecent] = useState<string[]>(recentSearches);
  // 0.10.7: "Add anyway" on "Looks like you already have this".
  const [dismissedHave, setDismissedHave] = useState(false);
  // 0.10.7: products ticked but not added yet: leaving asks first (leaveGuard.ts). Set once saved.
  const doneAdding = useRef(false);
  const screenRef = useRef<HTMLDivElement>(null);
  useLeaveGuard(() => picks.size > 0 && !doneAdding.current && !forLine, 'adding something: you’ve picked a product but not added it');
  useEffect(() => {
    if (picks.size) doneAdding.current = false;
  }, [picks]);
  // 0.10.7: barcodes from Scan several still to match.
  const scansLeft = useSyncExternalStore(onScanLines, () => toMatch());
  const [preview, setPreview] = useState<StoreProduct>();
  // After a scan: the product at each shop Restock is sure is the same one, ticked for you.
  const [auto, setAuto] = useState<Map<string, BestMatch>>();
  // A scan that only told us the brand: the brand's products across your shops, to pick from.
  const [candidates, setCandidates] = useState<Candidate[]>();
  const [showUnlikely, setShowUnlikely] = useState<Partial<Record<Chain, boolean>>>({});
  // A shop that came back with nothing like a typed search, searched again for the kind of thing
  // it is ("western star" → that shop's butter), and whether to show what it first found (0.8.6).
  const [instead, setInstead] = useState<Partial<Record<Chain, { kind: string; items: StoreProduct[]; top: string[] }>>>({});
  const [original, setOriginal] = useState<Partial<Record<Chain, boolean>>>({});
  const insteadFor = useRef<string | undefined>(undefined);
  // After a match at one shop: the other shops being searched again by the product's type, and
  // similar products at shops that don't sell that brand.
  const [, setFollowing] = useState<Chain[]>([]);
  const [, setSimilar] = useState<Partial<Record<Chain, StoreProduct[]>>>({});
  const followFor = useRef<string | undefined>(undefined);
  // After you tick your first product from a typed search (0.7.6): the other shops searched again
  // for it, so the same product or the ones most like it are in that shop's results (0.12.6: never ticked for you).
  const [recAnchor, setRecAnchor] = useState<StoreProduct>();
  const [, setRecs] = useState<Partial<Record<Chain, { same?: StoreProduct; like: StoreProduct[] }>>>({});
  const [, setRecBusy] = useState<Chain[]>([]);
  const recFor = useRef<string | undefined>(undefined);
  // Products already in your pantry, so search results can say so.
  const pantry = useLive(async () => {
    const [products, groups] = await Promise.all([allProducts(), allGroups()]);
    const byId = new Map<string, Group>();
    for (const g of groups) for (const id of groupProductIds(g)) byId.set(id, g);
    const out = new Map<string, Group>();
    for (const p of products) {
      const g = byId.get(p.id);
      if (g && p.storeProductId) out.set(`${p.chain}:${p.storeProductId}`, g);
    }
    return out;
  }, []);

  /** 0.10.7: a scanned barcode whose shop match is already one of your items (the barcode isn't linked to it yet). */
  const alreadyHave = (() => {
    if (!scanned || known || !auto || attachTo || forLine) return undefined;
    for (const m of auto.values()) {
      const productKey = `${m.sp.chain}:${m.sp.storeProductId}`;
      const group = pantry?.get(productKey);
      if (group) return { group, productKey };
    }
    return undefined;
  })();
  /** Puts the scanned barcode on your product, so the next scan knows it straight away. */
  const linkBarcode = async (productKey: string, code: string) => {
    const p = (await allProducts()).find((x) => `${x.chain}:${x.storeProductId}` === productKey);
    if (p && !p.barcode) await updateProduct(p.id, { barcode: code });
  };

  /** This tab's shops only. When adding your product at another store, only the stores it isn't linked to yet. */
  const chainsToSearch = (all: StoreChain[], sec: Section = section) => {
    if (onlyChain) return [onlyChain];
    const enabled = searchChainsIn(all, sec);
    if (!attach || as !== 'main' || another) return enabled;
    const have = new Set(attach.mains.map((p) => p.chain));
    const missing = enabled.filter((c) => !have.has(c));
    return missing.length ? missing : enabled;
  };

  const searchChain = async (chain: StoreChain, text: string, rq: RankQuery, storeId?: string) => {
    setResults((r) => ({ ...r, [chain]: { status: 'loading' } }));
    try {
      const a = adapterFor(chain)!;
      // A scan at Woolworths or Coles: also search the barcode itself, which finds the exact
      // product even when the name search doesn't bring it up.
      const byCode =
        rq.barcode && (chain === 'woolworths' || chain === 'coles') && rq.barcode !== text
          ? a.search(rq.barcode, storeId).catch(() => [] as StoreProduct[])
          : Promise.resolve([] as StoreProduct[]);
      const [found, coded] = await Promise.all([a.search(text, storeId), byCode]);
      const exact = coded.filter((p) => sameCode(p.barcode, rq.barcode));
      const seen = new Set(exact.map(keyOf));
      const items = uniqueProducts([...exact, ...found.filter((p) => !seen.has(keyOf(p)))]);
      const scored = scoreAll(rq, items);
      void seenBefore(items)
        .then((m) => m.size && setBefore((b) => new Map([...b, ...m])))
        .catch(() => undefined);
      setResults((r) => ({
        ...r,
        [chain]: {
          status: 'ok',
          items: scored.map((x) => x.sp),
          scored,
          top: topPicks(scored).map(keyOf),
          page: 1,
          more: !!a.pages && found.length >= FULL_PAGE,
        },
      }));
      void recordHealth({ [chain]: null }).catch(() => undefined);
    } catch (e) {
      if (!(e instanceof NativeOnlyError)) {
        void recordHealth({ [chain]: e instanceof Error ? e.message : String(e) }).catch(() => undefined);
        void logProblem(chain, 'search', e instanceof Error ? e.message : String(e));
      }
      setResults((r) => ({
        ...r,
        [chain]: {
          status: 'error',
          message: e instanceof Error ? e.message : String(e),
          blocked: e instanceof BlockedError || isBlockedError(e instanceof Error ? e.message : String(e)),
          // 0.10.5: also when a hidden-browser shop doesn't answer.
          unblock: e instanceof BlockedError || offerUnblock(chain, e instanceof Error ? e.message : String(e)),
        },
      }));
    }
  };

  const [lastText, setLastText] = useState('');
  // 0.12.0: pick one, then your pick at each shop. Which shop's results show ("all": a few from each),
  // the shop whose pick is being changed, the shops you said don't sell it, and which picks Restock
  // made for you ("same": sure it's the same product; "like": the closest it found).
  const [shopView, setShopView] = useState<'all' | Chain>('all');
  const [changing, setChanging] = useState<Chain>();
  const [declined, setDeclined] = useState<Set<string>>(new Set());
  // 0.12.0: a new phone's first search asks where you shop, once (in place of the setup step).
  // 0.12.1: the title is the section switcher (as on the shopping list); this is its menu.
  const [switching, setSwitching] = useState(false);
  const [askShops, setAskShops] = useState<{ q: string; rq: RankQuery; sec: Section; pressed: boolean }>();
  // 0.9.5: ticking only ever puts it in the bar at the bottom. The sheet to name it and add it opens
  // from the bar's green arrow, never by itself (0.9.4 popped it up for a second on every tick).
  const [panelOpen, setPanelOpen] = useState(false);
  useEffect(() => setPanelOpen((open) => sheetOpenAfter(open, { kind: 'picks', size: picks.size })), [picks.size]);
  // What a screen reader hears when something's ticked or unticked.
  const [said, setSaid] = useState('');
  const lastPicks = useRef(picks);
  useEffect(() => {
    const msg = tickMessage(lastPicks.current, picks);
    lastPicks.current = picks;
    if (msg) setSaid(msg);
  }, [picks]);
  // The height left above the keyboard, so the add panel never grows taller than what can be seen.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const set = () => document.documentElement.style.setProperty('--vvh', `${Math.round(vv.height)}px`);
    set();
    vv.addEventListener('resize', set);
    return () => {
      vv.removeEventListener('resize', set);
      document.documentElement.style.removeProperty('--vvh');
    };
  }, []);
  const [searched, setSearched] = useState<StoreChain[]>([]);
  /**
   * `pressed`: the person pressed Search (the search box, or "What is it?"). 0.9.6 (review L1): only
   * then is Costco asked too. Every other search (a scan, opening from an item, changing the tab, a
   * quick pick or a recent search) leaves Costco out, and "Search Costco" below asks it on a press.
   */
  const search = async (q: string, rq: RankQuery, sec: Section = section, _pressed = false, fresh?: Awaited<ReturnType<typeof getSettings>>) => {
    const s = fresh ?? settings ?? (await getSettings());
    const text = q.trim();
    if (!text) return;
    if (s.shopsAsked === false && sec === 'pantry' && !attachTo && !forLine && !onlyChain) {
      setAskShops({ q, rq, sec, pressed: _pressed });
      return;
    }
    setRankQ(rq);
    setLastText(text);
    setShopView('all');
    setChanging(undefined);
    setDeclined(new Set());
    // A new scan is a new product: ticks left from an earlier search would block "ticked for you".
    if (rq.barcode && !attachGroup) setPicks(new Map());
    setShowing({});
    setAuto(undefined);
    setCandidates(undefined);
    setShowUnlikely({});
    setInstead({});
    setOriginal({});
    insteadFor.current = undefined;
    setFollowing([]);
    setSimilar({});
    followFor.current = undefined;
    setRecAnchor(undefined);
    setRecs({});
    setRecBusy([]);
    recFor.current = undefined;
    // 0.9.8: Costco is searched like the other shops whenever you search (Declan, 11 Nov). Never in the background.
    const chains = chainsToSearch(s.enabledChains, sec);
    setSearched(chains);
    setResults(Object.fromEntries(chains.map((c) => [c, { status: 'loading' }])));
    await Promise.all(chains.map((chain) => searchChain(chain, text, rq, searchStoreId(s, chain))));
  };

  // Once every shop has answered a scan, tick the best match at each (only if nothing's ticked yet).
  useEffect(() => {
    if (!rankQ.barcode || auto || !searched.length || (attachGroup && as === 'alt')) return;
    const answers = searched.map((c) => results[c]);
    if (answers.some((r) => !r || r.status === 'loading')) return;
    const byChain = Object.fromEntries(searched.map((c) => [c, results[c]?.status === 'ok' ? (results[c] as { items: StoreProduct[] }).items : []]));
    // 0.12.6: only the product you scanned is ticked, where a shop lists that barcode. A match by
    // name or size (a guess) is left for you to tick.
    const found = new Map([...bestMatches(rankQ, byChain)].filter(([, m]) => m.sure === 'barcode'));
    setAuto(found);
    if (!found.size) {
      if (rankQ.brand) setCandidates(whichOne(rankQ, byChain));
      return;
    }
    // Keep anything you ticked while the shops were answering, and add the best match at each shop.
    setPicks((prev) => {
      const next = new Map(prev);
      const ticked = new Set([...prev.values()].map((p) => p.chain));
      for (const m of found.values()) if (!ticked.has(m.sp.chain)) next.set(keyOf(m.sp), m.sp);
      return next;
    });
    setPanelOpen(true); // 0.12.0: straight to "your pick at each shop"
    const first = [...found.values()][0].sp;
    void followUp(first, new Set(found.keys()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [results, searched, rankQ, auto]);

  // 0.12.6: a typed search specific enough to be sure of ("western star butter 500g") is no longer
  // ticked for you: it's at the top of the results, marked Good match, and you tick it.

  // Once every shop has answered a typed search: shops with nothing like it are searched again for
  // what it is, worked out from the shops that do have it ("western star" is butter at Woolworths
  // and Coles, so Aldi is searched for butter), or from the brands Restock knows (0.8.6).
  useEffect(() => {
    if (rankQ.barcode || onlyChain || !searched.length || insteadFor.current === rankQ.text) return;
    const answers = searched.map((c) => results[c]);
    if (answers.some((r) => !r || r.status === 'loading')) return;
    insteadFor.current = rankQ.text;
    const byChain = Object.fromEntries(
      searched.filter((c) => results[c]?.status === 'ok').map((c) => [c, (results[c] as { scored?: Scored[] }).scored ?? []]),
    );
    const weak = weakShops(byChain) as StoreChain[];
    const kind = weak.length ? intendedKind(rankQ, byChain) : undefined;
    if (!kind) return;
    const tag = rankQ.text;
    void (async () => {
      const s = settings ?? (await getSettings());
      await Promise.all(
        weak.map(async (chain) => {
          const a = followAdapter(chain);
          if (!a) return;
          const found = await a.search(kind, searchStoreId(s, chain)).catch(() => [] as StoreProduct[]);
          if (insteadFor.current !== tag) return;
          const scored = scoreAll({ text: kind }, found);
          if (!scored.length || scored[0].s < UNLIKELY) return;
          setInstead((m) => ({ ...m, [chain]: { kind, items: scored.map((x) => x.sp), top: topPicks(scored).map(keyOf) } }));
        }),
      );
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [results, searched, rankQ]);

  /**
   * "Wrong results?": saves what this shop sent back for this search into a file to send to the
   * developer, so it becomes a test that search has to get right (0.8.6). Only the search and the
   * shop's results: nothing about you or your pantry.
   */
  const reportWrong = async (chain: StoreChain) => {
    const r = results[chain];
    const alt = instead[chain];
    const file = {
      app: 'restock',
      kind: 'wrong-results',
      version: __APP_VERSION__,
      at: new Date().toISOString(),
      shop: chain,
      shopName: chainName(chain),
      tab: section,
      search: lastText,
      results: r?.status === 'ok' ? r.items.slice(0, 60).map(slim) : [],
      instead: alt ? { kind: alt.kind, results: alt.items.slice(0, 60).map(slim) } : undefined,
    };
    await shareTextFile(
      // Today on the phone's calendar (0.9.0), not UTC's.
      `restock-wrong-results-${chain}-${localDay(new Date().toISOString())}.json`,
      JSON.stringify(file, null, 1),
      'application/json',
      'Restock wrong results',
    );
  };

  /** Switch which kind of shop to search, and search again there. */
  const switchSection = (sec: Section) => {
    if (sec === section) return;
    setPickedSection(sec);
    setPicks(new Map());
    setSuggest([]);
    setCategoryId('');
    setResults({});
    if (lastText) void search(lastText, rankQ, sec);
  };

  const handleBarcode = async (code: string, force = false, pressed = false) => {
    setKnown(undefined);
    setSearchedFor(undefined);
    setWhatIsIt('');
    // Already tracking this barcode? Offer the item instead of searching all over again.
    if (!attachTo && !force) {
      const product = await findProductByBarcode(code);
      const group = product && (await allGroups()).find((g) => groupProductIds(g).includes(product.id));
      if (group) {
        setResults({});
        setScanned({ barcode: code, name: group.name, imageUrl: product.imageUrl });
        setKnown(group);
        return;
      }
    }
    setScanned({ barcode: code });
    setLookingUp(true);
    const info = await identifyBarcode(code, section);
    setLookingUp(false);
    setScanned(info);
    // Bottle shops and pharmacies search better with a short term ("paracetamol 500mg"); results
    // are still ranked by the full name and size, so the exact product comes first.
    const { term: q, generic } = searchTermFor(info, section);
    setTerm(q);
    setSearchedFor(generic ? q : undefined);
    await search(q, { text: displayName(info), brand: info.brand, size: info.size, barcode: code }, section, pressed);
  };

  useEffect(() => {
    // 0.10.7: with words too (a name shared back from Google Lens), those words are the search.
    if (barcode && !query) void handleBarcode(barcode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [barcode]);

  // Coming from an item's "Find at another shop": search straight away.
  const ready = !attachTo || attach !== undefined;
  useEffect(() => {
    if (query && ready && settings) {
      // 0.10.7: the words for a barcode (from Google Lens): picking a result remembers the barcode.
      if (barcode) setScanned({ barcode, name: query } as BarcodeInfo);
      void search(query, { text: query, barcode });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, ready, !!settings]);

  const runText = (t: string, pressed = false) => {
    if (!t.trim()) return;
    const fixed = normaliseQuery(t);
    setSearchedFor(queryChanged(t) ? fixed : undefined);
    rememberSearch(t);
    setRecent(recentSearches());
    void search(fixed, { text: fixed }, section, pressed);
  };

  // 0.9.6 (review L1): Costco is on and this search left it out (it was not a Search press): a
  // button to ask Costco too, one page, only when pressed.
  // 0.9.8: Costco is in every search now, so this button never shows (kept for a search made before).
  const costcoLeftOut = !!settings && !!lastText && costcoIsOn() && !searched.includes('costco') && false;
  const searchCostcoToo = () => {
    if (!settings || !lastText || searched.includes('costco')) return;
    setSearched((s) => (s.includes('costco') ? s : [...s, 'costco']));
    void searchChain('costco', lastText, rankQ, searchStoreId(settings, 'costco'));
  };

  const doScan = async () => {
    const out = await scanBarcode();
    if (out.ok) await handleBarcode(out.code);
  };

  /** Adds products found by a second search to a shop's list (no repeats). */
  const mergeInto = (chain: Chain, items: StoreProduct[]) =>
    setResults((r) => {
      const cur = r[chain];
      const ok = cur?.status === 'ok' ? cur : undefined;
      const have = ok?.items ?? [];
      const seen = new Set(have.map(keyOf));
      return { ...r, [chain]: { ...ok, status: 'ok', items: uniqueProducts([...have, ...items.filter((p) => !seen.has(keyOf(p)))]) } };
    });

  /**
   * The shop's next page of results, for "Show more" once everything already found is showing
   * (0.8.5). Added after what's there, best first among themselves, so nothing jumps about.
   */
  const loadMore = async (chain: StoreChain) => {
    const cur = results[chain];
    if (cur?.status !== 'ok' || !cur.more || cur.loadingMore) return;
    const a = followAdapter(chain);
    if (!a?.pages) return;
    const page = (cur.page ?? 1) + 1;
    setResults((r) => ({ ...r, [chain]: { ...(r[chain] as typeof cur), loadingMore: true } }));
    const s = settings ?? (await getSettings());
    let found: StoreProduct[] = [];
    try {
      found = await a.search(lastText, searchStoreId(s, chain), page);
    } catch {
      found = [];
    }
    setResults((r) => {
      const now = r[chain];
      if (now?.status !== 'ok') return r;
      const seen = new Set(now.items.map(keyOf));
      const fresh = rankAll(rankQ, uniqueProducts(found.filter((p) => !seen.has(keyOf(p)))));
      return {
        ...r,
        [chain]: { ...now, items: [...now.items, ...fresh], page, loadingMore: false, more: fresh.length > 0 && found.length >= FULL_PAGE },
      };
    });
    setShowing((m) => ({ ...m, [chain]: (m[chain] ?? FIRST_PAGE) + MORE_PAGE }));
  };

  /**
   * Shops name the same thing differently ("Tough On Grease Green Tea & Lime" at one, "Dishwashing
   * Liquid" at another), so once a product is picked at one shop, the shops without a match are
   * searched again by its brand and type ("Earth Choice dishwashing liquid"). The same product and
   * size there is ticked too; a shop that doesn't sell the brand gets similar products to look at.
   */
  const followUp = async (anchor: StoreProduct, have: Set<string>) => {
    const s = settings ?? (await getSettings());
    const kind = genericName(anchor.name, anchor.brand);
    const brand = anchor.brand ?? rankQ.brand;
    const todo = searched.filter((c) => !have.has(c));
    const tag = `${keyOf(anchor)}|${todo.join(',')}`;
    if (!todo.length || !kind || followFor.current === tag) return;
    followFor.current = tag;
    setFollowing(todo);
    setSimilar({});
    await Promise.all(
      todo.map(async (chain) => {
        const a = followAdapter(chain);
        const storeId = searchStoreId(s, chain);
        try {
          if (!a) return;
          const typed = brand ? await a.search(`${brand} ${kind}`.toLowerCase(), storeId).catch(() => [] as StoreProduct[]) : [];
          let same: StoreProduct | undefined = matchesFor(anchor, typed, 0.6)[0];
          // Still nothing: look inside the brand's top few products here (barcode, description), as a
          // shop may call "Dishwashing Liquid" something like "Green Tea & Lime 900mL".
          if (!same && typed.length) same = await matchByDetails(anchor, typed, kind, rankQ.barcode, chain === 'coles' ? storeId : undefined);
          if (followFor.current !== tag) return;
          if (typed.length) mergeInto(chain, typed);
          if (same) {
            setAuto((m) => new Map(m ?? []).set(chain, { sp: same, sure: 'same' }));
            setPicks((prev) => (prev.has(keyOf(same)) ? prev : new Map(prev).set(keyOf(same), same)));
            return;
          }
          // Nothing from that brand here: the same kind of product, for you to look at.
          const plain = await a.search(kind.toLowerCase(), storeId).catch(() => [] as StoreProduct[]);
          if (followFor.current !== tag) return;
          const kindQ: RankQuery = { text: kind, size: anchor.size };
          const like = rankAll(kindQ, plain)
            .filter((p, i) => score(kindQ, p, i) >= 0.5)
            .slice(0, 3);
          if (plain.length) mergeInto(chain, plain);
          if (like.length) setSimilar((m) => ({ ...m, [chain]: like }));
        } finally {
          setFollowing((f) => f.filter((c) => c !== chain));
        }
      }),
    );
  };

  /** You picked which product it is: tick it at every shop that sells it. */
  const choose = (c: Candidate) => {
    const m = new Map<string, BestMatch>();
    // 0.12.6: only the one you tapped. Its look-alikes at other shops are yours to tick.
    m.set(c.sp.chain, { sp: c.sp, sure: 'chosen' });
    setAuto(m);
    setCandidates(undefined);
    setSuggest([]);
    setPicks(new Map([...m.values()].map((x) => [keyOf(x.sp), x.sp])));
    void followUp(c.sp, new Set(m.keys()));
  };

  /**
   * You ticked your first product: search your other shops again for it (by brand and type, as
   * shops name things differently) and pick out the same product, or the ones most like it in
   * kind, size and price. You can still scroll each shop's list and tick your own.
   */
  const recommend = async (anchor: StoreProduct) => {
    const s = settings ?? (await getSettings());
    const kind = genericName(anchor.name, anchor.brand) || lastText;
    const todo = searched.filter((c) => c !== anchor.chain) as Chain[];
    const tag = keyOf(anchor);
    if (!todo.length || recFor.current === tag) return;
    recFor.current = tag;
    setRecAnchor(anchor);
    setRecs({});
    setRecBusy(todo);
    const typed = lastText.toLowerCase().trim();
    const terms = [...new Set([anchor.brand ? `${anchor.brand} ${kind}` : '', kind].map((t) => t.toLowerCase().trim()))].filter(
      (t) => t && t !== typed,
    );
    await Promise.all(
      todo.map(async (chain) => {
        try {
          const a = followAdapter(chain);
          const cur = results[chain];
          const have = cur?.status === 'ok' ? cur.items : [];
          const extra: StoreProduct[] = [];
          if (a) for (const t of terms) extra.push(...(await a.search(t, searchStoreId(s, chain as StoreChain)).catch(() => [] as StoreProduct[])));
          if (recFor.current !== tag) return;
          if (extra.length) mergeInto(chain, extra);
          const pool = [...have, ...extra];
          const same = matchesFor(anchor, pool, 0.6)[0];
          const like = likeThis(
            anchor,
            pool.filter((p) => !same || keyOf(p) !== keyOf(same)),
            kind,
            lastText,
            // 0.12.0: a few more to choose the closest name from (the pick made for you)
            6,
          );
          setRecs((m) => ({ ...m, [chain]: { same, like } }));
        } finally {
          if (recFor.current === tag) setRecBusy((b) => b.filter((c) => c !== chain));
        }
      }),
    );
  };

  // 0.9.1: "Other sizes of this": other packs and sizes of the first thing you ticked or, on an
  // item's "Add another product", of its usual pick. Found in what the shops sent back, plus one more
  // search for its brand and type (at its own shop; the others are searched by recommend()).
  const sizesFor: StoreProduct | undefined = (() => {
    if (attachGroup) {
      if (as !== 'main' || !another || !attach) return undefined;
      const usual = attach.mains.find((p) => p.id === attachGroup.usualProductId) ?? attach.mains[0];
      if (!usual?.storeProductId) return undefined;
      const live = Object.values(results)
        .flatMap((r) => (r?.status === 'ok' ? r.items : []))
        .find((p) => p.chain === usual.chain && p.storeProductId === usual.storeProductId);
      return (
        live ?? {
          chain: usual.chain,
          storeProductId: usual.storeProductId,
          name: usual.name,
          brand: usual.brand,
          size: usual.size,
          imageUrl: usual.imageUrl,
          price: attach.latest.get(usual.id),
          isSpecial: false,
          memberOnly: false,
        }
      );
    }
    if (!picks.size) return undefined;
    return recAnchor && picks.has(keyOf(recAnchor)) ? recAnchor : [...picks.values()][0];
  })();
  const sizesKey = sizesFor ? keyOf(sizesFor) : '';
  const [sizesBusy, setSizesBusy] = useState<string>();
  const sizesSearched = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!sizesFor || !searched.length || sizesSearched.current === sizesKey) return;
    if (searched.some((c) => !results[c] || results[c]?.status === 'loading')) return;
    sizesSearched.current = sizesKey;
    const kind = genericName(sizesFor.name, sizesFor.brand);
    const term = sizesFor.brand && kind ? `${sizesFor.brand} ${kind}`.toLowerCase().trim() : '';
    if (!term || term === lastText.toLowerCase().trim()) return;
    const chains = (another ? searched : searched.filter((c) => c === sizesFor.chain)).filter((c) => followAdapter(c));
    if (!chains.length) return;
    setSizesBusy(sizesKey);
    void (async () => {
      const s = settings ?? (await getSettings());
      await Promise.all(
        chains.map(async (c) => {
          const found = await followAdapter(c)!
            .search(term, searchStoreId(s, c))
            .catch(() => [] as StoreProduct[]);
          if (sizesSearched.current === sizesKey && found.length) mergeInto(c as Chain, found);
        }),
      );
      setSizesBusy((k) => (k === sizesKey ? undefined : k));
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sizesKey, searched, results]);
  const sizesPool = [
    ...Object.values(results).flatMap((r) => (r?.status === 'ok' ? r.items : [])),
    ...Object.values(instead).flatMap((x) => x?.items ?? []),
  ];
  const sizesSkip = attach ? new Set(attach.mains.filter((p) => p.storeProductId).map((p) => `${p.chain}:${p.storeProductId}`)) : undefined;

  // 0.12.8: adding to an item you already have: + adds that one product straight away, with Undo
  // (a sheet opened after every tick: "Check it, then add"). A product already in the item shows ticked.
  const addingToItem = !!attachTo && !forLine;
  const isPicked = (k: string) => (addingToItem ? attach?.inItem.get(k) === as : picks.has(k));
  const [addedHere, setAddedHere] = useState<Set<string>>(new Set());
  const attachBusy = useRef(false);
  const attachToggle = async (sp: StoreProduct) => {
    if (!attachGroup || attachBusy.current) return;
    attachBusy.current = true;
    const k = keyOf(sp);
    try {
      const g = (await getGroup(attachGroup.id)) ?? attachGroup;
      if (isPicked(k)) {
        if (!addedHere.has(k)) {
          nav.toast(`${g.name} already has this one. To take it off, open ${g.name} and tap it under ${as === 'alt' ? 'Also happy with' : 'Products I buy'}.`);
          return;
        }
        const id = (await getProducts(groupProductIds(g))).find((p) => p.chain === sp.chain && String(p.storeProductId) === String(sp.storeProductId))?.id;
        if (id) await act(`Taken off ${g.name}`, () => removeProductFromGroup(g, id));
        setAddedHere((a) => new Set([...a].filter((x) => x !== k)));
        return;
      }
      const has = attach?.inItem.get(k);
      if (has === 'main' && as === 'alt') {
        // Already one you buy: it can't also be a second choice.
        nav.toast(`${g.name} already has this one under Products I buy.`);
        return;
      }
      await act(as === 'alt' ? `Added to Also happy with for ${g.name}` : has === 'alt' ? `Moved to Products I buy for ${g.name}` : `Added to ${g.name}`, async () => {
        const ids = await saveStoreProducts([sp], barcodeFor);
        const patch = attachPatch((await getGroup(g.id)) ?? g, ids, as, [sp.chain]);
        if (patch) await updateGroup(g.id, patch);
      });
      setAddedHere((a) => new Set([...a, k]));
    } finally {
      attachBusy.current = false;
    }
  };

  // How many of this item's products were added on this visit (Undo takes one back off).
  const addedCount = addingToItem ? [...addedHere].filter((k) => attach?.inItem.get(k) === as).length : 0;

  const toggle = (sp: StoreProduct) => {
    if (addingToItem) {
      void attachToggle(sp);
      return;
    }
    // 0.12.7: ticked from "Find one" under Also happy with: it's an alternative. Unticked: no longer one.
    const on = !picks.has(keyOf(sp));
    setAlts((a) => {
      const next = new Set(a);
      if (on && altMode) next.add(keyOf(sp));
      else next.delete(keyOf(sp));
      return next;
    });
    setPicks((prev) => togglePick(prev, sp));
    // Ticked one? Look for the same thing at the other stores, so it's one tap to tick them all.
    if (as === 'alt' || picks.has(keyOf(sp))) {
      setSuggest((list) => list.filter((x) => keyOf(x) !== keyOf(sp)));
      return;
    }
    const others = Object.values(results).flatMap((r) => (r?.status === 'ok' ? r.items : []));
    // After a scan Restock couldn't match: the first one you tick is the product, so tick the
    // same product at your other shops too.
    if (rankQ.barcode && (!auto || auto.size === 0) && !attachTo) {
      choose({ sp, at: [sp, ...matchesFor(sp, others, 0.6)] });
      return;
    }
    // Your first tick from a typed search: recommend it, or the closest thing, at every other shop.
    if (!picks.size && !rankQ.barcode && !attachTo && !recFor.current) {
      setSuggest([]);
      void recommend(sp);
      return;
    }
    if (recAnchor) return;
    const pickedChains = new Set([...picks.values()].map((p) => p.chain).concat(sp.chain));
    setSuggest(matchesFor(sp, others).filter((m) => !pickedChains.has(m.chain)));
  };

  // 0.10.2: a line's "Add to pantry": the product it was added as, ticked again once its shop answers
  // (and its look-alikes at the other shops recommended, as a first tick does). Once only.
  const preTicked = useRef(false);
  const preTick = forLine?.preTick ?? preTickProp;
  const preShop = preTick ? results[preTick.chain] : undefined;
  useEffect(() => {
    if (!preTick?.storeProductId || preTicked.current || preShop?.status !== 'ok') return;
    preTicked.current = true;
    let sp = preShop.items.find((p) => String(p.storeProductId) === String(preTick.storeProductId));
    // 0.12.0: from a special on Home: the product itself comes along, in case the search by its name
    // doesn't bring it back.
    if (!sp && preTickProp?.product) {
      sp = preTickProp.product;
      mergeInto(sp.chain as Chain, [sp]);
    }
    if (sp && !picks.has(keyOf(sp))) {
      if (preTickProp) pickOne(sp);
      else toggle(sp);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preShop]);

  // 0.12.0: opened from a barcode button: the scanner straight away.
  const scanStarted = useRef(false);
  useEffect(() => {
    if (!scan || scanStarted.current || !settings) return;
    scanStarted.current = true;
    void doScan();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scan, !!settings]);

  /**
   * + on a result. 0.12.4: it ticks that product, and tapping it again unticks it, so you can tick as
   * many as you buy as this item, at any shop (it kept one per shop, and a second + started over).
   * The first tick is the product. 0.12.6: nothing is ticked for you at your other shops (Restock
   * still searches them for it, so it's near the top when you look there). Nothing opens by itself: the bar at the bottom says how many are ticked, and
   * Finish opens the sheet to check them and add.
   */
  const pickOne = (sp: StoreProduct) => {
    const k = keyOf(sp);
    if (addingToItem) {
      void attachToggle(sp);
      return;
    }
    if (forLine) {
      toggle(sp);
      setPanelOpen(true);
      return;
    }
    if (picks.has(k)) {
      setPicks((prev) => new Map([...prev].filter(([key]) => key !== k)));
      setAlts((a) => new Set([...a].filter((key) => key !== k)));
      return;
    }
    if (picks.size > 0) {
      // One more of yours (0.12.7: or, from Find one under Also happy with, an alternative).
      if (altMode) setAlts((a) => new Set([...a, k]));
      setPicks((prev) => new Map([...prev, [k, sp]]));
      setDeclined((d) => new Set([...d].filter((c) => c !== sp.chain)));
      return;
    }
    // The first tick: the product itself.
    setPicks(new Map([[k, sp]]));
    setSuggest([]);
    setDeclined(new Set());
    recFor.current = undefined;
    setRecs({});
    setRecBusy([]);
    const others = Object.values(results).flatMap((r) => (r?.status === 'ok' ? r.items : []));
    if (rankQ.barcode && (!auto || auto.size === 0)) choose({ sp, at: [sp, ...matchesFor(sp, others, 0.6)] });
    else void recommend(sp);
    // From a special or a list line (the product came with you): straight to the sheet, as before.
    if (preTickProp || rankQ.barcode) setPanelOpen(true);
  };

  // 0.12.6: nothing is picked for you at your other shops any more. Each shop starts empty on the
  // review sheet ("Not added", with Find it and Not sold here) and you tick what you buy there.
  // What recommend() finds is still merged into that shop's results, so Find it shows it first.

  /** Save each picked store product (or reuse it if it's already tracked) with today's price. */
  const barcodeFor = (sp: StoreProduct) => sp.barcode ?? (isExactBarcode(rankQ, sp) || as === 'main' ? rankQ.barcode : undefined);
  const saveProducts = (): Promise<string[]> => saveStoreProducts(picks.values(), barcodeFor);

  // 0.12.7: what you buy, and what you'd also be happy with (alternatives never go on the list as your pick).
  const mainPicks = [...picks.values()].filter((p) => !alts.has(keyOf(p)));
  const altPicks = [...picks.values()].filter((p) => alts.has(keyOf(p)));
  const cheapestPick = () => mainPicks.filter((p) => p.price !== undefined).sort((a, b) => a.price! - b.price!)[0];
  const cheapestChain = (): Chain | undefined => cheapestPick()?.chain ?? mainPicks[0]?.chain;
  /** Does adding make a pantry item (so it has a name, a category and Also happy with)? Not a one-off list line. */
  const makesItem = !attachGroup && (!forList || !!forLine);
  const takenItem = attachGroup ? undefined : sameNameItem(everyItem, name);
  // The name on offer under the empty box: short, no brand, no size (lib/nameSuggest).
  const nameIdea = !attachGroup
    ? suggestName(
        mainPicks.map((p) => ({ name: p.name, brand: p.brand })),
        rankQ.barcode ? undefined : rankQ.text || lastText,
        scanned?.name && !weakName(scanned) ? { name: scanned.name, brand: scanned.brand } : undefined,
      )
    : '';
  const sureCategory = makesItem ? (confidentCategoryId(name.trim() || nameIdea, mainPicks.map((p) => p.name), (categories ?? []).map((c) => ({ ...c, section })), section) ?? '') : '';
  const shownCategory = catTouched ? categoryId : categoryId || sureCategory;


  const saveAttach = async () => {
    if (!attachGroup || !picks.size) return;
    setSaving(true);
    try {
      // 0.9.5 (undo): the whole attach is one Undo.
      await act(as === 'alt' ? `Added to Also happy with for ${attachGroup.name}` : `Added to ${attachGroup.name}`, async () => {
      const ids = await saveProducts();
      const all = new Set([attachGroup.usualProductId, ...attachGroup.sameProductIds, ...attachGroup.altProductIds]);
      if (as === 'alt') {
        const fresh = ids.filter((id) => !all.has(id));
        await updateGroup(attachGroup.id, { altProductIds: [...attachGroup.altProductIds, ...fresh] });
      } else {
        // One you'd also take, ticked as a pick, moves to Products I buy (0.8.9).
        const mains = new Set([attachGroup.usualProductId, ...attachGroup.sameProductIds]);
        const fresh = ids.filter((id) => !mains.has(id));
        // A pick ticked at a shop marked "Not at this shop" puts the shop back in (0.8.9).
        const at = new Set([...picks.values()].map((p) => p.chain));
        await updateGroup(attachGroup.id, {
          notAt: (attachGroup.notAt ?? []).filter((c) => !at.has(c as Chain)),
          usualProductId: attachGroup.usualProductId ?? fresh[0],
          sameProductIds: [...attachGroup.sameProductIds, ...fresh.filter((id) => id !== (attachGroup.usualProductId ?? fresh[0]))],
          altProductIds: attachGroup.altProductIds.filter((id) => !fresh.includes(id)),
        });
      }
      });
      doneAdding.current = true;
      nav.pop();
    } finally {
      setSaving(false);
    }
  };

  const save = async (target: Target) => {
    if (!picks.size || saving) return;
    // 0.12.7: you name it (Restock never fills the name in), and at least one pick is what you buy.
    if (!name.trim()) {
      setNameMissing(true);
      setPanelOpen(true);
      requestAnimationFrame(() => {
        nameBox.current?.scrollIntoView({ block: 'center' });
        nameBox.current?.focus();
      });
      return;
    }
    if (!mainPicks.length) {
      nav.toast('Pick what you buy first. Also happy with is for a second choice.');
      return;
    }
    // 0.12.10: no second item under a name you already use (a list line alone is fine).
    if (target !== 'list' && sameNameItem(everyItem, name)) {
      setPanelOpen(true);
      requestAnimationFrame(() => {
        nameBox.current?.scrollIntoView({ block: 'center' });
        nameBox.current?.focus();
      });
      return;
    }
    setSaving(true);
    setBusyAs(target);
    try {
      const itemName = name.trim();
      const item = { name: itemName, section, categoryId: shownCategory, alertLevel, alertPct, allowBulk, allowMulti };
      if (forLine && target !== 'list') {
        // From the Pick sheet: the new item, and the list line becomes it ("both"), or comes off the
        // list ("pantry", 0.9.11). 0.9.5 (final review): with an Undo, as every other add.
        const off = target === 'pantry';
        const { group, linked } = await addItemForLineUndoable(
          forLine.entry,
          mainPicks,
          item,
          forLine.always,
          (r) => pickedWords(r.group.name, { made: true, linked: r.linked, always: forLine.always, word: forLine.word, place: SECTION_PLACE[section], off }),
          barcodeFor,
          off ? 'pantry' : 'both',
          altPicks,
        );
        reset();
        forLine.onDone(group, true, linked);
        return;
      }
      let groupId: string | undefined;
      // 0.9.6 (review H1): a list line is shared, so the cheapest at Costco goes on as "Any shop", with its words only.
      const costcoLine = target === 'list' && isLocalOnlyShop(cheapestChain());
      // 0.9.5 (undo): the new item, its products and prices, and its list line: one Undo.
      const said =
        target === 'list'
          ? `${itemName} added to your shopping list${costcoLine ? `. ${COSTCO_LIST_NOTE}` : ''}`
          : target === 'both'
            ? `${itemName} added to ${SECTION_PLACE[section]} and shopping list`
            : `${itemName} added to ${SECTION_PLACE[section]}`;
      await act(said, async () => {
      if (target !== 'list') groupId = (await addItemFromPicks(mainPicks, item, barcodeFor, altPicks)).id;
      if (target !== 'pantry') {
        const one = groupId || costcoLine ? undefined : cheapestPick();
        await addListEntry({
          id: uid(),
          text: itemName,
          groupId,
          chain: groupId || costcoLine ? undefined : cheapestChain(),
          price: one?.price,
          categoryId: shownCategory || undefined,
          section,
          // What it is, so the list can show its photo and details (0.7.3).
          product: one
            ? {
                chain: one.chain,
                name: one.name,
                brand: one.brand,
                size: one.size,
                imageUrl: one.imageUrl,
                storeProductId: one.storeProductId,
                unitText: unitTextOf(one) || undefined,
              }
            : undefined,
          checked: false,
          createdAt: nowIso(),
        });
        const old = replaceEntry ?? forLine?.entry.id;
        if (old) await deleteListEntries([old]);
      }
      });
      doneAdding.current = true;
      const code = barcode ?? scanned?.barcode;
      // 0.10.7: from Scan several, "Add to pantry" puts the item itself on the list in place of the scanned line.
      if (fromScans && target === 'pantry' && groupId && replaceEntry) {
        const g = await getGroup(groupId);
        await deleteListEntries([replaceEntry]);
        if (g) await addToList(g);
      }
      reset();
      // 0.9.11: "Add to list" from the Pick sheet: the line is now this product, and the sheet closes.
      if (forLine) return forLine.onListed();
      // 0.10.7: from Scan several: ticked off there, and back to the rest.
      if (fromScans && code) {
        markMatched(code, itemName, groupId);
        nav.pop();
        return;
      }
      // 0.12.0: a plain add stays here, ready for the next thing (the toast has Undo). It used to
      // open the new item's page.
      if (forList && overlay) nav.pop();
    } finally {
      setSaving(false);
      setBusyAs(undefined);
    }
  };

  const reset = () => {
    setTerm('');
    setScanned(undefined);
    setResults({});
    setPicks(new Map());
    setAlts(new Set());
    setAltMode(false);
    setName('');
    setNameMissing(false);
    setCatTouched(false);
    setCategoryId('');
    setRankQ({ text: '' });
    setSuggest([]);
    setKnown(undefined);
    setSearchedFor(undefined);
    setAuto(undefined);
    setDismissedHave(false);
  };

  const anyResults = Object.keys(results).length > 0;
  // 0.10.7: on the Add tab, Back goes one step (results, or a scan, back to the start of Add), not
  // out to Home; with products ticked it asks first.
  useBackHandler(() => {
    if (picks.size) {
      void okToLeave().then((ok) => ok && reset());
      return true;
    }
    reset();
    return true;
  }, !overlay && !forLine && (!!scanned || anyResults || !!term.trim()));
  /** A shop without a photo: show the scanned product's photo (Open Food Facts) when it's the same product. */
  const photoFor = (sp: StoreProduct): string | undefined => {
    if (!scanned?.imageUrl) return undefined;
    if (sameCode(sp.barcode, scanned.barcode)) return scanned.imageUrl;
    // Otherwise only for a shop's top result whose name clearly matches the scanned product.
    const r = results[sp.chain as StoreChain];
    if (!scanned.name || r?.status !== 'ok' || !r.items[0] || keyOf(r.items[0]) !== keyOf(sp)) return undefined;
    const want = new Set(tokens(`${scanned.brand ?? ''} ${scanned.name}`));
    const have = tokens(sp.name);
    const shared = have.filter((t) => want.has(t)).length;
    return want.size && shared / want.size >= 0.7 ? scanned.imageUrl : undefined;
  };
  // 0.12.1: Android's back button on "Pick one at Woolworths" goes back to your picks.
  useBackHandler(() => {
    if (!changing) return false;
    backToPicks();
    return true;
  }, !!changing);

  const title = attachGroup
    ? as === 'alt'
      ? onlyChain
        ? `Find one at ${chainName(onlyChain)}`
        : 'Also happy with'
      : another
        ? 'Add another product'
        : onlyChain
          ? `Find it at ${chainName(onlyChain)}`
          : 'Find at another shop'
    : forList
      ? 'Add to shopping list'
      : toPantry
        ? `Add to ${section === 'pantry' ? 'pantry' : SECTION_NAMES[section]}`
        : // 0.12.1: from Home: it says which tab's shops it searches, and the title switches it
          sectionsOn.length > 1
          ? `Add · ${SECTION_NAMES[section]}`
          : 'Add an item';
  // A ticked product that's already a pantry item: from the Pick sheet, the line can just be that item.
  const trackedPick = forLine ? [...picks.keys()].map((k) => pantry?.get(k)).find((g): g is Group => !!g) : undefined;
  /** 0.12.10: adding a new item with a product that's already "Products I buy" of another item. */
  const havePick =
    makesItem && !forLine
      ? mainPicks
          .map((p) => pantry?.get(`${p.chain}:${p.storeProductId}`))
          .find((g): g is Group => !!g && [g.usualProductId, ...g.sameProductIds].some((id) => !!id))
      : undefined;
  const useTracked = async (g: Group) => {
    if (!forLine) return;
    setSaving(true);
    try {
      const linked = await pickItemFor(forLine.entry, g, forLine.always);
      reset();
      forLine.onDone(g, false, linked);
    } finally {
      setSaving(false);
    }
  };
  const sheetTitle = forLine
    ? 'Add to your pantry'
    : attachGroup
      ? as === 'alt'
        ? 'Also happy with'
        : `Add to ${attachGroup.name}`
      : forList
        ? 'Add to your shopping list'
        : name.trim() || 'Your pick at each shop';

  // ---------- 0.12.0: pick one, then your pick at each shop ----------
  const sentence = (t: string) => t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
  /** One result: the photo, the name, its shop and size, one price and a word. + picks it. */
  const resultRow = (sp: StoreProduct, top: Set<string>) => {
    const k = keyOf(sp);
    const picked = isPicked(k);
    const tracked = pantry?.get(k);
    const inRole = addingToItem ? attach?.inItem.get(k) : undefined;
    const size = sp.size && !nameHasSize(sp.name, sp.size) ? tidySize(sp.size, sp.name) : undefined;
    const note: { text: string; tone: NoteTone } | undefined = isExactBarcode(rankQ, sp)
      ? { text: 'Exact match', tone: 'good' }
      : tracked
        ? // 0.12.9: in the item being added to, it says which group it's in (an Also happy with one read "In your pantry" beside a +)
          { text: inRole === 'alt' ? 'Also happy with' : inRole === 'main' ? 'Products I buy' : `In ${SECTION_PLACE[(tracked.section ?? section) as Section]}`, tone: 'plain' }
        : sp.isSpecial && !sp.memberOnly
          ? { text: sentence(specialTag(sp.price, sp.wasPrice)), tone: 'good' }
          : sp.memberOnly && sp.chain !== 'costco'
            ? { text: 'Member price', tone: 'plain' }
            : !rankQ.barcode && top.has(k)
              ? { text: 'Good match', tone: 'good' }
              : // 0.11.0: what an earlier search of yours saw it at (history, never today's price)
                before.get(`${sp.chain}|${sp.storeProductId}`)
                ? { text: `You saw ${money(before.get(`${sp.chain}|${sp.storeProductId}`)!.price)} on ${seenDay(before.get(`${sp.chain}|${sp.storeProductId}`)!.day)}`, tone: 'plain' }
                : undefined;
    const what = `${sp.name} at ${chainName(sp.chain)}, ${money(sp.price)}`;
    return (
      <Hold key={k} onLong={() => setPreview(sp)}>
        <ItemRow
          className={picked ? 'picked' : undefined}
          photo={sp.imageUrl ?? photoFor(sp)}
          name={sp.name}
          chain={sp.chain}
          // 0.12.5: loose fruit and veg also say their price by the kilo
          // 0.12.8: and that price is the main one, as on the shelf ticket; the shop's price for one sits beside the shop
          shopText={`${chainName(sp.chain)}${size ? ` · ${size}` : ''}${kiloPrice(sp, sp.price)?.each ? ` · ${kiloPrice(sp, sp.price)!.each}` : ''}`}
          price={sp.price}
          priceText={kiloPrice(sp, sp.price)?.main}
          note={note}
          onOpen={() => pickOne(sp)}
          openLabel={picked ? `${what}: picked. Tap to unpick` : `Pick ${what}`}
          onInfo={() => setPreview(sp)}
          action={
            <span className={`plus-btn${picked ? ' on' : ''}`} aria-hidden="true">
              <Icon name={picked ? 'check' : 'plus'} size={22} />
            </span>
          }
        />
      </Hold>
    );
  };
  /** What a shop found, as the results show it (its second search, when the first found nothing like it). */
  const shownItems = (c: Chain): StoreProduct[] => {
    const alt = instead[c];
    const r = results[c];
    const items = alt && !original[c] ? alt.items : r?.status === 'ok' ? r.items : [];
    return uniqueProducts(items).filter((sp) => !specialsOnly || sp.isSpecial);
  };
  const topKeys = new Set(
    (searched as Chain[]).flatMap((c) => {
      const alt = instead[c];
      const r = results[c];
      return alt && !original[c] ? alt.top : r?.status === 'ok' ? (r.top ?? []) : [];
    }),
  );
  // "All": a few from each shop in turn, best first, so one shop's list doesn't fill the page.
  const PER_SHOP = 3;
  const mixed: StoreProduct[] = [];
  for (let i = 0; i < PER_SHOP; i++) for (const c of searched as Chain[]) if (shownItems(c)[i]) mixed.push(shownItems(c)[i]);
  const view: 'all' | Chain = changing ?? (searched.length > 1 ? shopView : ((searched[0] as Chain | undefined) ?? 'all'));
  const backToPicks = () => {
    setAltMode(false);
    setChanging(undefined);
    setShopView('all');
    setPanelOpen(true);
  };
  /** 0.12.1: said on the sheet itself: this shop doesn't sell it (so nothing is picked there, and it isn't picked for you again). */
  const notSoldAt = (c: Chain) => {
    setPicks((prev) => new Map([...prev].filter(([, x]) => x.chain !== c)));
    setDeclined((d) => new Set([...d, c]));
  };
  const toTop = () => screenRef.current?.scrollTo?.({ top: 0 });
  const startChange = (c: Chain, asAlt = false) => {
    setAltMode(asAlt);
    setChanging(c);
    setPanelOpen(false);
    toTop();
  };
  // Your pick at each shop: the shop you picked at first, then the others searched.
  const anchorChain: Chain | undefined = (recAnchor && picks.has(keyOf(recAnchor)) ? recAnchor.chain : [...picks.values()][0]?.chain) as Chain | undefined;
  const matchShops = [...new Set([...(anchorChain ? [anchorChain] : []), ...(searched as Chain[]), ...[...picks.values()].map((x) => x.chain as Chain)])];
  /**
   * 0.12.4: "Finished at Coles" at the bottom of one shop's results: on to the next shop that
   * answered, and after the last one, the sheet to check your picks and add.
   */
  const shopsInTurn = matchShops.filter((c) => (searched as Chain[]).includes(c) && results[c as StoreChain]?.status === 'ok');
  const nextShopAfter = (c: Chain): Chain | undefined => shopsInTurn[shopsInTurn.indexOf(c) + 1];
  const finishedAt = (c: Chain) => {
    const next = nextShopAfter(c);
    if (next) {
      if (changing) setChanging(next);
      else setShopView(next);
      toTop();
      return;
    }
    setChanging(undefined);
    setShopView('all');
    toTop();
    if (picks.size > 0) setPanelOpen(true);
  };
  /**
   * 0.12.5: "Finish: review and add" on a shop's page: straight to your picks, without walking the
   * other shops. 0.12.6: nothing is ever picked for you, so a shop you didn't tick at is simply empty
   * there ("Not added").
   */
  const finishEarly = () => {
    setAltMode(false);
    setChanging(undefined);
    setShopView('all');
    toTop();
    setPanelOpen(true);
  };
  const pickLabel = (sp: StoreProduct): { text: string; tone: NoteTone } => {
    const k = keyOf(sp);
    const scannedHere = auto?.get(sp.chain);
    // A scan's match says how sure it is (the same words as before 0.12.0, in sentence case).
    if (scannedHere && keyOf(scannedHere.sp) === k && scannedHere.sure !== 'chosen')
      return scannedHere.sure === 'closest'
        ? { text: 'Closest match · check it', tone: 'warn' }
        : { text: scannedHere.sure === 'barcode' ? 'Same barcode' : scannedHere.sure === 'same' ? 'Same product and size' : 'Name and size match', tone: 'good' };
    return { text: 'You picked', tone: 'plain' };
  };
  const matchCards = (
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
                  {chainName(c)} didn't answer just now, so Restock can't say whether it sells this. You can add it without {chainName(c)} and
                  find it there later from the item's page.
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
  );

  // 0.12.7: "Also happy with (alternative product)" while adding. It was only on the item's page
  // afterwards, so people never found it. One line per shop: your alternative there, or Find one.
  const altGroup = makesItem && (
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
  );

  const pickedCategory = categories?.find((c) => c.id === shownCategory)?.name;

  return (
    // Inside the Pick sheet the sheet scrolls, so the bar at the bottom stays in view there too.
    <div className="screen" ref={screenRef} style={forLine ? { padding: 0, overflow: 'visible', flex: 'none' } : undefined}>
      {forLine ? null : changing ? (
        // 0.12.1: "Pick one at Woolworths" is a page of its own: this title, one line, that shop's results.
        <div className="topbar">
          <button className="icon-btn" aria-label="Back" onClick={backToPicks}>
            <Icon name="back" size={20} />
          </button>
          <h1 style={{ fontSize: 24 }}>{altMode ? `Alternative at ${chainName(changing)}` : `Pick at ${chainName(changing)}`}</h1>
        </div>
      ) : !attachGroup && !onlyChain && sectionsOn.length > 1 ? (
        // 0.12.1: the title is the switcher, as on the shopping list (it was a row of buttons under the title)
        <div className="list-top navy-top navy-open">
          <div className="list-top-row add-top-row">
            {overlay && (
              <button className="icon-btn" aria-label="Back" onClick={nav.pop}>
                <Icon name="back" size={20} />
              </button>
            )}
            <button
              className="list-switch add-switch"
              aria-haspopup="menu"
              aria-expanded={switching}
              aria-label={`${title}. Tap to switch to another of your tabs`}
              onClick={() => setSwitching((x) => !x)}
            >
              <Icon name={section} size={22} />
              <span className="list-switch-name">{title}</span>
              <span className="list-switch-pill">
                Change{' '}
                <span className={switching ? 'turn-up' : 'turn-down'}>
                  <Icon name="chevron" size={16} />
                </span>
              </span>
            </button>
          </div>
          {switching && (
            <div className="list-switch-menu" role="menu" aria-label="Add to">
              {sectionsOn.map((sec) => (
                <button
                  key={sec}
                  role="menuitemradio"
                  aria-checked={sec === section}
                  className={sec === section ? 'on' : ''}
                  onClick={() => {
                    setSwitching(false);
                    switchSection(sec);
                  }}
                >
                  <Icon name={sec} size={20} />
                  <span className="grow">{SECTION_NAMES[sec]}</span>
                  {sec === section && <Icon name="check" size={18} />}
                </button>
              ))}
            </div>
          )}
        </div>
      ) : overlay ? (
        <div className="navy-top navy-open">
          <TopBar title={title} />
        </div>
      ) : (
        <div className="navy-top navy-open">
          <h1>{title}</h1>
        </div>
      )}
      {/* Read out when something's ticked or unticked (the bar at the bottom shows it). */}
      <div className="sr-only" role="status" aria-live="polite">
        {said}
      </div>
      {/* 0.12.1: everything between the title and the results steps aside while one shop's pick is being changed */}
      <div className="add-top" hidden={!!changing}>
      {photoFind && (
        <Sheet title="Find it from a photo" onClose={() => setPhotoFind(false)}>
          <p className="small" style={{ margin: 0 }}>
            Take a photo of the front of the pack, with the name filling most of it. Restock reads it on your phone.
          </p>
          <PackReader
            label="Take a photo of the pack"
            onName={(n) => setTerm(n)}
            onSearch={(n) => {
              setPhotoFind(false);
              setTerm(n);
              setSearchedFor(n);
              const fixed = normaliseQuery(n);
              void search(fixed, { text: fixed }, section, true);
            }}
          />
        </Sheet>
      )}

      {/* 0.12.4: the search box and the barcode button sit in the navy top (inside a Pick sheet they stay plain) */}
      <div className={forLine ? 'add-top' : 'navy-cont'}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setScanned(undefined);
          setKnown(undefined);
          // 0.12.6: "Lemon." (voice typing) searches for lemon.
          const t = cleanSearch(term);
          const code = productCode(t);
          // The Search press: the only search that asks Costco too (0.9.6, review L1).
          if (code) void handleBarcode(code, false, true);
          else runText(t, true);
        }}
        style={{ display: 'flex', gap: 8 }}
      >
        {/* 0.12.9: opened to type (nothing searched, scanned or picked yet): the cursor is in the box and the keyboard is up */}
        <SearchField placeholder={SEARCH_PLACEHOLDER[section]} aria-label={`Search ${SECTION_SHOPS[section]}`} enterKeyHint="search" value={term} onValue={setTerm} autoFocus={!query && !barcode && !scan && !preTickProp && !fromScans && !forLine} />
        {/* 0.12.0: Enter (the keyboard's Search key) searches, so there's no Search button; the barcode button sits by the box */}
        {!forLine && (
          <button className="btn primary" type="button" aria-label="Scan a barcode" style={{ width: 52, minWidth: 52, flexShrink: 0, padding: 0 }} onClick={doScan}>
            <Icon name="scan" />
          </button>
        )}
      </form>
      {/* 0.12.0: which shops this searches, said plainly. 0.12.4: no "Change shops" here (shops are picked in Settings). */}
      {settings && !onlyChain && !forLine && (
        <p className="small search-shops">
          Searches{' '}
          {chainsToSearch(settings.enabledChains)
            .map((c) => chainName(c))
            .join(', ')
            .replace(/, ([^,]*)$/, ' and $1') || 'no shops yet'}
        </p>
      )}
      </div>

      {/* 0.10.10: after the search box, which now comes first. 0.10.8: one tidy block: Scan a barcode, then the other ways in as equal tiles (Scan several,
          Photo, Receipt), and the scanned barcodes still to match as one line. */}
      {!forLine && (
        <div className="add-ways">
          {!attachTo && scansLeft > 0 && (
            <button className="card add-scans" onClick={() => nav.push({ name: 'scanned', section })}>
              <Icon name="scan" size={18} />
              <span className="grow">{scansLeft === 1 ? '1 scanned barcode to match' : `${scansLeft} scanned barcodes to match`}</span>
              <Icon name="chevron" size={16} />
            </button>
          )}
        </div>
      )}

      {!anyResults && !scanned && !term && recent.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ display: 'flex', alignItems: 'center' }}>
            <div className="eyebrow" style={{ flex: 1 }}>
              Recent searches
            </div>
            <button
              className="linkish small"
              style={TAP}
              onClick={() => {
                clearRecentSearches();
                setRecent([]);
              }}
            >
              Clear
            </button>
          </div>
          <div className="chips">
            {recent.map((r) => (
              <button
                key={r}
                className="chip"
                onClick={() => {
                  setTerm(r);
                  runText(r);
                }}
              >
                <Icon name="search" size={14} /> {r}
              </button>
            ))}
          </div>
        </div>
      )}

      {searchedFor && anyResults && (
        <p className="small" style={{ margin: 0 }}>
          Searched for <strong>{searchedFor}</strong>.{' '}
          <button
            className="linkish"
            style={TAP}
            onClick={() => document.querySelector<HTMLInputElement>('.screen input[type="search"], .screen input.input')?.focus()}
          >
            Change it
          </button>
        </p>
      )}

      {/* 0.10.7: you already have this: View it, Add anyway, or Cancel. Also when the barcode isn't
          linked to it yet but the shop's match is already in your pantry (scanned "pineapple" when you
          track "Canned pineapple"): then View it links the barcode, so next time it's known straight away. */}
      {scanned && (known || (alreadyHave && !dismissedHave)) && (
        <div className="card" role="region" aria-labelledby="already-have">
          <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <Thumb src={scanned.imageUrl} icon="scan" />
            <div style={{ flex: 1 }}>
              <div className="eyebrow green" id="already-have">
                {known ? `You already have this in ${SECTION_PLACE[known.section ?? section]}` : `Looks like you already have this in ${SECTION_PLACE[(alreadyHave?.group.section ?? section) as Section]}`}
              </div>
              <div className="title">{(known ?? alreadyHave?.group)?.name}</div>
            </div>
          </div>
          <div className="three-btns">
            <button
              className="btn primary"
              onClick={async () => {
                const g = known ?? alreadyHave?.group;
                if (!g) return;
                if (!known && alreadyHave) await linkBarcode(alreadyHave.productKey, scanned.barcode);
                nav.push({ name: 'item', groupId: g.id });
              }}
            >
              View it
            </button>
            <button
              className="btn"
              onClick={() => {
                if (known) void handleBarcode(scanned.barcode, true);
                else setDismissedHave(true);
              }}
            >
              Add anyway
            </button>
            <button
              className="btn"
              onClick={() => {
                setDismissedHave(false);
                reset();
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* 0.10.8: not as well as the "already have" card above (the same photo twice) */}
      {scanned && !known && !(alreadyHave && !dismissedHave) && (
        <div className="card" style={{ flexDirection: 'row', alignItems: 'center' }}>
          <Thumb src={scanned.imageUrl} icon="scan" />
          <div style={{ flex: 1 }}>
            <div className="eyebrow green">Scanned {scanned.barcode}</div>
            <div className="title">{scanned.name ? displayName(scanned) : lookingUp ? 'Looking it up…' : "We don't know this barcode yet."}</div>
            {scanned.size && <div className="small">{tidySize(scanned.size, scanned.name)}</div>}
            {(scanned as { source?: string }).source && <div className="small">Found on {(scanned as { source?: string }).source}</div>}
          </div>
        </div>
      )}

      {scanned && !known && !scanned.name && !lookingUp && (
        <form
          className="card"
          onSubmit={(e) => {
            e.preventDefault();
            const t = whatIsIt.trim();
            if (!t) return;
            setTerm(t);
            const fixed = normaliseQuery(t);
            void search(fixed, { text: fixed, barcode: scanned.barcode }, section, true); // its Search button
          }}
        >
          <div className="title">What is it?</div>
          <p className="small">
            Take a photo of the front of the pack and Restock reads the name, or type it in. Restock searches for it and remembers this barcode
            next time.
          </p>
          {/* 0.10.7: for everyone (it used to need the Receipts add-on), and Google Lens as the backup. */}
          <PackReader
            barcode={scanned.barcode}
            onName={(n, go) => {
              setWhatIsIt(n);
              if (!go) return;
              setTerm(n);
              setSearchedFor(n);
              const fixed = normaliseQuery(n);
              void search(fixed, { text: fixed, barcode: scanned.barcode });
            }}
          />
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              className="input"
              value={whatIsIt}
              onChange={(e) => setWhatIsIt(e.target.value)}
              placeholder="Brand and product"
              aria-label="What is it?"
            />
            <button className="btn primary" type="submit" style={{ padding: '0 14px' }}>
              Search
            </button>
          </div>
          {QUICK_PICKS[section].length > 0 && (
            <div className="chips" role="group" aria-label="Quick picks">
              {QUICK_PICKS[section].map((q) => (
                <button
                  key={q}
                  type="button"
                  className="chip"
                  onClick={() => {
                    setWhatIsIt(q);
                    setTerm(q);
                    setSearchedFor(q);
                    void search(q.toLowerCase(), { text: q.toLowerCase(), barcode: scanned.barcode });
                  }}
                >
                  {q}
                </button>
              ))}
            </div>
          )}
        </form>
      )}

      {/* 0.12.0: a scan's best matches open as "your pick at each shop" (they were a card of tick boxes here) */}
      {auto && auto.size > 0 && picks.size > 0 && !panelOpen && !changing && (
        <div className="card best-match">
          <div className="eyebrow green">Best match</div>
          <strong>Found at {[...auto.keys()].map((c) => chainName(c)).join(auto.size === 2 ? ' and ' : ', ')}</strong>
          <button className="btn primary" onClick={() => setPanelOpen(true)}>
            See your pick at each shop
          </button>
        </div>
      )}
      {rankQ.barcode && !auto && searched.some((c) => !results[c] || results[c]?.status === 'loading') && (
        <div className="card best-match" role="status">
          <div className="eyebrow green">Best match</div>
          <span className="small">Finding this product at {searched.map((c) => chainName(c)).join(searched.length === 2 ? ' and ' : ', ')}…</span>
          <LoadingBar seconds={10} />
        </div>
      )}
      {auto && auto.size === 0 && rankQ.barcode && candidates && candidates.length > 0 && (
        <div className="card best-match">
          <div className="eyebrow green">Which one did you scan?</div>
          <span className="small">
            {brandOnly(rankQ)
              ? `The barcode only told Restock the brand (${rankQ.brand}).`
              : `Restock couldn't be sure which ${rankQ.brand} product this is.`}{' '}
            Tap the one you've got. It remembers this barcode for next time.
          </span>
          <div className="card flush" style={{ boxShadow: 'none' }}>
            {candidates.map((c) => (
              <div key={keyOf(c.sp)} className="row" style={{ gap: 10 }}>
                <MoreInfo src={c.sp.imageUrl ?? photoFor(c.sp)} name={c.sp.name} onOpen={() => setPreview(c.sp)} />
                <button className="row-main" style={{ color: 'inherit', font: 'inherit', ...TAP }} onClick={() => choose(c)} aria-label={`It's ${c.sp.name}`}>
                  <span className="grow" style={{ textAlign: 'left' }}>
                    <span className="title" style={{ fontSize: 15 }}>
                      {c.sp.name}
                    </span>
                    <span className="small">
                      {c.sp.size && !nameHasSize(c.sp.name, c.sp.size) ? `${tidySize(c.sp.size, c.sp.name)} · ` : ''}
                      {c.at.map((p) => chainName(p.chain)).join(c.at.length === 2 ? ' and ' : ', ')} · from{' '}
                      {money(Math.min(...c.at.map((p) => p.price ?? Infinity)))}
                    </span>
                  </span>
                  <Icon name="chevron" size={18} />
                </button>
                <RowInfo name={c.sp.name} onOpen={() => setPreview(c.sp)} />
              </div>
            ))}
          </div>
          <span className="small">Not there? Look through each shop's list below, or type what's on the pack.</span>
        </div>
      )}
      {auto && auto.size === 0 && rankQ.barcode && !candidates?.length && (
        <div className="banner grey" style={{ fontSize: 13 }}>
          Restock couldn't be sure which product this is at your shops, so nothing's picked yet. Tick it at each shop
          you buy it at.
        </div>
      )}

      {sizesFor && anyResults && !changing && (
        <OtherSizesCard
          anchor={sizesFor}
          pool={sizesPool}
          skip={sizesSkip}
          picks={addingToItem ? new Map(sizesPool.filter((sp) => isPicked(keyOf(sp))).map((sp) => [keyOf(sp), sp])) : picks}
          onToggle={toggle}
          onPreview={setPreview}
          photoFor={photoFor}
          containersOn={!!settings?.otherContainerSizes}
          onContainers={(on) => void updateSettings({ otherContainerSizes: on })}
          searching={sizesBusy === sizesKey}
        />
      )}

      </div>
      {/* 0.12.1: changing one shop's pick: one line on what it's compared with, and that shop's results only */}
      {changing && (
        <div className="change-head">
          {anchorChain && anchorChain !== changing && [...picks.values()].find((x) => x.chain === anchorChain) && (
            <p className="small" style={{ margin: 0 }}>
              To compare with {[...picks.values()].find((x) => x.chain === anchorChain)!.name} from {chainName(anchorChain)}.
            </p>
          )}
          <p className="small" style={{ margin: 0 }}>
            {altMode
              ? `Tick a second choice at ${chainName(changing)}: another brand or size you'd accept. Tap one again to untick it.`
              : `Tick everything you buy as this at ${chainName(changing)}. Tap one again to untick it.`}
          </p>
          <button className="btn block" onClick={backToPicks}>
            Back to your picks
          </button>
        </div>
      )}

      {anyResults && !changing && (
        <div className="chips" role="group" aria-label="Show results from">
          {searched.length > 1 && (
            <button className="chip" aria-pressed={view === 'all'} onClick={() => setShopView('all')}>
              All
            </button>
          )}
          {searched.length > 1 &&
            (searched as Chain[]).map((c) => (
              <button key={c} className="chip" aria-pressed={view === c} onClick={() => setShopView(c)}>
                {chainName(c)}
              </button>
            ))}
          <button className="chip" aria-pressed={specialsOnly} onClick={() => setSpecialsOnly((v) => !v)}>
            On special only
          </button>
        </div>
      )}

      {anyResults && view === 'all' && searched.length > 1 && (
        <>
          {/* 0.12.5: said plainly: the first results are the closest match at each of your shops */}
          {mixed.length > 0 && (
            <div className="rec-head">
              <span className="rec-tag">Recommended</span>
              <span className="small">The closest matches at your shops. Tick the ones you buy.</span>
            </div>
          )}
          {mixed.length > 0 && <div className="card flush">{mixed.map((sp) => resultRow(sp, topKeys))}</div>}
          {(searched as Chain[]).some((c) => results[c as StoreChain]?.status === 'ok' && shownItems(c).length > PER_SHOP) && (
            <div className="eyebrow">Everything else</div>
          )}
          {(searched as Chain[]).map((c) => {
            const r = results[c as StoreChain];
            const left = shownItems(c).length - Math.min(PER_SHOP, shownItems(c).length);
            if (r?.status === 'loading')
              return (
                <div key={c} role="status" className="small">
                  Searching {chainName(c)}…
                  <LoadingBar seconds={(shopDef(c)?.kind ?? 'web') === 'web' ? 25 : 8} />
                </div>
              );
            if (r?.status === 'error')
              return isNative() ? (
                <div key={c} className="banner amber shop-miss">
                  <span>
                    <strong>{chainName(c)} didn't answer.</strong> {r.blocked ? 'Its website is checking for bots.' : 'Its prices are missing from this list.'}
                  </span>
                  <button className="btn small" style={TAP} onClick={() => setShopView(c)}>
                    See why
                  </button>
                </div>
              ) : null;
            if (r?.status === 'ok' && !shownItems(c).length)
              return (
                <p key={c} className="small" style={{ margin: 0 }}>
                  {specialsOnly ? `Nothing on special at ${chainName(c)}.` : `No matches at ${chainName(c)}.`}
                </p>
              );
            return left > 0 ? (
              // 0.12.2: a full-width button at the usual height (it was a small grey one)
              <button key={c} className="btn more-from" onClick={() => setShopView(c)}>
                <ChainDot chain={c} />
                <span className="grow">More from {chainName(c)}</span>
                <span className="num more-from-n">{left}</span>
                <Icon name="chevron" size={18} />
              </button>
            ) : null;
          })}
        </>
      )}

      {!isNative() && anyResults && (
        <div className="banner grey">
          <strong>Shop search works in the Android app</strong>
          <span style={{ fontSize: 13 }}>In this preview you can still add items by hand.</span>
        </div>
      )}

      {costcoLeftOut && isNative() && (
        <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <span className="small">Costco is only searched when you press Search.</span>
          <button className="btn" style={TAP} onClick={searchCostcoToo}>
            <Icon name="search" size={18} /> Search Costco
          </button>
        </div>
      )}

      {(() => {
        // Only hide a shop's results as "nothing like it" when another shop does have it.
        const likely = new Set(
          searched.filter((c) => {
            const r = results[c];
            return r?.status === 'ok' && r.items.length > 0 && bestScore(rankQ, r.items) >= UNLIKELY;
          }),
        );
        return searched
          .filter((c) => results[c] && view === c)
          .map((chain) => {
            const alt = instead[chain];
            const useAlt = !!alt && !original[chain];
            const first = results[chain]!;
            const firstCount = first.status === 'ok' ? first.items.length : 0;
            const r: ChainResult = useAlt ? { status: 'ok', items: alt.items, top: alt.top } : first;
            if (r.status === 'error' && !isNative()) return null;
            const limit = showing[chain] ?? FIRST_PAGE;
            const pool = r.status === 'ok' ? uniqueProducts(r.items).filter((sp) => !specialsOnly || sp.isSpecial) : [];
            const by = sortBy[chain] ?? 'relevant';
            // 0.12.5: by price or value, what doesn't mention what you typed goes after what does (steel wool isn't the cheapest potato)
            const inOrder = sorted(pool, by);
            const onTopic = by === 'relevant' || !rankQ.text ? inOrder : inOrder.filter((sp) => mentions(rankQ, sp));
            const ordered = onTopic.length && onTopic.length < inOrder.length ? [...onTopic, ...inOrder.filter((sp) => !onTopic.includes(sp))] : inOrder;
            // Ticked products first, so a ticked best match is never hidden under "Show more".
            const firstTicked =
              by === 'relevant' ? [...ordered.filter((sp) => picks.has(keyOf(sp))), ...ordered.filter((sp) => !picks.has(keyOf(sp)))] : ordered;
            // A shop with nothing like what you scanned or typed (wine and tofu for a dishwashing liquid).
            const unlikely =
              !useAlt &&
              r.status === 'ok' &&
              !!rankQ.text &&
              likely.size > 0 &&
              !likely.has(chain) &&
              pool.length > 0 &&
              !showUnlikely[chain] &&
              !ordered.some((sp) => picks.has(keyOf(sp))) &&
              bestScore(rankQ, pool) < UNLIKELY;
            const list = unlikely ? [] : firstTicked.slice(0, limit);
            const left = unlikely ? 0 : pool.length - list.length;
            const top = new Set(r.status === 'ok' ? (r.top ?? []) : []);
            const more = r.status === 'ok' && !!r.more && !unlikely && !specialsOnly;
            return (
              <section key={chain} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div className="eyebrow" style={{ flex: 1 }}>
                    <ChainName chain={chain} />
                  </div>
                  {r.status === 'ok' && r.items.length > 1 && (
                    <select
                      className="input"
                      style={{ width: 'auto', maxWidth: '60%', height: 44, padding: '0 8px', fontSize: 13 }}
                      value={sortBy[chain] ?? 'relevant'}
                      onChange={(e) => setSortBy((m) => ({ ...m, [chain]: e.target.value as SortKey }))}
                      aria-label={`Sort ${chainName(chain)} results`}
                    >
                      {SORTS.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
                {r.status === 'loading' && (
                  <div role="status" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <p className="small">
                      Searching {chainName(chain)}…
                      {(shopDef(chain)?.kind ?? 'web') === 'web' ? ' Reading the shop’s own website can take up to half a minute.' : ''}
                    </p>
                    <LoadingBar seconds={(shopDef(chain)?.kind ?? 'web') === 'web' ? 25 : 8} />
                  </div>
                )}
                {r.status === 'error' && (
                  <div className="banner amber" style={{ fontSize: 13 }}>
                    {r.blocked ? (
                      <>
                        <strong>{chainName(chain)} is blocking Restock</strong>
                        <span>Its website is checking for bots. That’s its check, not Restock’s. Unblock it once and prices carry on.</span>
                      </>
                    ) : (
                      r.message
                    )}
                    {settings && (
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
                        <button className="btn small" style={TAP} onClick={() => void searchChain(chain, lastText, rankQ, searchStoreId(settings, chain))}>
                          <Icon name="refresh" size={16} /> Try again
                        </button>
                        {(r.blocked || r.unblock) && (
                          <UnblockButton small chain={chain} onWorked={() => void searchChain(chain, lastText, rankQ, searchStoreId(settings, chain))} />
                        )}
                      </div>
                    )}
                  </div>
                )}
                {alt && (
                  <p className="small">
                    {useAlt && (
                      <>
                        {chainName(chain)} doesn’t seem to have “{lastText}”. Its {alt.kind} instead:{' '}
                      </>
                    )}
                    {(useAlt ? firstCount > 0 : true) && (
                      <button className="linkish small" style={TAP} onClick={() => setOriginal((m) => ({ ...m, [chain]: !m[chain] }))}>
                        {useAlt ? `Show what it found for “${lastText}” (${firstCount})` : `Show ${chainName(chain)}’s ${alt.kind} instead`}
                      </button>
                    )}
                  </p>
                )}
                {r.status === 'ok' && !r.items.length && (
                  <p className="small">
                    No matches at {chainName(chain)}.
                    {/* A shop read off its website that found nothing may just not be readable yet (0.8.6). */}
                    {shopKindOf(chain) === 'web' &&
                      ' If it sells this, its website may not work with Restock yet: Settings → Advanced → Diagnostics → Send search details helps get it fixed.'}
                  </p>
                )}
                {r.status === 'ok' && r.items.length > 0 && !pool.length && <p className="small">Nothing on special at {chainName(chain)}.</p>}
                {unlikely && (
                  <p className="small">
                    Nothing like it at {chainName(chain)}.{' '}
                    <button className="linkish small" style={TAP} onClick={() => setShowUnlikely((m) => ({ ...m, [chain]: true }))}>
                      Show what {chainName(chain)} found ({pool.length})
                    </button>
                  </p>
                )}
                {/* 0.10.11: tick one flavour, and the same thing's other flavours here (same brand and size) are one tap */}
                {(() => {
                  const mine = [...picks.values()].filter((x) => x.chain === chain);
                  const more = otherFlavours(mine, pool, (a, b) => keyOf(a) === keyOf(b));
                  if (!more.length) return null;
                  const word = varietyWord([...mine, ...more].map((x) => x.name));
                  if (changing) return null; // 0.12.1: one choice at a time on "Pick one at …"
                  return (
                    <button
                      className="btn small flavour-all"
                      style={TAP}
                      onClick={() => {
                        setPicks((prev) => {
                          const next = new Map(prev);
                          for (const x of more) next.set(keyOf(x), x);
                          return next;
                        });
                        setShowing((m) => ({ ...m, [chain]: Math.max(m[chain] ?? 0, pool.length) }));
                      }}
                    >
                      <Icon name="check" size={16} /> Add the other {more.length === 1 ? word.replace(/s$/, '') : `${more.length} ${word}`} too
                    </button>
                  );
                })()}
                {list.length > 0 && (
                  <div className="card flush">
                    {list.map((sp) => resultRow(sp, top))}
                  </div>
                )}
                {left > 0 && (
                  <button className="btn ghost small" style={TAP} onClick={() => setShowing((m) => ({ ...m, [chain]: limit + MORE_PAGE }))}>
                    Show more ({left})
                  </button>
                )}
                {left <= 0 && more && r.status === 'ok' && (
                  <button className="btn ghost small" style={TAP} disabled={r.loadingMore} onClick={() => void loadMore(chain)}>
                    {r.loadingMore ? `Getting more from ${chainName(chain)}…` : `Get more from ${chainName(chain)}`}
                  </button>
                )}
                {first.status === 'ok' && !rankQ.barcode && isNative() && (
                  <button className="linkish small" style={{ alignSelf: 'flex-end', ...TAP }} onClick={() => void reportWrong(chain)}>
                    Wrong results? Save them for the developer
                  </button>
                )}
              </section>
            );
          });
      })()}

      {suggest.length > 0 && (
        <div className="card hint" style={{ flexDirection: 'column' }}>
          <strong>Same product at {suggest.map((x) => chainName(x.chain)).join(' and ')}?</strong>
          {suggest.map((x) => (
            <span key={keyOf(x)} className="small clip">
              <ChainDot chain={x.chain} /> {x.name} · {money(x.price)}
            </span>
          ))}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button
              className="btn small primary"
              style={TAP}
              onClick={() => {
                setPicks((prev) => {
                  const next = new Map(prev);
                  for (const x of suggest) next.set(keyOf(x), x);
                  return next;
                });
                setSuggest([]);
              }}
            >
              <Icon name="check" size={16} /> Pick {suggest.length === 1 ? 'it' : 'them'} too
            </button>
            <button className="btn small" style={TAP} onClick={() => setSuggest([])}>
              No thanks
            </button>
          </div>
        </div>
      )}

      {/* 0.12.4: one shop's results end with the way on: the next shop, or your picks */}
      {view !== 'all' && anyResults && !attachTo && !forLine && results[view as StoreChain]?.status === 'ok' && (searched.length > 1 || !!changing) && (
        <div className="shop-done">
          {/* 0.12.5: two ways on: the next shop, or straight to your picks (it was one button, "Finished at Coles") */}
          {altMode ? (
            // 0.12.7: finding an alternative at one shop: one way on, back to your picks.
            <button className="btn primary block shop-done-btn" onClick={backToPicks}>
              <Icon name="check" size={18} /> Done: back to your picks
            </button>
          ) : nextShopAfter(view as Chain) ? (
            <>
              <button className="btn primary block shop-done-btn" onClick={() => finishedAt(view as Chain)}>
                Next shop: {chainName(nextShopAfter(view as Chain)!)}
                <Icon name="chevron" size={18} />
              </button>
              {picks.size > 0 && (
                <button className="btn block shop-done-btn" onClick={() => finishEarly()}>
                  <Icon name="check" size={18} /> Finish: review and add
                </button>
              )}
            </>
          ) : (
            <button className="btn primary block shop-done-btn" onClick={() => finishedAt(view as Chain)}>
              <Icon name="check" size={18} /> {picks.size > 0 ? 'Finish: review and add' : `Finished at ${chainName(view)}`}
            </button>
          )}
          {!altMode && ![...picks.values()].some((x) => x.chain === view) && !declined.has(view) && picks.size > 0 && (
            <button
              className="btn block"
              onClick={() => {
                notSoldAt(view as Chain);
                finishedAt(view as Chain);
              }}
            >
              Not sold at {chainName(view)}
            </button>
          )}
        </div>
      )}

      {/* 0.12.4: Add manually shows once you've searched or scanned (it sat on the empty screen too), as a big button under the results */}
      {(!!searchedFor || !!scanned || anyResults) && !changing && (
        <div className="add-manual">
          <span className="small">Can't find it at your shops?</span>
          <button className="btn block add-manual-btn" onClick={() => setManual(true)}>
            <Icon name="pencil" size={18} /> Add manually
          </button>
        </div>
      )}

      {/* 0.12.5: "More ways to add" is one button again, on the empty screen and under the results. It opens to the other ways in:
          by hand, several barcodes in a row, a photo of the pack, a receipt. (0.12.4 had two small links under Add manually and a receipt button.) */}
      {!forLine && !changing && (
        <div className="add-more-ways">
          <button className="btn block add-more-btn" aria-expanded={moreWays} onClick={() => setMoreWays((o) => !o)}>
            <span className="grow">More ways to add</span>
            <span className={moreWays ? 'turn-up' : 'turn-down'}>
              <Icon name="chevron" size={16} />
            </span>
          </button>
          {moreWays && (
            <div className="card flush">
              <button className="row" onClick={() => setManual(true)}>
                <Icon name="pencil" size={22} />
                <span className="grow">
                  <span className="title" style={{ fontSize: 15 }}>
                    Add manually
                  </span>
                  <span className="small">Type it in, for things your shops don't list</span>
                </span>
                <Icon name="chevron" size={16} />
              </button>
              {!attachTo && (
                <button className="row" onClick={() => nav.push({ name: 'scanned', section, start: true })}>
                  <Icon name="scan" size={22} />
                  <span className="grow">
                    <span className="title" style={{ fontSize: 15 }}>
                      Scan several barcodes
                    </span>
                    <span className="small">One after another, then match them</span>
                  </span>
                  <Icon name="chevron" size={16} />
                </button>
              )}
              {!scanned && (
                <button className="row" onClick={() => setPhotoFind(true)}>
                  <Icon name="camera" size={22} />
                  <span className="grow">
                    <span className="title" style={{ fontSize: 15 }}>
                      Find it from a photo
                    </span>
                    <span className="small">Take a picture of the pack</span>
                  </span>
                  <Icon name="chevron" size={16} />
                </button>
              )}
              {/* Shown wherever Add is opened from (the old receipt button only showed on an Add tab, which is gone) */}
              {!attachTo && !scanned && (
                <button className="row" onClick={() => nav.push(settings?.receipts.enabled ? { name: 'receipt' } : { name: 'receipts' })}>
                  <Icon name="receipt" size={22} />
                  <span className="grow">
                    <span className="title" style={{ fontSize: 15 }}>
                      Scan a receipt
                    </span>
                    <span className="small">Keep it and add what you bought</span>
                  </span>
                  <Icon name="chevron" size={16} />
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {addingToItem && attachGroup && picks.size === 0 && (
        // 0.12.8: adding to an item you already have: each + is saved as you tap it.
        // 0.12.9: a big Done button on the bottom edge from the start (it was a small bar that showed after the first +).
        <div className="sticky-cta add-done">
          <span className="small" role="status">
            {addedCount > 0
              ? `${addedCount} added to ${as === 'alt' ? 'Also happy with' : attachGroup.name} · saved already`
              : 'Each + is saved as you tap it.'}
          </span>
          <button className="btn primary block" onClick={() => nav.pop()}>
            <Icon name="check" size={18} /> Done
          </button>
        </div>
      )}
      {picks.size > 0 && !changing && (
        // The bar: what's ticked and where. Tap it (or its green arrow) to name it and add it.
        <button
          className="card add-mini"
          onClick={() => setPanelOpen((open) => sheetOpenAfter(open, { kind: 'arrow', size: picks.size }))}
          aria-haspopup="dialog"
          aria-expanded={panelOpen}
          aria-label={`${picks.size} picked at ${tickedShops([...picks.values()])}. Review and add`}
        >
          <span className="grow add-mini-text">
            <span className="title" style={{ fontSize: 15 }}>
              {picks.size} picked · Review and add
            </span>
            {!flavourBarNote(picks.values(), chainName) && <span className="small">Tick any others you buy as this, then tap here.</span>}
            <span className="small clip">{tickedShops([...picks.values()])}</span>
            {flavourBarNote(picks.values(), chainName) && <span className="small">{flavourBarNote(picks.values(), chainName)}</span>}
          </span>
          <span className="add-mini-arrow" aria-hidden="true">
            <span style={{ display: 'inline-flex', transform: 'rotate(-90deg)' }}>
              <Icon name="chevron" size={26} />
            </span>
          </span>
        </button>
      )}
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
                  <button className="btn small" style={TAP} disabled={saving} onClick={() => void useTracked(trackedPick)}>
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
                    <AddBtn target="both" busy={busyAs} className="btn" onClick={() => void save('both')}>
                      <Icon name="cart" size={18} /> And put it on my shopping list
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
                      ? `Kept in ${SECTION_PLACE[section]}, and Restock keeps watching its price.`
                      : addButtonsNote(SECTION_PLACE[section], pickedCategory)}
                </p>
              </>
            )
          )}
        </Sheet>
      )}

      {preview && (
        <ProductPreview
          product={storePreview(preview)}
          onClose={() => setPreview(undefined)}
          action={
            <>
              <CostcoLines sp={preview} />
              <button
                className={`btn ${isPicked(keyOf(preview)) ? '' : 'primary'}`}
                onClick={() => {
                  if (isPicked(keyOf(preview))) toggle(preview);
                  else pickOne(preview);
                  setPreview(undefined);
                }}
              >
                <Icon name={isPicked(keyOf(preview)) ? 'close' : 'plus'} size={18} /> {isPicked(keyOf(preview)) ? (addingToItem ? 'Take it off' : 'Remove this pick') : addingToItem ? 'Add this one' : 'Pick this one'}
              </button>
            </>
          }
        />
      )}

      {askShops && settings && (
        <WhereShopSheet
          onClose={() => setAskShops(undefined)}
          onOther={async () => {
            await updateSettings({ shopsAsked: true });
            setAskShops(undefined);
            nav.push({ name: 'stores', section: 'pantry' });
          }}
          onDone={async (chains) => {
            const now = await getSettings();
            await updateSettings({ enabledChains: [...now.enabledChains.filter((c) => !FIRST_SHOPS.includes(c)), ...chains], shopsAsked: true });
            const a = askShops;
            setAskShops(undefined);
            void search(a.q, a.rq, a.sec, a.pressed, await getSettings());
          }}
        />
      )}

      {manual && (
        <ManualSheet
          attachTo={attachGroup}
          as={as}
          defaultName={name || term}
          barcode={scanned?.barcode}
          categories={categories ?? []}
          section={section}
          shops={settings ? enabledIn(settings.enabledChains, section) : []}
          forLine={forLine}
          onClose={() => setManual(false)}
          onDone={(groupId) => {
            setManual(false);
            reset();
            if (overlay) nav.pop();
            if (groupId && !attachGroup) nav.push({ name: 'item', groupId });
          }}
        />
      )}
    </div>
  );
}

/** 0.12.0: the three most people use; every other shop is one tap further (Settings → your shops). */
const FIRST_SHOPS: StoreChain[] = ['woolworths', 'coles', 'aldi'];

/** 0.12.0: "Where do you shop?", asked by a new phone's first search in place of the setup step. */
function WhereShopSheet({
  onDone,
  onOther,
  onClose,
}: {
  onDone: (chains: StoreChain[]) => void | Promise<void>;
  onOther: () => void | Promise<void>;
  onClose: () => void;
}) {
  // None ticked to start with: which shops is your choice, and no shop gets a head start.
  const [on, setOn] = useState<StoreChain[]>([]);
  return (
    <Sheet title="Where do you shop?" onClose={onClose}>
      <p className="small" style={{ margin: 0 }}>
        Tick the ones you use. Restock searches them and compares them. Asked once: change it any time in Settings.
      </p>
      <div className="where-shops">
        {FIRST_SHOPS.map((c) => (
          <label key={c} className={`where-shop${on.includes(c) ? ' on' : ''}`}>
            <ChainDot chain={c} />
            <span className="grow">{chainName(c)}</span>
            <input type="checkbox" checked={on.includes(c)} onChange={() => setOn((list) => (list.includes(c) ? list.filter((x) => x !== c) : [...list, c]))} />
          </label>
        ))}
      </div>
      <button className="linkish" style={TAP} onClick={() => void onOther()}>
        Other shops (IGA, Costco and more)
      </button>
      <button className="btn primary block" disabled={!on.length} onClick={() => void onDone(on)}>
        {on.length ? `Search ${on.length} shop${on.length === 1 ? '' : 's'}` : 'Pick at least one shop'}
      </button>
    </Sheet>
  );
}

export function ManualSheet({
  attachTo,
  as,
  defaultName,
  barcode,
  categories,
  section,
  shops,
  forLine,
  onClose,
  onDone,
}: {
  attachTo?: Group;
  as: 'main' | 'alt';
  defaultName: string;
  barcode?: string;
  categories: { id: string; name: string }[];
  section: Section;
  /** This tab's shops, to pick from. */
  shops: StoreChain[];
  /** 0.9.5, from the Pick sheet: only "Add to pantry", and the list line becomes the new item. */
  forLine?: ForLine;
  onClose: () => void;
  onDone: (groupId?: string) => void;
}) {
  const [name, setName] = useState(defaultName);
  const [chain, setChain] = useState<Chain>(shops[0] ?? 'other');
  const [size, setSize] = useState('');
  const [price, setPrice] = useState('');
  const [special, setSpecial] = useState(false);
  const [categoryId, setCategoryId] = useState('');
  // One save at a time, so a double tap doesn't add it twice.
  const [saving, setSaving] = useState(false);
  const [busyAs, setBusyAs] = useState<Target>();
  const savingRef = useRef(false);
  // 0.12.10: a new item can't take a name another item has (adding to an item, or a list line, can).
  const everyItem = useLive(allGroups, []);
  const takenItem = attachTo ? undefined : sameNameItem(everyItem, name);
  const [takenSaid, setTakenSaid] = useState(false);

  const save = async (target: Target) => {
    if (!name.trim() || savingRef.current) return;
    if (target !== 'list' && takenItem) {
      setTakenSaid(true);
      requestAnimationFrame(() => document.getElementById('manual-name-taken')?.scrollIntoView({ block: 'center' }));
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setBusyAs(target);
    try {
      await saveAs(target);
    } finally {
      savingRef.current = false;
      setSaving(false);
      setBusyAs(undefined);
    }
  };

  const saveAs = async (target: Target) => {
    const n = name.trim();
    // 0.9.5 (undo): whatever this adds is one Undo; what to do after comes back from it.
    const next = await act(
      (r: { said?: string }) => r.said ?? null,
      async (): Promise<{ said?: string; after: () => void }> => {
        if (target === 'list') {
          // 0.9.6 (review H1): never a list line at Costco (it is shared): "Any shop", and it says so.
          const atCostco = isLocalOnlyShop(chain);
          await addListEntry({ id: uid(), text: n, chain: atCostco ? undefined : chain, categoryId: categoryId || undefined, section, checked: false, createdAt: nowIso() });
          // 0.9.11: from the Pick sheet, this replaces the line.
          if (forLine) await deleteListEntries([forLine.entry.id]);
          return { said: `${n} added to your shopping list${atCostco ? `. ${COSTCO_LIST_NOTE}` : ''}`, after: () => (forLine ? forLine.onListed() : onDone()) };
        }
        const id = uid();
        await addProduct({ id, chain, name: n, size: size || undefined, barcode: as === 'main' ? barcode : undefined, createdAt: nowIso() });
        // "$4.50" works as well as "4.50" (0.9.0).
        const p = parseMoney(price);
        if (p > 0) await addReading({ productId: id, date: nowIso(), price: p, isSpecial: special, memberOnly: false, source: 'manual' });
        if (attachTo) {
          if (as === 'alt') await updateGroup(attachTo.id, { altProductIds: [...attachTo.altProductIds, id] });
          else {
            const notAt = (attachTo.notAt ?? []).filter((c) => c !== chain);
            if (!attachTo.usualProductId) await updateGroup(attachTo.id, { usualProductId: id, notAt });
            else await updateGroup(attachTo.id, { sameProductIds: [...attachTo.sameProductIds, id], notAt });
          }
          return { said: `Added to ${attachTo.name}`, after: () => onDone(attachTo.id) };
        }
        const groupId = uid();
        await addGroup({
          id: groupId,
          name: tidyItemName(n), // 0.11.3: starts with a capital
          // 0.11.2: no category chosen: the one its name fits, else none ("Other").
          categoryId: categoryId || guessCategoryId([n], categories.map((c) => ({ ...c, section })), section) || undefined,
          usualProductId: id,
          sameProductIds: [],
          altProductIds: [],
          alertLevel: 'good',
          section,
          createdAt: nowIso(),
        });
        if (forLine) {
          // 0.9.11: "Add to both" (the line becomes it) or "Add to pantry" (the line comes off the list).
          const off = target === 'pantry';
          const linked = await (off ? pickItemOffList : pickItemFor)(forLine.entry, { id: groupId, name: n }, forLine.always);
          return {
            said: pickedWords(n, { made: true, linked, always: forLine.always, word: forLine.word, place: SECTION_PLACE[section], off }),
            after: () => forLine.onDone({ id: groupId, name: n }, true, linked),
          };
        }
        if (target === 'both') {
          await addListEntry({ id: uid(), text: n, groupId, categoryId: categoryId || undefined, section, checked: false, createdAt: nowIso() });
        }
        return {
          said: target === 'both' ? `${n} added to ${SECTION_PLACE[section]} and shopping list` : `${n} added to ${SECTION_PLACE[section]}`,
          after: () => onDone(groupId),
        };
      },
    );
    next.after();
  };

  return (
    <Sheet title="Add manually" onClose={onClose} unsaved={!saving && !busyAs && (name.trim() !== defaultName.trim() || !!size.trim() || !!price.trim())}>
      <p className="small">Prices for hand-added products aren't checked automatically. Enter them from the shelf or catalogue as you see them.</p>
      <label className="field">
        <span>Product name</span>
        <input
          className="input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus={!defaultName.trim()}
          aria-invalid={takenSaid && !!takenItem}
          aria-describedby={takenSaid && takenItem ? 'manual-name-taken' : undefined}
        />
      </label>
      {takenSaid && takenItem && (
        <span id="manual-name-taken" className="small name-first-help missing" role="alert">
          {sameNameWords(takenItem)}
        </span>
      )}
      <div className="two">
        <label className="field">
          <span>Shop</span>
          <select className="input" value={chain} onChange={(e) => setChain(e.target.value as Chain)}>
            {shops.map((c) => (
              <option key={c} value={c}>
                {chainName(c)}
              </option>
            ))}
            <option value="other">Other</option>
          </select>
        </label>
        <label className="field">
          <span>Size</span>
          <input className="input" placeholder="e.g. 1kg, 24 pack" value={size} onChange={(e) => setSize(e.target.value)} />
        </label>
      </div>
      <div className="two">
        <label className="field">
          <span>Price today ($)</span>
          <input className="input num" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} />
        </label>
        <label className="check" style={{ alignSelf: 'end', padding: '0 0 12px' }}>
          <input type="checkbox" checked={special} onChange={(e) => setSpecial(e.target.checked)} />
          <span>On special</span>
        </label>
      </div>
      {!attachTo && (
        <label className="field">
          <span>Category</span>
          <CategoryPick section={section} categories={categories} value={categoryId} onChange={setCategoryId} none="None" />
        </label>
      )}
      {forLine ? (
        <>
          <PickButtons forLine={forLine} section={section} saving={saving} busy={busyAs} blocked={!name.trim()} onSave={(t) => void save(t)} />
        </>
      ) : attachTo ? (
        <button className="btn primary" disabled={!name.trim() || saving} onClick={() => save('pantry')}>
          {as === 'alt' ? 'Add to Also happy with' : `Add to ${attachTo.name}`}
        </button>
      ) : (
        <>
          {/* 0.9.12: the same layout as the search results and Pick my…. */}
          <AddBtn target="both" busy={busyAs} blocked={!name.trim()} className="btn primary" onClick={() => void save('both')}>
            Add to both
          </AddBtn>
          <AddPair section={section} category={categories.find((c) => c.id === categoryId)?.name} disabled={!name.trim()} busy={busyAs} onPantry={() => void save('pantry')} onList={() => void save('list')} />
          <p className="small" style={{ margin: 0 }}>{addButtonsNote(SECTION_PLACE[section], categories.find((c) => c.id === categoryId)?.name)}</p>
        </>
      )}
    </Sheet>
  );
}

/**
 * 0.9.6: the shop to ask for a follow-up search (the same product at your other shops, other sizes, "instead of"
 * suggestions, recommendations). Never Costco: it is only ever asked when the person presses Search, one request.
 */
function followAdapter(chain: string) {
  // 0.9.8: Costco too: each of these is something the person did on the screen.
  return adapterFor(chain as StoreChain);
}

function storePreview(sp: StoreProduct): PreviewProduct {
  return {
    chain: sp.chain,
    name: sp.name,
    brand: sp.brand,
    size: sp.size,
    imageUrl: sp.imageUrl,
    storeProductId: sp.storeProductId,
    barcode: sp.barcode,
    price: sp.price,
    wasPrice: sp.wasPrice,
    isSpecial: sp.isSpecial,
    memberOnly: sp.memberOnly,
    promo: sp.promo,
    unitText: unitTextOf(sp) || undefined,
    // 0.10.7: no stock in search results: it's only checked when asked, on the shopping list.
    inStock: undefined,
  };
}

/** "Aldi, Woolworths (2), Coles": each shop once, with how many are ticked there when it's more than one. */
export function tickedShops(picks: StoreProduct[]): string {
  const counts = new Map<StoreChain, number>();
  for (const p of picks) counts.set(p.chain as StoreChain, (counts.get(p.chain as StoreChain) ?? 0) + 1);
  return [...counts].map(([c, n]) => (n > 1 ? `${chainName(c)} (${n})` : chainName(c))).join(', ');
}

/**
 * 0.9.11: the end of "Pick my coconut cream", on the phone (shop search and Add by hand): the same
 * three buttons as any add, and the "next time" tick (ticked to start with).
 */
export function PickButtons({
  forLine,
  section,
  saving,
  busy,
  blocked,
  onSave,
}: {
  forLine: ForLine;
  section: Section;
  saving: boolean;
  /** 0.10.7: which button is saving (only that one shows it). */
  busy?: Target;
  /** Nothing to add yet. */
  blocked?: boolean;
  onSave: (t: 'both' | 'list' | 'pantry') => void;
}) {
  const busyAs = busy ?? (saving ? 'both' : undefined);
  // 0.10.2: from the line's "Add to pantry": one button, the item made and the line kept as it.
  if (forLine.toPantry)
    return (
      <>
        <AlwaysTick forLine={forLine} />
        <AddBtn target="both" busy={busyAs} blocked={blocked} className="btn primary" onClick={() => onSave('both')}>
          <Icon name={section} size={18} /> Add to {SECTION_NAMES[section].toLowerCase()}
        </AddBtn>
        <p className="small" style={{ margin: 0 }}>{toPantryNote(SECTION_PLACE[section])}</p>
      </>
    );
  return (
    <>
      <AlwaysTick forLine={forLine} />
      <AddBtn target="both" busy={busyAs} blocked={blocked} className="btn primary" onClick={() => onSave('both')}>
        <Icon name="cart" size={18} /> Add to both
      </AddBtn>
      <AddPair section={section} disabled={blocked} busy={busyAs} onPantry={() => onSave('pantry')} onList={() => onSave('list')} />
      <p className="small" style={{ margin: 0 }}>{pickButtonsNote(SECTION_PLACE[section])}</p>
    </>
  );
}

