import { useState } from 'react';
import { downloadMarket, MARKET_SHOPS, marketInfo, megabytes, removeMarket } from '../../lib/market';
import { priceShareStatus, shareFromNow, sharedOn } from '../../lib/priceShare';
import { afterSave, updateSettings } from '../../lib/settingsDraft';
import { useLive } from '../../lib/useLive';
import { chainName } from '../../shops';
import { isNative } from '../../stores/http';
import type { Settings } from '../../types';
import { Icon, Sheet, timeAgo } from '../components';
import { useNav } from '../nav';

// 0.10.0: Shared prices, one switch (Settings → Privacy and sharing, and setup): this phone gets
// the shared price history (Judge new items from day one) and sends back the shelf prices it reads
// from the shops (Send prices back), or neither. Turning it off is a deliberate step: a page that
// says what it does and what you'd lose, with Keep sharing and Turn off shared prices. The same
// words are used on the phone, in setup and on the web page (SHARED_*), and in the privacy policy.

export const SHARED_TITLE = 'Shared prices';
export const SHARED_ONE_LINE =
  "New items get a fair verdict from day one, from prices everyone's phones and Restock's own collection have seen. In return, your phone shares the shelf prices it reads from the shops.";
export const SHARED_GOES =
  "What a search or price check reads straight from Coles, Woolworths, Aldi and Costco's websites: each product's shop, product number, name, brand, size, barcode and picture link, the price with any special, member price or multi-buy, and the day.";
export const SHARED_NEVER =
  'Anything you type in or change yourself, who you are, your account, cards, branch or location, your lists, pantry or what you tick off, receipts, or the words you search. Prices from shops you added yourself and sample items stay here too.';
export const SHARED_WHERE =
  "To Restock's shared price service (restock-prices.plenty.family). It checks each price, adds it to the history every night, and publishes it openly on GitHub (d-plenty/restock-prices), free for anyone to use. Nothing in it identifies you or says which phone a price came from.";
export const SHARED_INSTALL =
  "With the prices goes a random number made for this install, so the service can tell phones apart and stop any one sending too much. It isn't linked to you, and your internet address isn't kept.";
export const SHARED_GET =
  'Your phone downloads the shared history for just your shops, for how far back you chose (Prices and deals). Everyone downloads the same files, so nobody can tell what you track.';

/** Settings → Privacy and sharing → Shared prices. */
export function SharedPricesSection({ settings }: { settings: Settings }) {
  const nav = useNav();
  const on = sharedOn(settings);
  const md = settings.marketData;
  const every = md.every ?? 'weekly';
  const info = useLive(marketInfo, []);
  const sent = useLive(priceShareStatus, []);
  const [progress, setProgress] = useState<string>();
  const [asking, setAsking] = useState(false);

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

  const turn = async (want: boolean) => {
    if (want && settings.sharePrices === 'no') await shareFromNow();
    await updateSettings({ sharePrices: want ? 'yes' : 'no', marketData: { ...md, enabled: want } });
    // 0.9.5 (save): the first download starts once it's saved.
    if (want)
      await afterSave('market', (s) => {
        if (sharedOn(s) && !info?.count) void download(s.marketData.wifiOnly);
      });
  };

  const got = (() => {
    if (progress) return progress;
    if (info?.count) return `${info.count.toLocaleString()} products · updated ${timeAgo(info.updatedAt)}${info.lastTry?.bytes ? ` · ${megabytes(info.lastTry.bytes)}` : ''}`;
    if (info?.lastTry && !info.lastTry.products) return `Nothing published for your shops yet (checked ${timeAgo(info.lastTry.at)}). It's fetched as soon as it is.`;
    return `Not downloaded yet. It downloads after the next price check${md.wifiOnly ? ' on Wi-Fi' : ''}, or tap Download now.`;
  })();
  const gave = !isNative()
    ? 'Phones send them; this web page never does.'
    : sent?.lastSentAt
      ? `Last sent ${timeAgo(sent.lastSentAt)}${sent.total ? ` · ${sent.total.toLocaleString()} prices from this phone so far` : ''}.${sent.error ? ` Last try: ${sent.error}.` : ''}`
      : sent?.error
        ? `Not sent yet: ${sent.error}. It tries again later.`
        : 'Nothing sent yet. Prices go a few minutes after your next search or price check.';
  const covered = settings.enabledChains.filter((c) => (MARKET_SHOPS as readonly string[]).includes(c));
  const notCovered = settings.enabledChains.filter((c) => !(MARKET_SHOPS as readonly string[]).includes(c) && !c.startsWith('custom-'));

  return (
    <>
      <div className="eyebrow" id="s-shared">
        {SHARED_TITLE}
      </div>
      <div className="card flush">
        <label className="check">
          <input
            type="checkbox"
            className="switch"
            checked={on}
            onChange={(e) => {
              // 0.10.0: on straight away; off only after the page that says what it means.
              if (e.target.checked) void turn(true);
              else setAsking(true);
            }}
          />
          <span style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
            <span className="title" style={{ fontSize: 15 }}>
              {SHARED_TITLE}
            </span>
            <span className="small">
              {on ? 'On' : 'Off'} · {SHARED_ONE_LINE}
            </span>
          </span>
        </label>
        <div style={{ padding: '0 14px 14px', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <p className="small" style={{ margin: 0 }}>
            <strong>What goes:</strong> {SHARED_GOES}
          </p>
          <p className="small" style={{ margin: 0 }}>
            <strong>Never:</strong> {SHARED_NEVER}
          </p>
          <p className="small" style={{ margin: 0 }}>
            <strong>Where it goes:</strong> {SHARED_WHERE}{' '}
            <a href="https://github.com/d-plenty/restock-prices" target="_blank" rel="noreferrer">
              See it on GitHub
            </a>
          </p>
          <p className="small" style={{ margin: 0 }}>
            <strong>What you get:</strong> {SHARED_GET}
            {covered.length ? ` For ${covered.map(chainName).join(', ')}.` : ''}
            {notCovered.length ? ` ${notCovered.map(chainName).join(', ')} ${notCovered.length === 1 ? "isn't" : "aren't"} collected yet.` : ''}
          </p>
          <p className="small" style={{ margin: 0 }}>
            {SHARED_INSTALL}
          </p>
        </div>
        {on && (
          <>
            <div style={{ padding: '6px 14px 10px', display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span className="title" style={{ fontSize: 15 }} id="shared-every">
                Get new shared prices
              </span>
              <div className="seg" role="group" aria-labelledby="shared-every">
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
                <span className="small">Downloads wait for Wi-Fi. Download now always goes ahead. Sending is a few kilobytes, so it goes any time.</span>
              </span>
            </label>
            <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
              <span className="grow" style={{ minWidth: 180 }}>
                <span className="title" style={{ fontSize: 15 }}>
                  On this phone
                </span>
                <span className="small" role="status">
                  {got}
                </span>
                <span className="small">{gave}</span>
              </span>
              <button className="btn small" disabled={!!progress} onClick={() => void download()}>
                <Icon name="refresh" size={16} /> {progress ? 'Downloading…' : 'Download now'}
              </button>
            </div>
          </>
        )}
        {!on && info && info.count > 0 && (
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
      {asking && (
        <TurnOffShared
          onKeep={() => setAsking(false)}
          onOff={() => {
            setAsking(false);
            void turn(false);
          }}
        />
      )}
    </>
  );
}

/** "Turn off shared prices?": what it does for you and everyone, how private it is, what you'd lose. */
export function TurnOffShared({ onKeep, onOff }: { onKeep: () => void; onOff: () => void }) {
  return (
    <Sheet title="Turn off shared prices?" onClose={onKeep}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <p style={{ margin: 0 }}>
          <strong>Shared prices is what lets Restock judge a new item on day one.</strong> Without it, a new item has no history, so for its first 4 to 8
          weeks Restock can't tell whether a "special" is really a good price, and you could miss a real one or fall for a fake one.
        </p>
        <p style={{ margin: 0 }}>
          <strong>It works because everyone shares.</strong> Each phone that sends the shelf prices it reads makes the history better for every Restock
          user, you included. It's free, open data, published on GitHub for anyone to use, and never sold.
        </p>
        <p style={{ margin: 0 }}>
          <strong>Nothing about you goes.</strong> Only the price, product and day that the shop's own website showed. Never your name, account, list,
          pantry, cards, branch, location, receipts, the words you search, or prices you type in.
        </p>
        <p className="small" style={{ margin: 0 }}>
          If you turn it off, this phone stops downloading the shared history and stops sending prices, and new items are judged only from the prices
          this phone sees itself. You can turn it back on any time in Privacy and sharing.
        </p>
        <button type="button" className="btn primary block" onClick={onKeep}>
          Keep sharing
        </button>
        <button type="button" className="btn block" onClick={onOff}>
          Turn off shared prices
        </button>
      </div>
    </Sheet>
  );
}
