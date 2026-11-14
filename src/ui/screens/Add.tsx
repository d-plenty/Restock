import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
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
  surePick,
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
import { BlockedError, isNative, NativeOnlyError, promoLabel } from '../../stores/http';
import { CostcoLines } from '../CostcoLines';
import { COSTCO_LIST_NOTE } from '../../lib/costcoLocal';
import { isBlockedError, offerUnblock, recordHealth } from '../../lib/health';
import { UnblockButton } from '../Unblock';
import { isExactBarcode, rankAll, score, tokens, type RankQuery } from '../../stores/rank';
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
  pharmacy: 'Search Health',
  baby: 'Search Baby',
  pets: 'Search Pets',
  ...slots('Search products'),
};
/** Small buttons and links still get a 44 px target. */
const TAP: CSSProperties = { minHeight: 44 };
import { ChainDot, ChainName, Hold, Icon, useBackHandler, LoadingBar, MemberTag, MoreInfo, ProductPreview, Sheet, Thumb, TopBar, type PreviewProduct, SearchField } from '../components';
import { useNav } from '../nav';
import { OtherSizesCard } from '../OtherSizes';
import { keyOf, sheetOpenAfter, tickMessage, togglePick } from './addPicks';
import { addItemForLineUndoable, addItemFromPicks, pickedWords, saveStoreProducts } from './addSave';
import { AlertPicker } from './Item';
import { AddBtn, AddPair, addButtonsNote, AlwaysTick, pickButtonsNote, toPantryNote } from './addPickWords';

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
const MATCH_LABEL: Record<BestMatch['sure'], string> = {
  barcode: 'SAME BARCODE',
  same: 'SAME PRODUCT AND SIZE',
  name: 'NAME AND SIZE MATCH',
  closest: 'CLOSEST MATCH · CHECK IT',
  chosen: 'YOUR PICK',
};

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
    return { group, mains, latest };
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
  const [showing, setShowing] = useState<Partial<Record<Chain, number>>>({});
  const [sortBy, setSortBy] = useState<Partial<Record<Chain, SortKey>>>({});
  const [picks, setPicks] = useState<Map<string, StoreProduct>>(new Map());
  // From the shopping list, keep the name you typed there ("Nescafe").
  // 0.10.2: a line's "Add to pantry" keeps the line's name ("Eggs").
  const [name, setName] = useState(forLine?.toPantry ? forLine.entry.text : forList && query ? query : '');
  const [categoryId, setCategoryId] = useState('');
  const [alertLevel, setAlertLevel] = useState<AlertLevel>('good');
  const [allowBulk, setAllowBulk] = useState(false);
  const [allowMulti, setAllowMulti] = useState(true);
  const [alertPct, setAlertPct] = useState<number>(30);
  const [manual, setManual] = useState(false);
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
  useLeaveGuard(() => picks.size > 0 && !doneAdding.current && !forLine, 'adding something: you’ve ticked products but not added them');
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
  const [following, setFollowing] = useState<Chain[]>([]);
  const [similar, setSimilar] = useState<Partial<Record<Chain, StoreProduct[]>>>({});
  const followFor = useRef<string | undefined>(undefined);
  // After you tick your first product from a typed search (0.7.6): the other shops searched again
  // for it, with the same product or the ones most like it (kind, size, price) picked out for you.
  const [recAnchor, setRecAnchor] = useState<StoreProduct>();
  const [recs, setRecs] = useState<Partial<Record<Chain, { same?: StoreProduct; like: StoreProduct[] }>>>({});
  const [recBusy, setRecBusy] = useState<Chain[]>([]);
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
      const items = [...exact, ...found.filter((p) => !seen.has(keyOf(p)))];
      const scored = scoreAll(rq, items);
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
  const search = async (q: string, rq: RankQuery, sec: Section = section, _pressed = false) => {
    const s = settings ?? (await getSettings());
    const text = q.trim();
    if (!text) return;
    setRankQ(rq);
    setLastText(text);
    // A new scan is a new product: ticks left from an earlier search would block "ticked for you".
    if (rq.barcode && !attachGroup) setPicks(new Map());
    setShowing({});
    setSureKey(undefined);
    sureFor.current = undefined;
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
    const found = bestMatches(rankQ, byChain);
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
    const first = [...found.values()][0].sp;
    if (!name && !attachTo) {
      const sc = scanned as (BarcodeInfo & { kindOnly?: boolean }) | undefined;
      if (!(forList && query))
        setName(sc?.name && !weakName(sc) && !sc.kindOnly ? genericName(sc.name, sc.brand) : genericName(first.name, first.brand));
    }
    void followUp(first, new Set(found.keys()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [results, searched, rankQ, auto]);

  // A typed search specific enough to be sure of ("western star butter 500g"): once every shop
  // has answered, tick it and look for the same at your other shops (0.8.5).
  const [sureKey, setSureKey] = useState<string>();
  const sureFor = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (rankQ.barcode || attachTo || !searched.length || picks.size || recFor.current) return;
    if (sureFor.current === rankQ.text) return;
    const answers = searched.map((c) => results[c]);
    if (answers.some((r) => !r || r.status === 'loading')) return;
    sureFor.current = rankQ.text;
    const byChain = Object.fromEntries(searched.map((c) => [c, results[c]?.status === 'ok' ? (results[c] as { scored?: Scored[] }).scored : []]));
    const sp = surePick(rankQ, byChain);
    if (!sp) return;
    setSureKey(keyOf(sp));
    toggle(sp);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [results, searched, rankQ]);

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
    // A name that's only the brand ("Earth Choice") waits for the product you tick to name it.
    if (info.name && !attachGroup && !weakName(info)) setName(genericName(info.name, info.brand));
    await search(q, { text: displayName(info), brand: info.brand, size: info.size, barcode: code }, section, pressed);
  };

  useEffect(() => {
    // 0.10.7: with words too (a name shared back from Google Lens), those words are the search.
    if (barcode && !query) void handleBarcode(barcode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [barcode]);

  // Coming from an item's "Find at another store": search straight away.
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
      return { ...r, [chain]: { ...ok, status: 'ok', items: [...have, ...items.filter((p) => !seen.has(keyOf(p)))] } };
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
      const fresh = rankAll(rankQ, found.filter((p) => !seen.has(keyOf(p))));
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
    m.set(c.sp.chain, { sp: c.sp, sure: 'chosen' });
    for (const p of c.at) if (!m.has(p.chain)) m.set(p.chain, { sp: p, sure: 'same' });
    setAuto(m);
    setCandidates(undefined);
    setSuggest([]);
    setPicks(new Map([...m.values()].map((x) => [keyOf(x.sp), x.sp])));
    if (!name && !attachTo) setName(genericName(c.sp.name, c.sp.brand));
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
            same ? 2 : 3,
          );
          setRecs((m) => ({ ...m, [chain]: { same, like } }));
        } finally {
          if (recFor.current === tag) setRecBusy((b) => b.filter((c) => c !== chain));
        }
      }),
    );
  };

  // 0.9.1: "Other sizes of this": other packs and sizes of the first thing you ticked or, on an
  // item's "Add another pick", of its usual pick. Found in what the shops sent back, plus one more
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

  const toggle = (sp: StoreProduct) => {
    setPicks((prev) => {
      const next = togglePick(prev, sp);
      if (next.has(keyOf(sp)) && !name && !attachTo)
        setName(scanned?.name && !weakName(scanned) ? genericName(scanned.name, scanned.brand) : genericName(sp.name, sp.brand));
      return next;
    });
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
  const preTick = forLine?.preTick;
  const preShop = preTick ? results[preTick.chain] : undefined;
  useEffect(() => {
    if (!preTick?.storeProductId || preTicked.current || preShop?.status !== 'ok') return;
    preTicked.current = true;
    const sp = preShop.items.find((p) => String(p.storeProductId) === String(preTick.storeProductId));
    if (sp && !picks.has(keyOf(sp))) toggle(sp);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preShop]);

  /** Save each picked store product (or reuse it if it's already tracked) with today's price. */
  const barcodeFor = (sp: StoreProduct) => sp.barcode ?? (isExactBarcode(rankQ, sp) || as === 'main' ? rankQ.barcode : undefined);
  const saveProducts = (): Promise<string[]> => saveStoreProducts(picks.values(), barcodeFor);

  const cheapestPick = () => [...picks.values()].filter((p) => p.price !== undefined).sort((a, b) => a.price! - b.price!)[0];
  const cheapestChain = (): Chain | undefined => cheapestPick()?.chain ?? [...picks.values()][0]?.chain;

  const saveAttach = async () => {
    if (!attachGroup || !picks.size) return;
    setSaving(true);
    try {
      // 0.9.5 (undo): the whole attach is one Undo.
      await act(as === 'alt' ? `Added to Would also take for ${attachGroup.name}` : `Added to My picks for ${attachGroup.name}`, async () => {
      const ids = await saveProducts();
      const all = new Set([attachGroup.usualProductId, ...attachGroup.sameProductIds, ...attachGroup.altProductIds]);
      if (as === 'alt') {
        const fresh = ids.filter((id) => !all.has(id));
        await updateGroup(attachGroup.id, { altProductIds: [...attachGroup.altProductIds, ...fresh] });
      } else {
        // One you'd also take, ticked as a pick, moves to My picks (0.8.9).
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
    setSaving(true);
    setBusyAs(target);
    try {
      const first = [...picks.values()][0];
      const itemName = name.trim() || genericName(first.name, first.brand);
      const item = { name: itemName, section, categoryId, alertLevel, alertPct, allowBulk, allowMulti };
      if (forLine && target !== 'list') {
        // From the Pick sheet: the new item, and the list line becomes it ("both"), or comes off the
        // list ("pantry", 0.9.11). 0.9.5 (final review): with an Undo, as every other add.
        const off = target === 'pantry';
        const { group, linked } = await addItemForLineUndoable(
          forLine.entry,
          picks.values(),
          item,
          forLine.always,
          (r) => pickedWords(r.group.name, { made: true, linked: r.linked, always: forLine.always, word: forLine.word, place: SECTION_PLACE[section], off }),
          barcodeFor,
          off ? 'pantry' : 'both',
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
      if (target !== 'list') groupId = (await addItemFromPicks(picks.values(), item, barcodeFor)).id;
      if (target !== 'pantry') {
        const one = groupId || costcoLine ? undefined : cheapestPick();
        await addListEntry({
          id: uid(),
          text: itemName,
          groupId,
          chain: groupId || costcoLine ? undefined : cheapestChain(),
          price: one?.price,
          categoryId: categoryId || undefined,
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
      if (overlay) nav.pop();
      if (groupId) nav.push({ name: 'item', groupId });
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
    setName('');
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
  const title = attachGroup
    ? as === 'alt'
      ? onlyChain
        ? `Find one at ${chainName(onlyChain)}`
        : 'Would also take'
      : another
        ? 'Add another pick'
        : onlyChain
          ? `Find it at ${chainName(onlyChain)}`
          : 'Find at another shop'
    : forList
      ? 'Pick the one you buy'
      : 'Add an item';
  const hint = attachGroup
    ? as === 'alt'
      ? `Tick products you'd happily buy instead of ${attachGroup.name}. They'll show up when they're on special and cheaper than yours.`
      : another
        ? `Tick another product you buy as ${attachGroup.name}, at any shop. It's kept alongside the ones you have, and Restock shows whichever is cheapest.`
        : `Tick ${attachGroup.name} at each shop that sells it. Restock then shows you whichever shop is cheapest.`
    : forLine
      ? `Tick what you'd buy as "${forLine.word}" at each shop, then tap the bar at the bottom to add it to your pantry.`
      : forList
        ? 'Tick the ones you’d buy, at any shop. The cheapest of them goes on your Shopping list for this trip only. Then tap the bar at the bottom.'
        : 'Tick what you buy at each shop (it can be a different product at each one), so Restock can tell you where it’s cheapest. Then tap the bar at the bottom to add it. You can add ones you’d also take later, from the item’s page.';

  // A ticked product that's already a pantry item: from the Pick sheet, the line can just be that item.
  const trackedPick = forLine ? [...picks.keys()].map((k) => pantry?.get(k)).find((g): g is Group => !!g) : undefined;
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
        ? 'Would also take'
        : `Add to ${attachGroup.name}`
      : forList
        ? 'Add to your shopping list'
        : 'Add what you ticked';

  // "Picked for you at your other shops", in the sheet the bar opens (0.9.5: not on the page).
  const recShown = !!recAnchor && picks.has(keyOf(recAnchor));
  const pickedChains = new Set([...picks.values()].map((p) => p.chain));
  const recShops = recShown
    ? (searched.filter((c) => c !== recAnchor!.chain && !pickedChains.has(c) && (recs[c as Chain]?.same || recs[c as Chain]?.like.length)) as Chain[])
    : [];
  const picksForYou = recShown && recAnchor && (
    // Not a card in a card: in the sheet the rows need all the width they can get (largest text).
    <div role="group" aria-label="Picked for you at your other shops" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div className="eyebrow green">Picked for you at your other shops</div>
      <span className="small">
        Like the {recAnchor.name} you ticked at {chainName(recAnchor.chain)} ({money(recAnchor.price)}). Tick the ones you want here, or close this
        and tick your own in each shop's results.
      </span>
      {recBusy.length > 0 && (
        <span className="small" role="status">
          Searching {recBusy.map((c) => chainName(c)).join(' and ')} for it…
          <LoadingBar seconds={15} />
        </span>
      )}
      {searched
        .filter((c) => c !== recAnchor.chain && recs[c as Chain])
        .map((c) => {
          const r = recs[c as Chain]!;
          const rows = [...(r.same ? [r.same] : []), ...r.like];
          return (
            <div key={c} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span className="small" style={{ fontWeight: 700, display: 'flex', alignItems: 'center', gap: 6 }}>
                <ChainDot chain={c} />{' '}
                {r.same
                  ? `Same product at ${chainName(c)}`
                  : rows.length
                    ? `Most like it at ${chainName(c)}`
                    : `Nothing like it at ${chainName(c)}`}
              </span>
              {rows.length > 0 && (
                <div className="card flush" style={{ boxShadow: 'none' }}>
                  {rows.map((sp) => (
                    <label key={keyOf(sp)} className={`row${picks.has(keyOf(sp)) ? ' selected' : ''}`}>
                      <input
                        type="checkbox"
                        checked={picks.has(keyOf(sp))}
                        onChange={() => toggle(sp)}
                        aria-label={`Tick ${sp.name} at ${chainName(sp.chain)}`}
                      />
                      <MoreInfo src={sp.imageUrl ?? photoFor(sp)} name={sp.name} onOpen={() => setPreview(sp)} />
                      <span className="grow" style={{ minWidth: 0 }}>
                        <span className="title" style={{ fontSize: 15 }}>
                          {sp.name}
                        </span>
                        {sp.size && !nameHasSize(sp.name, sp.size) && <span className="small">{tidySize(sp.size, sp.name)}</span>}
                        {unitTextOf(sp) && <span className="small">{unitTextOf(sp)}</span>}
                        {sp === r.same && (
                          <span className="tag great" style={{ whiteSpace: 'normal' }}>
                            Same product
                          </span>
                        )}
                      </span>
                      <span className="num" style={{ fontWeight: 700, flex: 'none' }}>
                        {money(sp.price)}
                      </span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          );
        })}
    </div>
  );

  // 0.10.8: how many of Add's small ways in show (one on its own is a plain button, not a lone tile)
  const toolCount = [!attachTo, !scanned, !attachTo && !overlay && !!settings?.receipts.enabled].filter(Boolean).length;
  return (
    // Inside the Pick sheet the sheet scrolls, so the bar at the bottom stays in view there too.
    <div className="screen" style={forLine ? { padding: 0, overflow: 'visible', flex: 'none' } : undefined}>
      {forLine ? null : overlay ? <TopBar title={title} /> : <h1>{title}</h1>}
      {/* Read out when something's ticked or unticked (the bar at the bottom shows it). */}
      <div className="sr-only" role="status" aria-live="polite">
        {said}
      </div>
      {!forLine && !attachGroup && !onlyChain && sectionsOn.length > 1 && (
        <div className="seg" role="tablist" aria-label="Which shops to search">
          {sectionsOn.map((sec) => (
            <button key={sec} role="tab" aria-selected={sec === section} className={sec === section ? 'on' : ''} onClick={() => switchSection(sec)}>
              <Icon name={sec} size={17} /> {SECTION_NAMES[sec]}
            </button>
          ))}
        </div>
      )}

      {/* 0.10.8: one tidy block: Scan a barcode, then the other ways in as equal tiles (Scan several,
          Photo, Receipt), and the scanned barcodes still to match as one line. */}
      {!forLine && (
        <div className="add-ways">
          <button className="btn primary block" onClick={doScan}>
            <Icon name="scan" /> Scan a barcode
          </button>
          {toolCount > 0 && (
            <div className={`add-tools${toolCount === 1 ? ' one' : ''}`}>
              {!attachTo && (
                <button
                  className="add-tool"
                  onClick={() => nav.push({ name: 'scanned', section, start: true })}
                  aria-label="Scan several things in a row"
                >
                  <Icon name="scan" size={22} />
                  <span>Scan several</span>
                </button>
              )}
              {!scanned && (
                <button className="add-tool" onClick={() => setPhotoFind(true)} aria-label="Find it from a photo of the pack">
                  <Icon name="camera" size={22} />
                  <span>{toolCount === 1 ? 'Find it from a photo' : 'Photo'}</span>
                </button>
              )}
              {!attachTo && !overlay && settings?.receipts.enabled && (
                <button className="add-tool" onClick={() => nav.push({ name: 'receipt' })} aria-label="Add a receipt">
                  <Icon name="receipt" size={22} />
                  <span>Receipt</span>
                </button>
              )}
            </div>
          )}
          {!attachTo && scansLeft > 0 && (
            <button className="card add-scans" onClick={() => nav.push({ name: 'scanned', section })}>
              <Icon name="scan" size={18} />
              <span className="grow">{scansLeft === 1 ? '1 scanned barcode to match' : `${scansLeft} scanned barcodes to match`}</span>
              <Icon name="chevron" size={16} />
            </button>
          )}
        </div>
      )}
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

      <form
        onSubmit={(e) => {
          e.preventDefault();
          setScanned(undefined);
          setKnown(undefined);
          const t = term.trim();
          const code = productCode(t);
          // The Search press: the only search that asks Costco too (0.9.6, review L1).
          if (code) void handleBarcode(code, false, true);
          else runText(t, true);
        }}
        style={{ display: 'flex', gap: 8 }}
      >
        <SearchField placeholder={SEARCH_PLACEHOLDER[section]} aria-label={`Search ${SECTION_SHOPS[section]}`} enterKeyHint="search" value={term} onValue={setTerm} />
        <button className="btn" type="submit" aria-label="Search" style={{ width: 52, minWidth: 52, flexShrink: 0, padding: 0 }}>
          <Icon name="search" />
        </button>
      </form>

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
            if (!attachGroup) setName(genericName(t));
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
              if (!attachGroup) setName(genericName(n));
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
                    if (!attachGroup) setName(q);
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

      {auto && auto.size > 0 && (
        <div className="card best-match">
          <div className="eyebrow green">
            {[...auto.values()].some((m) => m.sure === 'chosen') ? 'Your pick · ticked at each shop' : 'Best match · ticked for you'}
          </div>
          <strong>Found at {[...auto.keys()].map((c) => chainName(c)).join(auto.size === 2 ? ' and ' : ', ')}</strong>
          {[...auto.values()].some((m) => m.sure === 'closest') && (
            <span className="small">
              "Closest match" means the name and brand fit best but the size couldn't be checked. Have a look before adding.
            </span>
          )}
          <div className="card flush" style={{ boxShadow: 'none' }}>
            {[...auto.values()].map(({ sp, sure }) => (
              <label key={keyOf(sp)} className={`row${picks.has(keyOf(sp)) ? ' selected' : ''}`}>
                <input
                  type="checkbox"
                  checked={picks.has(keyOf(sp))}
                  onChange={() => toggle(sp)}
                  aria-label={`Tick ${sp.name} at ${chainName(sp.chain)}`}
                />
                <MoreInfo src={sp.imageUrl ?? photoFor(sp)} name={sp.name} onOpen={() => setPreview(sp)} />
                <span className="grow">
                  <span className="small" style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 700 }}>
                    <ChainDot chain={sp.chain} /> {chainName(sp.chain)}
                  </span>
                  <span className="title" style={{ fontSize: 15 }}>
                    {sp.name}
                  </span>
                  {sp.size && !nameHasSize(sp.name, sp.size) && <span className="small">{tidySize(sp.size, sp.name)}</span>}
                  <span className="tags">
                    <span className={`tag ${sure === 'closest' ? 'wait' : sure === 'name' ? 'normal' : 'good'}`}>{MATCH_LABEL[sure]}</span>
                    {sp.isSpecial && <span className="tag wait">SPECIAL</span>}
                  </span>
                </span>
                <span className="num" style={{ fontWeight: 700 }}>
                  {money(sp.price)}
                </span>
              </label>
            ))}
          </div>
          {following.length > 0 && (
            <span className="small" role="status">
              Looking for it at {following.map((c) => chainName(c)).join(' and ')} by what it is, as shops name things differently…
              <LoadingBar seconds={8} />
            </span>
          )}
          {searched.filter((c) => !auto.has(c) && !following.includes(c)).length > 0 && (
            <span className="small">
              Not found at{' '}
              {searched
                .filter((c) => !auto.has(c) && !following.includes(c))
                .map((c) => chainName(c))
                .join(' or ')}
              . If it's there, tick it in that shop's list below.
            </span>
          )}
          {searched
            .filter((c) => !auto.has(c) && similar[c]?.length)
            .map((c) => (
              <div key={c} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <span className="small" style={{ fontWeight: 700, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <ChainDot chain={c} /> Similar at {chainName(c)}: tick it if it's the same
                </span>
                <div className="card flush" style={{ boxShadow: 'none' }}>
                  {similar[c]!.map((sp) => (
                    <label key={keyOf(sp)} className={`row${picks.has(keyOf(sp)) ? ' selected' : ''}`}>
                      <input
                        type="checkbox"
                        checked={picks.has(keyOf(sp))}
                        onChange={() => toggle(sp)}
                        aria-label={`Tick ${sp.name} at ${chainName(sp.chain)}`}
                      />
                      <MoreInfo src={sp.imageUrl ?? photoFor(sp)} name={sp.name} onOpen={() => setPreview(sp)} />
                      <span className="grow">
                        <span className="title" style={{ fontSize: 15 }}>
                          {sp.name}
                        </span>
                        {sp.size && !nameHasSize(sp.name, sp.size) && <span className="small">{tidySize(sp.size, sp.name)}</span>}
                        {unitTextOf(sp) && <span className="small">{unitTextOf(sp)}</span>}
                      </span>
                      <span className="num" style={{ fontWeight: 700 }}>
                        {money(sp.price)}
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            ))}
          <span className="small">Not the right one? Untick it, and tick the right product in the shop's list below.</span>
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
            Tap the one you've got and it's ticked at every shop that sells it. Restock remembers this barcode for next time.
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
              </div>
            ))}
          </div>
          <span className="small">Not there? Look through each shop's list below, or type what's on the pack.</span>
        </div>
      )}
      {auto && auto.size === 0 && rankQ.barcode && !candidates?.length && (
        <div className="banner grey" style={{ fontSize: 13 }}>
          Restock couldn't be sure which product this is at your shops, so nothing's ticked yet. Tick it at one shop and Restock ticks the same
          product at the others.
        </div>
      )}

      {sizesFor && anyResults && (
        <OtherSizesCard
          anchor={sizesFor}
          pool={sizesPool}
          skip={sizesSkip}
          picks={picks}
          onToggle={toggle}
          onPreview={setPreview}
          photoFor={photoFor}
          containersOn={!!settings?.otherContainerSizes}
          onContainers={(on) => void updateSettings({ otherContainerSizes: on })}
          searching={sizesBusy === sizesKey}
        />
      )}

      {anyResults && (
        <div className="chips" role="group" aria-label="Filter results">
          <button className="chip" aria-pressed={specialsOnly} onClick={() => setSpecialsOnly((v) => !v)}>
            On special only
          </button>
        </div>
      )}

      {anyResults && (
        <p className="small">
          {hint} Not sure it's the right one? Tap the photo (or press and hold the product) for a bigger look, ingredients and nutrition.
        </p>
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
          .filter((c) => results[c])
          .map((chain) => {
            const alt = instead[chain];
            const useAlt = !!alt && !original[chain];
            const first = results[chain]!;
            const firstCount = first.status === 'ok' ? first.items.length : 0;
            const r: ChainResult = useAlt ? { status: 'ok', items: alt.items, top: alt.top } : first;
            if (r.status === 'error' && !isNative()) return null;
            const limit = showing[chain] ?? FIRST_PAGE;
            const pool = r.status === 'ok' ? r.items.filter((sp) => !specialsOnly || sp.isSpecial) : [];
            const by = sortBy[chain] ?? 'relevant';
            const ordered = sorted(pool, by);
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
                {list.length > 0 && (
                  <div className="card flush">
                    {list.map((sp) => {
                      const k = keyOf(sp);
                      const picked = picks.has(k);
                      const tracked = pantry?.get(k);
                      const unitText = unitTextOf(sp);
                      return (
                        <Hold key={k} onLong={() => setPreview(sp)}>
                          <label className={`row${picked ? ' selected' : ''}`}>
                            <input
                              type="checkbox"
                              checked={picked}
                              onChange={() => toggle(sp)}
                              aria-label={`Tick ${sp.name} at ${chainName(sp.chain)}, ${money(sp.price)}`}
                            />
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
                              <Thumb src={sp.imageUrl ?? photoFor(sp)} />
                              <span className="info-dot" aria-hidden>
                                <Icon name="info" size={12} />
                              </span>
                            </button>
                            <span className="grow">
                              <span className="title" style={{ fontSize: 15 }}>
                                {sp.name}
                              </span>
                              {sp.size && !nameHasSize(sp.name, sp.size) && <span className="small">{tidySize(sp.size, sp.name)}</span>}
                              <span className="tags">
                                {isExactBarcode(rankQ, sp) && <span className="tag good">EXACT MATCH</span>}
                                {!isExactBarcode(rankQ, sp) && k === sureKey && <span className="tag good">BEST MATCH · TICKED FOR YOU</span>}
                                {!isExactBarcode(rankQ, sp) && k !== sureKey && !rankQ.barcode && top.has(k) && (
                                  <span className="tag good">RECOMMENDED</span>
                                )}
                                {tracked && <span className="tag normal">IN YOUR PANTRY</span>}
                                {sp.isSpecial && !sp.memberOnly && (
                                  <span className="tag wait">
                                    {sp.wasPrice ? `SPECIAL · SAVE ${money(sp.wasPrice - (sp.price ?? sp.wasPrice))}` : 'SPECIAL'}
                                  </span>
                                )}
                                {sp.isSpecial && sp.chain !== 'costco' && promoLabel(sp.promo) && <span className="tag normal">{promoLabel(sp.promo)}</span>}
                                {sp.memberOnly && sp.chain !== 'costco' && <MemberTag chain={sp.chain} />}
                              </span>
                              <CostcoLines sp={sp} />
                            </span>
                            <span style={{ textAlign: 'right' }}>
                              <span className="num" style={{ fontWeight: 600, display: 'block' }}>
                                {money(sp.price)}
                              </span>
                              {unitText && (
                                <span className="small num" style={{ display: 'block', fontWeight: 600, color: 'var(--ink-2)' }}>
                                  {unitText}
                                </span>
                              )}
                              {sp.isSpecial && (
                                <span className="small" style={{ display: 'block' }}>
                                  {sp.wasPrice ? (
                                    <>
                                      was{' '}
                                      <span className="num" style={{ textDecoration: 'line-through' }}>
                                        {money(sp.wasPrice)}
                                      </span>
                                    </>
                                  ) : (
                                    'special price'
                                  )}
                                </span>
                              )}
                            </span>
                          </label>
                        </Hold>
                      );
                    })}
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
              <Icon name="check" size={16} /> Tick {suggest.length === 1 ? 'it' : 'them'} too
            </button>
            <button className="btn small" style={TAP} onClick={() => setSuggest([])}>
              No thanks
            </button>
          </div>
        </div>
      )}

      <button className="btn add" onClick={() => setManual(true)}>
        Can't find it? Add it by hand
      </button>

      {picks.size > 0 && (
        // The bar: what's ticked and where. Tap it (or its green arrow) to name it and add it.
        <button
          className="card add-mini"
          onClick={() => setPanelOpen((open) => sheetOpenAfter(open, { kind: 'arrow', size: picks.size }))}
          aria-haspopup="dialog"
          aria-expanded={panelOpen}
          aria-label={`${picks.size} ticked at ${tickedShops([...picks.values()])}. Tap to add.`}
        >
          <span className="grow add-mini-text">
            <span className="title" style={{ fontSize: 15 }}>
              {picks.size} ticked · tap to add
            </span>
            <span className="small clip">{tickedShops([...picks.values()])}</span>
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
        <Sheet title={sheetTitle} onClose={() => setPanelOpen((open) => sheetOpenAfter(open, { kind: 'close' }))}>
          {/* Its own scrolling list, so 15 ticked cans never push the buttons away. */}
          <div className="small picked-list" style={{ minWidth: 0 }} aria-label="Ticked" role="list">
            {[...picks.values()].map((p) => (
              <div key={keyOf(p)} className="picked-line" role="listitem">
                <ChainDot chain={p.chain} />
                <span className="clip grow">{p.name}</span>
                <span className="num picked-price">{money(p.price)}</span>
              </div>
            ))}
          </div>
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
              <label className="field">
                <span>Name in your pantry</span>
                <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Chopsticks" />
              </label>
              {picksForYou}
              <details className="explain">
                <summary>
                  <Icon name="bell" size={18} />
                  <span>Category and alerts</span>
                </summary>
                <div className="explain-body">
                  <select className="input" value={categoryId} onChange={(e) => setCategoryId(e.target.value)} aria-label="Category">
                    <option value="">No category</option>
                    {categories?.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                  <AlertPicker level={alertLevel} pct={alertPct} onChange={(l, p) => (setAlertLevel(l), setAlertPct(p))} />
                </div>
              </details>
              <PickButtons forLine={forLine} section={section} saving={saving} busy={busyAs} onSave={(t) => void save(t)} />
            </>
          ) : (
            forList && !attachGroup ? (
              <>
                <label className="field">
                  <span>Name on your Shopping list</span>
                  <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Coffee" />
                </label>
                {picksForYou}
                <AddBtn target="list" busy={busyAs} className="btn primary" onClick={() => void save('list')}>
                  <Icon name="cart" size={18} /> Add to list
                </AddBtn>
                <p className="small" style={{ margin: 0 }}>
                  Just for this trip, at the cheapest of what you ticked. It doesn't go in your pantry, and Restock won't keep watching its price.
                </p>
                {isLocalOnlyShop(cheapestChain()) && (
                  <p className="small" style={{ margin: 0 }}>
                    {COSTCO_LIST_NOTE}
                  </p>
                )}
              </>
            ) : attachGroup ? (
              <AddBtn target="pantry" busy={saving ? 'pantry' : undefined} className="btn primary" onClick={() => void saveAttach()}>
                {as === 'alt' ? 'Add to Would also take' : `Add to ${attachGroup.name}`}
              </AddBtn>
            ) : (
              <>
                <label className="field">
                  <span>Name in {SECTION_PLACE[section]} and Shopping list</span>
                  <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Honey" />
                </label>
                {picksForYou}
                <details className="explain">
                  <summary>
                    <Icon name="bell" size={18} />
                    <span>Category and alerts</span>
                  </summary>
                  <div className="explain-body">
                    <select className="input" value={categoryId} onChange={(e) => setCategoryId(e.target.value)} aria-label="Category">
                      <option value="">No category</option>
                      {categories?.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                    <AlertPicker level={alertLevel} pct={alertPct} onChange={(l, p) => (setAlertLevel(l), setAlertPct(p))} />
                  </div>
                </details>
                <label className="check" style={{ padding: '4px 2px' }}>
                  <input type="checkbox" className="switch" checked={allowBulk} onChange={(e) => setAllowBulk(e.target.checked)} />
                  <span style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
                    <span className="title" style={{ fontSize: 15 }}>
                      Swap for bulk packs to save money
                    </span>
                    <span className="small">
                      Let Restock suggest a bigger pack you'd also take (like a 6-pack instead of one) as a swap when it's cheaper per 100 g. Leave it
                      off if you only ever want this size.
                    </span>
                  </span>
                </label>
                <label className="check" style={{ padding: '4px 2px' }}>
                  <input type="checkbox" className="switch" checked={allowMulti} onChange={(e) => setAllowMulti(e.target.checked)} />
                  <span style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
                    <span className="title" style={{ fontSize: 15 }}>
                      Multi-buy to save money
                    </span>
                    <span className="small">
                      Count deals like "2 for $12" when they're cheaper each. Leave it off if you only buy one at a time: then a multi-buy isn't treated
                      as a sale, and you see the price for one.
                    </span>
                  </span>
                </label>
                {/* 0.9.12: one layout everywhere: Add to both first, then list or pantry on their own. */}
                {tabHidden ? (
                  <div className="two">
                    <AddBtn target="list" busy={busyAs} className="btn primary" onClick={() => void save('list')}>
                      <Icon name="cart" size={18} /> Add to list
                    </AddBtn>
                    <AddBtn target="both" busy={busyAs} className="btn" onClick={() => void save('both')}>
                      <Icon name={section} size={18} /> Add to both
                    </AddBtn>
                  </div>
                ) : (
                  <>
                    <AddBtn target="both" busy={busyAs} className="btn primary" onClick={() => void save('both')}>
                      <Icon name="cart" size={18} /> Add to both
                    </AddBtn>
                    <AddPair section={section} busy={busyAs} onPantry={() => void save('pantry')} onList={() => void save('list')} />
                  </>
                )}
                <p className="small" style={{ margin: 0 }}>
                  {tabHidden
                    ? "Add to list puts it on your Shopping list for this trip only, at the price shown. Restock won't keep watching its price."
                    : addButtonsNote(SECTION_PLACE[section])}
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
                className={`btn ${picks.has(keyOf(preview)) ? '' : 'primary'}`}
                onClick={() => {
                  toggle(preview);
                  setPreview(undefined);
                }}
              >
                <Icon name="check" size={18} /> {picks.has(keyOf(preview)) ? 'Untick this one' : 'Tick this one'}
              </button>
            </>
          }
        />
      )}

      {manual && (
        <ManualSheet
          attachTo={attachGroup}
          as={as}
          defaultName={name || (scanned?.name ? genericName(scanned.name, scanned.brand) : term)}
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

  const save = async (target: Target) => {
    if (!name.trim() || savingRef.current) return;
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
          name: n,
          categoryId: categoryId || undefined,
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
    <Sheet title="Add by hand" onClose={onClose}>
      <p className="small">Prices for hand-added products aren't checked automatically. Enter them from the shelf or catalogue as you see them.</p>
      <label className="field">
        <span>Product name</span>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
      </label>
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
          <select className="input" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            <option value="">None</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {forLine ? (
        <>
          <PickButtons forLine={forLine} section={section} saving={saving} busy={busyAs} blocked={!name.trim()} onSave={(t) => void save(t)} />
        </>
      ) : attachTo ? (
        <button className="btn primary" disabled={!name.trim() || saving} onClick={() => save('pantry')}>
          {as === 'alt' ? 'Add to Would also take' : `Add to ${attachTo.name}`}
        </button>
      ) : (
        <>
          {/* 0.9.12: the same layout as the search results and Pick my…. */}
          <AddBtn target="both" busy={busyAs} blocked={!name.trim()} className="btn primary" onClick={() => void save('both')}>
            Add to both
          </AddBtn>
          <AddPair section={section} disabled={!name.trim()} busy={busyAs} onPantry={() => void save('pantry')} onList={() => void save('list')} />
          <p className="small" style={{ margin: 0 }}>{addButtonsNote(SECTION_PLACE[section])}</p>
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

