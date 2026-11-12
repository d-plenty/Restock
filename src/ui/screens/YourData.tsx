import { useEffect, useMemo, useState } from 'react';
import { allGroups } from '../../lib/db';
import { phoneSpending, noteTicks, spendingOnServer } from '../../lib/spending';
import { getSettings } from '../../lib/db';
import { RestockNative } from '../../lib/sql/native';
import { syncInfo } from '../../lib/sync';
import { useLive } from '../../lib/useLive';
import { money } from '../../lib/units';
import { serverMode } from '../../server-mode/flag';
import { PriceChart, PriceKey, ShopBars, SpendingChart } from '../../server-mode/ui/DeskDataCharts';
import { PERIODS, type DataSeries, type DataStats, type Period } from '../../server-mode/ui/houseData';
import { isNative } from '../../stores/http';
import { chainName } from '../../shops';
import { useNav } from '../nav';

// 0.9.14: Settings → Your data, the phone's version of the server's Data tab: what you spent (from
// what you tick off), where, what specials saved, any item's price over time, and what's stored.
// Without a server it's worked out on this phone (spending.ts). With a Restock server it can show
// the server's own figures, read as this phone (RestockNative.serverData). Nothing is sent anywhere.

type Source = 'phone' | 'server';

interface Reader {
  stats(p: Period): Promise<DataStats>;
  series(item: string, p: Period): Promise<DataSeries>;
}

const periodParam = (p: Period) => (p === 'all' ? 'all' : String(p));

const phoneReader = (): Reader => {
  const s = phoneSpending();
  return { stats: (p) => s.stats(p), series: (i, p) => s.series(i, p) };
};

const serverReader = (): Reader => ({
  stats: async (p) => (await RestockNative.serverData({ path: `/data/stats?period=${periodParam(p)}` })) as unknown as DataStats,
  series: async (i, p) => (await RestockNative.serverData({ path: `/data/series?item=${encodeURIComponent(i)}&period=${periodParam(p)}` })) as unknown as DataSeries,
});

function Tile({ label, big, sub }: { label: string; big: string; sub?: string }) {
  return (
    <div className="card" style={{ flex: '1 1 140px', display: 'flex', flexDirection: 'column', gap: 2, padding: 12 }}>
      <span className="small">{label}</span>
      <span className="num" style={{ fontSize: 22, fontWeight: 700 }}>
        {big}
      </span>
      {sub && <span className="small">{sub}</span>}
    </div>
  );
}

export function YourData() {
  const nav = useNav();
  const info = useLive(syncInfo, []);
  const settings = useLive(getSettings, []);
  const onServer = isNative() && !!info?.server && info.serverApi === 3;
  // 0.10.0: with a server, its figures unless Share my spending with the server is off (Sync and backups).
  const source: Source = onServer && settings && spendingOnServer(settings) ? 'server' : 'phone';
  const [period, setPeriod] = useState<Period>(3);
  const [stats, setStats] = useState<DataStats>();
  const [err, setErr] = useState<string>();
  const [busy, setBusy] = useState(true);
  const groups = useLive(allGroups, []);
  // Sample items are in the chart's list too (made-up prices, marked), never in the spending.
  const items = useMemo(() => [...(groups ?? [])].sort((a, b) => a.name.localeCompare(b.name)), [groups]);
  const [itemId, setItemId] = useState<string>();
  const [find, setFind] = useState('');
  const [series, setSeries] = useState<DataSeries>();
  const stored = useLive(() => phoneSpending().stored(), []);
  const reader = source === 'server' ? serverReader() : phoneReader();

  useEffect(() => {
    let alive = true;
    setBusy(true);
    setErr(undefined);
    void (async () => {
      try {
        if (source === 'phone') await noteTicks();
        const s = await reader.stats(period);
        if (alive) setStats(s);
      } catch (e) {
        if (alive) {
          setStats(undefined);
          setErr(e instanceof Error ? e.message : String(e));
        }
      } finally {
        if (alive) setBusy(false);
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, period, settings === undefined]);

  // The item chart: the most bought one to start with, else the first item.
  useEffect(() => {
    if (itemId || !items.length) return;
    setItemId(stats?.top.items.find((t) => t.itemId)?.itemId ?? items[0].id);
  }, [items, stats, itemId]);
  useEffect(() => {
    if (!itemId) return;
    let alive = true;
    void reader
      .series(itemId, period)
      .then((s) => alive && setSeries(s))
      .catch(() => alive && setSeries(undefined));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemId, period, source]);

  if (serverMode) return <p className="small">Your data is in the Data tab on this page.</p>;
  const shown = find.trim() ? items.filter((g) => g.name.toLowerCase().includes(find.trim().toLowerCase())) : items;
  const sp = stats?.spending;

  return (
    <>
      <p className="small" style={{ margin: 0 }}>
        {source === 'server'
          ? "Your household's figures from your Restock server, the same on every phone and on its web page."
          : 'Worked out on this phone from what you tick off on your shopping list. It stays on this phone.'}
        {onServer && (
          <>
            {' '}
            <button className="linkish" onClick={() => nav.push({ name: 'settings', page: 'sync' })}>
              {source === 'server' ? 'Keep it on this phone instead' : 'Share it with your server'}
            </button>
          </>
        )}
      </p>
      <div className="seg" role="group" aria-label="Time period">
        {PERIODS.map((p) => (
          <button key={String(p.value)} type="button" aria-pressed={period === p.value} onClick={() => setPeriod(p.value)}>
            {p.label}
          </button>
        ))}
      </div>

      {err && (
        <p className="small warn" role="alert">
          {source === 'server' ? `Couldn't reach your Restock server: ${err}` : err}
        </p>
      )}
      {busy && !stats && (
        <p className="small" role="status">
          Working it out…
        </p>
      )}

      {stats && sp && (
        <>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Tile label="Spent" big={money(sp.total)} sub={`${sp.count} thing${sp.count === 1 ? '' : 's'} ticked off${sp.unpriced ? `, ${sp.unpriced} without a price` : ''}`} />
            <Tile label="Saved on specials" big={money(stats.saved.total)} sub={stats.saved.count ? `on ${stats.saved.count} thing${stats.saved.count === 1 ? '' : 's'}` : 'Nothing on special yet'} />
          </div>
          {sp.count === 0 ? (
            <div className="card">
              <p className="small" style={{ margin: 0 }}>
                Tick things off your shopping list and your spending shows up here.
              </p>
            </div>
          ) : (
            <>
              <div className="eyebrow">Spending each month</div>
              <div className="card">
                <SpendingChart months={sp.months} />
              </div>
              <div className="eyebrow">Where you shop</div>
              <div className="card">
                <ShopBars shops={stats.shops} />
              </div>
              <div className="eyebrow">What you buy most</div>
              <div className="card flush">
                {stats.top.items.slice(0, 8).map((t) => (
                  <button key={t.key} className="row" disabled={!t.itemId} onClick={() => t.itemId && setItemId(t.itemId)}>
                    <span className="grow">
                      <span className="title" style={{ fontSize: 15 }}>
                        {t.name}
                      </span>
                      <span className="small">
                        {t.times} time{t.times === 1 ? '' : 's'} · {money(t.total)}
                        {t.cheapest ? ` · cheapest now ${money(t.cheapest.price)} at ${chainName(t.cheapest.chain)}` : ''}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}
        </>
      )}

      <div className="eyebrow" id="yd-price">
        Price over time
      </div>
      <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {!items.length ? (
          <p className="small" style={{ margin: 0 }}>
            Add something to your pantry and its prices show here.
          </p>
        ) : (
          <>
            <input className="input" type="search" placeholder="Find an item" aria-label="Find an item" value={find} onChange={(e) => setFind(e.target.value)} />
            <select className="input" aria-label="Item" value={itemId ?? ''} onChange={(e) => setItemId(e.target.value)}>
              {itemId && !shown.some((g) => g.id === itemId) && <option value={itemId}>{items.find((g) => g.id === itemId)?.name ?? 'This item'}</option>}
              {shown.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                  {g.id.startsWith('demo-') ? ' (sample)' : ''}
                </option>
              ))}
            </select>
            {series && series.weeks.length > 1 ? (
              <>
                <PriceChart series={series} />
                <PriceKey usual={series.usual} />
              </>
            ) : (
              <p className="small" style={{ margin: 0 }}>
                {series ? 'Not enough prices for a chart yet. Each price check adds one.' : 'Loading…'}
              </p>
            )}
            {itemId && (
              <button className="linkish" style={{ alignSelf: 'flex-start' }} onClick={() => nav.push({ name: 'item', groupId: itemId })}>
                Open this item
              </button>
            )}
          </>
        )}
      </div>

      <div className="eyebrow">On this phone</div>
      <div className="card">
        {stored ? (
          <p className="small" style={{ margin: 0 }}>
            {stored.items.toLocaleString()} items, {stored.products.toLocaleString()} products, {stored.prices.toLocaleString()} prices
            {stored.oldestPrice ? ` (since ${new Date(stored.oldestPrice).toLocaleDateString('en-AU', { month: 'long', year: 'numeric' })})` : ''},{' '}
            {stored.listLines.toLocaleString()} list lines, {stored.purchases.toLocaleString()} purchases, {stored.receipts.toLocaleString()} receipts,{' '}
            {stored.cards.toLocaleString()} loyalty cards
            {stored.shared ? `, and shared prices for ${stored.shared.toLocaleString()} products` : ''}.
          </p>
        ) : (
          <p className="small" style={{ margin: 0 }}>
            Counting…
          </p>
        )}
        <p className="small" style={{ margin: '8px 0 0' }}>
          Export it in Sync and backups (a backup, or spreadsheets). Erase it all in Advanced.
        </p>
      </div>
    </>
  );
}
