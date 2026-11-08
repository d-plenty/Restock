import { useState } from 'react';
import { checkPrices } from '../lib/check';
import { RestockNative } from '../lib/sql/native';
import { syncInfo } from '../lib/sync';
import { isNative } from '../stores/http';
import { LoadingBar, usePullToRefresh } from './components';
import { useNav } from './nav';

// Pull down on Home, Pantry, Keg, Pharmacy or the shopping list for a full update (0.8.2): sync
// with the household, check prices, then sync again so the other phones get the new prices.

export type RefreshStage = 'sync' | 'prices' | 'share';

let running: Promise<void> | undefined;

export function useFullRefresh() {
  const nav = useNav();
  const [stage, setStage] = useState<RefreshStage>();
  const [progress, setProgress] = useState<[number, number]>();

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
      if (sync?.paired && res.updated > 0) {
        setStage('share');
        await RestockNative.syncNow().catch(() => undefined);
      }
      const bits = [
        sync?.paired
          ? synced
            ? `Synced with ${synced === 1 ? 'your household' : `${synced} phones`}`
            : "Couldn't find the household's other phones"
          : undefined,
        res.checked ? `checked ${res.checked} price${res.checked === 1 ? '' : 's'}, ${res.updated} updated` : undefined,
      ].filter(Boolean);
      nav.toast(bits.length ? bits.join(' · ').replace(/^./, (c) => c.toUpperCase()) : 'Up to date');
    })().finally(() => {
      running = undefined;
      setStage(undefined);
      setProgress(undefined);
    });
  };

  const pull = usePullToRefresh(run, !!stage, 'Pull to sync and check prices', 'Let go to sync and check prices');
  const status = stage ? (
    <div className="refresh-status" role="status">
      <span className="small">
        {stage === 'sync'
          ? 'Syncing with your household…'
          : stage === 'share'
            ? 'Sharing the new prices with your household…'
            : progress
              ? `Checking prices… ${progress[0]} of ${progress[1]}`
              : 'Checking prices…'}
      </span>
      {stage === 'prices' && progress ? (
        <div className="progress">
          <div style={{ width: `${(progress[0] / Math.max(1, progress[1])) * 100}%` }} />
        </div>
      ) : (
        <LoadingBar seconds={stage === 'prices' ? 30 : 6} />
      )}
    </div>
  ) : null;
  return { props: pull.props, indicator: pull.indicator, status, run, busy: !!stage };
}
