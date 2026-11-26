import { logProblem } from './diagnostics';
import { isPressOnlyShop, kindOf, priceSource, sectionOn, tabsOf, type StoreChain } from '../shops';
import { adapterFor } from '../stores';
import { isNative } from '../stores/http';
import type { Chain, Settings } from '../types';
import { allGroups, allProducts, getSettings, nowIso, readingsFor, refresh, saveFindings, updateSettings } from './db';
import type { PriceReading } from '../types';
import { isIos } from './platform';
import { RestockNative } from './sql/native';
import { localDay } from './verdict';
import { background } from './undo';
import { quiet } from './quietErrors';
import { carryOn, PROGRESS_KEY, readProgress } from './checkProgress';

// Price checks run in the app's native Android code (PriceCheckWorker.java), both for
// "Check now" and for the background schedule, so there's one implementation.

export interface CheckResult {
  checked: number;
  updated: number;
  errors: Partial<Record<Chain, string>>;
  nativeOnly: boolean;
  /** 0.15.2 (iPhone): false when the check stopped before the end (it carries on next time). */
  complete?: boolean;
}

export interface CheckOptions {
  /** Android: the scheduled check for the latest slot (the catch-up when Restock opens). */
  slot?: boolean;
  /** 0.15.2, iPhone: someone pressed Check now (so it may carry on after Restock leaves the screen). */
  byHand?: boolean;
  /** 0.15.2, iPhone: stop by then (ms), as a check in the background must. */
  until?: number;
  /** 0.15.2, iPhone: stop now (iOS has said the time's up). */
  stop?: () => boolean;
}

let running: Promise<CheckResult> | undefined;

export function checkPrices(onProgress?: (done: number, total: number) => void, opts?: CheckOptions): Promise<CheckResult> {
  if (!running) running = doCheck(onProgress, opts).finally(() => (running = undefined));
  return running;
}

async function afterIosCheck(): Promise<void> {
  await RestockNative.sharePrices().catch(quiet('price check'));
  await (RestockNative as unknown as { marketMaybeRefresh?: () => Promise<void> }).marketMaybeRefresh?.().catch(quiet('price check'));
  refresh();
}

async function doCheck(onProgress?: (done: number, total: number) => void, opts?: CheckOptions): Promise<CheckResult> {
  if (!isNative()) return { checked: 0, updated: 0, errors: {}, nativeOnly: true };
  // iPhone app: the check runs in the app's own code, while Restock is open or when iOS gives it time
  // in the background (0.15.2: ios/backgroundCheck.ts). One that stops part way carries on next time.
  if (isIos()) {
    // 0.15.2: a Check now keeps going when Restock leaves the screen, where iOS allows it (iOS 26).
    const task = opts?.byHand ? await import('../ios/backgroundCheck').then((m) => m.keepGoing()).catch(() => undefined) : undefined;
    try {
      const r = await checkBySearch(
        (done, total) => {
          onProgress?.(done, total);
          task?.progress(done, total);
        },
        undefined,
        { until: opts?.until, stop: () => !!opts?.stop?.() || !!task?.stopped() },
      );
      if (r.complete) {
        await updateSettings({ lastCheck: nowIso() }).catch(quiet('price check'));
        // As Android does after its background check: send what was read, and get the shared history if there's something new.
        void afterIosCheck();
      }
      return { ...r, nativeOnly: false };
    } finally {
      task?.end();
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
  // 0.15.2: or a check was cut off less than a day ago: it carries on.
  if (isIos()) return { due: iosCheckDue(settings) || (autoChecks(settings) && (await unfinishedCheck())) };
  const r = await RestockNative.scheduleChecks({ enabled: settings.sync.backgroundActivity, intervalHours: settings.checkIntervalHours });
  // 0.9.11: and the price helper's half-hourly job (on only on a phone set up as one).
  await RestockNative.priceHelperSchedule?.().catch(quiet('price check'));
  return { due: !!r.due };
}

/** iPhone: how old the last check has to be before opening Restock checks again. */
export const IOS_CHECK_EVERY_HOURS = 12;
/** Automatic checks are on (not switched off, and not "only when I press Check now"). */
export const autoChecks = (s: Pick<Settings, 'sync' | 'checkDays'>): boolean => s.sync.backgroundActivity && !(s.checkDays && !s.checkDays.length);

/** 0.15.2: a check that was cut off less than a day ago, to carry on with. */
export async function unfinishedCheck(now = Date.now()): Promise<boolean> {
  const was = await readProgress();
  return !!was && carryOn(was, now).started === was.started;
}

export function iosCheckDue(s: Pick<Settings, 'lastCheck' | 'sync' | 'checkDays'>, now = Date.now()): boolean {
  if (!autoChecks(s)) return false;
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
export async function checkBySearch(
  onProgress?: (done: number, total: number) => void,
  limit = 400,
  opts: Pick<CheckOptions, 'until' | 'stop'> = {},
): Promise<{ checked: number; updated: number; errors: Partial<Record<Chain, string>>; complete: boolean }> {
  const settings = await getSettings();
  const sources = settings.enabledChains.map(priceSource);
  const [products, groups] = await Promise.all([allProducts(), allGroups()]);
  const kept = new Set<string>();
  for (const g of groups) for (const id of [g.usualProductId, ...g.sameProductIds, ...g.altProductIds]) if (id) kept.add(id);
  const all = products
    .filter((p) => kept.has(p.id) && p.chain !== 'other' && !!p.storeProductId && !isPressOnlyShop(p.chain) && sources.includes(p.chain as StoreChain) && !!adapterFor(p.chain))
    .slice(0, limit);
  const errors: Partial<Record<Chain, string>> = {};
  if (!all.length) return { checked: 0, updated: 0, errors, complete: true };
  // 0.15.2: carry on from where a check that was cut off got to (less than a day ago: checkProgress.ts).
  const progress = carryOn(await readProgress());
  const already = new Set(progress.done);
  const todo = all.filter((p) => !already.has(p.id));
  const total = all.length;
  const last = await readingsFor(todo.map((p) => p.id));
  let checked = 0;
  let updated = 0;
  let done = total - todo.length;
  const failed = new Map<Chain, number>();
  let finished = false;
  // Saved with each lot of prices; once finished, cleared, so the next check starts from the beginning.
  const found = findings(() => ({ key: PROGRESS_KEY, value: finished ? null : progress }));
  onProgress?.(done, total);
  const timeUp = () => !!opts.stop?.() || (opts.until !== undefined && Date.now() >= opts.until);
  try {
    for (const p of todo) {
      // 0.15.2: time's up (in the background): what's done is saved, and the rest is checked next time.
      if (timeUp()) break;
      done++;
      // A shop that has turned away three in a row isn't asked again this time (nor marked done: next time it is).
      if ((failed.get(p.chain) ?? 0) >= 3) {
        onProgress?.(done, total);
        continue;
      }
      try {
        const hit = (await adapterFor(p.chain)!.search(p.name)).find((x) => x.storeProductId === p.storeProductId);
        failed.set(p.chain, 0);
        checked++;
        // Done (a shop that didn't answer isn't: carrying on asks it again).
        progress.done.push(p.id);
        if (hit?.imageUrl && !p.imageUrl) found.photo(p.id, hit.imageUrl);
        if (hit && hit.price !== undefined) {
          const prev = (last.get(p.id) ?? []).slice(-1)[0];
          if (!(prev && localDay(prev.date) === localDay(nowIso()) && prev.price === hit.price)) {
            found.price({ productId: p.id, date: nowIso(), price: hit.price, wasPrice: hit.wasPrice, isSpecial: hit.isSpecial, memberOnly: hit.memberOnly, promo: hit.promo, source: 'auto' });
            updated++;
          }
        }
      } catch (e) {
        failed.set(p.chain, (failed.get(p.chain) ?? 0) + 1);
        const msg = e instanceof Error ? e.message : String(e);
        if (!errors[p.chain]) errors[p.chain] = msg;
        void logProblem(p.chain as StoreChain, 'price check', msg);
      }
      await found.next();
      onProgress?.(done, total);
    }
    finished = done >= total;
  } finally {
    // Cut off (an error, or iOS stopping it): what was found is saved with how far it got.
    await found.save();
  }
  return { checked, updated, errors, complete: finished };
}

/** 0.15.2: how many products a check reads before saving what it found (one write, one refresh of the screens). */
export const SAVE_EVERY = 20;

/** What a check has found and not saved yet: saved every SAVE_EVERY products and at the end, with `note` if given. */
export function findings(note?: () => { key: string; value: unknown }) {
  let readings: Omit<PriceReading, 'id'>[] = [];
  let photos: { id: string; imageUrl: string }[] = [];
  let seen = 0;
  const save = async () => {
    const n = note?.();
    if (!readings.length && !photos.length && !n) return;
    const r = readings;
    const ph = photos;
    readings = [];
    photos = [];
    // 0.9.5 (final review): a price check is never part of an action someone is doing.
    await background(() => saveFindings(r, ph, n)).catch(quiet('price check'));
  };
  return {
    price: (r: Omit<PriceReading, 'id'>) => void readings.push(r),
    photo: (id: string, imageUrl: string) => void photos.push({ id, imageUrl }),
    /** One product read: saves when SAVE_EVERY have been. */
    async next() {
      if (++seen % SAVE_EVERY === 0) await save();
    },
    save,
  };
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
  const found = findings();
  try {
    for (const p of todo) {
      try {
        const hit = (await adapterFor(p.chain)!.search(p.name)).find((x) => x.storeProductId === p.storeProductId);
        checked++;
        // 0.12.10: a product saved before its shop's photos could be read gets its photo now.
        if (hit?.imageUrl && !p.imageUrl) found.photo(p.id, hit.imageUrl);
        if (!hit || hit.price === undefined) continue;
        const prev = (last.get(p.id) ?? []).slice(-1)[0];
        // Same day on the phone's own calendar, not UTC's (verdict.ts localDay).
        if (prev && localDay(prev.date) === localDay(nowIso()) && prev.price === hit.price) continue;
        // 0.10.7: stock isn't kept from price checks any more: only "Check stock" on the list asks.
        found.price({ productId: p.id, date: nowIso(), price: hit.price, wasPrice: hit.wasPrice, isSpecial: hit.isSpecial, memberOnly: hit.memberOnly, promo: hit.promo, source: 'auto' });
        updated++;
      } catch {
        // that shop isn't answering; the next check tries again
      } finally {
        await found.next();
      }
    }
  } finally {
    // 0.15.2: in lots, as checkBySearch does.
    await found.save();
  }
  return { checked, updated };
}
