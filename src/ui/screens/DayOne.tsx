import { useEffect, useState } from 'react';
import { confirmAction } from '../../lib/confirm';
import { pruneHistory, serverKeepsHistory } from '../../lib/db';
import { downloadMarket, MARKET_SHOPS, marketInfo, megabytes, removeMarket, windowCost, windowIndex, type MarketDays, type WindowIndex } from '../../lib/market';
import { afterSave, updateSettings } from '../../lib/settingsDraft';
import { useLive } from '../../lib/useLive';
import { chainName } from '../../shops';
import { isNative } from '../../stores/http';
import { keepDays, KEEP_WEEKS, historyLabel, type Settings } from '../../types';
import { Icon, timeAgo } from '../components';
import { useNav } from '../nav';

// 0.9.14: price history in one place (Settings → Prices and deals, and setup). How far back
// Restock looks (8 weeks, 6 months or 12 months) is one setting: how long this phone keeps the
// prices it reads, and, with "Judge new items from day one" on, how much shared history it gets.

const LENGTH_HELP: Record<number, string> = {
  8: 'Enough to know an everyday price.',
  26: 'Sees a few rounds of specials, so it knows a real one.',
  52: 'Catches once-a-year sales like Christmas and Easter.',
};

const shopsCovered = (s: Settings) => s.enabledChains.filter((c) => (MARKET_SHOPS as readonly string[]).includes(c));

/** 8 weeks / 6 months / 12 months, with what each costs when shared history is on. */
export function HistoryLengths({ settings, onPicked }: { settings: Settings; onPicked?: (weeks: number) => void }) {
  const [index, setIndex] = useState<WindowIndex>();
  useEffect(() => {
    let alive = true;
    if (settings.marketData.enabled) void windowIndex().then((v) => alive && setIndex(v));
    return () => {
      alive = false;
    };
  }, [settings.marketData.enabled]);
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
                {settings.marketData.enabled && cost.shops.length
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

/** The day-one switch's one-line description, shared with setup. */
export function dayOneText(s: Settings): string {
  const covered = shopsCovered(s);
  const not = s.enabledChains.filter((c) => !(MARKET_SHOPS as readonly string[]).includes(c) && !c.startsWith('custom-'));
  return (
    `Fills in prices other Restock users and Restock's own collection have seen, so a new item gets a fair verdict straight away. ` +
    (covered.length ? `For ${covered.map(chainName).join(', ')}.` : 'For Coles, Woolworths, Aldi and Costco: pick one in My shops.') +
    (not.length ? ` ${not.map(chainName).join(', ')} ${not.length === 1 ? "isn't" : "aren't"} collected yet.` : '')
  );
}

/** Settings → Prices and deals → Price history. */
export function PriceHistorySettings({ settings }: { settings: Settings }) {
  const nav = useNav();
  const info = useLive(marketInfo, []);
  const [progress, setProgress] = useState<string>();
  const md = settings.marketData;
  const every = md.every ?? 'weekly';

  const download = async (onlyUnmetered = false) => {
    if (!isNative()) {
      nav.toast('Shared prices download in the Android app.');
      return;
    }
    setProgress('Checking what’s published…');
    try {
      const r = await downloadMarket(
        (chain, bytes, products) => setProgress(`${chainName(chain)}: ${megabytes(bytes)} downloaded, ${products.toLocaleString()} products so far`),
        { onlyUnmetered },
      );
      if (r.waitingForWifi) {
        nav.toast("You're on mobile data, so it'll download on Wi-Fi. Tap Download now to get it anyway.");
        return;
      }
      const failed = Object.entries(r.errors);
      nav.toast(
        failed.length
          ? `Got ${r.products.toLocaleString()} products. ${failed.map(([c, e]) => `${chainName(c)}: ${e}`).join('. ')}`
          : r.products
            ? `Shared prices for ${r.products.toLocaleString()} products (${megabytes(r.bytes)})`
            : "Shared prices for your shops aren't published yet. Restock gets them as soon as they are.",
      );
    } catch (e) {
      nav.toast(e instanceof Error ? e.message : String(e));
    } finally {
      setProgress(undefined);
    }
  };

  const status = (() => {
    if (progress) return progress;
    if (info?.count) return `${info.count.toLocaleString()} products · updated ${timeAgo(info.updatedAt)}${info.lastTry?.bytes ? ` · ${megabytes(info.lastTry.bytes)}` : ''}`;
    if (info?.lastTry && !info.lastTry.products) return `Nothing published for your shops yet (checked ${timeAgo(info.lastTry.at)}). It's fetched as soon as it is.`;
    return `Not downloaded yet. It downloads after the next price check${md.wifiOnly ? ' on Wi-Fi' : ''}, or tap Download now.`;
  })();

  return (
    <>
      <div className="card flush">
        <div style={{ padding: '12px 14px 4px' }}>
          <span className="title" style={{ fontSize: 15 }}>
            How far back Restock looks
          </span>
          <p className="small" style={{ margin: '4px 0 0' }}>
            Restock keeps the prices it reads for this long, and works out each item's usual price from them. Longer knows sales better; it's only a few
            megabytes either way.
          </p>
        </div>
        <div style={{ padding: '0 14px 6px' }}>
          <HistoryLengths
            settings={settings}
            onPicked={() =>
              void afterSave('market-days', (s) => {
                if (s.marketData.enabled) void download(s.marketData.wifiOnly);
              })
            }
          />
        </div>
      </div>
      <div className="card flush" id="s-dayone">
        <label className="check">
          <input
            type="checkbox"
            className="switch"
            checked={md.enabled}
            onChange={async (e) => {
              const enabled = e.target.checked;
              await updateSettings({ marketData: { ...md, enabled } });
              // 0.9.5 (save): the first download starts once it's saved.
              await afterSave('market', (s) => {
                if (s.marketData.enabled && !info?.count) void download(s.marketData.wifiOnly);
              });
            }}
          />
          <span style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
            <span className="title" style={{ fontSize: 15 }}>
              Judge new items from day one
            </span>
            <span className="small">{dayOneText(settings)} Everyone downloads the same files, so nobody can tell what you track.</span>
          </span>
        </label>
        {md.enabled && (
          <>
            <div style={{ padding: '6px 14px 10px', display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span className="title" style={{ fontSize: 15 }} id="dayone-every">
                Get new shared prices
              </span>
              <div className="seg" role="group" aria-labelledby="dayone-every">
                <button type="button" aria-pressed={every === 'weekly'} onClick={() => void updateSettings({ marketData: { ...md, every: 'weekly' } })}>
                  Weekly
                </button>
                <button type="button" aria-pressed={every === 'daily'} onClick={() => void updateSettings({ marketData: { ...md, every: 'daily' } })}>
                  Every day
                </button>
              </div>
              <span className="small">
                {every === 'weekly'
                  ? 'Once a week, after the Thursday collection (with that week’s specials). The default.'
                  : 'Every day, with the prices other phones sent the day before. A little more data.'}
              </span>
            </div>
            <label className="check">
              <input type="checkbox" className="switch" checked={md.wifiOnly} onChange={(e) => updateSettings({ marketData: { ...md, wifiOnly: e.target.checked } })} />
              <span style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
                <span className="title" style={{ fontSize: 15 }}>
                  Only on Wi-Fi
                </span>
                <span className="small">Downloads wait for Wi-Fi. Download now always goes ahead.</span>
              </span>
            </label>
            <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
              <span className="grow" style={{ minWidth: 180 }}>
                <span className="title" style={{ fontSize: 15 }}>
                  Shared prices on this phone
                </span>
                <span className="small" role="status">
                  {status}
                </span>
              </span>
              <button className="btn small" disabled={!!progress} onClick={() => void download()}>
                <Icon name="refresh" size={16} /> {progress ? 'Downloading…' : 'Download now'}
              </button>
            </div>
          </>
        )}
        {!md.enabled && info && info.count > 0 && (
          <button
            className="row"
            onClick={async () => {
              await removeMarket();
              nav.toast('Shared prices removed from this phone');
            }}
          >
            <span className="grow">
              <span className="title" style={{ color: 'var(--red-ink)' }}>
                Remove downloaded shared prices
              </span>
              <span className="small">{info.count.toLocaleString()} product summaries are still on this phone</span>
            </span>
          </button>
        )}
      </div>
    </>
  );
}
