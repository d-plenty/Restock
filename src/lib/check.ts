import { logProblem } from './diagnostics';
import { isPressOnlyShop, kindOf, priceSource, sectionOn, tabsOf, type StoreChain } from '../shops';
import { adapterFor } from '../stores';
import { isNative } from '../stores/http';
import type { Chain, Settings } from '../types';
import { addReading, allProducts, getSettings, nowIso, readingsFor, refresh } from './db';
import { RestockNative } from './sql/native';
import { localDay } from './verdict';
import { background } from './undo';

// Price checks run in the app's native Android code (PriceCheckWorker.java), both for
// "Check now" and for the background schedule, so there's one implementation.

export interface CheckResult {
  checked: number;
  updated: number;
  errors: Partial<Record<Chain, string>>;
  nativeOnly: boolean;
}

let running: Promise<CheckResult> | undefined;

export function checkPrices(onProgress?: (done: number, total: number) => void, opts?: { slot?: boolean }): Promise<CheckResult> {
  if (!running) running = doCheck(onProgress, opts).finally(() => (running = undefined));
  return running;
}

async function doCheck(onProgress?: (done: number, total: number) => void, opts?: { slot?: boolean }): Promise<CheckResult> {
  if (!isNative()) return { checked: 0, updated: 0, errors: {}, nativeOnly: true };
  const handle = await RestockNative.addListener('checkProgress', (e) => onProgress?.(e.done, e.total));
  try {
    const r = await RestockNative.checkNow(opts?.slot ? { slot: true } : undefined);
    const extra = await refreshPagelessProducts().catch(() => ({ checked: 0, updated: 0 }));
    for (const [chain, msg] of Object.entries(r.errors ?? {})) if (msg) void logProblem(chain as StoreChain, 'price check', String(msg));
    return { checked: r.checked + extra.checked, updated: r.updated + extra.updated, errors: r.errors as CheckResult['errors'], nativeOnly: false };
  } finally {
    await handle.remove();
    refresh();
  }
}

/**
 * Keep Android's background schedule in step with the "Allow background activity" setting and the
 * price check time (0.9.6: a set time of day, default 5:00 am). Says whether a set time passed with
 * no check (the phone was off), so Restock can run one when it opens.
 */
export async function syncBackgroundSchedule(settings: Settings): Promise<{ due: boolean }> {
  if (!isNative()) return { due: false };
  const r = await RestockNative.scheduleChecks({ enabled: settings.sync.backgroundActivity, intervalHours: settings.checkIntervalHours });
  // 0.9.11: and the price helper's half-hourly job (on only on a phone set up as one).
  await RestockNative.priceHelperSchedule?.().catch(() => undefined);
  return { due: !!r.due };
}

/** A shop product with no product page of its own to check (found in a page's data, not a link). */
export const isPageless = (chain: Chain, storeProductId?: string) =>
  chain !== 'other' && kindOf(chain) === 'web' && !!storeProductId && !/^https?:\/\/[^#]+$/.test(storeProductId);

/**
 * Products from shop websites that only showed up in search results (no product page to open)
 * can't be checked in the background, so "Check now" searches for them by name instead and
 * picks the same product out of the results.
 */
async function refreshPagelessProducts(limit = 30): Promise<{ checked: number; updated: number }> {
  const settings = await getSettings();
  const sources = settings.enabledChains.map(priceSource);
  const todo = (await allProducts())
    .filter(
      (p) =>
        // A product is saved under the shop whose website has its price (My Chemist's under Chemist Warehouse).
        // 0.9.6 (review L1): never Costco ("Check at Costco" on the item is the only way, costcoCheck.ts).
        !isPressOnlyShop(p.chain) && isPageless(p.chain, p.storeProductId) && sources.includes(p.chain as StoreChain) && tabsOf(p.chain, settings.shopTabs ?? {}).some((t) => sectionOn(settings, t)),
    )
    .slice(0, limit);
  if (!todo.length) return { checked: 0, updated: 0 };
  const last = await readingsFor(todo.map((p) => p.id));
  let checked = 0;
  let updated = 0;
  for (const p of todo) {
    try {
      const hit = (await adapterFor(p.chain)!.search(p.name)).find((x) => x.storeProductId === p.storeProductId);
      checked++;
      if (!hit || hit.price === undefined) continue;
      const prev = (last.get(p.id) ?? []).slice(-1)[0];
      // Same day on the phone's own calendar, not UTC's (verdict.ts localDay).
      if (prev && localDay(prev.date) === localDay(nowIso()) && prev.price === hit.price) continue;
      // 0.9.5 (final review): a price check is never part of an action someone is doing.
      await background(async () => {
        await addReading({
          productId: p.id,
          date: nowIso(),
          price: hit.price!,
          wasPrice: hit.wasPrice,
          isSpecial: hit.isSpecial,
          memberOnly: hit.memberOnly,
          promo: hit.promo,
          source: 'auto',
        });
        // 0.10.7: stock isn't kept from price checks any more: only "Check stock" on the list asks.
      });
      updated++;
    } catch {
      // that shop isn't answering; the next check tries again
    }
  }
  return { checked, updated };
}
