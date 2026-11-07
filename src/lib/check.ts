import { logProblem } from './diagnostics';
import { kindOf, sectionOn, sectionOf, type StoreChain } from '../shops';
import { adapterFor } from '../stores';
import { isNative } from '../stores/http';
import type { Chain, Settings } from '../types';
import { addReading, allProducts, getSettings, nowIso, readingsFor, refresh, updateProduct } from './db';
import { RestockNative } from './sql/native';

// Price checks run in the app's native Android code (PriceCheckWorker.java), both for
// "Check now" and for the background schedule, so there's one implementation.

export interface CheckResult {
  checked: number;
  updated: number;
  errors: Partial<Record<Chain, string>>;
  nativeOnly: boolean;
}

let running: Promise<CheckResult> | undefined;

export function checkPrices(onProgress?: (done: number, total: number) => void): Promise<CheckResult> {
  if (!running) running = doCheck(onProgress).finally(() => (running = undefined));
  return running;
}

async function doCheck(onProgress?: (done: number, total: number) => void): Promise<CheckResult> {
  if (!isNative()) return { checked: 0, updated: 0, errors: {}, nativeOnly: true };
  const handle = await RestockNative.addListener('checkProgress', (e) => onProgress?.(e.done, e.total));
  try {
    const r = await RestockNative.checkNow();
    const extra = await refreshPagelessProducts().catch(() => ({ checked: 0, updated: 0 }));
    for (const [chain, msg] of Object.entries(r.errors ?? {})) if (msg) void logProblem(chain as StoreChain, 'price check', String(msg));
    return { checked: r.checked + extra.checked, updated: r.updated + extra.updated, errors: r.errors as CheckResult['errors'], nativeOnly: false };
  } finally {
    await handle.remove();
    refresh();
  }
}

/** Keep Android's background schedule in step with the "Allow background activity" setting. */
export async function syncBackgroundSchedule(settings: Settings): Promise<void> {
  if (!isNative()) return;
  await RestockNative.scheduleChecks({ enabled: settings.sync.backgroundActivity, intervalHours: settings.checkIntervalHours });
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
  const todo = (await allProducts())
    .filter(
      (p) =>
        isPageless(p.chain, p.storeProductId) && settings.enabledChains.includes(p.chain as StoreChain) && sectionOn(settings, sectionOf(p.chain)),
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
      const today = nowIso().slice(0, 10);
      if (prev && prev.date.slice(0, 10) === today && prev.price === hit.price) continue;
      await addReading({
        productId: p.id,
        date: nowIso(),
        price: hit.price,
        wasPrice: hit.wasPrice,
        isSpecial: hit.isSpecial,
        memberOnly: hit.memberOnly,
        promo: hit.promo,
        source: 'auto',
      });
      if (hit.inStock !== undefined) await updateProduct(p.id, { inStock: hit.inStock, stockAt: nowIso() });
      updated++;
    } catch {
      // that shop isn't answering; the next check tries again
    }
  }
  return { checked, updated };
}
