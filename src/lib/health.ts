import { adapterFor } from '../stores';
import type { Chain } from '../types';
import { isLocalOnlyShop, kindOf, sectionOf } from '../shops';
import { getKV, putKV } from './db';

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

export interface ConnectionTest {
  chain: StoreChain;
  ok: boolean;
  count?: number;
  ms: number;
  error?: string;
}

/** Try a real search at each store, like adding an item would. */
export async function testConnections(chains: StoreChain[], storeIds: Partial<Record<StoreChain, string | undefined>>): Promise<ConnectionTest[]> {
  const results = await Promise.all(
    // 0.9.6: never Costco: it is only searched one page at a time, when a person presses Search.
    chains.filter((c) => !isLocalOnlyShop(c)).map(async (chain): Promise<ConnectionTest> => {
      const t0 = Date.now();
      const word = { pantry: 'milk', keg: 'beer', pharmacy: 'paracetamol' }[sectionOf(chain)];
      try {
        // Shop websites read through the hidden browser can take a while to draw.
        const items = await withTimeout(adapterFor(chain)!.search(word, storeIds[chain]), kindOf(chain) === 'web' ? 75_000 : 30_000);
        if (!items.length) return { chain, ok: false, ms: Date.now() - t0, error: `The shop answered but found nothing for "${word}"` };
        return { chain, ok: true, count: items.length, ms: Date.now() - t0 };
      } catch (e) {
        return { chain, ok: false, ms: Date.now() - t0, error: e instanceof Error ? e.message : String(e) };
      }
    }),
  );
  await recordHealth(Object.fromEntries(results.map((r) => [r.chain, r.ok ? null : (r.error ?? 'failed')])));
  return results;
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
