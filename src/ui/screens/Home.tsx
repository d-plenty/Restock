import { greeting, todayText } from '../../lib/greeting';
import { useState } from 'react';
import { refreshText, useFullRefresh } from '../refresh';
import { allCards, allListEntries, getSettings, updateSettings } from '../../lib/db';
import { loadDemo } from '../../lib/demo';
import { addToList, takeOffList } from '../../lib/listActions'; // 0.9.5 (undo)
import { aroundPlan, shopTotals } from '../../lib/shopTotals';
import { loadRecommendations } from '../../lib/recs';
import { money } from '../../lib/units';
import { lineCost } from '../../lib/verdict';
import { useLive } from '../../lib/useLive';
import { type Recommendation } from '../../lib/verdict';
import { isBlockMessage, isNative } from '../../stores/http';
import { chainName, stockKnown, type ListEntry, type Settings } from '../../types';
import { ChainDot, ChainName, Icon, LoadingBar, OpenStoreButton, Price, SectionMark, SwapBox, Thumb } from '../components';
import { activeSections, searchChainsIn, type StoreChain } from '../../shops';
import { ActionInfoTag, MemberInfoTag, MultiInfoTag } from '../tagInfo';
import { failingStores, getHealth } from '../../lib/health';
import { exportBackup, needsBackupNudge } from '../../lib/backup';
import { syncInfo } from '../../lib/sync';
import { protection } from '../../lib/protection';
import { confirmAction } from '../../lib/confirm';
import { useNav } from '../nav';
import { RecallBanner } from './Recalls';
import { SetupNudges } from './SetupNudges';
import { serverMode } from '../../server-mode/flag';
import { ConnectionsSheet } from './Settings';
import { nextCheckWords } from '../../lib/checkSchedule';
import { getCheckLog, missedSlot, missedWords, whenWords } from '../../lib/checkLog';

export function HomeScreen() {
  const nav = useNav();
  const allRecs = useLive(loadRecommendations, []);
  const settings = useLive(getSettings, []);
  // 0.9.3: phone-to-phone sync or a Restock server counts as a copy kept elsewhere.
  const sync = useLive(syncInfo, []);
  const allEntries = useLive(allListEntries, []);
  const health = useLive(getHealth, []);
  const failingAll = health ? failingStores(health) : [];
  const [errors, setErrors] = useState<Record<string, string>>({});
  // The shops whose deals show (0.8.8: pick several, from a menu). None picked: every shop.
  const [picked, setPickedState] = useState<string[]>(() => {
    try {
      const many = localStorage.getItem('homeDealShops');
      if (many) return JSON.parse(many) as string[];
      const one = localStorage.getItem('homeDealShop');
      return one ? [one] : [];
    } catch {
      return [];
    }
  });
  const [shopMenu, setShopMenu] = useState(false);
  const setPicked = (list: string[]) => {
    setPickedState(list);
    try {
      localStorage.setItem('homeDealShops', JSON.stringify(list));
      localStorage.removeItem('homeDealShop');
    } catch {
      // storage can be unavailable
    }
  };
  // Check now syncs with the household first, then checks prices, then shares the new prices with
  // the household. Pulling down only syncs (0.8.8). One run at a time, across every tab.
  const refresh = useFullRefresh((res) => setErrors(res.errors as Record<string, string>));
  const progress = refresh.stage === 'prices' ? (refresh.progress ?? [0, 1]) : undefined;

  const cards = useLive(allCards, []);
  const [testing, setTesting] = useState(false);
  // 0.10.2: the background checks' log (above the early return: hooks always run in the same order).
  const runs = useLive(getCheckLog, []) ?? [];
  if (!allRecs || !settings || !allEntries) return <div className="screen" />;
  const { on, recs, totals, oneStop, listSaving, listed, dealChain, dealRecs, dealShops, showing, buys, altDeals, smalls, waits, skips, normal, worth, saving } =
    weekDeals(allRecs, settings, allEntries, picked);
  // Only warn about shops you still use, on a tab that's switched on.
  const failing = failingAll.filter((f) => on.some((sec) => searchChainsIn(settings.enabledChains, sec).includes(f.chain)));
  const oldest = recs.map((r) => r.group.createdAt).sort()[0];
  const backupNow = async () => {
    if (cards?.length) {
      const ok = await confirmAction('Your backup includes your card numbers', {
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
  const next = nextCheck(settings);
  // 0.10.2: a scheduled check that didn't happen says so (Advanced → Diagnostics says why).
  const missed =
    isNative() && !serverMode && settings.sync.backgroundActivity
      ? missedSlot({ intervalHours: settings.checkIntervalHours, time: settings.checkTime, weekday: settings.checkWeekday }, settings.lastCheck, runs)
      : undefined;

  const runCheck = () => {
    if (refresh.busy) return;
    setErrors({});
    refresh.run();
  };

  const today = todayText();

  return (
    <div className="screen" {...refresh.props}>
      {refresh.indicator}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div className="sub">{today}</div>
        <div className="topbar">
          <h1>{greeting()}</h1>
          <button className="icon-btn" aria-label="Settings" onClick={() => nav.push({ name: 'settings' })}>
            <Icon name="settings" size={20} />
          </button>
        </div>
        {/* Fixed tiles, not a row that scrolls sideways (0.8.8): easier to hit, nothing to swipe. */}
        {/* 0.9.12: all four, as on the web page; Receipts shows how to turn them on until they are. */}
        <div className="home-links" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
          <button onClick={() => nav.push({ name: 'cards' })}>
            <Icon name="card" size={22} />
            <span>Cards</span>
          </button>
          <button onClick={() => nav.push({ name: 'catalogues' })}>
            <Icon name="book" size={22} />
            <span>Catalogues</span>
          </button>
          <button onClick={() => nav.push({ name: 'specials' })}>
            <Icon name="flame" size={22} />
            <span>Specials</span>
          </button>
          <button onClick={() => nav.push({ name: 'receipts' })}>
            <Icon name="receipt" size={22} />
            <span>Receipts</span>
          </button>
        </div>
        <div className="checkline">
          {refresh.stage && !progress ? (
            <>
              <span>{refreshText(refresh.stage)}</span>
              <div style={{ flex: 1 }}>
                <LoadingBar seconds={6} />
              </div>
            </>
          ) : progress ? (
            <>
              <span>{refreshText('prices', refresh.progress)}</span>
              <div className="progress" style={{ flex: 1 }}>
                <div style={{ width: `${(progress[0] / Math.max(1, progress[1])) * 100}%` }} />
              </div>
            </>
          ) : (
            <>
              <span>
                {serverMode
                  ? 'Prices come from your phones'
                  : !isNative()
                  ? 'Live prices work in the Android app'
                  : settings.lastCheck
                    ? `${settings.enabledChains.some((c) => stockKnown(settings, c)) ? 'Prices & stock' : 'Prices'} updated ${whenWords(settings.lastCheck)}${next ? ` · next ${next}` : ''}`
                    : 'Prices not checked yet'}
                {missed !== undefined && (
                  <>
                    <br />
                    <button className="linkish small" style={{ padding: 0, color: 'var(--amber-ink)', fontWeight: 600 }} onClick={() => nav.push({ name: 'diagnostics' })}>
                      {missedWords(missed, runs)}. Why?
                    </button>
                  </>
                )}
              </span>
              {isNative() && (
                <button className="btn primary small check-now" onClick={runCheck} aria-label="Check prices and stock now">
                  <Icon name="refresh" size={16} /> Check now
                </button>
              )}
            </>
          )}
        </div>
      </div>

      <RecallBanner />

      {!settings.tour.active && !serverMode && <SetupNudges settings={settings} />}

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
              at the till, shopping around
              {totals.around.chains.length > 1
                ? ` · ${totals.around.chains.length} shops`
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
            !oneStop && <span className="small">No single shop has everything. Tap to compare shops.</span>
          )}
          {listSaving > 0.5 && <span className="home-list-save">About {money(listSaving)} less than buying it all at usual prices</span>}
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
            vs usual
            <br />
            prices
          </span>
        </div>
      )}

      {Object.entries(refresh.busy ? {} : errors).map(([chain, msg]) => (
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

      {!serverMode && sync && recs.length > 0 && needsBackupNudge(settings, recs.length, oldest, Date.now(), protection(false, sync).covered) && (
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
            <li>Tick it at each shop that sells it. Restock then watches the prices for you.</li>
          </ol>
          <button className="btn primary" onClick={() => nav.setTab('add')}>
            <Icon name="scan" size={18} /> Add my first item
          </button>
          <button
            className="btn ghost"
            onClick={async () => {
              await loadDemo();
              // 0.9.12: on the web page they stay in this browser (they never sync), so it says so.
              nav.toast(
                serverMode
                  ? "Sample items added, in this browser only: they never go to your phones. Remove them any time in Settings."
                  : 'Sample items added. Remove them any time in Settings.',
              );
            }}
          >
            Or look around with sample items
          </button>
        </div>
      )}

      {dealShops.length > 1 && (
        <>
          {/* All shops, or the ones you pick from a menu (0.8.8: was a row of every shop). */}
          <div className="deal-shops" role="group" aria-label="Deals at">
            <button
              className="chip"
              aria-pressed={!showing.length}
              onClick={() => {
                setPicked([]);
                setShopMenu(false);
              }}
            >
              All shops
            </button>
            <button className="chip" aria-pressed={showing.length > 0} aria-expanded={shopMenu} onClick={() => setShopMenu(!shopMenu)}>
              {showing.length === 1 ? (
                <>
                  <ChainDot chain={showing[0] as StoreChain} /> {chainName(showing[0] as StoreChain)}
                </>
              ) : showing.length > 1 ? (
                `${showing.length} shops`
              ) : (
                'Choose shops'
              )}
              <span className={`deal-caret${shopMenu ? ' open' : ''}`} aria-hidden>
                <Icon name="chevron" size={14} />
              </span>
            </button>
          </div>
          {shopMenu && (
            <div className="card flush deal-menu">
              {dealShops.map((c) => {
                const n = dealRecs.filter((r) => dealChain(r) === c).length;
                const on = showing.includes(c);
                return (
                  <label key={c} className="row">
                    <input type="checkbox" checked={on} onChange={() => setPicked(on ? showing.filter((x) => x !== c) : [...showing, c])} />
                    <ChainDot chain={c} />
                    <span className="grow">{chainName(c)}</span>
                    {n > 0 && <span className="small">{n === 1 ? '1 deal' : `${n} deals`}</span>}
                  </label>
                );
              })}
              <div className="row">
                <button className="btn small" onClick={() => setPicked([])}>
                  Show all
                </button>
                <span className="grow" />
                <button className="btn primary small" onClick={() => setShopMenu(false)}>
                  Done
                </button>
              </div>
            </div>
          )}
        </>
      )}
      {buys.length > 0 && <div className="eyebrow green">On special now</div>}
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
                  <span className="title clip" style={{ fontSize: 15 }}>
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
                    await takeOffList([id], r.group.name); // 0.9.5 (undo)
                    return;
                  }
                  const added = await addToList(r.group); // 0.9.5 (undo)
                  if (!added) nav.toast(`${r.group.name} is already on your list`);
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
          className="card note-card"
          style={{ flexDirection: 'row', alignItems: 'center', textAlign: 'left' }}
          onClick={() => nav.push({ name: 'item', groupId: r.group.id })}
        >
          <span style={{ color: 'var(--muted)' }}>
            <Icon name="close" size={18} />
          </span>
          <span style={{ flex: 1, fontSize: 13, color: 'var(--ink-2)' }}>
            {r.best?.verdict.always
              ? `Always on special: ${r.group.name} has been "on special" nearly every day for 3 weeks. Skipped.`
              : `Fake sale: ${r.group.name} is "on special" at its usual price. Skipped.`}
          </span>
        </button>
      ))}

      {normal.length > 0 && recs.length > 0 && (
        <button className="btn ghost" onClick={() => nav.setTab('pantry')}>
          {normal.length} other item{normal.length === 1 ? '' : 's'} at the usual price
        </button>
      )}
      {testing && <ConnectionsSheet settings={settings} onClose={() => setTesting(false)} />}
    </div>
  );
}

/**
 * This week on Home: the deals from every tab that's switched on, and the grocery list's totals.
 * `picked`: only deals at these shops (none: every shop). 0.9.3: also what the web's desktop Home shows.
 */
export function weekDeals(allRecs: Recommendation[], settings: Settings, allEntries: ListEntry[], picked: string[] = []) {
  // Deals from every tab that's switched on; the list summary is the grocery list.
  const on = activeSections(settings);
  const recs = allRecs.filter((r) => on.includes(r.group.section ?? 'pantry'));
  const pantryIds = new Set(allRecs.filter((r) => (r.group.section ?? 'pantry') === 'pantry').map((r) => r.group.id));
  const entries = allEntries.filter((e) => (e.groupId ? pantryIds.has(e.groupId) : (e.section ?? 'pantry') === 'pantry'));
  // Items on the shopping list, by pantry item, with the list line (so the cart button can take it off again).
  const listed = new Map(allEntries.filter((e) => !e.checked && e.groupId).map((e) => [e.groupId!, e.id]));
  const totals = shopTotals(
    entries,
    recs.filter((r) => pantryIds.has(r.group.id)),
    searchChainsIn(settings.enabledChains, 'pantry'),
    settings.listCompare,
  );
  // The store with everything that the shopping list compares against, so Home and the list agree (0.9.0).
  const oneStop = aroundPlan(totals, settings.listCompare, settings.shopAroundMin ?? 1).complete;
  // What this week's list saves against everything's normal price. Not from a sale that may have
  // ended, or a price that may be out of date (0.9.0): those aren't deals.
  const listSaving = totals.around.lines.reduce((sum, l) => {
    if (l.pick.verdict.stale) return sum;
    const normal = l.pick.stats.typical ?? l.pick.stats.current?.wasPrice;
    return normal && l.pick.price !== undefined ? sum + Math.max(0, normal * l.qty - lineCost(l.pick, l.qty)) : sum;
  }, 0);

  // Deals at one shop only, or all of them (0.7.4). The shop each deal is at: the swap's for a swap.
  const dealChain = (r: Recommendation) => (r.action === 'alt' ? r.alt : r.best)?.product.chain;
  const dealRecs = recs.filter((r) => r.action === 'buy' || r.action === 'alt' || r.action === 'small');
  // Every section follows the shop picked (0.7.5): sales, small savings, wait, fake sales, normal price.
  const dealShops = [...new Set(recs.map(dealChain).filter((c): c is NonNullable<typeof c> => !!c))].sort((a, b) =>
    chainName(a).localeCompare(chainName(b)),
  );
  const showing = picked.filter((c) => dealShops.includes(c as never));
  const atShop = (r: Recommendation) => !showing.length || showing.includes(dealChain(r) ?? '');
  const buys = recs.filter((r) => r.action === 'buy' && atShop(r));
  const altDeals = recs.filter((r) => r.action === 'alt' && atShop(r));
  const smalls = recs.filter((r) => r.action === 'small' && atShop(r));
  const waits = recs.filter((r) => r.action === 'wait' && atShop(r));
  const skips = recs.filter((r) => r.action === 'skip' && atShop(r));
  const normal = recs.filter((r) => r.action === 'none' && atShop(r));
  const worth = [...buys, ...altDeals];
  const saving = worth.reduce((sum, r) => sum + (r.saving ?? 0), 0);
  return { on, recs, pantryIds, entries, listed, totals, oneStop, listSaving, dealChain, dealRecs, dealShops, showing, buys, altDeals, smalls, waits, skips, normal, worth, saving };
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
              await takeOffList([listed], rec.group.name); // 0.9.5 (undo)
              return;
            }
            const added = await addToList(rec.group); // 0.9.5 (undo)
            if (!added) nav.toast(`${rec.group.name} is already on your list`);
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
          Also on special: {rec.alt.product.name} at {chainName(rec.alt.product.chain)}, {money(rec.alt.price)}
        </div>
      )}
    </div>
  );
}

/** When the next background check should run, in words ("tonight 5:00 pm", "tomorrow 5:00 am"). 0.9.6: the set time of day. */
export function nextCheck(
  s: { checkIntervalHours: number; checkTime?: string; checkWeekday?: number; sync: { backgroundActivity: boolean } },
  now = Date.now(),
): string | undefined {
  if (!s.sync.backgroundActivity) return undefined;
  return nextCheckWords({ intervalHours: s.checkIntervalHours, time: s.checkTime, weekday: s.checkWeekday }, now);
}
