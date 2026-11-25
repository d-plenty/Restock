import { useEffect, useState } from 'react';
import { confirmAction } from '../../lib/confirm';
import { pruneHistory, serverKeepsHistory } from '../../lib/db';
import { downloadMarket, megabytes, windowCost, windowIndex, type MarketDays, type WindowIndex } from '../../lib/market';
import { sharedOn } from '../../lib/priceShare';
import { pruneSeen, seenCount, seenKeepWeeks } from '../../lib/seen';
import { useLive } from '../../lib/useLive';
import { serverMode } from '../../server-mode/flag';
import { SHARED_TITLE } from './SharedPrices';
import { afterSave, updateSettings } from '../../lib/settingsDraft';
import { isNative } from '../../stores/http';
import { keepDays, KEEP_WEEKS, historyLabel, type Settings } from '../../types';
import { Icon, More } from '../components';
import { useNav } from '../nav';

// 0.9.14: price history in one place (Settings → Prices and deals, and setup). How far back
// Restock looks (8 weeks, 6 months or 12 months) is one setting: how long this phone keeps the
// prices it reads, and, with Shared prices on (0.10.0, SharedPrices.tsx), how much shared history it gets.

const LENGTH_HELP: Record<number, string> = {
  8: 'Enough to know an everyday price.',
  26: 'Sees a few rounds of specials, so it knows a real one.',
  39: 'Most of a year of specials. Shared prices come as the 12-month set.',
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
          : `Prices older than ${historyLabel(w)} are deleted from this phone once you save${settings.searchKeepWeeks === undefined ? ', and so are search results older than that' : ''}. Each item keeps its latest price, and sample items aren't touched.`,
        action: onServer ? 'Move older prices' : 'Delete older prices',
        danger: !onServer,
      });
      if (!ok) return;
    }
    await updateSettings({ historyWeeks: w, marketData: { ...settings.marketData, days: keepDays(w) } });
    await afterSave('history', async (s) => {
      await pruneHistory(s.historyWeeks);
      // 0.11.0: what searches found follows (unless it has a time of its own)
      await pruneSeen(s);
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

/**
 * 0.11.0: what searches found (lib/seen.ts): what it's for, how much is kept, and "Keep search
 * results for a different time" (otherwise it follows the price history above). On the web page
 * it's greyed: searching the shops and remembering it happens on the phones.
 */
export function SearchKeepSettings({ settings }: { settings: Settings }) {
  const count = useLive(() => seenCount(), []);
  const own = settings.searchKeepWeeks !== undefined;
  const weeks = seenKeepWeeks(settings);
  const save = async (w: number | undefined) => {
    if (w !== undefined && w < weeks) {
      const ok = await confirmAction(`Keep only ${historyLabel(w)} of search results?`, {
        detail: `Search results older than ${historyLabel(w)} are deleted from this phone once you save. Your pantry's prices aren't touched.`,
        action: 'Delete older search results',
        danger: true,
      });
      if (!ok) return;
    }
    await updateSettings({ searchKeepWeeks: w });
    await afterSave('search-keep', async (s) => {
      await pruneSeen(s);
    });
  };
  return (
    <div className="card flush" id="s-searchkeep" aria-disabled={serverMode || undefined}>
      <div style={{ padding: '12px 14px 4px' }}>
        <span className="title" style={{ fontSize: 15 }}>
          Search results
        </span>
        <p className="small" style={{ margin: '4px 0 0' }}>Restock remembers what your searches and scans find.{' '}<More title="Search results"><p>Restock remembers what your searches and scans find: the product, its price that day, its barcode and whether it was in stock. That's how it can
          tell you what something cost before, and judge a sale on something you don't track yet. A search always asks the shops again: a remembered
          price is never shown as today's. They stay on this phone, and go to your own Restock server if you have one.</p></More></p>
        {serverMode ? (
          <p className="small" style={{ margin: '6px 0 0' }}>
            <strong>Set on each phone.</strong> Searching the shops and remembering what they said happens in the Android app.
          </p>
        ) : (
          <p className="small" style={{ margin: '6px 0 0' }} role="status">
            {count && count.rows > 0
              ? `Remembering ${count.rows.toLocaleString('en-AU')} price${count.rows === 1 ? '' : 's'} of ${count.products.toLocaleString('en-AU')} product${count.products === 1 ? '' : 's'}. Kept for ${historyLabel(weeks)}${own ? '' : ', the same as your price history'}.`
              : `Nothing remembered yet. Kept for ${historyLabel(weeks)}${own ? '' : ', the same as your price history'}.`}
          </p>
        )}
      </div>
      <label className="check" style={serverMode ? { opacity: 0.5 } : undefined}>
        <input
          type="checkbox"
          className="switch"
          checked={own}
          disabled={serverMode}
          onChange={(e) => void save(e.target.checked ? settings.historyWeeks : undefined)}
        />
        <span style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
          <span className="title" style={{ fontSize: 15 }}>
            Keep search results for a different time
          </span>
          <span className="small">Off: they're kept as long as your price history, and follow it when you change it.</span>
        </span>
      </label>
      {own && !serverMode && (
        <div role="radiogroup" aria-label="How long to keep search results" style={{ display: 'flex', flexDirection: 'column', gap: 2, padding: '0 14px 6px' }}>
          {KEEP_WEEKS.map((w) => (
            <label key={w} className="check" style={{ padding: '8px 0' }}>
              <input type="radio" name="search-keep-weeks" checked={weeks === w} onChange={() => void save(w)} />
              <span className="title" style={{ fontSize: 15 }}>
                {historyLabel(w)}
              </span>
            </label>
          ))}
        </div>
      )}
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
          <p className="small" style={{ margin: '4px 0 0' }}>How long Restock keeps prices, and works out usual prices from.{' '}<More title="How far back Restock looks"><p>Restock keeps the prices it reads, and what your searches find, for this long, and works out each item's usual price from them. With shared
            prices on, it's also how much shared history this phone gets. Longer knows sales better; it's only a few megabytes either way.</p></More></p>
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
      <SearchKeepSettings settings={settings} />
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
