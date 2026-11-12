import { chainName, enabledIn, isLocalOnlyShop, type Section, type StoreChain } from '../shops';

/** 0.9.6: the shops a test searches: never Costco, which is only ever searched one page at a time by a person pressing Search. */
const testShops = (chains: readonly string[], sec: Section) => enabledIn(chains, sec).filter((c) => !isLocalOnlyShop(c));
import { adapterFor } from '../stores';
import type { StoreProduct } from '../stores/types';
import { searchStoreId } from '../types';
import { isNative } from '../stores/http';
import { shareTextFile } from './backup';
import { getKV, getSettings, putKV } from './db';
import { RestockNative } from './sql/native';
import { intendedKind, normaliseQuery, scoreAll, weakShops } from './searchHelp';
import { mark, scorecard } from './searchScore';
import { PHONE_WORDS, SEARCH_WORDS } from './searchWords';
import { localDay } from './verdict';

// The search test on the phone (0.8.6): Settings → Advanced → Diagnostics. Searches a list
// of everyday words at your shops the way the app does (including the shops that only answer the
// phone), marks the results, and saves one file to send to the developer. Gentle on the shops:
// one search at a time, with a pause between. The file has the shops' answers and the test words,
// nothing about you, your items or your store.

export interface SearchTestProgress {
  done: number;
  total: number;
  now: string;
}

const PAUSE_MS = 1200;
// With the screen off the WebView's own timers slow right down, so the pause is kept natively.
const sleep = (ms: number) =>
  isNative() ? RestockNative.pause({ ms }).catch(() => undefined) : new Promise<void>((r) => setTimeout(r, ms));

/** Just what's needed to mark a result: no pictures, links or store numbers. */
export const slim = (p: StoreProduct) => ({
  chain: p.chain,
  storeProductId: p.storeProductId,
  name: p.name,
  brand: p.brand,
  size: p.size,
  price: p.price,
  wasPrice: p.wasPrice,
  isSpecial: p.isSpecial,
  memberOnly: p.memberOnly,
  promo: p.promo,
});

/** How many searches a test would make (before any shop is searched again for the kind). */
export async function searchTestSize(sections: Section[], every = false): Promise<number> {
  const s = await getSettings();
  return sections.reduce((n, sec) => n + testShops(s.enabledChains, sec).length * (every ? SEARCH_WORDS : PHONE_WORDS)[sec].length, 0);
}

export async function runSearchTest(
  sections: Section[],
  every: boolean,
  onProgress: (p: SearchTestProgress) => void,
  stopped: () => boolean,
): Promise<{ file: Record<string, unknown>; summary: string }> {
  const s = await getSettings();
  const raw: Record<string, StoreProduct[]> = {};
  const errors: Record<string, string> = {};
  const plan = sections.flatMap((sec) =>
    testShops(s.enabledChains, sec).flatMap((shop) =>
      (every ? SEARCH_WORDS : PHONE_WORDS)[sec].map((word) => ({
        sec,
        shop,
        word,
      })),
    ),
  );
  let done = 0;
  const started = Date.now();
  // Keeps going with the screen off or in another app, with a notification and a Stop button.
  const native = isNative();
  let stopTapped = false;
  if (native) await RestockNative.searchTestStart({ total: plan.length }).catch(() => undefined);
  const stopNow = () => stopped() || stopTapped;
  const tell = async (p: SearchTestProgress) => {
    onProgress(p);
    if (!native) return;
    const r = await RestockNative.searchTestProgress({ done: p.done, total: p.total, text: p.now }).catch(() => ({ stop: false }));
    stopTapped = stopTapped || r.stop;
  };
  const ask = async (shop: StoreChain, term: string, key: string) => {
    try {
      raw[key] = ((await adapterFor(shop)?.search(term, searchStoreId(s, shop))) ?? []).map(slim) as StoreProduct[];
    } catch (e) {
      errors[key] = e instanceof Error ? e.message : String(e);
    }
    await sleep(PAUSE_MS);
  };
  for (const { shop, word } of plan) {
    if (stopNow()) break;
    await tell({
      done,
      total: plan.length,
      now: `“${word}” at ${chainName(shop)}`,
    });
    await ask(shop, normaliseQuery(word), `${shop}|${word}`);
    done++;
  }
  // Shops with nothing like a word: searched again for what it is, as the app does.
  for (const sec of sections) {
    for (const word of (every ? SEARCH_WORDS : PHONE_WORDS)[sec]) {
      if (stopNow()) break;
      const text = normaliseQuery(word);
      const shops = testShops(s.enabledChains, sec).filter((c) => raw[`${c}|${word}`]);
      const scored = Object.fromEntries(shops.map((c) => [c, scoreAll({ text }, raw[`${c}|${word}`])]));
      const kind = intendedKind({ text }, scored);
      if (!kind) continue;
      for (const shop of weakShops(scored) as StoreChain[]) {
        if (stopNow()) break;
        await tell({
          done,
          total: plan.length,
          now: `“${kind}” at ${chainName(shop)}, which had nothing like “${word}”`,
        });
        await ask(shop, kind, `${shop}|${word}|${kind}`);
      }
    }
  }
  const card = scorecard(mark(raw));
  const file = {
    app: 'restock',
    kind: 'search-test',
    version: __APP_VERSION__,
    at: new Date().toISOString(),
    minutes: Math.round((Date.now() - started) / 60000),
    sections,
    every,
    stoppedEarly: stopNow(),
    shops: [...new Set(plan.map((p) => p.shop))].map((id) => ({
      id,
      name: chainName(id),
    })),
    errors,
    scorecard: card,
    raw,
  };
  return { file, summary: card.split('\n\n')[0] };
}

// ---------- one test at a time, carried on while you leave the screen (0.8.6) ----------

export interface SearchTestState {
  progress?: SearchTestProgress;
  /** The last finished test, kept until the next one, so it can be sent later. */
  last?: { at: string; summary: string; stoppedEarly: boolean };
}

const LAST = 'searchTest:last';
let state: SearchTestState = {};
let stopFlag = false;
const listeners = new Set<(s: SearchTestState) => void>();
const set = (next: SearchTestState) => {
  state = next;
  for (const l of listeners) l(state);
};
const summaryOf = (f: Record<string, unknown>) => String(f.scorecard ?? '').split('\n\n')[0];

/** Follows the test's progress; returns a function to stop following. */
export function watchSearchTest(fn: (s: SearchTestState) => void): () => void {
  listeners.add(fn);
  fn(state);
  if (!state.last && !state.progress)
    void getKV<Record<string, unknown>>(LAST)
      .then((f) => {
        if (f && !state.last) set({ ...state, last: { at: String(f.at), summary: summaryOf(f), stoppedEarly: !!f.stoppedEarly } });
      })
      .catch(() => undefined);
  return () => {
    listeners.delete(fn);
  };
}

export const stopSearchTest = () => {
  stopFlag = true;
};

/** Shares the last finished test's file (Android's share menu). */
export async function shareLastSearchTest(): Promise<boolean> {
  const f = await getKV<Record<string, unknown>>(LAST);
  if (!f) return false;
  await shareTextFile(`restock-search-test-${localDay(String(f.at))}.json`, JSON.stringify(f), 'application/json', 'Restock search test');
  return true;
}

/**
 * Runs a search test. It carries on if you leave the screen or lock the phone. When it ends the
 * file is kept: shared straight away if Restock is on screen, and otherwise a notification says
 * it's ready to send from Diagnostics.
 */
export async function startSearchTest(sections: Section[], every: boolean): Promise<'shared' | 'saved'> {
  if (state.progress) return 'saved';
  stopFlag = false;
  set({ ...state, progress: { done: 0, total: 0, now: 'Starting…' } });
  try {
    const { file, summary } = await runSearchTest(sections, every, (p) => set({ ...state, progress: p }), () => stopFlag);
    await putKV(LAST, file);
    set({ last: { at: String(file.at), summary, stoppedEarly: !!file.stoppedEarly } });
    const all = summary.split('\n').find((l) => l.startsWith('ALL'));
    const firstPct = all?.trim().split(/\s+/)[2];
    const onScreen = typeof document === 'undefined' || document.visibilityState === 'visible';
    if (isNative())
      await RestockNative.searchTestEnd(
        onScreen
          ? {}
          : {
              title: file.stoppedEarly ? 'Search test stopped' : 'Search test finished',
              text: `${firstPct ? `The right thing came first ${firstPct} of the time. ` : ''}Send it from Settings → Advanced → Diagnostics.`,
            },
      ).catch(() => undefined);
    if (!onScreen) return 'saved';
    await shareLastSearchTest();
    return 'shared';
  } catch (e) {
    if (isNative()) await RestockNative.searchTestEnd({}).catch(() => undefined);
    set({ last: state.last });
    throw e;
  }
}
