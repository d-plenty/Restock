import { useEffect, useRef, useState } from 'react';
import { lookupBarcode, productCode, scanBarcode, type BarcodeInfo } from '../../lib/barcode';
import { displayName, identifyBarcode, QUICK_PICKS, searchTermFor, weakName } from '../../lib/lookup';
import { PackReader } from '../PackReader';
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
  findProductByStore,
  getGroup,
  getProducts,
  cachedSettings,
  getSettings,
  groupProductIds,
  nowIso,
  uid,
  updateGroup,
  updateProduct,
} from '../../lib/db';
import { addGroupToList } from '../../lib/listActions';
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
import { recordHealth } from '../../lib/health';
import { isExactBarcode, rankAll, score, tokens, type RankQuery } from '../../stores/rank';
import { chainName, mainProductIds, searchStoreId, stockKnown, type AlertLevel, type Chain, type Group, type Product } from '../../types';
import {
  activeSections,
  enabledIn,
  SECTION_NAMES,
  SECTION_PLACE,
  SECTION_SHOPS,
  searchChainsIn,
  shopDef,
  type Section,
  type StoreChain,
  kindOf as shopKindOf,
} from '../../shops';

const SEARCH_PLACEHOLDER: Record<Section, string> = {
  pantry: 'Or search a product name',
  keg: 'Or search a beer, wine or spirit',
  pharmacy: 'Or search a medicine or product',
};
import {
  ChainDot,
  ChainName,
  Hold,
  Icon,
  LoadingBar,
  MemberTag,
  MoreInfo,
  OpenStoreButton,
  ProductPreview,
  Sheet,
  Thumb,
  TopBar,
  type PreviewProduct,
} from '../components';
import { useNav } from '../nav';
import { AlertPicker } from './Item';

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
  | { status: 'error'; message: string; blocked?: boolean };

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

const keyOf = (sp: StoreProduct) => `${sp.chain}:${sp.storeProductId}`;

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
    return { group, mains };
  }, [attachTo]);
  const attachGroup = attach?.group;
  // Adding to an item: its tab. Otherwise the tab you came from, or the one picked at the top.
  const section: Section = attachGroup?.section ?? pickedSection;
  const categories = allCats?.filter((c) => c.section === section);
  const sectionsOn = settings ? activeSections(settings) : (['pantry'] as Section[]);
  /** This tab is left out of the bottom bar: a one-off buy, so the shopping list comes first. */
  const tabHidden = section !== 'pantry' && !!settings?.hiddenTabs?.includes(section);

  const [term, setTerm] = useState(query ?? '');
  const [rankQ, setRankQ] = useState<RankQuery>({ text: query ?? '' });
  const [scanned, setScanned] = useState<BarcodeInfo>();
  const [lookingUp, setLookingUp] = useState(false);
  const [results, setResults] = useState<Partial<Record<Chain, ChainResult>>>({});
  const [showing, setShowing] = useState<Partial<Record<Chain, number>>>({});
  const [sortBy, setSortBy] = useState<Partial<Record<Chain, SortKey>>>({});
  const [picks, setPicks] = useState<Map<string, StoreProduct>>(new Map());
  // From the shopping list, keep the name you typed there ("Nescafe").
  const [name, setName] = useState(forList && query ? query : '');
  const [categoryId, setCategoryId] = useState('');
  const [alertLevel, setAlertLevel] = useState<AlertLevel>('good');
  const [allowBulk, setAllowBulk] = useState(false);
  const [allowMulti, setAllowMulti] = useState(true);
  const [alertPct, setAlertPct] = useState<number>(30);
  const [manual, setManual] = useState(false);
  const [saving, setSaving] = useState(false);
  const [specialsOnly, setSpecialsOnly] = useState(false);
  const [searchedFor, setSearchedFor] = useState<string>();
  const [known, setKnown] = useState<Group>();
  const [whatIsIt, setWhatIsIt] = useState('');
  const [suggest, setSuggest] = useState<StoreProduct[]>([]);
  const [recent, setRecent] = useState<string[]>(recentSearches);
  const [stocktake, setStocktake] = useState(false);
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
  const recCard = useRef<HTMLDivElement>(null);
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
        [chain]: { status: 'error', message: e instanceof Error ? e.message : String(e), blocked: e instanceof BlockedError },
      }));
    }
  };

  const [lastText, setLastText] = useState('');
  // The add panel pops up for a moment each time something's ticked, then shrinks to a slim bar
  // so the rest of the results can be seen. Touching the panel keeps it open.
  const [panelOpen, setPanelOpen] = useState(false);
  const [panelHeld, setPanelHeld] = useState(false);
  const lastPicks = useRef(0);
  useEffect(() => {
    const grew = picks.size > lastPicks.current;
    lastPicks.current = picks.size;
    if (!picks.size) return setPanelOpen(false);
    if (!grew) return;
    setPanelOpen(true);
    if (panelHeld) return;
    const t = setTimeout(() => setPanelOpen(false), 1100);
    return () => clearTimeout(t);
  }, [picks.size, panelHeld]);
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
  const search = async (q: string, rq: RankQuery, sec: Section = section) => {
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
          const a = adapterFor(chain);
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

  const handleBarcode = async (code: string, force = false) => {
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
    await search(q, { text: displayName(info), brand: info.brand, size: info.size, barcode: code });
  };

  useEffect(() => {
    if (barcode) void handleBarcode(barcode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [barcode]);

  // Coming from an item's "Find at another store": search straight away.
  const ready = !attachTo || attach !== undefined;
  useEffect(() => {
    if (query && ready && settings) void search(query, { text: query });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, ready, !!settings]);

  const runText = (t: string) => {
    if (!t.trim()) return;
    const fixed = normaliseQuery(t);
    setSearchedFor(queryChanged(t) ? fixed : undefined);
    rememberSearch(t);
    setRecent(recentSearches());
    void search(fixed, { text: fixed });
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
    const a = adapterFor(chain);
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
        const a = adapterFor(chain);
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
    setTimeout(() => recCard.current?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 200);
    const typed = lastText.toLowerCase().trim();
    const terms = [...new Set([anchor.brand ? `${anchor.brand} ${kind}` : '', kind].map((t) => t.toLowerCase().trim()))].filter(
      (t) => t && t !== typed,
    );
    await Promise.all(
      todo.map(async (chain) => {
        try {
          const a = adapterFor(chain);
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

  const toggle = (sp: StoreProduct) => {
    setPicks((prev) => {
      const next = new Map(prev);
      const k = keyOf(sp);
      if (next.has(k)) next.delete(k);
      else {
        next.set(k, sp);
        if (!name && !attachTo)
          setName(scanned?.name && !weakName(scanned) ? genericName(scanned.name, scanned.brand) : genericName(sp.name, sp.brand));
      }
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

  /** Save each picked store product (or reuse it if it's already tracked) with today's price. */
  const saveProducts = async (): Promise<string[]> => {
    const ids: string[] = [];
    for (const sp of picks.values()) {
      const existing = await findProductByStore(sp.chain, sp.storeProductId);
      let id = existing?.id;
      if (!id) {
        id = uid();
        const product: Product = {
          id,
          chain: sp.chain,
          name: sp.name,
          brand: sp.brand,
          size: sp.size,
          barcode: sp.barcode ?? (isExactBarcode(rankQ, sp) || as === 'main' ? rankQ.barcode : undefined),
          storeProductId: sp.storeProductId,
          imageUrl: sp.imageUrl,
          inStock: sp.inStock,
          stockAt: sp.inStock === undefined ? undefined : nowIso(),
          createdAt: nowIso(),
        };
        await addProduct(product);
      } else {
        // Always overwrite, so a stale "out of stock" is cleared when the store stops saying so.
        await updateProduct(id, { inStock: sp.inStock, stockAt: sp.inStock === undefined ? undefined : nowIso() });
      }
      if (sp.price !== undefined) {
        await addReading({
          productId: id,
          date: nowIso(),
          price: sp.price,
          wasPrice: sp.wasPrice,
          isSpecial: sp.isSpecial,
          memberOnly: sp.memberOnly,
          promo: sp.promo,
          source: 'auto',
        });
      }
      if (!ids.includes(id)) ids.push(id);
    }
    return ids;
  };

  const cheapestPick = () => [...picks.values()].filter((p) => p.price !== undefined).sort((a, b) => a.price! - b.price!)[0];
  const cheapestChain = (): Chain | undefined => cheapestPick()?.chain ?? [...picks.values()][0]?.chain;

  const saveAttach = async () => {
    if (!attachGroup || !picks.size) return;
    setSaving(true);
    try {
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
      nav.toast(as === 'alt' ? `Added to Would also take for ${attachGroup.name}` : `Added to My picks for ${attachGroup.name}`);
      nav.pop();
    } finally {
      setSaving(false);
    }
  };

  const save = async (target: Target) => {
    if (!picks.size) return;
    setSaving(true);
    try {
      const first = [...picks.values()][0];
      const itemName = name.trim() || genericName(first.name, first.brand);
      let groupId: string | undefined;
      if (target !== 'list') {
        const ids = await saveProducts();
        const group: Group = {
          id: uid(),
          name: itemName,
          categoryId: categoryId || undefined,
          usualProductId: ids[0],
          sameProductIds: ids.slice(1),
          altProductIds: [],
          alertLevel,
          alertPct: alertLevel === 'custom' ? alertPct : undefined,
          allowBulk,
          allowMulti,
          section,
          createdAt: nowIso(),
        };
        await addGroup(group);
        groupId = group.id;
      }
      if (target !== 'pantry') {
        const one = groupId ? undefined : cheapestPick();
        await addListEntry({
          id: uid(),
          text: itemName,
          groupId,
          chain: groupId ? undefined : cheapestChain(),
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
        if (replaceEntry) await deleteListEntries([replaceEntry]);
      }
      nav.toast(
        target === 'list'
          ? `${itemName} added to your shopping list`
          : target === 'both'
            ? `${itemName} added to ${SECTION_PLACE[section]} and shopping list`
            : `${itemName} added to ${SECTION_PLACE[section]}`,
      );
      reset();
      if (overlay) nav.pop();
      if (groupId) nav.push({ name: 'item', groupId });
    } finally {
      setSaving(false);
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
  };

  const anyResults = Object.keys(results).length > 0;
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
          : 'Find at another store'
    : forList
      ? 'Find the cheapest'
      : 'Add an item';
  const hint = attachGroup
    ? as === 'alt'
      ? `Tick products you'd happily buy instead of ${attachGroup.name}. They'll show up when they're on sale and cheaper than yours.`
      : another
        ? `Tick another product you buy as ${attachGroup.name}, at any shop. It's kept alongside the ones you have, and Restock shows whichever is cheapest.`
        : `Tick ${attachGroup.name} at each store that sells it. Restock then shows you whichever store is cheapest.`
    : forList
      ? 'Tick the ones you’d buy, at any shop. The cheapest of them goes on your shopping list for this trip only.'
      : 'Tick what you buy at each store (it can be a different product at each one), so Restock can tell you where it’s cheapest. You can add ones you’d also take later, from the item’s page.';

  return (
    <div className="screen">
      {overlay ? <TopBar title={title} /> : <h1>{title}</h1>}
      {!attachGroup && !onlyChain && sectionsOn.length > 1 && (
        <div className="seg" role="tablist" aria-label="Which shops to search">
          {sectionsOn.map((sec) => (
            <button key={sec} role="tab" aria-selected={sec === section} className={sec === section ? 'on' : ''} onClick={() => switchSection(sec)}>
              <Icon name={sec} size={17} /> {SECTION_NAMES[sec]}
            </button>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8 }}>
        <button className="btn primary" style={{ flex: 1 }} onClick={doScan}>
          <Icon name="scan" /> Scan a barcode
        </button>
        {!attachTo && (
          <button className="btn" onClick={() => setStocktake(true)} aria-label="Scan several things in a row">
            Scan several
          </button>
        )}
      </div>
      {!attachTo && !overlay && settings?.receipts.enabled && (
        <button className="btn ghost small" style={{ alignSelf: 'flex-start' }} onClick={() => nav.push({ name: 'receipt' })}>
          <Icon name="receipt" size={16} /> Add a receipt
        </button>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          setScanned(undefined);
          setKnown(undefined);
          const t = term.trim();
          const code = productCode(t);
          if (code) void handleBarcode(code);
          else runText(t);
        }}
        style={{ display: 'flex', gap: 8 }}
      >
        <input
          className="input"
          type="search"
          placeholder={SEARCH_PLACEHOLDER[section]}
          aria-label={`Search ${SECTION_SHOPS[section]}`}
          value={term}
          onChange={(e) => setTerm(e.target.value)}
        />
        <button className="btn" type="submit" aria-label="Search" style={{ width: 52, padding: 0 }}>
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
            onClick={() => document.querySelector<HTMLInputElement>('.screen input[type="search"], .screen input.input')?.focus()}
          >
            Change it
          </button>
        </p>
      )}

      {known && scanned && (
        <div className="card">
          <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <Thumb src={scanned.imageUrl} icon="scan" />
            <div style={{ flex: 1 }}>
              <div className="eyebrow green">Already tracking this</div>
              <div className="title">{known.name}</div>
            </div>
          </div>
          <div className="two">
            <button
              className="btn primary"
              onClick={async () => {
                const added = await addGroupToList(known);
                nav.toast(added ? `${known.name} added to your shopping list` : `${known.name} is already on your shopping list`);
                reset();
              }}
            >
              <Icon name="cartPlus" size={18} /> Add to list
            </button>
            <button className="btn" onClick={() => nav.push({ name: 'item', groupId: known.id })}>
              Open it
            </button>
          </div>
          <button className="linkish small" style={{ alignSelf: 'flex-start' }} onClick={() => void handleBarcode(scanned.barcode, true)}>
            Search the stores anyway
          </button>
        </div>
      )}

      {scanned && !known && (
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
            void search(fixed, { text: fixed, barcode: scanned.barcode });
          }}
        >
          <div className="title">What is it?</div>
          <p className="small">
            Type what's on the pack, like "Arnott's Tim Tam Original". Restock searches for it and remembers this barcode next time.
          </p>
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
          {settings?.receipts.installed && (
            <PackReader
              onName={(n) => {
                setWhatIsIt(n);
                setTerm(n);
                setSearchedFor(n);
                const fixed = normaliseQuery(n);
                void search(fixed, { text: fixed, barcode: scanned.barcode });
              }}
            />
          )}
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
                <button className="row-main" style={{ color: 'inherit', font: 'inherit' }} onClick={() => choose(c)} aria-label={`It's ${c.sp.name}`}>
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

      {recAnchor && picks.size > 0 && (
        <div className="card best-match" ref={recCard} style={{ scrollMarginTop: 12 }}>
          <div className="eyebrow green">Picked for you at your other shops</div>
          <span className="small">
            Like the {recAnchor.name} you ticked at {chainName(recAnchor.chain)} ({money(recAnchor.price)}). Tick the ones you want, or keep scrolling
            to pick your own.
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
                          <span className="grow">
                            <span className="title" style={{ fontSize: 15 }}>
                              {sp.name}
                            </span>
                            {sp.size && !nameHasSize(sp.name, sp.size) && <span className="small">{tidySize(sp.size, sp.name)}</span>}
                            {unitTextOf(sp) && <span className="small">{unitTextOf(sp)}</span>}
                            {sp === r.same && <span className="tag great">Same product</span>}
                          </span>
                          <span className="num" style={{ fontWeight: 700 }}>
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
          <strong>Store search works in the Android app</strong>
          <span style={{ fontSize: 13 }}>In this preview you can still add items by hand.</span>
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
                      style={{ width: 'auto', height: 36, padding: '0 8px', fontSize: 13 }}
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
                    {r.message}
                    {settings && (
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
                        <button className="btn small" onClick={() => void searchChain(chain, lastText, rankQ, searchStoreId(settings, chain))}>
                          <Icon name="refresh" size={16} /> Try again
                        </button>
                        {r.blocked && (
                          <OpenStoreButton chain={chain} onDone={() => void searchChain(chain, lastText, rankQ, searchStoreId(settings, chain))} />
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
                      <button className="linkish small" onClick={() => setOriginal((m) => ({ ...m, [chain]: !m[chain] }))}>
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
                      ' If it sells this, its website may not work with Restock yet: Settings → Troubleshooting → Diagnostics → Send search details helps get it fixed.'}
                  </p>
                )}
                {r.status === 'ok' && r.items.length > 0 && !pool.length && <p className="small">Nothing on special at {chainName(chain)}.</p>}
                {unlikely && (
                  <p className="small">
                    Nothing like it at {chainName(chain)}.{' '}
                    <button className="linkish small" onClick={() => setShowUnlikely((m) => ({ ...m, [chain]: true }))}>
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
                            <input type="checkbox" checked={picked} onChange={() => toggle(sp)} aria-label={`Select ${sp.name}`} />
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
                                {sp.isSpecial && promoLabel(sp.promo) && <span className="tag normal">{promoLabel(sp.promo)}</span>}
                                {sp.memberOnly && <MemberTag chain={sp.chain} />}
                              </span>
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
                  <button className="btn ghost small" onClick={() => setShowing((m) => ({ ...m, [chain]: limit + MORE_PAGE }))}>
                    Show more ({left})
                  </button>
                )}
                {left <= 0 && more && r.status === 'ok' && (
                  <button className="btn ghost small" disabled={r.loadingMore} onClick={() => void loadMore(chain)}>
                    {r.loadingMore ? `Getting more from ${chainName(chain)}…` : `Get more from ${chainName(chain)}`}
                  </button>
                )}
                {first.status === 'ok' && !rankQ.barcode && isNative() && (
                  <button className="linkish small" style={{ alignSelf: 'flex-end' }} onClick={() => void reportWrong(chain)}>
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
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              className="btn small primary"
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
            <button className="btn small" onClick={() => setSuggest([])}>
              No thanks
            </button>
          </div>
        </div>
      )}

      <button className="btn add" onClick={() => setManual(true)}>
        Can't find it? Add it by hand
      </button>

      {picks.size > 0 && !panelOpen && (
        <button className="card add-mini" onClick={() => setPanelOpen(true)} aria-label="Open the add panel">
          <span className="grow add-mini-text">
            <span className="title" style={{ fontSize: 15 }}>
              {picks.size} ticked · tap to add
            </span>
            <span className="small clip">{tickedShops([...picks.values()])}</span>
          </span>
          <span className="add-mini-arrow" aria-hidden="true">
            <span style={{ display: 'inline-flex', transform: 'rotate(-90deg)' }}>
              <Icon name="chevron" size={26} />
            </span>
          </span>
        </button>
      )}
      {picks.size > 0 && panelOpen && (
        <div
          className="card add-panel"
          style={{ position: 'sticky', bottom: 0, boxShadow: '0 -6px 20px rgba(0,0,0,0.08)' }}
          onPointerDown={() => setPanelHeld(true)}
          onFocus={(e) => {
            setPanelHeld(true);
            // Typing with the keyboard up: the panel scrolls inside itself (it's no taller than the
            // space left), and the box being typed in is brought into view.
            const el = e.target as HTMLElement;
            if (el.matches('input:not([type=checkbox]), textarea, select'))
              setTimeout(() => el.scrollIntoView({ block: 'center', behavior: 'smooth' }), 350);
          }}
        >
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
            {/* Its own scrolling list, so 15 ticked cans never push the arrow or the buttons away. */}
            <div className="small grow picked-list" style={{ minWidth: 0 }}>
              {[...picks.values()].map((p) => (
                <div key={keyOf(p)} className="picked-line">
                  <ChainDot chain={p.chain} />
                  <span className="clip grow">{p.name}</span>
                  <span className="num picked-price">{money(p.price)}</span>
                </div>
              ))}
            </div>
            {/* The same big green button as the one that opens the panel, pointing down. */}
            <button
              className="add-mini-arrow"
              style={{ border: 'none', cursor: 'pointer' }}
              aria-label="Shrink the add panel"
              onClick={(e) => {
                e.stopPropagation();
                setPanelHeld(false);
                setPanelOpen(false);
              }}
            >
              <span style={{ display: 'inline-flex', transform: 'rotate(90deg)' }}>
                <Icon name="chevron" size={26} />
              </span>
            </button>
          </div>
          {forList && !attachGroup ? (
            <>
              <label className="field">
                <span>Name on your shopping list</span>
                <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Coffee" />
              </label>
              <button className="btn primary" onClick={() => save('list')} disabled={saving}>
                <Icon name="cart" size={18} /> Add to shopping list
              </button>
              <p className="small" style={{ margin: 0 }}>
                Just for this trip, at the cheapest of what you ticked. It doesn't go in your pantry, and Restock won't keep watching its price.
              </p>
            </>
          ) : attachGroup ? (
            <button className="btn primary" onClick={saveAttach} disabled={saving}>
              {as === 'alt' ? 'Add to Would also take' : `Add to ${attachGroup.name}`}
            </button>
          ) : (
            <>
              <label className="field">
                <span>Name in {SECTION_PLACE[section]} and shopping list</span>
                <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Honey" />
              </label>
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
              {tabHidden ? (
                <div className="two">
                  <button className="btn primary" onClick={() => save('list')} disabled={saving}>
                    <Icon name="cart" size={18} /> Shopping list
                  </button>
                  <button className="btn" onClick={() => save('both')} disabled={saving}>
                    <Icon name={section} size={18} /> Track it too
                  </button>
                </div>
              ) : (
                <>
                  <div className="two">
                    <button className="btn primary" onClick={() => save('pantry')} disabled={saving}>
                      <Icon name={section} size={18} /> Add to {SECTION_NAMES[section].toLowerCase()}
                    </button>
                    <button className="btn primary" onClick={() => save('list')} disabled={saving}>
                      <Icon name="cart" size={18} /> Shopping list
                    </button>
                  </div>
                  <button className="btn" onClick={() => save('both')} disabled={saving}>
                    Add to both
                  </button>
                </>
              )}
              <p className="small" style={{ margin: 0 }}>
                Shopping list adds it for this trip only, at the price shown. Restock won't keep watching its price.
              </p>
            </>
          )}
        </div>
      )}

      {stocktake && <Stocktake section={section} onClose={() => setStocktake(false)} />}
      {preview && (
        <ProductPreview
          product={storePreview(preview)}
          onClose={() => setPreview(undefined)}
          action={
            <button
              className={`btn ${picks.has(keyOf(preview)) ? '' : 'primary'}`}
              onClick={() => {
                toggle(preview);
                setPreview(undefined);
              }}
            >
              <Icon name="check" size={18} /> {picks.has(keyOf(preview)) ? 'Untick this one' : 'Tick this one'}
            </button>
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

function ManualSheet({
  attachTo,
  as,
  defaultName,
  barcode,
  categories,
  section,
  shops,
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
  onClose: () => void;
  onDone: (groupId?: string) => void;
}) {
  const nav = useNav();
  const [name, setName] = useState(defaultName);
  const [chain, setChain] = useState<Chain>(shops[0] ?? 'other');
  const [size, setSize] = useState('');
  const [price, setPrice] = useState('');
  const [special, setSpecial] = useState(false);
  const [categoryId, setCategoryId] = useState('');
  // One save at a time, so a double tap doesn't add it twice.
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);

  const save = async (target: Target) => {
    if (!name.trim() || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try {
      await saveAs(target);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const saveAs = async (target: Target) => {
    const n = name.trim();
    if (target === 'list') {
      await addListEntry({ id: uid(), text: n, chain, categoryId: categoryId || undefined, section, checked: false, createdAt: nowIso() });
      nav.toast(`${n} added to your shopping list`);
      onDone();
      return;
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
      nav.toast(`Added to ${attachTo.name}`);
      onDone(attachTo.id);
      return;
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
    if (target === 'both') {
      await addListEntry({ id: uid(), text: n, groupId, categoryId: categoryId || undefined, section, checked: false, createdAt: nowIso() });
    }
    nav.toast(target === 'both' ? `${n} added to ${SECTION_PLACE[section]} and shopping list` : `${n} added to ${SECTION_PLACE[section]}`);
    onDone(groupId);
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
      {attachTo ? (
        <button className="btn primary" disabled={!name.trim() || saving} onClick={() => save('pantry')}>
          {as === 'alt' ? 'Add to Would also take' : `Add to ${attachTo.name}`}
        </button>
      ) : (
        <>
          <div className="two">
            <button className="btn primary" disabled={!name.trim() || saving} onClick={() => save('pantry')}>
              Add to {SECTION_NAMES[section].toLowerCase()}
            </button>
            <button className="btn primary" disabled={!name.trim() || saving} onClick={() => save('list')}>
              Shopping list
            </button>
          </div>
          <button className="btn" disabled={!name.trim() || saving} onClick={() => save('both')}>
            Add to both
          </button>
        </>
      )}
    </Sheet>
  );
}

type TakeLine = { code: string; name: string; groupId?: string; status: 'added' | 'already' | 'new' };

/**
 * Scan several things in a row, like walking past the cupboard: anything you track goes
 * on the shopping list, anything new goes on as plain text with a button to start tracking it.
 */
function Stocktake({ section, onClose }: { section: Section; onClose: () => void }) {
  const nav = useNav();
  const [lines, setLines] = useState<TakeLine[]>([]);
  const [busy, setBusy] = useState(false);

  const scanNext = async () => {
    setBusy(true);
    try {
      for (;;) {
        const out = await scanBarcode('Scan the next thing. Press back when you are done.');
        if (!out.ok) break;
        const product = await findProductByBarcode(out.code);
        const group = product && (await allGroups()).find((g) => groupProductIds(g).includes(product.id));
        if (group) {
          const added = await addGroupToList(group);
          setLines((l) => [{ code: out.code, name: group.name, groupId: group.id, status: added ? 'added' : 'already' }, ...l]);
        } else {
          const info = await lookupBarcode(out.code);
          const name = info.name ? genericName(info.name, info.brand) : `Item ${out.code}`;
          await addListEntry({ id: uid(), text: name, qty: 1, section, checked: false, createdAt: nowIso() });
          setLines((l) => [{ code: out.code, name, status: 'new' }, ...l]);
        }
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet title="Scan several" onClose={onClose}>
      <p className="small">
        Scan whatever is running low, one after another. Things in your pantry go straight on your shopping list. New things go on too, and you can
        start tracking their price here.
      </p>
      <button className="btn primary block" disabled={busy} onClick={scanNext}>
        <Icon name="scan" /> {lines.length ? 'Scan more' : 'Start scanning'}
      </button>
      {lines.length > 0 && (
        <div className="card flush">
          {lines.map((l, i) => (
            <div key={`${l.code}-${i}`} className="row">
              <span className="grow">
                <span className="title" style={{ fontSize: 15 }}>
                  {l.name}
                </span>
                <span className="small">
                  {l.status === 'added'
                    ? 'Added to your shopping list'
                    : l.status === 'already'
                      ? 'Already on your shopping list'
                      : 'New. Added to your shopping list'}
                </span>
              </span>
              {l.status === 'new' && (
                <button
                  className="btn small"
                  onClick={() => {
                    onClose();
                    nav.push({ name: 'add', barcode: l.code });
                  }}
                >
                  Track price
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      <button className="btn" onClick={onClose}>
        Done
      </button>
    </Sheet>
  );
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
    // Only stock about your own store (see stockKnown); online stock isn't shown.
    inStock: stockKnown(cachedSettings(), sp.chain) ? sp.inStock : undefined,
  };
}

/** "Aldi, Woolworths (2), Coles": each shop once, with how many are ticked there when it's more than one. */
export function tickedShops(picks: StoreProduct[]): string {
  const counts = new Map<StoreChain, number>();
  for (const p of picks) counts.set(p.chain as StoreChain, (counts.get(p.chain as StoreChain) ?? 0) + 1);
  return [...counts].map(([c, n]) => (n > 1 ? `${chainName(c)} (${n})` : chainName(c))).join(', ');
}
