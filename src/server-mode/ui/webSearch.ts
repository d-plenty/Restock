// 0.9.5 (web search): "Let the web page search the shops" on the web (docs/server-protocol.md
// "v3, 0.9.5"). The household's server runs the phone's own search, only when someone presses Search
// here, and keeps what it found for 15 minutes so Track and Add to list save the shop's price as the
// server got it (the browser never sends a price). This file: the setting, the two calls, the words
// for what can go wrong, and the plain logic the screens use (WebShopSearch.tsx), kept here so it's
// tested on its own. Ticking, the bar and when the details sheet opens are the phone's (addPicks.ts).

import { useEffect, useSyncExternalStore } from 'react';
import { genericName } from '../../lib/naming';
import { likeThis, matchesFor } from '../../lib/searchHelp';
import { LIST_NAMES, sectionOf, type ListSection, type Section, type StoreChain } from '../../shops';
import type { StoreProduct } from '../../stores/types';
import { chainName } from '../../types';
import { keyOf } from '../../ui/screens/addPicks';
import { ApiError, api3, v3Send } from '../api';
import { canAdmin, house } from './houseData';

// ---------- the setting ----------

let on: boolean | undefined;
let loading: Promise<void> | undefined;
const subs = new Set<() => void>();
const tell = () => subs.forEach((f) => f());

/** For tests and after a sign-out: forget what the server said. */
export function resetWebSearch(v?: boolean): void {
  on = v;
  loading = undefined;
  tell();
}

/** Ask the server (once a page load; again after a change or a 403 web-search-off). */
export function loadWebSearch(): Promise<void> {
  if (!house()) return Promise.resolve();
  loading ??= api3
    .settings()
    .then((s) => {
      on = s.webSearch === true;
      tell();
    })
    .catch(() => {
      loading = undefined;
    });
  return loading;
}

/** Is "Let the web page search the shops" on? undefined while the server hasn't said (or not a house). */
export function useWebSearchOn(): boolean | undefined {
  const v = useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => on,
    () => undefined,
  );
  useEffect(() => {
    void loadWebSearch();
  }, []);
  return v;
}

export const WEB_SEARCH_TITLE = 'Let the web page search the shops';
export const WEB_SEARCH_TEXT =
  'Lets this page search Coles, Woolworths, Aldi and your other shops when you press Search. The server only contacts a shop when someone presses Search here; nothing runs in the background. Some shops may block searches from a server; if they do, search on a phone.';
export const TURN_ON_LINK = 'Search the shops from here? Turn it on in Settings.';
export const PICK_OFF_TEXT = 'Search the shops on a phone, or turn on Let the web page search the shops in Settings.';
/** Who can change it: a browser signed in with the passphrase. */
export const canChangeWebSearch = () => house() && canAdmin();

/** Turns it on or off on the server (a passphrase-signed browser). Answers what the server now has. */
export async function saveWebSearch(v: boolean): Promise<boolean> {
  const s = await api3.putSettings({ webSearch: v });
  on = s.webSearch === true;
  tell();
  return on;
}

// ---------- the calls ----------

export interface FoundProduct extends StoreProduct {
  unitText?: string;
  halfPrice?: boolean;
  /** One of the household's pantry items already has this product. */
  itemId?: string;
  itemName?: string;
}

export type ShopAnswer =
  | { chain: StoreChain; name: string; status: 'ok'; items: FoundProduct[]; top: string[]; message?: string }
  | { chain: StoreChain; name: string; status: 'blocked'; blocked: true; message: string }
  | { chain: StoreChain; name: string; status: 'error' | 'skipped'; message: string };

export interface SearchAnswer {
  search: string;
  at: string;
  expires: string;
  text: string;
  section: Section;
  shops: ShopAnswer[];
}

export interface SearchAsk {
  q: string;
  section: Section;
  chain?: StoreChain;
  barcode?: string;
}

export type Target = 'pantry' | 'list' | 'both';

export interface AddBody {
  search: string;
  picks: { chain: string; storeProductId: string }[];
  target: Target;
  list?: 'general';
  name?: string;
  categoryId?: string;
  qty?: number;
}

export interface AddAnswer {
  item: { id: string; name: string; section: Section } | null;
  products: string[];
  line: { id: string; list?: ListSection } | null;
}

export async function searchShops(ask: SearchAsk): Promise<SearchAnswer> {
  const body: Record<string, unknown> = { q: ask.q, section: ask.section };
  if (ask.chain) body.chain = ask.chain;
  if (ask.barcode) body.barcode = ask.barcode;
  try {
    return await v3Send<SearchAnswer>('POST', '/api/v3/search', body);
  } catch (e) {
    noteOff(e);
    throw e;
  }
}

export async function addFromSearch(body: AddBody): Promise<AddAnswer> {
  try {
    return await v3Send<AddAnswer>('POST', '/api/v3/search/add', body);
  } catch (e) {
    noteOff(e);
    throw e;
  }
}

/** The server says it's off (someone turned it off meanwhile): this page shows it off too. */
function noteOff(e: unknown) {
  if (e instanceof ApiError && e.status === 403 && e.code === 'web-search-off' && on !== false) {
    on = false;
    tell();
  }
}

/** What to say when a search or an add didn't work. */
export function searchErrorText(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 429 && e.code === 'rate-server') return 'Your server has done a lot of searches this hour. Try again later, or search on a phone.';
    if (e.status === 429) return 'Too many searches. Try again in a minute.';
    if (e.status === 410) return 'That search expired. Search again.';
    if (e.status === 403 && e.code === 'web-search-off') return 'Turn on Let the web page search the shops in Settings.';
    if (e.status === 0) return e.message;
    if (e.message) return e.message;
  }
  return e instanceof Error ? e.message : String(e);
}

/** A 410: the kept search is gone, so the page searches again before anything else. */
export const isGone = (e: unknown) => e instanceof ApiError && e.status === 410;

// ---------- what the screens show ----------

/** A typed line is searched at its tab's shops; General's at the supermarkets (as the phone's Find the cheapest). */
export const searchTabFor = (list: ListSection): Section => (list === 'general' ? 'pantry' : list);

/** The tab whose shops sell at this chain (a special's shop, say). */
export const tabOfChain = (chain: string): Section => sectionOf(chain);

/** Which lists a found product can go on: its tab's, and General. */
export const listChoices = (tab: Section): ListSection[] => [tab, 'general'];
export const listLabel = (l: ListSection) => (l === 'pantry' ? 'Shopping list (Groceries)' : `${LIST_NAMES[l]} list`);

/** "Aldi, Woolworths (2), Coles": each shop once, with how many are ticked there when more than one (as the phone's bar). */
export function tickedShops(picks: Iterable<StoreProduct>): string {
  const counts = new Map<string, number>();
  for (const p of picks) counts.set(p.chain, (counts.get(p.chain) ?? 0) + 1);
  return [...counts].map(([c, n]) => (n > 1 ? `${chainName(c)} (${n})` : chainName(c))).join(', ');
}

/** The name to suggest for what's ticked: what was typed for a Pick sheet line, else the first pick's plain name. */
export function suggestedName(picks: Iterable<StoreProduct>, typed?: string): string {
  const first = [...picks][0];
  if (typed?.trim()) return typed.trim().charAt(0).toUpperCase() + typed.trim().slice(1);
  if (!first) return '';
  return genericName(first.name, first.brand) || first.name;
}

/**
 * The body for POST /api/v3/search/add, from what was ticked and what was chosen in the sheet.
 * General is a list only, so it goes with Add to list alone (the sheet offers nothing else for it).
 */
export function addBody(
  search: string,
  picks: Iterable<StoreProduct>,
  o: { target: Target; tab: Section; list: ListSection; name?: string; categoryId?: string; qty?: number },
): AddBody {
  const all = [...picks];
  if (!all.length) throw new Error('Tick at least one product first.');
  if (all.length > 6) throw new Error('Tick 6 or fewer, then add.');
  if (o.list === 'general' && o.target !== 'list') throw new Error('General is a list only: use Add to list for it.');
  if (o.list !== 'general' && o.list !== o.tab) throw new Error("That isn't one of this tab's lists.");
  const body: AddBody = { search, picks: all.map((p) => ({ chain: p.chain, storeProductId: p.storeProductId })), target: o.target };
  if (o.list === 'general') body.list = 'general';
  const name = o.name?.trim();
  if (name) body.name = name.slice(0, 80);
  // A General line has no category (General has none).
  if (o.categoryId && o.list !== 'general') body.categoryId = o.categoryId;
  if (o.qty && o.qty > 1) body.qty = Math.min(99, Math.round(o.qty));
  return body;
}

/** What to say once it's added. */
export function addedText(a: AddAnswer, name: string, tab: Section): string {
  const place = tab === 'pantry' ? 'your pantry' : tab === 'keg' ? 'your keg' : 'your Health list';
  const listName = a.line?.list === 'general' ? 'General' : 'your Shopping list';
  if (a.item && a.line) return `${name} added to ${place} and ${listName}`;
  if (a.item) return `${name} added to ${place}`;
  return a.line?.list === 'general' ? `${name} added to General` : `${name} added to your Shopping list`;
}

/** How a shop answered, in words, for one that didn't give results. */
export function shopNote(s: ShopAnswer): string | undefined {
  if (s.status === 'ok') return s.items.length ? undefined : (s.message ?? `No matches at ${s.name}.`);
  return s.message;
}

/** Best first, as the server ranked them; with "ticked first" so a tick is never under Show more. */
export function shownItems(s: ShopAnswer, picks: ReadonlyMap<string, StoreProduct>, specialsOnly: boolean, limit: number) {
  const items = s.status === 'ok' ? s.items.filter((p) => !specialsOnly || p.isSpecial) : [];
  const ordered = [...items.filter((p) => picks.has(keyOf(p))), ...items.filter((p) => !picks.has(keyOf(p)))];
  return { list: ordered.slice(0, limit), left: Math.max(0, ordered.length - limit), total: items.length };
}

/**
 * "Picked for you at your other shops": like the phone's, from what the other shops already sent
 * back (no second search: each one costs one of the server's searches). The same product there, or
 * the ones most like it.
 */
export function picksForYou(anchor: StoreProduct, shops: ShopAnswer[], typed: string): { chain: StoreChain; same?: FoundProduct; like: FoundProduct[] }[] {
  const kind = genericName(anchor.name, anchor.brand) || typed;
  const out: { chain: StoreChain; same?: FoundProduct; like: FoundProduct[] }[] = [];
  for (const s of shops) {
    if (s.chain === anchor.chain || s.status !== 'ok' || !s.items.length) continue;
    const same = matchesFor(anchor, s.items, 0.6)[0] as FoundProduct | undefined;
    const like = likeThis(
      anchor,
      s.items.filter((p) => !same || keyOf(p) !== keyOf(same)),
      kind,
      typed,
      same ? 2 : 3,
    ) as FoundProduct[];
    if (same || like.length) out.push({ chain: s.chain, same, like });
  }
  return out;
}

/** Specials: the special's own product in what its shop sent back (the same shop id), if there. */
export function findProduct(a: SearchAnswer, chain: string, storeProductId: string | undefined): FoundProduct | undefined {
  if (!storeProductId) return undefined;
  for (const s of a.shops) if (s.chain === chain && s.status === 'ok') return s.items.find((p) => String(p.storeProductId) === String(storeProductId));
  return undefined;
}

/** "Searching Woolworths, Coles and Aldi…" */
export function searchingText(shops: string[]): string {
  if (!shops.length) return 'Searching your shops from your server…';
  const names = shops.map((c) => chainName(c));
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return `Searching ${list} from your server…`;
}

// ---------- one search at a time, asked from the add box or a scan ----------

/** What to search for: typed words, or a scanned barcode (searched as itself). `n` makes each ask new. */
export interface ShopAsk {
  q: string;
  barcode?: string;
  /** The list it came from (General's are searched at the supermarkets). */
  list: ListSection;
  n: number;
}
let ask: ShopAsk | undefined;
let askN = 0;
const askSubs = new Set<() => void>();
export function askShops(a: Omit<ShopAsk, 'n'> | undefined): void {
  ask = a && a.q.trim() ? { ...a, q: a.q.trim().slice(0, 100), n: ++askN } : undefined;
  askSubs.forEach((f) => f());
}
export const currentAsk = () => ask;
export function useShopAsk(): ShopAsk | undefined {
  return useSyncExternalStore(
    (f) => {
      askSubs.add(f);
      return () => askSubs.delete(f);
    },
    () => ask,
    () => undefined,
  );
}

/**
 * A scanned barcode no household product has: when the setting is on, the shops are searched for it
 * (scan.ts setBarcodeSearch calls this). Undefined leaves it ("Type its name to add it").
 */
export async function barcodeSearch(code: string, list: ListSection): Promise<string | undefined> {
  if (on === undefined) await loadWebSearch();
  if (on !== true) return undefined;
  askShops({ q: code, barcode: code, list });
  return `Searching your shops for barcode ${code}…`;
}

/** What Enter in the web's add box does with typed words: add the item you track, search the shops, or add the words. */
export function enterDoes(o: { text: string; exactPantry: boolean; pantryMatches: number; searchOn: boolean | undefined }): 'pantry' | 'search' | 'add' | 'nothing' {
  if (!o.text.trim()) return 'nothing';
  if (o.exactPantry) return 'pantry';
  if (o.searchOn === true && o.pantryMatches === 0) return 'search';
  return 'add';
}
