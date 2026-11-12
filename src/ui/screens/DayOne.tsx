import { useEffect, useState } from 'react';
import { confirmAction } from '../../lib/confirm';
import { pruneHistory, serverKeepsHistory } from '../../lib/db';
import { downloadMarket, megabytes, windowCost, windowIndex, type MarketDays, type WindowIndex } from '../../lib/market';
import { sharedOn } from '../../lib/priceShare';
import { SHARED_TITLE } from './SharedPrices';
import { afterSave, updateSettings } from '../../lib/settingsDraft';
import { isNative } from '../../stores/http';
import { keepDays, KEEP_WEEKS, historyLabel, type Settings } from '../../types';
import { Icon } from '../components';
import { useNav } from '../nav';

// 0.9.14: price history in one place (Settings → Prices and deals, and setup). How far back
// Restock looks (8 weeks, 6 months or 12 months) is one setting: how long this phone keeps the
// prices it reads, and, with Shared prices on (0.10.0, SharedPrices.tsx), how much shared history it gets.

const LENGTH_HELP: Record<number, string> = {
  8: 'Enough to know an everyday price.',
  26: 'Sees a few rounds of specials, so it knows a real one.',
  52: 'Catches once-a-year sales like Christmas and Easter.',
};

/** 8 weeks / 6 months / 12 months, with what each costs when shared history is on. */
export function HistoryLengths({ settings, onPicked }: { settings: Settings; onPicked?: (weeks: number) => void }) {
  const [index, setIndex] = useState<WindowIndex>();
  useEffect(() => {
    let alive = true;
    if (sharedOn(settings)) void windowIndex().then((v) => alive && setIndex(v));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.sharePrices]);
  const weeks = settings.historyWeeks;
  const pick = async (w: number) => {
    if (w === weeks) return;
    if (w < weeks) {
      // 0.9.2: with a Restock server, older prices move there instead of being deleted.
      const onServer = await serverKeepsHistory();
      const ok = await confirmAction(`Keep only ${historyLabel(w)} of prices on this phone?`, {
        detail: onServer
          ? `Prices older than ${historyLabel(w)} move to your Restock server, and come off this phone once it has them. Each item keeps its latest price.`
          : `Prices older than ${historyLabel(w)} are deleted from this phone once you save. Each item keeps its latest price, and sample items aren't touched.`,
        action: onServer ? 'Move older prices' : 'Delete older prices',
        danger: !onServer,
      });
      if (!ok) return;
    }
    await updateSettings({ historyWeeks: w, marketData: { ...settings.marketData, days: keepDays(w) } });
    await afterSave('history', async (s) => {
      await pruneHistory(s.historyWeeks);
    });
    onPicked?.(w);
  };
  return (
    <div role="radiogroup" aria-label="How far back Restock looks" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {KEEP_WEEKS.map((w) => {
        const cost = windowCost(keepDays(w) as MarketDays, settings.enabledChains, index);
        return (
          <label key={w} className="check" style={{ padding: '8px 0' }}>
            <input type="radio" name="history-weeks" checked={weeks === w} onChange={() => void pick(w)} />
            <span style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
              <span className="title" style={{ fontSize: 15 }}>
                {historyLabel(w)}
                {w === 8 ? ' (default)' : ''}
              </span>
              <span className="small">
                {LENGTH_HELP[w]}
                {sharedOn(settings) && cost.shops.length
                  ? ` Shared prices: ${cost.measured ? '' : 'about '}${megabytes(cost.download)} to download, about ${megabytes(cost.stored)} on this phone.`
                  : ''}
              </span>
            </span>
          </label>
        );
      })}
    </div>
  );
}

/** Settings → Prices and deals → Price history: how far back, and where Shared prices is. */
export function PriceHistorySettings({ settings }: { settings: Settings }) {
  const nav = useNav();
  const on = sharedOn(settings);
  return (
    <>
      <div className="card flush">
        <div style={{ padding: '12px 14px 4px' }}>
          <span className="title" style={{ fontSize: 15 }}>
            How far back Restock looks
          </span>
          <p className="small" style={{ margin: '4px 0 0' }}>
            Restock keeps the prices it reads for this long, and works out each item's usual price from them. With shared prices on, it's also how much
            shared history this phone gets. Longer knows sales better; it's only a few megabytes either way.
          </p>
        </div>
        <div style={{ padding: '0 14px 6px' }}>
          <HistoryLengths
            settings={settings}
            onPicked={() =>
              void afterSave('market-days', (s) => {
                if (sharedOn(s) && isNative()) void downloadMarket(undefined, { onlyUnmetered: s.marketData.wifiOnly }).catch(() => undefined);
              })
            }
          />
        </div>
      </div>
      <div className="card flush" id="s-dayone">
        <button className="row" onClick={() => nav.push({ name: 'settings', page: 'privacy' })}>
          <span className="grow">
            <span className="title">{SHARED_TITLE}</span>
            <span className="small">
              {on ? 'On' : 'Off'} · judges new items from day one, and shares the shop prices your phone reads (Privacy and sharing)
            </span>
          </span>
          <Icon name="chevron" size={18} />
        </button>
      </div>
    </>
  );
}
