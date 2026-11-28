// 0.15.2: price checks on iPhone and iPad when Restock isn't on screen. iOS decides when an app may
// run in the background, so there are three ways, and the check carries on from where it got to
// whichever runs it (checkProgress.ts):
//
// - A short run now and then (Background App Refresh, about half a minute, when iOS chooses): after
//   the household sync, as many products as fit, when a check is owed or one was cut off.
// - A longer run at the set check time (4:00 am unless changed), while the phone is charging and on
//   Wi-Fi (not mobile data): the whole check, when iOS allows it. iOS picks the moment, usually
//   overnight, never before the set time.
// - A Check now carries on after leaving Restock, with its progress on the Lock Screen (iOS 26 and
//   later; earlier, it stops when Restock leaves the screen and carries on next time).
//
// The check itself is the same one as when Restock is open (check.ts checkBySearch), in the app's own
// code, so it reads the shops the same way. RestockBackground.swift is the iOS side.
import { autoChecks, checkPrices, iosCheckDue, unfinishedCheck } from '../lib/check';
import { getGroup, getKV, getSettings, putKV, readingsFor } from '../lib/db';
import { latestSlot, nextSlot, planOf } from '../lib/checkSchedule';
import { loadRecommendations } from '../lib/recs';
import { dealOption, localDay, worthAlerting, type Recommendation } from '../lib/verdict';
import { quiet } from '../lib/quietErrors';
import { RestockNative } from '../lib/sql/native';
import type { Settings } from '../types';
import { appleHere, RestockApple } from './apple';

/** Each is given a little less than iOS's own limit, so what was found is saved before it ends. */
const REFRESH_MS = 20_000;
/** How long before iOS's end a run stops (the save takes a moment). */
const MARGIN_MS = 3_000;

let stopAsked = false;
let listening = false;

/** Is a check owed now? `long`: the run at the set time (only once that time has passed and no check since). */
export async function checkOwed(s: Settings, kind: 'refresh' | 'long', now = Date.now()): Promise<boolean> {
  if (!autoChecks(s)) return false;
  if (await unfinishedCheck(now)) return true;
  if (kind === 'refresh') return iosCheckDue(s, now);
  const slot = latestSlot(planOf(s), now);
  const last = s.lastCheck ? Date.parse(s.lastCheck) : NaN;
  return slot !== undefined && (!Number.isFinite(last) || last < slot);
}

/** When to ask iOS for the longer run: the next set check time (none with automatic checks off). */
export function nextLongRun(s: Settings, now = Date.now()): number | undefined {
  return autoChecks(s) ? nextSlot(planOf(s), now) : undefined;
}

/** Runs a check in the background until `until` (or until iOS says stop). Says whether it finished. */
export async function runInBackground(kind: 'refresh' | 'long', until: number): Promise<boolean> {
  const s = await getSettings();
  if (!(await checkOwed(s, kind))) return true;
  // The longer run is for Wi-Fi, not mobile data (iOS only promises "online").
  if (kind === 'long' && (await RestockApple.netInfo().catch(() => ({ online: true, expensive: false }))).expensive) return false;
  stopAsked = false;
  const r = await checkPrices(undefined, { until, stop: () => stopAsked });
  if (r.complete) await alertDeals(s).catch(quiet('price check'));
  return !!r.complete;
}

/** Sets up the iOS side: once, when Restock starts on an iPhone or iPad. */
export function listen(): void {
  if (listening || !appleHere()) return;
  listening = true;
  void RestockApple.addListener('backgroundStop', () => void (stopAsked = true)).catch(quiet('price check'));
  void RestockApple.addListener('backgroundCheck', () => {
    // iOS gives minutes, not a set time: "backgroundStop" says when they're up.
    void runInBackground('long', Number.POSITIVE_INFINITY)
      .then(
        (ok) => RestockApple.backgroundCheckDone({ ok }),
        () => RestockApple.backgroundCheckDone({ ok: false }),
      )
      .catch(quiet('price check'));
  }).catch(quiet('price check'));
}

/** After the short background sync: as much of an owed check as fits in what's left of the half minute. */
export async function afterBackgroundSync(woke: number): Promise<void> {
  const until = woke + REFRESH_MS - MARGIN_MS;
  if (Date.now() >= until) return;
  await runInBackground('refresh', until);
}

/** What to tell iOS as Restock leaves the screen: when the next longer run may start. */
export async function scheduleNext(): Promise<void> {
  const s = await getSettings();
  await RestockApple.backgroundSchedule({ checkAt: nextLongRun(s) });
}

/**
 * A Check now that keeps going after Restock leaves the screen (iOS 26). Always answers: where iOS
 * doesn't allow it, the check runs as before (stopping when Restock does).
 */
export async function keepGoing(): Promise<{ progress(done: number, total: number): void; stopped(): boolean; end(): void }> {
  let started = false;
  let stopped = false;
  stopAsked = false;
  if (appleHere()) started = (await RestockApple.checkTaskStart({ total: 0 }).catch(() => ({ started: false }))).started;
  let last = 0;
  return {
    progress(done, total) {
      if (!started) return;
      // A few times a second at most: each is a call across to iOS.
      const now = Date.now();
      if (done < total && now - last < 300) return;
      last = now;
      void RestockApple.checkTaskProgress({ done, total }).catch(quiet('price check'));
    },
    stopped: () => (stopped ||= stopAsked && started),
    end() {
      if (started) void RestockApple.checkTaskEnd({ ok: !stopped }).catch(quiet('price check'));
    },
  };
}

// ---------- deal alerts after a check in the background (as Android's PriceChecker.alertDeals) ----------

/** This phone's alerts already sent (kept apart from Android's, which a phone never has both of). */
const SENT_KEY = 'iosNotified';

/** The day a price first showed, from the readings before it (so a week-long special alerts once). */
export function priceSince(readings: { date: string; price: number }[], cur: { date: string; price: number }): string {
  let since = cur.date;
  for (let i = readings.length - 1; i >= 0; i--) {
    const r = readings[i];
    if (r.date > cur.date) continue;
    if (Math.abs(r.price - cur.price) >= 0.005) break;
    since = r.date;
  }
  return localDay(since);
}

/** The new deals worth a notification: lines to show, and the keys that mark them as sent. */
async function newDeals(recs: Recommendation[], sent: Set<string>): Promise<{ lines: string[]; keys: string[]; items: string[] }> {
  const lines: string[] = [];
  const keys: string[] = [];
  const items: string[] = [];
  const deals = recs.filter(worthAlerting);
  const history = await readingsFor(deals.map((r) => dealOption(r)!.product.id));
  for (const rec of deals) {
    const o = dealOption(rec)!;
    const cur = o.stats.current;
    if (!cur || o.price === undefined) continue;
    const key = `${rec.group.id}:${o.product.id}:${o.price.toFixed(2)}:${priceSince(history.get(o.product.id) ?? [], cur)}`;
    if (sent.has(key)) continue;
    keys.push(key);
    items.push(rec.group.id);
    lines.push(`${rec.group.name}: ${rec.headline}`);
  }
  return { lines, keys, items };
}

async function alertDeals(s: Settings): Promise<void> {
  if (s.alerts?.greatDeals === false) return;
  const sent = (await getKV<string[]>(SENT_KEY).catch(() => undefined)) ?? [];
  const { lines, keys, items } = await newDeals(await loadRecommendations(), new Set(sent));
  if (!lines.length) return;
  await putKV(SENT_KEY, [...sent, ...keys].slice(-300));
  const one = new Set(items).size === 1 ? await getGroup(items[0]) : undefined;
  await RestockNative.notify({
    id: 7301,
    title: lines.length === 1 ? 'Worth grabbing' : `${lines.length} deals worth grabbing`,
    body: lines.slice(0, 4).join('\n'),
    action: one ? `item:${one.id}` : 'deals',
  });
}
