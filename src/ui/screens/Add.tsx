import { AltGroup, MatchCards } from './AddPanel';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { seenBefore, type SeenBefore } from '../../lib/seen';
import { cleanSearch } from '../../lib/searchText';
import { confidentCategoryId } from '../../lib/categoryGuess';
import { suggestName } from '../../lib/nameSuggest';
import { sameNameItem } from '../../lib/sameName';
import { flavourBarNote } from '../../lib/flavours';
import { act } from '../../lib/undo';
import { productCode, scanBarcode, type BarcodeInfo } from '../../lib/barcode';
import { displayName, identifyBarcode, searchTermFor, weakName } from '../../lib/lookup';
import { PackReader } from '../PackReader';
import { markMatched, onScanLines, toMatch } from '../../lib/scanQueue';
import { okToLeave, useLeaveGuard } from '../leaveGuard';
import { logProblem } from '../../lib/diagnostics';
import { addListEntry, deleteListEntries, allCategories, allGroups, allProducts, findProductByBarcode, getGroup, getProducts, getSettings, groupProductIds, nowIso, readingsFor, uid, removeProductFromGroup, updateGroup, updateProduct, updateSettings } from '../../lib/db';
import { adoptGeneralLines, pickItemFor } from '../../lib/listPicks';
import { addToList } from '../../lib/listActions';
import { genericName } from '../../lib/naming';
import { shareTextFile } from '../../lib/backup';
import { slim } from '../../lib/searchTest';
import { bestMatches, sameCode, type BestMatch, type Candidate, whichOne, UNLIKELY, likeThis, matchesFor, normaliseQuery, queryChanged, recentSearches, rememberSearch, unitTextOf, scoreAll, topPicks, intendedKind, weakShops, type Scored } from '../../lib/searchHelp';
import { localDay } from '../../lib/verdict';
import { useLive } from '../../lib/useLive';
import { adapterFor, type StoreProduct } from '../../stores';
import { BlockedError, NativeOnlyError } from '../../stores/http';
import { CostcoLines } from '../CostcoLines';
import { COSTCO_LIST_NOTE } from '../../lib/costcoLocal';
import { isBlockedError, offerUnblock, recordHealth } from '../../lib/health';
import { isExactBarcode, rankAll, score, tokens, type RankQuery } from '../../stores/rank';
import { chainName, mainProductIds, searchStoreId, type AlertLevel, type Chain, type Group } from '../../types';
import { activeSections, costcoIsOn, enabledIn, isLocalOnlyShop, SECTION_NAMES, SECTION_PLACE, SECTION_SHOPS, searchChainsIn, type Section, type StoreChain } from '../../shops';
import { Icon, useBackHandler, ProductPreview, Sheet, SearchField } from '../components';
import { useNav } from '../nav';
import { type NoteTone } from '../simple';
import { keyOf, sheetOpenAfter, tickMessage, togglePick } from './addPicks';
import { addItemForLineUndoable, addItemFromPicks, pickedWords, saveStoreProducts } from './addSave';
import { attachPatch, rolesIn, uniqueProducts } from './attachOne';
import { WhereShopSheet, ManualSheet } from './AddSheets';
import { AddPanel } from './AddPanel';
import { AddWays } from './AddWays';
import { AddResults, ChangeHead, ResultRow, ShopDone } from './AddResults';
import { AddScanned } from './AddScanned';
import { AddRecent, AddTitle } from './AddTop';
import { SEARCH_PLACEHOLDER, type ForLine, type ChainResult, FULL_PAGE, type SortKey, FIRST_PAGE, MORE_PAGE, type Target, matchByDetails, FIRST_SHOPS, followAdapter, storePreview, tickedShops } from './addShared';

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
  // 0.13.0: no tab is hidden any more (Bottle shop and Chemist had a "Show in More" switch)
  const tabHidden = false as boolean;

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

  /** 0.13.0: a once-only line's name when none was typed: the product's own. */
  const onceName = (p: { name: string; brand?: string } | undefined) => (p?.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Item';
  const save = async (target: Target) => {
    if (!picks.size || saving) return;
    // 0.12.7: you name it (Restock never fills the name in), and at least one pick is what you buy.
    // 0.13.0: only what's kept needs a name. A line that's on the list just this once takes the
    // product's own name when you haven't typed one.
    if (!name.trim() && target !== 'list') {
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
      const itemName = name.trim() || onceName(cheapestPick() ?? mainPicks[0]);
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
      // A line waiting on General under these words is this item now (it isn't left behind there).
      if (groupId && !forLine) await adoptGeneralLines({ id: groupId, name: itemName }, [itemName, term, query]);
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
  const pickTracked = async (g: Group) => {
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
  /** One result: the photo, the name, its shop and size, one price and a word. + picks it. */
  const resultRow = (sp: StoreProduct, top: Set<string>) => {
    const k = keyOf(sp);
    return (
      <ResultRow
        key={k}
        sp={sp}
        good={top.has(k)}
        picked={isPicked(k)}
        tracked={pantry?.get(k)}
        inRole={addingToItem ? attach?.inItem.get(k) : undefined}
        rankQ={rankQ}
        section={section}
        seen={before.get(`${sp.chain}|${sp.storeProductId}`)}
        photo={sp.imageUrl ?? photoFor(sp)}
        onPick={pickOne}
        onPreview={setPreview}
      />
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
    <MatchCards anchorChain={anchorChain} attachTo={attachTo} declined={declined} forLine={forLine} lastText={lastText} mainPicks={mainPicks} makesItem={makesItem} matchShops={matchShops} notSoldAt={notSoldAt} photoFor={photoFor} pickLabel={pickLabel} pickOne={pickOne} rankQ={rankQ} results={results} searchChain={searchChain} searched={searched} setAlts={setAlts} setDeclined={setDeclined} settings={settings} startChange={startChange} toggle={toggle} />
  );

  // 0.12.7: "Also happy with (alternative product)" while adding. It was only on the item's page
  // afterwards, so people never found it. One line per shop: your alternative there, or Find one.
  const altGroup = makesItem && (
    <AltGroup altPicks={altPicks} matchShops={matchShops} photoFor={photoFor} pickOne={pickOne} results={results} searched={searched} setAlts={setAlts} startChange={startChange} />
  );

  const pickedCategory = categories?.find((c) => c.id === shownCategory)?.name;

  return (
    // Inside the Pick sheet the sheet scrolls, so the bar at the bottom stays in view there too.
    <div className="screen" ref={screenRef} style={forLine ? { padding: 0, overflow: 'visible', flex: 'none' } : undefined}>
      <AddTitle altMode={altMode} attachGroup={attachGroup} backToPicks={backToPicks} changing={changing} forLine={forLine} nav={nav} onlyChain={onlyChain} overlay={overlay} section={section} sectionsOn={sectionsOn} setSwitching={setSwitching} switchSection={switchSection} switching={switching} title={title} />
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

      <AddRecent anyResults={anyResults} recent={recent} runText={runText} scanned={scanned} searchedFor={searchedFor} setRecent={setRecent} setTerm={setTerm} term={term} />

      <AddScanned addingToItem={addingToItem} alreadyHave={alreadyHave} anyResults={anyResults} auto={auto} candidates={candidates} changing={changing} choose={choose} dismissedHave={dismissedHave} handleBarcode={handleBarcode} isPicked={isPicked} known={known} linkBarcode={linkBarcode} lookingUp={lookingUp} nav={nav} panelOpen={panelOpen} photoFor={photoFor} picks={picks} rankQ={rankQ} reset={reset} results={results} scanned={scanned} search={search} searched={searched} section={section} setDismissedHave={setDismissedHave} setPanelOpen={setPanelOpen} setPreview={setPreview} setSearchedFor={setSearchedFor} setTerm={setTerm} setWhatIsIt={setWhatIsIt} settings={settings} sizesBusy={sizesBusy} sizesFor={sizesFor} sizesKey={sizesKey} sizesPool={sizesPool} sizesSkip={sizesSkip} toggle={toggle} whatIsIt={whatIsIt} />

      </div>
      <ChangeHead altMode={altMode} anchorChain={anchorChain} backToPicks={backToPicks} changing={changing} picks={picks} />

      <AddResults PER_SHOP={PER_SHOP} anyResults={anyResults} changing={changing} costcoLeftOut={costcoLeftOut} instead={instead} lastText={lastText} loadMore={loadMore} mixed={mixed} original={original} picks={picks} rankQ={rankQ} reportWrong={reportWrong} resultRow={resultRow} results={results} searchChain={searchChain} searchCostcoToo={searchCostcoToo} searched={searched} setOriginal={setOriginal} setPicks={setPicks} setShopView={setShopView} setShowUnlikely={setShowUnlikely} setShowing={setShowing} setSortBy={setSortBy} setSpecialsOnly={setSpecialsOnly} setSuggest={setSuggest} settings={settings} showUnlikely={showUnlikely} showing={showing} shownItems={shownItems} sortBy={sortBy} specialsOnly={specialsOnly} suggest={suggest} topKeys={topKeys} view={view} />

      <ShopDone altMode={altMode} anyResults={anyResults} attachTo={attachTo} backToPicks={backToPicks} changing={changing} declined={declined} finishEarly={finishEarly} finishedAt={finishedAt} forLine={forLine} nextShopAfter={nextShopAfter} notSoldAt={notSoldAt} picks={picks} results={results} searched={searched} view={view} />

      <AddWays anyResults={anyResults} attachTo={attachTo} changing={changing} forLine={forLine} moreWays={moreWays} nav={nav} scanned={scanned} searchedFor={searchedFor} section={section} setManual={setManual} setMoreWays={setMoreWays} setPhotoFind={setPhotoFind} settings={settings} />

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
      <AddPanel alertLevel={alertLevel} alertPct={alertPct} allowBulk={allowBulk} allowMulti={allowMulti} altGroup={altGroup} as={as} attachGroup={attachGroup} busyAs={busyAs} catTouched={catTouched} categories={categories} categoryId={categoryId} cheapestChain={cheapestChain} forLine={forLine} forList={forList} havePick={havePick} makesItem={makesItem} matchCards={matchCards} matchShops={matchShops} name={name} nameBox={nameBox} nameIdea={nameIdea} nameMissing={nameMissing} nav={nav} panelOpen={panelOpen} pickedCategory={pickedCategory} picks={picks} save={save} saveAttach={saveAttach} saving={saving} section={section} setAlertLevel={setAlertLevel} setAlertPct={setAlertPct} setAllowBulk={setAllowBulk} setAllowMulti={setAllowMulti} setCatTouched={setCatTouched} setCategoryId={setCategoryId} setName={setName} setNameMissing={setNameMissing} setPanelOpen={setPanelOpen} sheetTitle={sheetTitle} shownCategory={shownCategory} sureCategory={sureCategory} tabHidden={tabHidden} takenItem={takenItem} toPantry={toPantry} trackedPick={trackedPick} pickTracked={pickTracked} />

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

