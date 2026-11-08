import { chainName, enabledIn, type Section, type StoreChain } from "../shops";
import { adapterFor } from "../stores";
import type { StoreProduct } from "../stores/types";
import { searchStoreId } from "../types";
import { getSettings } from "./db";
import {
  intendedKind,
  normaliseQuery,
  scoreAll,
  weakShops,
} from "./searchHelp";
import { mark, scorecard } from "./searchScore";
import { PHONE_WORDS, SEARCH_WORDS } from "./searchWords";

// The search test on the phone (0.8.6): Settings → Troubleshooting → Diagnostics. Searches a list
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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
export async function searchTestSize(
  sections: Section[],
  every = false,
): Promise<number> {
  const s = await getSettings();
  return sections.reduce(
    (n, sec) =>
      n +
      enabledIn(s.enabledChains, sec).length *
        (every ? SEARCH_WORDS : PHONE_WORDS)[sec].length,
    0,
  );
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
    enabledIn(s.enabledChains, sec).flatMap((shop) =>
      (every ? SEARCH_WORDS : PHONE_WORDS)[sec].map((word) => ({
        sec,
        shop,
        word,
      })),
    ),
  );
  let done = 0;
  const started = Date.now();
  const ask = async (shop: StoreChain, term: string, key: string) => {
    try {
      raw[key] = (
        (await adapterFor(shop)?.search(term, searchStoreId(s, shop))) ?? []
      ).map(slim) as StoreProduct[];
    } catch (e) {
      errors[key] = e instanceof Error ? e.message : String(e);
    }
    await sleep(PAUSE_MS);
  };
  for (const { shop, word } of plan) {
    if (stopped()) break;
    onProgress({
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
      if (stopped()) break;
      const text = normaliseQuery(word);
      const shops = enabledIn(s.enabledChains, sec).filter(
        (c) => raw[`${c}|${word}`],
      );
      const scored = Object.fromEntries(
        shops.map((c) => [c, scoreAll({ text }, raw[`${c}|${word}`])]),
      );
      const kind = intendedKind({ text }, scored);
      if (!kind) continue;
      for (const shop of weakShops(scored) as StoreChain[]) {
        if (stopped()) break;
        onProgress({
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
    app: "restock",
    kind: "search-test",
    version: __APP_VERSION__,
    at: new Date().toISOString(),
    minutes: Math.round((Date.now() - started) / 60000),
    sections,
    every,
    stoppedEarly: stopped(),
    shops: [...new Set(plan.map((p) => p.shop))].map((id) => ({
      id,
      name: chainName(id),
    })),
    errors,
    scorecard: card,
    raw,
  };
  return { file, summary: card.split("\n\n")[0] };
}
