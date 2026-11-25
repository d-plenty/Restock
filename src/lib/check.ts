import { logProblem } from './diagnostics';
import { isPressOnlyShop, kindOf, priceSource, sectionOn, tabsOf, type StoreChain } from '../shops';
import { adapterFor } from '../stores';
import { isNative } from '../stores/http';
import type { Chain, Settings } from '../types';
import { addReading, allGroups, allProducts, getSettings, nowIso, readingsFor, refresh, updateProduct, updateSettings } from './db';
import { isIos } from './platform';
import { RestockNative } from './sql/native';
import { localDay } from './verdict';
import { background } from './undo';
import { quiet } from './quietErrors';

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

async function afterIosCheck(): Promise<void> {
  await RestockNative.sharePrices().catch(quiet('price check'));
  await (RestockNative as unknown as { marketMaybeRefresh?: () => Promise<void> }).marketMaybeRefresh?.().catch(quiet('price check'));
  refresh();
}

async function doCheck(onProgress?: (done: number, total: number) => void, opts?: { slot?: boolean }): Promise<CheckResult> {
  if (!isNative()) return { checked: 0, updated: 0, errors: {}, nativeOnly: true };
  // iPhone app: an iPhone has no background job to hand this to, so it's done here while Restock is open.
  if (isIos()) {
    try {
      const r = await checkBySearch(onProgress);
      await updateSettings({ lastCheck: nowIso() }).catch(quiet('price check'));
      // As Android does after its background check: send what was read, and get the shared history if there's something new.
      void afterIosCheck();
      return { ...r, nativeOnly: false };
    } finally {
      refresh();
    }
  }
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
  // iPhone app: iOS doesn't let an app run at a set time. Prices are checked when Restock is opened, when
  // the last check is older than IOS_CHECK_EVERY_HOURS (and automatic checks aren't switched off).
  if (isIos()) return { due: iosCheckDue(settings) };
  const r = await RestockNative.scheduleChecks({ enabled: settings.sync.backgroundActivity, intervalHours: settings.checkIntervalHours });
  // 0.9.11: and the price helper's half-hourly job (on only on a phone set up as one).
  await RestockNative.priceHelperSchedule?.().catch(quiet('price check'));
  return { due: !!r.due };
}

/** iPhone: how old the last check has to be before opening Restock checks again. */
export const IOS_CHECK_EVERY_HOURS = 12;
export function iosCheckDue(s: Pick<Settings, 'lastCheck' | 'sync' | 'checkDays'>, now = Date.now()): boolean {
  if (!s.sync.backgroundActivity || (s.checkDays && !s.checkDays.length)) return false;
  const last = s.lastCheck ? Date.parse(s.lastCheck) : NaN;
  return !Number.isFinite(last) || now - last >= IOS_CHECK_EVERY_HOURS * 3_600_000;
}

/**
 * iPhone: the price check itself. Each product you keep (in your pantry or a tab) is looked up
 * the way adding it found it: a search of its shop for its own name, and the same product picked out
 * of the results. Android asks each shop for the product directly, in its background job; this is
 * the same idea refreshPagelessProducts already uses for products with no page of their own. One
 * shop at a time, one product after another, so no shop gets a burst of requests.
 */
export async function checkBySearch(onProgress?: (done: number, total: number) => void, limit = 400): Promise<{ checked: number; updated: number; errors: Partial<Record<Chain, string>> }> {
  const settings = await getSettings();
  const sources = settings.enabledChains.map(priceSource);
  const [products, groups] = await Promise.all([allProducts(), allGroups()]);
  const kept = new Set<string>();
  for (const g of groups) for (const id of [g.usualProductId, ...g.sameProductIds, ...g.altProductIds]) if (id) kept.add(id);
  const todo = products
    .filter((p) => kept.has(p.id) && p.chain !== 'other' && !!p.storeProductId && !isPressOnlyShop(p.chain) && sources.includes(p.chain as StoreChain) && !!adapterFor(p.chain))
    .slice(0, limit);
  const errors: Partial<Record<Chain, string>> = {};
  if (!todo.length) return { checked: 0, updated: 0, errors };
  const last = await readingsFor(todo.map((p) => p.id));
  let checked = 0;
  let updated = 0;
  let done = 0;
  const failed = new Map<Chain, number>();
  onProgress?.(0, todo.length);
  for (const p of todo) {
    done++;
    // A shop that has turned away three in a row isn't asked again this time.
    if ((failed.get(p.chain) ?? 0) >= 3) {
      onProgress?.(done, todo.length);
      continue;
    }
    try {
      const hit = (await adapterFor(p.chain)!.search(p.name)).find((x) => x.storeProductId === p.storeProductId);
      failed.set(p.chain, 0);
      checked++;
      if (hit?.imageUrl && !p.imageUrl) await background(() => updateProduct(p.id, { imageUrl: hit.imageUrl })).catch(quiet('price check'));
      if (hit && hit.price !== undefined) {
        const prev = (last.get(p.id) ?? []).slice(-1)[0];
        if (!(prev && localDay(prev.date) === localDay(nowIso()) && prev.price === hit.price)) {
          await background(() => addReading({ productId: p.id, date: nowIso(), price: hit.price!, wasPrice: hit.wasPrice, isSpecial: hit.isSpecial, memberOnly: hit.memberOnly, promo: hit.promo, source: 'auto' }));
          updated++;
        }
      }
    } catch (e) {
      failed.set(p.chain, (failed.get(p.chain) ?? 0) + 1);
      const msg = e instanceof Error ? e.message : String(e);
      if (!errors[p.chain]) errors[p.chain] = msg;
      void logProblem(p.chain as StoreChain, 'price check', msg);
    }
    onProgress?.(done, todo.length);
  }
  return { checked, updated, errors };
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
      // 0.12.10: a product saved before its shop's photos could be read gets its photo now.
      if (hit?.imageUrl && !p.imageUrl) await background(() => updateProduct(p.id, { imageUrl: hit.imageUrl })).catch(quiet('price check'));
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
