import { useRef, useState } from 'react';
import { checkPrices, type CheckResult } from '../lib/check';
import { useLive } from '../lib/useLive';
import { RestockNative } from '../lib/sql/native';
import { syncInfo } from '../lib/sync';
import { isNative } from '../stores/http';
import { LoadingBar, usePullToRefresh } from './components';
import { useNav } from './nav';

// Pull down on Home, Pantry, Keg, Pharmacy or the shopping list for a full update (0.8.2): sync
// with the household, check prices, then sync again so the other phones get the new prices.

export type RefreshStage = 'sync' | 'prices' | 'share';

let running: Promise<void> | undefined;

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

/** `onChecked` gets the price check's result (Home uses it to show shops that didn't work). */
export function useFullRefresh(onChecked?: (res: CheckResult) => void) {
  const nav = useNav();
  const [stage, setStage] = useState<RefreshStage>();
  const [progress, setProgress] = useState<[number, number]>();
  // Only mention sync when this phone is in a household.
  const paired = !!useLive(() => syncInfo().catch(() => undefined), [])?.paired;
  const checkedRef = useRef(onChecked);
  checkedRef.current = onChecked;

  const run = () => {
    if (running) return;
    running = (async () => {
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

  const pull = usePullToRefresh(
    run,
    !!stage,
    paired ? 'Pull to sync and check prices' : 'Pull to check prices',
    paired ? 'Let go to sync and check prices' : 'Let go to check prices',
  );
  const status = stage ? (
    <div className="refresh-status" role="status">
      <span className="small">{refreshText(stage, progress)}</span>
      {stage === 'prices' && progress ? (
        <div className="progress">
          <div style={{ width: `${(progress[0] / Math.max(1, progress[1])) * 100}%` }} />
        </div>
      ) : (
        <LoadingBar seconds={stage === 'prices' ? 30 : 6} />
      )}
    </div>
  ) : null;
  return { props: pull.props, indicator: pull.indicator, status, run, busy: !!stage, stage, progress, paired };
}
