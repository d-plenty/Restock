import { useLatest } from './useLatest';
import { useEffect, useSyncExternalStore } from 'react';
import { checkPrices, type CheckResult } from '../lib/check';
import { useLive } from '../lib/useLive';
import { RestockNative } from '../lib/sql/native';
import { syncInfo } from '../lib/sync';
import { isNative } from '../stores/http';
import { LoadingBar, usePullToRefresh } from './components';
import { useNav } from './nav';
import { serverMode, serverUi } from '../server-mode/flag';

// Check now on Home does a full update (0.8.2): sync with the household, check prices, then sync
// again so the other phones get the new prices. Pulling down on Home, Pantry, Keg, Pharmacy or
// the shopping list only syncs (0.8.8): a pull is easy to do by accident, and every price check
// asks each shop about each item.

export type RefreshStage = 'sync' | 'prices' | 'share';

let running: Promise<void> | undefined;

// 0.11.1: what a refresh is doing is kept here, not in the screen that started it. Before, it was
// Home's own: leaving Home threw it away, and coming back showed "Prices updated Wednesday" while
// the check was still going, as if it had been cancelled. Now every screen that shows it (Home,
// and the slim line on every other screen, 0.12.9) reads the same thing, for as long as it runs.
interface RefreshLive {
  stage?: RefreshStage;
  progress?: [number, number];
}
let live: RefreshLive = {};
const watchers = new Set<() => void>();
function setLive(patch: RefreshLive): void {
  live = { ...live, ...patch };
  for (const w of watchers) w();
}
const watch = (fn: () => void) => {
  watchers.add(fn);
  return () => watchers.delete(fn);
};
/** What a refresh is doing right now, on any screen. */
const useRefreshLive = (): RefreshLive => useSyncExternalStore(watch, () => live);

/**
 * A price check started somewhere other than Check now (the catch-up when Restock opens): shows
 * its progress like any other. Does nothing extra when a refresh is already showing.
 */
export async function trackCheck(opts?: { slot?: boolean }): Promise<CheckResult> {
  const mine = !live.stage;
  if (mine) setLive({ stage: 'prices', progress: undefined });
  try {
    return await checkPrices((d, t) => mine && setLive({ progress: [d, t] }), opts);
  } finally {
    if (mine) setLive({ stage: undefined, progress: undefined });
  }
}

/**
 * 0.12.9: one slim line under the clock, the same on every screen but Home (which shows the check in
 * its own top), while a sync or price check runs. It was a card above each page's navy top, which
 * hid under the status bar and pushed the page down; on More it didn't show at all. The page moves
 * down by this one line (--check-h) and no more.
 */
export function CheckLine() {
  const { stage, progress } = useRefreshLive();
  useEffect(() => {
    if (!stage) return;
    document.documentElement.classList.add('checking');
    return () => document.documentElement.classList.remove('checking');
  }, [stage]);
  if (!stage) return null;
  return (
    <div className="check-line" role="status">
      <span>{refreshText(stage, progress)}</span>
      {stage === 'prices' && progress ? (
        <div className="progress">
          <div style={{ width: `${(progress[0] / Math.max(1, progress[1])) * 100}%` }} />
        </div>
      ) : (
        <LoadingBar seconds={stage === 'prices' ? 30 : 6} />
      )}
    </div>
  );
}

/** What's happening, for the line under the pull (Home shows it in its own spot). */
export function refreshText(stage: RefreshStage, progress?: [number, number]): string {
  return stage === 'sync'
    ? 'Syncing with your household…'
    : stage === 'share'
      ? 'Sharing the new prices with your household…'
      : progress
        ? `Checking prices… ${progress[0]} of ${progress[1]}`
        : 'Checking prices…';
}

async function serverRefresh(setStage: (s: RefreshStage | undefined) => void, toast: (m: string) => void): Promise<void> {
  setStage('sync');
  if (serverUi.current) toast(await serverUi.current.refresh());
}

/** `onChecked` gets the price check's result (Home uses it to show shops that didn't work). */
export function useFullRefresh(onChecked?: (res: CheckResult) => void) {
  const nav = useNav();
  const { stage, progress } = useRefreshLive();
  const setStage = (s: RefreshStage | undefined) => setLive({ stage: s });
  const setProgress = (p: [number, number] | undefined) => setLive({ progress: p });
  // Only mention sync when this phone is in a household.
  const paired = !!useLive(() => syncInfo().catch(() => undefined), [])?.paired || serverMode;
  const checkedRef = useLatest(onChecked);

  const run = () => {
    if (running) return;
    running = (async () => {
      // On a Restock server: get the phones' latest (prices are checked on the phones).
      if (serverMode) return serverRefresh(setStage, nav.toast);
      if (!isNative()) {
        nav.toast('Prices and sync work in the Android app.');
        return;
      }
      const sync = await syncInfo().catch(() => undefined);
      let synced = 0;
      if (sync?.paired) {
        setStage('sync');
        const r = await RestockNative.syncNow().catch(() => undefined);
        synced = r?.reached ?? 0;
      }
      setStage('prices');
      setProgress(undefined);
      const res = await checkPrices((d, t) => setProgress([d, t]));
      checkedRef.current?.(res);
      if (sync?.paired && res.updated > 0) {
        setStage('share');
        await RestockNative.syncNow().catch(() => undefined);
      }
      const tried = res.checked > 0 || Object.keys(res.errors).length > 0;
      const bits = [
        sync?.paired
          ? synced
            ? `Synced with ${synced === 1 ? 'your household' : `${synced} phones`}`
            : "Couldn't find the household's other phones"
          : undefined,
        tried ? `checked ${res.checked} price${res.checked === 1 ? '' : 's'} · ${res.updated} updated` : undefined,
      ].filter(Boolean);
      nav.toast(bits.length ? bits.join(' · ').replace(/^./, (c) => c.toUpperCase()) : 'Nothing to check yet. Add items with a shop match first.');
    })().finally(() => {
      running = undefined;
      setStage(undefined);
      setProgress(undefined);
    });
  };

  /** Just syncs with the household's other phones. */
  const syncOnly = () => {
    if (running) return;
    running = (async () => {
      if (serverMode) return serverRefresh(setStage, nav.toast);
      if (!isNative()) return;
      setStage('sync');
      const r = await RestockNative.syncNow().catch(() => undefined);
      nav.toast(r?.reached ? `Synced with ${r.reached === 1 ? 'your household' : `${r.reached} phones`}` : "Couldn't find the household's other phones");
    })().finally(() => {
      running = undefined;
      setStage(undefined);
    });
  };

  // Not in a household: pulling does nothing at all.
  const pull = usePullToRefresh(syncOnly, !!stage || !paired, 'Pull to sync with your household', 'Let go to sync');
  return { props: pull.props, indicator: pull.indicator, run, busy: !!stage, stage, progress, paired };
}
