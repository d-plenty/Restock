import { useState } from 'react';
import { checkPrices } from '../../lib/check';
import { allCards, allListEntries, deleteListEntries, getSettings, updateSettings } from '../../lib/db';
import { loadDemo } from '../../lib/demo';
import { addGroupToList } from '../../lib/listActions';
import { recommendedStores, shopTotals } from '../../lib/shopTotals';
import { loadRecommendations } from '../../lib/recs';
import { money } from '../../lib/units';
import { lineCost } from '../../lib/verdict';
import { useLive } from '../../lib/useLive';
import { type Recommendation } from '../../lib/verdict';
import { isBlockMessage, isNative } from '../../stores/http';
import { WEEKDAYS, chainName, stockKnown } from '../../types';
import { ChainDot, ChainName, Icon, OpenStoreButton, Price, SectionMark, SwapBox, Thumb, timeAgo, usePullToRefresh } from '../components';
import { activeSections, searchChainsIn, type StoreChain } from '../../shops';
import { ActionInfoTag, MemberInfoTag, MultiInfoTag } from '../tagInfo';
import { failingStores, getHealth } from '../../lib/health';
import { exportBackup, needsBackupNudge } from '../../lib/backup';
import { confirmAction } from '../../lib/confirm';
import { useNav } from '../nav';
import { RecallBanner } from './Recalls';
import { SetupNudges } from './SetupNudges';
import { ConnectionsSheet } from './Settings';

export function HomeScreen() {
  const nav = useNav();
  const allRecs = useLive(loadRecommendations, []);
  const settings = useLive(getSettings, []);
  const allEntries = useLive(allListEntries, []);
  const [progress, setProgress] = useState<[number, number]>();
  const health = useLive(getHealth, []);
  const failingAll = health ? failingStores(health) : [];
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [dealShop, setDealShopState] = useState<string | undefined>(() => {
    try {
      return localStorage.getItem('homeDealShop') ?? undefined;
    } catch {
      return undefined;
    }
  });
  const setDealShop = (c: string | undefined) => {
    setDealShopState(c);
    try {
      if (c) localStorage.setItem('homeDealShop', c);
      else localStorage.removeItem('homeDealShop');
    } catch {
      // storage can be unavailable
    }
  };
  const refresh = usePullToRefresh(() => void runCheck());

  const cards = useLive(allCards, []);
  const [testing, setTesting] = useState(false);
  if (!allRecs || !settings || !allEntries) return <div className="screen" />;
  // Deals from every tab that's switched on; the list summary is the grocery list.
  const on = activeSections(settings);
  const recs = allRecs.filter((r) => on.includes(r.group.section ?? 'pantry'));
  // Only warn about shops you still use, on a tab that's switched on.
  const failing = failingAll.filter((f) => on.some((sec) => searchChainsIn(settings.enabledChains, sec).includes(f.chain)));
  const pantryIds = new Set(allRecs.filter((r) => (r.group.section ?? 'pantry') === 'pantry').map((r) => r.group.id));
  const entries = allEntries.filter((e) => (e.groupId ? pantryIds.has(e.groupId) : (e.section ?? 'pantry') === 'pantry'));
  const oldest = recs.map((r) => r.group.createdAt).sort()[0];
  const backupNow = async () => {
    if (cards?.length) {
      const ok = await confirmAction('Your backup includes your loyalty card numbers', {
        detail: 'Keep the file somewhere private, and only share it with people you trust.',
        action: 'Make the backup',
      });
      if (!ok) return;
    }
    try {
      nav.toast(`Backup ready: ${await exportBackup()}`);
    } catch (e) {
      nav.toast(`Backup failed: ${e instanceof Error ? e.message : e}`);
    }
  };
  // Items on the shopping list, by pantry item, with the list line (so the cart button can take it off again).
  const listed = new Map(allEntries.filter((e) => !e.checked && e.groupId).map((e) => [e.groupId!, e.id]));
  const totals = shopTotals(
    entries,
    recs.filter((r) => pantryIds.has(r.group.id)),
    searchChainsIn(settings.enabledChains, 'pantry'),
    settings.listCompare,
  );
  // The store recommended on the shopping list, so Home and the list agree.
  const pickedStore = recommendedStores(totals).recommended;
  const oneStop = pickedStore && !pickedStore.missing.length ? pickedStore : totals.stores.find((s) => !s.missing.length);
  // What this week's list saves against everything's normal price.
  const listSaving = totals.around.lines.reduce((sum, l) => {
    const normal = l.pick.stats.typical ?? l.pick.stats.current?.wasPrice;
    return normal && l.pick.price !== undefined ? sum + Math.max(0, normal * l.qty - lineCost(l.pick, l.qty)) : sum;
  }, 0);
  const next = nextCheck(settings);

  // Deals at one shop only, or all of them (0.7.4). The shop each deal is at: the swap's for a swap.
  const dealChain = (r: (typeof recs)[number]) => (r.action === 'alt' ? r.alt : r.best)?.product.chain;
  const dealRecs = recs.filter((r) => r.action === 'buy' || r.action === 'alt' || r.action === 'small');
  const dealShops = [...new Set(dealRecs.map(dealChain).filter((c): c is NonNullable<typeof c> => !!c))].sort((a, b) =>
    chainName(a).localeCompare(chainName(b)),
  );
  const atShop = (r: (typeof recs)[number]) => !dealShop || !dealShops.includes(dealShop as never) || dealChain(r) === dealShop;
  const buys = recs.filter((r) => r.action === 'buy' && atShop(r));
  const altDeals = recs.filter((r) => r.action === 'alt' && atShop(r));
  const smalls = recs.filter((r) => r.action === 'small' && atShop(r));
  const waits = recs.filter((r) => r.action === 'wait');
  const skips = recs.filter((r) => r.action === 'skip');
  const normal = recs.filter((r) => r.action === 'none');
  const worth = [...buys, ...altDeals];
  const saving = worth.reduce((sum, r) => sum + (r.saving ?? 0), 0);

  async function runCheck() {
    if (progress) return;
    setErrors({});
    setProgress([0, 1]);
    const res = await checkPrices((d, t) => setProgress([d, t]));
    setProgress(undefined);
    setErrors(res.errors as Record<string, string>);
    if (res.nativeOnly) nav.toast('Live prices only work in the Android app.');
    else if (!res.checked && !Object.keys(res.errors).length) nav.toast('Nothing to check yet. Add items with a store match first.');
    else nav.toast(`Checked ${res.checked} · ${res.updated} updated`);
  }

  const today = new Date().toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' });

  return (
    <div className="screen" {...refresh.props}>
      {refresh.indicator}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div className="sub">{today}</div>
        <div className="topbar">
          <h1>This week</h1>
          <button className="icon-btn" aria-label="Settings" onClick={() => nav.push({ name: 'settings' })}>
            <Icon name="settings" size={20} />
          </button>
        </div>
        <div className="chips" style={{ margin: '2px 0 4px' }}>
          <button className="chip" onClick={() => nav.push({ name: 'cards' })}>
            <Icon name="card" size={16} /> Loyalty cards
          </button>
          <button className="chip" onClick={() => nav.push({ name: 'catalogues' })}>
            <Icon name="book" size={16} /> Catalogues
          </button>
          <button className="chip" onClick={() => nav.push({ name: 'specials' })}>
            <Icon name="flame" size={16} /> Specials
          </button>
          {settings.receipts.enabled && (
            <button className="chip" onClick={() => nav.push({ name: 'receipts' })}>
              <Icon name="receipt" size={16} /> Receipts
            </button>
          )}
        </div>
        <div className="checkline">
          {progress ? (
            <>
              <span>Checking prices & stock…</span>
              <div className="progress" style={{ flex: 1 }}>
                <div style={{ width: `${(progress[0] / Math.max(1, progress[1])) * 100}%` }} />
              </div>
            </>
          ) : (
            <>
              <span>
                {!isNative()
                  ? 'Live prices work in the Android app'
                  : settings.lastCheck
                    ? `${settings.enabledChains.some((c) => stockKnown(settings, c)) ? 'Prices & stock' : 'Prices'} updated ${timeAgo(settings.lastCheck)}${next ? ` · next ${next}` : ''}`
                    : 'Prices not checked yet'}
              </span>
              {isNative() && (
                <button className="linkish" onClick={() => void runCheck()} aria-label="Check prices and stock now">
                  <Icon name="refresh" size={14} /> Check now
                </button>
              )}
            </>
          )}
        </div>
        {isNative() && !progress && (
          <span className="small">
            Pull down to check.{' '}
            {settings.sync.backgroundActivity
              ? settings.checkIntervalHours >= 168
                ? `Also checks every ${WEEKDAYS[settings.checkWeekday]}.`
                : `Also checks about every ${settings.checkIntervalHours} hours.`
              : 'Background checks are off.'}
          </span>
        )}
      </div>

      <RecallBanner />

      {!settings.tour.active && <SetupNudges settings={settings} />}

      {totals.linked > 0 && (
        <button
          className="card home-list"
          onClick={() => nav.setTab('list', 'pantry')}
          aria-label={`Shopping list, about ${money(totals.around.total)}. Open it`}
        >
          <span className="home-list-top">
            <span className="home-list-lab">
              <Icon name="cart" size={18} /> Shopping list · {totals.linked} item{totals.linked === 1 ? '' : 's'}
            </span>
            <Icon name="chevron" size={18} />
          </span>
          <span className="home-list-total">
            <span className="num">{money(totals.around.total)}</span>
            <span className="home-list-how">
              shopping around
              {totals.around.chains.length > 1
                ? ` · ${totals.around.chains.length} stores`
                : totals.around.chains.length === 1
                  ? ` · ${chainName(totals.around.chains[0])}`
                  : ''}
            </span>
          </span>
          {oneStop && totals.around.chains.length > 1 ? (
            <span className="home-list-alt">
              <ChainDot chain={oneStop.chain} />
              <span className="grow">
                All at {chainName(oneStop.chain)}, one trip
                {oneStop.lines.filter((l) => l.outOfStock).length > 0 && (
                  <span className="small" style={{ display: 'block', color: 'var(--amber-ink)' }}>
                    {oneStop.lines.filter((l) => l.outOfStock).length} out of stock there
                  </span>
                )}
              </span>
              <span className="num">{money(oneStop.total)}</span>
              {oneStop.total - totals.around.total > 0.004 && (
                <span className="home-list-more num">+{money(oneStop.total - totals.around.total)}</span>
              )}
            </span>
          ) : (
            !oneStop && <span className="small">No single store has everything. Tap to compare stores.</span>
          )}
          {listSaving > 0.5 && <span className="home-list-save">About {money(listSaving)} less than buying it all at normal prices</span>}
        </button>
      )}

      {worth.length > 0 && (
        <div className="banner green" style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span style={{ fontSize: 13, opacity: 0.92 }}>
              {worth.length} item{worth.length === 1 ? '' : 's'} worth grabbing
            </span>
            <span className="big num">{saving > 0 ? `Save about ${money(saving)}` : 'Worth a look'}</span>
          </div>
          <span style={{ fontSize: 12, textAlign: 'right', opacity: 0.92 }}>
            vs normal
            <br />
            prices
          </span>
        </div>
      )}

      {Object.entries(errors).map(([chain, msg]) => (
        <div key={chain} className="banner amber" role="alert">
          <strong>{chainName(chain)}</strong>
          <span style={{ fontSize: 13 }}>
            {isBlockMessage(msg)
              ? `${chainName(chain)} wants to check you're a person. Tap Open ${chainName(chain)}, let the page load (tick the box if it asks), tap Done, and Restock checks again.`
              : msg}
          </span>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn small" onClick={runCheck}>
              <Icon name="refresh" size={16} /> Try again
            </button>
            {isBlockMessage(msg) && chain !== 'other' && <OpenStoreButton chain={chain as StoreChain} onDone={runCheck} />}
          </div>
        </div>
      ))}

      {recs.length > 0 && needsBackupNudge(settings, recs.length, oldest) && (
        <div className="card hint" style={{ flexDirection: 'column', gap: 8 }}>
          <strong>Back up your pantry</strong>
          <span>
            Restock keeps everything on this phone. If it's lost, broken or reset, a backup is the only way to get your pantry, list and price history
            back. It's one small file you can save to Drive, email to yourself or keep on your computer.
          </span>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn small primary" onClick={backupNow}>
              Back up now
            </button>
            <button className="btn small" onClick={() => updateSettings({ backupNudgeAt: new Date().toISOString() })}>
              Not now
            </button>
          </div>
        </div>
      )}

      {failing
        .filter((f) => !errors[f.chain])
        .map((f) => (
          <div key={f.chain} className="banner amber" role="alert">
            <strong>
              {chainName(f.chain)} hasn't worked for {f.days} day{f.days === 1 ? '' : 's'}
            </strong>
            <span style={{ fontSize: 13 }}>
              Its prices may be out of date.{' '}
              {isBlockMessage(f.error ?? '')
                ? `${chainName(f.chain)} wants to check you're a person: tap Open ${chainName(f.chain)}.`
                : f.error
                  ? `Last error: ${f.error}.`
                  : ''}
            </span>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button className="btn small" onClick={runCheck}>
                <Icon name="refresh" size={16} /> Try again
              </button>
              <OpenStoreButton chain={f.chain} onDone={runCheck} />
              <button className="btn small" onClick={() => setTesting(true)}>
                Test connections
              </button>
            </div>
          </div>
        ))}

      {!recs.length && (
        <div className="card guide">
          <Icon name="scan" size={32} />
          <h2 style={{ margin: 0 }}>Let's add your first item</h2>
          <ol>
            <li>Grab something you buy often, like a jar of peanut butter.</li>
            <li>Tap Add and scan its barcode, or type its name.</li>
            <li>Tick it at each store that sells it. Restock then watches the prices for you.</li>
          </ol>
          <button className="btn primary" onClick={() => nav.setTab('add')}>
            <Icon name="scan" size={18} /> Add my first item
          </button>
          <button
            className="btn ghost"
            onClick={async () => {
              await loadDemo();
              nav.toast('Sample items added. Remove them any time in Settings.');
            }}
          >
            Or look around with sample items
          </button>
        </div>
      )}

      {dealShops.length > 1 && (
        <div className="chips deal-shops" role="tablist" aria-label="Deals at">
          <button
            role="tab"
            className="chip"
            aria-selected={!dealShop || !dealShops.includes(dealShop as never)}
            aria-pressed={!dealShop || !dealShops.includes(dealShop as never)}
            onClick={() => setDealShop(undefined)}
          >
            All shops
          </button>
          {dealShops.map((c) => (
            <button key={c} role="tab" className="chip" aria-selected={dealShop === c} aria-pressed={dealShop === c} onClick={() => setDealShop(c)}>
              <ChainDot chain={c} /> {chainName(c)}
              <span className="ph-count">{dealRecs.filter((r) => dealChain(r) === c).length}</span>
            </button>
          ))}
        </div>
      )}
      {buys.length > 0 && <div className="eyebrow green">On sale now</div>}
      {buys.map((r) => (
        <DealCard key={r.group.id} rec={r} listed={listed.get(r.group.id)} />
      ))}

      {altDeals.length > 0 && (
        <div className="eyebrow" style={{ color: 'var(--blue)' }}>
          Swap &amp; save
        </div>
      )}
      {altDeals.map((r) => (
        <DealCard key={r.group.id} rec={r} listed={listed.get(r.group.id)} />
      ))}

      {smalls.length > 0 && <div className="eyebrow green">Small savings</div>}
      {smalls.length > 0 && (
        <div className="card flush">
          {smalls.map((r) => (
            <div key={r.group.id} className="row" style={{ gap: 8 }}>
              <button
                className="row-main"
                style={{ color: 'inherit', font: 'inherit' }}
                onClick={() => nav.push({ name: 'item', groupId: r.group.id })}
              >
                <span className="grow">
                  <span className="title clip" style={{ fontSize: 14 }}>
                    <SectionMark section={r.group.section} />
                    {r.group.name}
                  </span>
                  <span className="small clip">
                    {chainName(r.best!.product.chain)} · {r.detail}
                  </span>
                </span>
                <span className="num" style={{ fontWeight: 600 }}>
                  {money(r.best?.price)}
                </span>
              </button>
              {/* The same add-to-list button as every other deal (0.7.3). */}
              <button
                className={`cart-btn${listed.get(r.group.id) ? ' on' : ''}`}
                aria-label={
                  listed.get(r.group.id) ? `${r.group.name} is on your shopping list. Tap to take it off` : `Add ${r.group.name} to shopping list`
                }
                aria-pressed={!!listed.get(r.group.id)}
                onClick={async () => {
                  const id = listed.get(r.group.id);
                  if (id) {
                    await deleteListEntries([id]);
                    nav.toast(`${r.group.name} taken off your shopping list`);
                    return;
                  }
                  const added = await addGroupToList(r.group);
                  nav.toast(added ? `${r.group.name} added to your shopping list` : `${r.group.name} is already on your list`);
                }}
              >
                <Icon name={listed.get(r.group.id) ? 'cartCheck' : 'cartPlus'} size={22} />
              </button>
            </div>
          ))}
        </div>
      )}

      {waits.length > 0 && <div className="eyebrow amber">Wait for a better sale</div>}
      {waits.map((r) => (
        <DealCard key={r.group.id} rec={r} listed={listed.get(r.group.id)} />
      ))}

      {skips.map((r) => (
        <button
          key={r.group.id}
          className="card dashed"
          style={{ flexDirection: 'row', alignItems: 'center', textAlign: 'left' }}
          onClick={() => nav.push({ name: 'item', groupId: r.group.id })}
        >
          <span style={{ color: 'var(--muted)' }}>
            <Icon name="close" size={18} />
          </span>
          <span style={{ flex: 1, fontSize: 13, color: 'var(--ink-2)' }}>
            Fake sale: {r.group.name} is "on special" at its normal price. Skipped.
          </span>
        </button>
      ))}

      {normal.length > 0 && recs.length > 0 && (
        <button className="btn ghost" onClick={() => nav.setTab('pantry')}>
          {normal.length} other item{normal.length === 1 ? '' : 's'} at normal price
        </button>
      )}
      {testing && <ConnectionsSheet settings={settings} onClose={() => setTesting(false)} />}
    </div>
  );
}

function DealCard({ rec, listed }: { rec: Recommendation; listed?: string }) {
  const nav = useNav();
  const isAlt = rec.action === 'alt';
  const deal = (isAlt ? rec.alt : rec.best)!;
  const cur = deal.stats.current;
  const open = () => nav.push({ name: 'item', groupId: rec.group.id });
  const mine = rec.best;

  return (
    <div className="card deal">
      <div className="deal-top">
        <button className="row-main" onClick={open} aria-label={`${rec.group.name}: ${rec.headline}`}>
          <Thumb src={deal.product.imageUrl ?? mine?.product.imageUrl} />
          <span className="grow">
            <span className="title clip">
              <SectionMark section={rec.group.section} />
              {rec.group.name}
            </span>
            <span className="sub">
              <ChainName chain={deal.product.chain} /> · {isAlt ? `swap to ${deal.product.name}` : rec.detail}
            </span>
            <span className="tags">
              <ActionInfoTag rec={rec} action={rec.action} great={rec.best?.verdict.kind === 'great'} />
              <MultiInfoTag o={deal} />
              {cur?.memberOnly && <MemberInfoTag chain={deal.product.chain} hasCard={!deal.locked} />}
            </span>
          </span>
          {!isAlt && <Price value={deal.multi ? deal.shelfPrice : deal.price} was={cur?.wasPrice} />}
        </button>
        <button
          className={`cart-btn${listed ? ' on' : ''}`}
          aria-label={listed ? `${rec.group.name} is on your shopping list. Tap to take it off` : `Add ${rec.group.name} to shopping list`}
          aria-pressed={!!listed}
          onClick={async () => {
            // Tap again to take it off, the same as on the Pantry tab.
            if (listed) {
              await deleteListEntries([listed]);
              nav.toast(`${rec.group.name} taken off your shopping list`);
              return;
            }
            const added = await addGroupToList(rec.group);
            nav.toast(added ? `${rec.group.name} added to your shopping list` : `${rec.group.name} is already on your list`);
          }}
        >
          <Icon name={listed ? 'cartCheck' : 'cartPlus'} size={22} />
        </button>
      </div>
      {isAlt && (
        <button className="two" style={{ border: 'none', background: 'none', padding: 0, textAlign: 'left' }} onClick={open}>
          <SwapBox label="Instead of yours" option={mine} />
          <SwapBox label="Get this" option={deal} hi />
        </button>
      )}
      {!isAlt && rec.alt && (
        <div className="small">
          Also on sale: {rec.alt.product.name} at {chainName(rec.alt.product.chain)}, {money(rec.alt.price)}
        </div>
      )}
    </div>
  );
}

/** When the next background check should run, in words ("tonight 9:15 pm", "Wed 8 am"). */
export function nextCheck(
  s: { lastCheck?: string; checkIntervalHours: number; checkWeekday?: number; sync: { backgroundActivity: boolean } },
  now = Date.now(),
): string | undefined {
  if (!s.sync.backgroundActivity || !s.lastCheck) return undefined;
  let at = Date.parse(s.lastCheck) + s.checkIntervalHours * 3_600_000;
  if (s.checkIntervalHours >= 168 && s.checkWeekday !== undefined) {
    // Weekly checks run some time on the chosen day, so just name the day.
    const d = new Date(now);
    const checkedToday = new Date(s.lastCheck).toDateString() === d.toDateString();
    let add = (s.checkWeekday - d.getDay() + 7) % 7;
    if (add === 0 && checkedToday) add = 7;
    if (add === 0) return 'today';
    if (add === 1) return 'tomorrow';
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() + add).toLocaleDateString('en-AU', { weekday: 'long' });
  }
  if (at < now) return 'soon';
  const d = new Date(at);
  const time = d.toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' }).toLowerCase();
  const today = new Date(now);
  const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  if (sameDay(d, today)) return `${d.getHours() >= 18 ? 'tonight' : 'today'} ${time}`;
  if (sameDay(d, tomorrow)) return `tomorrow ${time}`;
  return `${d.toLocaleDateString('en-AU', { weekday: 'short' })} ${time}`;
}
