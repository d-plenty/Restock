import { greeting, todayText } from '../../lib/greeting';
import { useState } from 'react';
import { refreshText, useFullRefresh } from '../refresh';
import { allCards, allListEntries, getSettings, updateSettings } from '../../lib/db';
import { loadDemo } from '../../lib/demo';
import { aroundPlan, shopTotals } from '../../lib/shopTotals';
import { loadRecommendations } from '../../lib/recs';
import { money } from '../../lib/units';
import { lineCost } from '../../lib/verdict';
import { useLive } from '../../lib/useLive';
import { type Recommendation } from '../../lib/verdict';
import { isNative } from '../../stores/http';
import { chainName, stockKnown, type ListEntry, type Settings } from '../../types';
import { ChainDot, Icon, LoadingBar, Sheet } from '../components';
import { activeSections, searchChainsIn, type StoreChain } from '../../shops';
import { failingStores, getHealth, getHiddenWarnings, isBlockedError, isHidden, offerUnblock } from '../../lib/health';
import { HideForADay, UnblockButton } from '../Unblock';
import { exportBackup, needsBackupNudge } from '../../lib/backup';
import { syncInfo } from '../../lib/sync';
import { protection } from '../../lib/protection';
import { confirmAction } from '../../lib/confirm';
import { useNav } from '../nav';
import { RecallBanner } from './Recalls';
import { AddBar, ItemRow } from '../simple';
import { yourShops } from './Catalogues';
import { shopTileNote } from '../../lib/ownSpecials';
import { ownCounts } from '../../lib/ownSpecialsLive';
import { TabOffer } from './SetupNudges';
import { loadSpecials } from '../../lib/specials';
import type { StoreProduct } from '../../stores';
import { UpdateBanner } from '../UpdateBanner';
import { serverMode } from '../../server-mode/flag';
import { ConnectionsSheet } from './Settings';
import { nextCheckWords, planOf } from '../../lib/checkSchedule';
import { getCheckLog, missedSlot, missedWords, whenWords } from '../../lib/checkLog';

import { startTour } from '../Tour';

export function HomeScreen() {
  const nav = useNav();
  const allRecs = useLive(loadRecommendations, []);
  const settings = useLive(getSettings, []);
  // 0.9.3: phone-to-phone sync or a Restock server counts as a copy kept elsewhere.
  const sync = useLive(syncInfo, []);
  const allEntries = useLive(allListEntries, []);
  const health = useLive(getHealth, []);
  const hidden = useLive(getHiddenWarnings, []);
  const failingAll = health ? failingStores(health).filter((f) => !isHidden(hidden, f.chain)) : [];
  const [errors, setErrors] = useState<Record<string, string>>({});
  // Check now syncs with the household first, then checks prices, then shares the new prices with
  // the household. Pulling down only syncs (0.8.8). One run at a time, across every tab.
  const refresh = useFullRefresh((res) => setErrors(res.errors as Record<string, string>));
  const progress = refresh.stage === 'prices' ? (refresh.progress ?? [0, 1]) : undefined;

  const cards = useLive(allCards, []);
  const [testing, setTesting] = useState(false);
  // 0.10.2: the background checks' log (above the early return: hooks always run in the same order).
  const runs = useLive(getCheckLog, []) ?? [];
  // 0.12.3: each shop's square button says how many of your things are on special there (its page shows them).
  const counts = useLive(async () => {
    const [r, s, e] = await Promise.all([loadRecommendations(), getSettings(), allListEntries()]);
    return ownCounts(r, yourShops(s), e);
  }, []);
  if (!allRecs || !settings || !allEntries) return <div className="screen" />;
  const { on, recs, totals, openLines, worth, saving } = weekDeals(allRecs, settings, allEntries);
  const shops = yourShops(settings);
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
      ? missedSlot(planOf(settings), settings.lastCheck, runs)
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
        {/* 0.10.10: Cards and Receipts live in More only. 0.12.2: the catalogues are here again, as buttons. */}
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

      {/* 0.12.0: adding starts here: search, or the barcode button (Add was a tab in the middle of the bar) */}
      {/* On a Restock server's web page there's no shop search (shops turn web pages away), so no search box here: Pantry says where adding is done. */}
      {!serverMode && <AddBar />}

      {/* 0.10.12: a newer Restock is out: first thing on Home, until it's installed */}
      <UpdateBanner settings={settings} />
      <RecallBanner />

      {/* 0.12.0: the "finish setting up" and tour cards are gone from Home (each thing is asked when it's first needed; both are in Settings). The household's offer of a tab it now shares stays. */}
      {!serverMode && <TabOffer settings={settings} />}

      {worth.length > 0 && (
        <div className="banner green" style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span style={{ fontSize: 14 }}>
              {worth.length} of your items {worth.length === 1 ? 'is' : 'are'} on special
            </span>
            <span className="big num">{saving > 0 ? `Save about ${money(saving)}` : 'Worth a look'}</span>
          </div>
        </div>
      )}

      {Object.entries(refresh.busy ? {} : errors).map(([chain, msg]) =>
        offerUnblock(chain, msg) && chain !== 'other' ? (
          <BlockedCard key={chain} chain={chain as StoreChain} onWorked={runCheck} maybe={!isBlockedError(msg)} />
        ) : (
          <div key={chain} className="banner amber" role="alert">
            <strong>{chainName(chain)}</strong>
            <span style={{ fontSize: 13 }}>{msg}</span>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button className="btn small" onClick={runCheck}>
                <Icon name="refresh" size={16} /> Try again
              </button>
            </div>
          </div>
        ),
      )}

      {!serverMode && sync && recs.length > 0 && needsBackupNudge(settings, recs.length, oldest, Date.now(), protection(false, sync).covered) && (
        <div className="card hint" style={{ flexDirection: 'column', gap: 8 }}>
          <strong>Back up your pantry</strong>
          {/* 0.12.0: two lines (it was a paragraph) */}
          <span>Everything is kept on this phone. A backup is the only way to get it back if the phone is lost or reset.</span>
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
        .map((f) =>
          offerUnblock(f.chain, f.error) ? (
            <BlockedCard key={f.chain} chain={f.chain} onWorked={runCheck} hide maybe={!isBlockedError(f.error)} days={f.days} />
          ) : (
            <div key={f.chain} className="banner amber" role="alert">
              <strong>
                {chainName(f.chain)} hasn't worked for {f.days} day{f.days === 1 ? '' : 's'}
              </strong>
              <span style={{ fontSize: 13 }}>
                Its prices may be out of date.{f.error ? ` Last error: ${f.error.replace(/\.$/, '')}.` : ''}
              </span>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button className="btn small" onClick={runCheck}>
                  <Icon name="refresh" size={16} /> Try again
                </button>
                <button className="btn small" onClick={() => setTesting(true)}>
                  Test connections
                </button>
              </div>
              <HideForADay chain={f.chain} />
            </div>
          ),
        )}

      {!allRecs.length && <FirstHome tourSeen={settings.tour.seen} />}

      {/* 0.12.2: Home is the way in to the catalogues: a square button for each shop. 0.12.3: My catalogue
          is merged into them (no Open my catalogue button): each shop's page is your own things on special there. */}
      {shops.length > 0 && (
        <section className="home-group" aria-labelledby="home-shops">
          <h2 className="eyebrow" id="home-shops">
            Your shops
          </h2>
          <div className="shop-tiles">
            {shops.map((c) => (
              <button
                key={c}
                className={`shop-tile${counts?.get(c) ? ' has-deals' : ''}`}
                onClick={() => nav.push({ name: 'shopcatalogue', chain: c })}
                aria-label={`${chainName(c)}: ${shopTileNote(counts?.get(c))}`}
              >
                <span className="shop-tile-icon">
                  <Icon name="shop" size={24} />
                  <ChainDot chain={c} />
                </span>
                <span className="shop-tile-name">{chainName(c)}</span>
                <span className="shop-tile-note num">{shopTileNote(counts?.get(c))}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      {/* 0.12.0: one line (the shop-by-shop totals are on the list itself) */}
      {openLines > 0 && (
        <button className="card home-list-row" onClick={() => nav.setTab('list', 'pantry')} aria-label={`Shopping list, ${openLines} to buy. Open it`}>
          <Icon name="cart" size={24} />
          <span className="grow">
            <span className="title">Shopping list</span>
            <span className="small">
              {openLines} to buy{totals.linked > 0 ? ` · about ${money(totals.around.total)}` : ''}
            </span>
          </span>
          <Icon name="chevron" size={18} />
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
  const openLines = entries.filter((e) => !e.checked).length;
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
  // Every section follows the shop picked (0.7.5): sales, small savings, wait, fake specials, normal price.
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
  return { on, recs, pantryIds, entries, openLines, listed, totals, oneStop, listSaving, dealChain, dealRecs, dealShops, showing, buys, altDeals, smalls, waits, skips, normal, worth, saving };
}

/**
 * 0.12.0: Home before anything's been added. This week's half-price lists from Woolworths and Coles
 * (the shops' own lists, kept 12 hours), so there's
 * something to tap straight away: + searches your shops for it. Where the lists can't be read
 * (no signal, the web page, a shop turning Restock away) it's the plain first step instead.
 */
function FirstHome({ tourSeen }: { tourSeen?: boolean }) {
  const nav = useNav();
  const lists = useLive(() => loadSpecials().catch(() => []), []);
  const [shop, setShop] = useState<string>();
  const [info, setInfo] = useState<StoreProduct>();
  const all = (lists ?? []).filter((l) => l.items.length);
  // A few from each shop in turn, so one shop's list doesn't fill the page.
  const mixed: StoreProduct[] = [];
  for (let i = 0; i < 6; i++) for (const l of all) if (l.items[i]) mixed.push(l.items[i]);
  const items = (shop ? (all.find((l) => l.chain === shop)?.items ?? []) : mixed).slice(0, 8);
  const half = (p: StoreProduct) => (p.wasPrice && p.price !== undefined && p.price <= p.wasPrice * 0.55 ? 'Half price' : 'Special');
  return (
    <>
      <div className="banner green first-banner">
        <span className="big">{items.length ? "This week's specials" : serverMode ? 'Nothing here yet' : 'Add what you buy'}</span>
        <span>
          {items.length
            ? 'Tap + on anything you buy. Restock keeps watching its price for you.'
            : serverMode
              ? 'Add what you buy on a phone: adding is by shop search, which only phones can do. This page then shows what your phones found.'
              : 'Search for it or scan its barcode. Restock watches the price and tells you when it is a real special.'}
        </span>
      </div>
      {lists === undefined && (
        <div role="status" className="small">
          Getting this week's specials…
          <LoadingBar seconds={12} />
        </div>
      )}
      {all.length > 1 && (
        <div className="chips" role="group" aria-label="Specials at">
          <button className="chip" aria-pressed={!shop} onClick={() => setShop(undefined)}>
            All
          </button>
          {all.map((l) => (
            <button key={l.chain} className="chip" aria-pressed={shop === l.chain} onClick={() => setShop(l.chain)}>
              {chainName(l.chain)}
            </button>
          ))}
        </div>
      )}
      {items.length > 0 && (
        <div className="card flush">
          {items.map((p) => (
            <ItemRow
              key={`${p.chain}:${p.storeProductId}`}
              photo={p.imageUrl}
              name={p.name}
              chain={p.chain}
              price={p.price}
              note={{ text: half(p), tone: 'good' }}
              onInfo={() => setInfo(p)}
              action={
                <button
                  className="btn primary plus-btn"
                  aria-label={`Add ${p.name}`}
                  onClick={() => nav.push({ name: 'add', query: p.name, preTick: { chain: p.chain as StoreChain, storeProductId: String(p.storeProductId), product: p } })}
                >
                  <Icon name="plus" size={22} />
                </button>
              }
            />
          ))}
        </div>
      )}
      <button
        className="btn ghost"
        onClick={async () => {
          await loadDemo();
          // 0.9.12: on the web page they stay in this browser (they never sync), so it says so.
          nav.toast(
            serverMode
              ? 'Sample items added, in this browser only: they never go to your phones. Remove them any time in Settings.'
              : 'Sample items added. Remove them any time in Settings.',
          );
        }}
      >
        Look around with sample items
      </button>
      {!serverMode && !tourSeen && (
        <button className="btn ghost" onClick={() => void startTour()}>
          Take the two-minute tour
        </button>
      )}
      {info && (
        <Sheet title={info.name} onClose={() => setInfo(undefined)}>
          <dl className="pinfo-rows">
            <div>
              <dt>
                <ChainDot chain={info.chain} /> Now at {chainName(info.chain)}
              </dt>
              <dd className="num big">{money(info.price)}</dd>
            </div>
            {info.wasPrice !== undefined && (
              <div>
                <dt>Was</dt>
                <dd className="num">{money(info.wasPrice)}</dd>
              </div>
            )}
            {info.wasPrice !== undefined && info.price !== undefined && info.wasPrice > info.price && (
              <div>
                <dt>You save</dt>
                <dd className="num">{money(info.wasPrice - info.price)}</dd>
              </div>
            )}
          </dl>
          <p className="small" style={{ margin: 0 }}>
            This is what {chainName(info.chain)} says. Add it and Restock starts its own price history, so next time it can tell you whether the
            special is a real one.
          </p>
        </Sheet>
      )}
    </>
  );
}

/** When the next background check should run, in words ("tonight 5:00 pm", "tomorrow 5:00 am"). 0.9.6: the set time of day. */
export function nextCheck(
  s: { checkIntervalHours: number; checkTime?: string; checkWeekday?: number; checkDays?: number[]; sync: { backgroundActivity: boolean } },
  now = Date.now(),
): string | undefined {
  // 0.11.0: Off (no days) says nothing here, like background activity off
  if (!s.sync.backgroundActivity || (Array.isArray(s.checkDays) && !s.checkDays.length)) return undefined;
  return nextCheckWords(planOf(s), now);
}

/**
 * 0.10.4: a shop that's turning Restock away. It says plainly that it's the shop's website checking
 * for bots, not Restock, then the big green Unblock and a small grey "Hide for a day".
 * 0.10.5: also for a shop read through the hidden browser that never answers or finds nothing
 * (`maybe`): its check most likely never cleared, so Unblock comes first, with Try again beside it.
 */
function BlockedCard({ chain, onWorked, hide, maybe, days }: { chain: StoreChain; onWorked: () => void; hide?: boolean; maybe?: boolean; days?: number }) {
  return (
    <div className="banner amber" role="alert">
      <strong>
        {maybe
          ? `${chainName(chain)} ${days ? `hasn't worked for ${days} day${days === 1 ? '' : 's'}` : "isn't answering"}`
          : `${chainName(chain)} is blocking Restock`}
      </strong>
      <span style={{ fontSize: 13 }}>
        {maybe
          ? 'Its website may be checking for bots. That’s its check, not Restock’s. Unblock it once and prices carry on.'
          : 'Its website is checking for bots. That’s its check, not Restock’s. Unblock it once and prices carry on.'}
      </span>
      <div className="unblock-actions">
        <UnblockButton chain={chain} onWorked={onWorked} />
        {!isNative() && <span className="small">Unblock is in the Android app: the shop’s page opens on your phone.</span>}
        {maybe && (
          <button className="btn small" style={{ alignSelf: 'flex-start', marginTop: 6 }} onClick={onWorked}>
            <Icon name="refresh" size={16} /> Try again
          </button>
        )}
        {hide && <HideForADay chain={chain} />}
      </div>
    </div>
  );
}
