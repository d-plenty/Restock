import { adapterFor } from '../stores';
import type { Chain } from '../types';
import { isPressOnlyShop, kindOf, sectionOf, type Section, slots } from '../shops';
import { getKV, putKV } from './db';
import { BlockedError, isBlockMessage } from '../stores/http';

// How each store's connection has been going: the last time it worked, and since when it's
// been failing. Price checks (PriceChecker.java) and searches update it, so Home can say
// "Coles hasn't worked for 3 days" instead of quietly going stale.

export type StoreChain = Exclude<Chain, 'other'>;

export interface ChainHealth {
  lastOk?: string;
  lastFail?: string;
  error?: string;
  /** When the current run of failures started (cleared when it works again). */
  failingSince?: string;
}
export type StoreHealth = Partial<Record<StoreChain, ChainHealth>>;

const KEY = 'storeHealth';

export async function getHealth(): Promise<StoreHealth> {
  return (await getKV<StoreHealth>(KEY)) ?? {};
}

/** Apply results (null = worked, text = the error) to the saved health. Pure, for testing. */
export function nextHealth(h: StoreHealth, results: Partial<Record<StoreChain, string | null>>, at: string): StoreHealth {
  const out: StoreHealth = { ...h };
  for (const [chain, err] of Object.entries(results) as [StoreChain, string | null][]) {
    const cur = out[chain] ?? {};
    out[chain] = err === null ? { lastOk: at, lastFail: cur.lastFail } : { ...cur, lastFail: at, error: err, failingSince: cur.failingSince ?? at };
  }
  return out;
}

export async function recordHealth(results: Partial<Record<StoreChain, string | null>>): Promise<void> {
  if (!Object.keys(results).length) return;
  await putKV(KEY, nextHealth(await getHealth(), results, new Date().toISOString()));
}

/** Stores that have been failing for at least `minHours`, longest first. */
export function failingStores(h: StoreHealth, now = Date.now(), minHours = 20): { chain: StoreChain; since: string; days: number; error?: string }[] {
  return (Object.entries(h) as [StoreChain, ChainHealth][])
    .filter(([, c]) => c.failingSince && now - Date.parse(c.failingSince) >= minHours * 3_600_000)
    .map(([chain, c]) => ({
      chain,
      since: c.failingSince!,
      days: Math.max(1, Math.round((now - Date.parse(c.failingSince!)) / 86_400_000)),
      error: c.error,
    }))
    .sort((a, b) => a.since.localeCompare(b.since));
}

/**
 * 0.10.4: the shop is turning Restock away (it answered 403, or showed a "checking your browser"
 * page), as opposed to answering with nothing. The fix is Unblock: the person passes the shop's
 * own check in Restock's built-in browser. Restock never solves or dodges a check itself.
 */
export const isBlockedError = (error: string | undefined): boolean => isBlockMessage(error);

// 0.10.4: "Hide for a day" on a shop's warning. Kept on this phone only. After a day the warning
// comes back if the shop is still failing.
const HIDDEN_KEY = 'hiddenShopWarnings';
export const HIDE_FOR_MS = 24 * 3_600_000;
export type HiddenWarnings = Partial<Record<StoreChain, string>>;

export async function getHiddenWarnings(): Promise<HiddenWarnings> {
  return (await getKV<HiddenWarnings>(HIDDEN_KEY).catch(() => undefined)) ?? {};
}

/** Until when a shop's warning stays hidden (pure, for testing). */
export function hideUntil(now = Date.now()): string {
  return new Date(now + HIDE_FOR_MS).toISOString();
}

/** True while the shop's warning is hidden. A broken or far-future time never hides it for good. */
export function isHidden(hidden: HiddenWarnings | undefined, chain: StoreChain, now = Date.now()): boolean {
  const until = Date.parse(hidden?.[chain] ?? '');
  return Number.isFinite(until) && until > now && until - now <= HIDE_FOR_MS;
}

export async function hideWarning(chain: StoreChain, now = Date.now()): Promise<void> {
  const cur = await getHiddenWarnings();
  // Drop the ones that have run out while here.
  const next: HiddenWarnings = Object.fromEntries(Object.entries(cur).filter(([c]) => isHidden(cur, c as StoreChain, now)));
  next[chain] = hideUntil(now);
  await putKV(HIDDEN_KEY, next);
}

/** Show the warning again straight away (after Unblock worked, say). */
export async function unhideWarning(chain: StoreChain): Promise<void> {
  const cur = await getHiddenWarnings();
  if (!cur[chain]) return;
  delete cur[chain];
  await putKV(HIDDEN_KEY, cur);
}

export interface ConnectionTest {
  chain: StoreChain;
  ok: boolean;
  count?: number;
  ms: number;
  error?: string;
  /** 0.10.4: the shop turned Restock away (403, or a "checking your browser" page). */
  blocked?: boolean;
  /** 0.10.5: offer Unblock (blocked, or a hidden-browser shop that timed out or found nothing). */
  unblock?: boolean;
}

/** The word Restock searches for when testing a shop (0.10.3: Baby and Pets too). */
export const TEST_WORD: Record<Section, string> = { pantry: 'milk', keg: 'beer', pharmacy: 'paracetamol', baby: 'nappies', pets: 'dog food', ...slots('soap') };

/** 0.10.5: shops read through the hidden browser (their website, or Dan Murphy's/BWS falling back to it). */
export const usesBrowser = (chain: StoreChain): boolean => {
  const k = kindOf(chain) ?? 'web';
  return k === 'web' || k === 'endeavour';
};

/**
 * 0.10.5: when to offer Unblock. A clear block (403, a "checking your browser" page), and also, for a
 * shop read through the hidden browser, a search that never answers or finds nothing for its test
 * word: a bottle shop with no beer is a shop whose check never cleared, not an empty shop.
 * Errors saved by older versions ("found nothing for "beer"") count too.
 */
export function offerUnblock(chain: StoreChain | string, error: string | undefined): boolean {
  if (!error) return false;
  if (isBlockedError(error)) return true;
  if (chain === 'other' || !usesBrowser(chain as StoreChain)) return false;
  // 0.10.6: Dan Murphy's and BWS answer from inside their own page even when their data turns the
  // app away, so "found nothing" there is an answer, not a check that never cleared. Only a real
  // refusal (above), or no answer at all, offers Unblock for them.
  if (kindOf(chain as StoreChain) === 'endeavour') return /no answer after/i.test(error);
  return /no answer after|found nothing for|nothing came back/i.test(error);
}

/** 0.10.5: how many shops are tested at once (the phone's hidden browser opens this many pages at once). */
export const TEST_AT_ONCE = 3;

/** How long one shop gets, counted from when its own test starts (not from pressing Test). */
export function testTimeoutMs(chain: StoreChain): number {
  const k = kindOf(chain) ?? 'web';
  return k === 'web' ? 75_000 : k === 'endeavour' ? 60_000 : 30_000;
}

/** Run `jobs` with at most `n` going at once, in order. */
export async function inTurns<T, R>(items: T[], n: number, job: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await job(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

/**
 * Try a real search at each store, like adding an item would. 0.10.5: three at a time, quick shops
 * first, each shop's clock starting when its own turn comes; `onEach` hears each result as it lands.
 */
export async function testConnections(
  chains: StoreChain[],
  storeIds: Partial<Record<StoreChain, string | undefined>>,
  onEach?: (r: ConnectionTest) => void,
): Promise<ConnectionTest[]> {
  // 0.9.6: never Costco: it is only searched one page at a time, when a person presses Search.
  const todo = chains.filter((c) => !isPressOnlyShop(c));
  // The shops with their own app data answer in a second or so: do them first.
  const ordered = [...todo.filter((c) => !usesBrowser(c)), ...todo.filter((c) => usesBrowser(c))];
  const results = await inTurns(ordered, TEST_AT_ONCE, async (chain): Promise<ConnectionTest> => {
    const t0 = Date.now();
    const word = TEST_WORD[sectionOf(chain)];
    let r: ConnectionTest;
    try {
      const items = await withTimeout(adapterFor(chain)!.search(word, storeIds[chain]), testTimeoutMs(chain));
      r = items.length
        ? { chain, ok: true, count: items.length, ms: Date.now() - t0 }
        : { chain, ok: false, ms: Date.now() - t0, error: `The shop answered but found nothing for "${word}"` };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      r = { chain, ok: false, ms: Date.now() - t0, error, blocked: e instanceof BlockedError || isBlockedError(error) };
    }
    if (!r.ok) r.unblock = !!r.blocked || offerUnblock(chain, r.error);
    onEach?.(r);
    return r;
  });
  await recordHealth(Object.fromEntries(results.map((r) => [r.chain, r.ok ? null : (r.error ?? 'failed')])));
  // Back in the order asked for.
  return todo.map((c) => results.find((r) => r.chain === c)!);
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`No answer after ${Math.round(ms / 1000)} seconds`)), ms);
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e)),
    );
  });
}
