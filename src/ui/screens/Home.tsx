import { useNow } from '../useNow';
import { deviceWord, isPad } from '../../lib/platform';
import { saveNeedsWarning, saveNow, saveState, subscribeSaveState } from '../../lib/saveState';
import { greeting, todayText } from '../../lib/greeting';
import { nameOf } from '../../lib/myName';
import { holidayColours, holidayGreeting, holidayNow } from '../../lib/holiday';
import { BunnyEars, HolidayDecor, SantaHat } from '../HolidayDecor';
import { useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { askResume, clearTrip, loadTrip, subscribeTrip } from '../../lib/trip';
import { refreshText, useFullRefresh } from '../refresh';
import { allCards, allListEntries, getSettings, updateSettings } from '../../lib/db';
import { loadDemo } from '../../lib/demo';
import { aroundPlan, shopTotals } from '../../lib/shopTotals';
import { loadRecommendations } from '../../lib/recs';
import { money } from '../../lib/units';
import { lineCost } from '../../lib/verdict';
import { useLive, useSettings } from '../../lib/useLive';
import { type Recommendation } from '../../lib/verdict';
import { isNative } from '../../stores/http';
import { chainName, type ListEntry, type Settings } from '../../types';
import { ChainDot, Icon, LoadingBar, ScreenWaiting } from '../components';
import { activeSections, searchChainsIn, type StoreChain } from '../../shops';
import { failingStores, getHealth, getHiddenWarnings, isBlockedError, isHidden, offerUnblock } from '../../lib/health';
import { HideForADay, TryAgain, TurnOffShop, UnblockButton } from '../Unblock';
import { exportBackup, needsBackupNudge, putOffBackup } from '../../lib/backup';
import { syncInfo } from '../../lib/sync';
import { protection } from '../../lib/protection';
import { confirmAction } from '../../lib/confirm';
import { useNav } from '../nav';
import { RecallBanner } from './Recalls';
import { CardExpiryNotice } from './CardExpiryNotice';
import { AddBar } from '../simple';
import { yourShops } from './Catalogues';
import { shopTileNote } from '../../lib/ownSpecials';
import { ownCounts } from '../../lib/ownSpecialsLive';
import { TabOffer } from './SetupNudges';
import { UpdateBanner } from '../UpdateBanner';
import { ConnectionsSheet } from './SettingsParts';
import { planOf } from '../../lib/checkSchedule';
import { getCheckLog, missedSlot, missedWords, whenWords } from '../../lib/checkLog';

import { startTour } from '../Tour';

export function HomeScreen() {
  const now = useNow(60_000);
  const nav = useNav();
  const allRecs = useLive(loadRecommendations, []);
  const settings = useSettings();
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
  if (!allRecs || !settings || !allEntries) return <ScreenWaiting back={false} name="Home" />;
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
  // 0.10.2: a scheduled check that didn't happen says so (Advanced → Diagnostics says why).
  const missed =
    isNative() && settings.sync.backgroundActivity
      ? missedSlot(planOf(settings), settings.lastCheck, runs)
      : undefined;

  const runCheck = () => {
    if (refresh.busy) return;
    setErrors({});
    refresh.run();
  };

  const today = todayText();
  // 0.16.0: the decoration follows the holiday's colours (only on the default theme).
  const decor = holidayColours(settings);

  return (
    <div className="screen" {...refresh.props}>
      {refresh.indicator}
      {/* 0.12.4: the navy top every screen has: the greeting, the price check, the search box and this week's saving */}
      <div className="navy-top home-top">
      {/* 0.16.0: a holiday's little decoration, on the default theme (HolidayDecor.tsx) */}
      <HolidayDecor holiday={decor} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div className="sub">{today}</div>
        <div className="topbar">
          {/* 0.12.5: no Settings cog here; Settings is in More */}
          {/* 0.16.0: with the person's name, when they gave one, and the holiday's hello */}
          <h1>
            {holidayGreeting(holidayNow(settings), greeting())}
            {nameOf(settings) && (
              <>
                ,{' '}
                <span className="hello-name">
                  {nameOf(settings)}
                  {decor === 'easter' && <BunnyEars />}
                </span>
              </>
            )}
          </h1>
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
                {!isNative()
                  ? 'Live prices work in the Android app'
                  : settings.lastCheck
                    ? // 0.17.0: one short line (when the next check is, is in Settings → Prices and deals)
                      `Prices updated ${whenWords(settings.lastCheck)}`
                    : 'Prices not checked yet'}
                {missed !== undefined && (
                  <>
                    <br />
                    <button className="linkish small" style={{ padding: 0, fontWeight: 600 }} onClick={() => nav.push({ name: 'diagnostics' })}>
                      {missedWords(missed, runs)}. Why?
                    </button>
                  </>
                )}
              </span>
              {isNative() && (
                <button className="btn primary small check-now" onClick={runCheck} aria-label="Check prices and stock now">
                  <Icon name="refresh" size={16} /> Check now
                  {decor === 'christmas' && <SantaHat />}
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {/* 0.12.0: adding starts here: search, or the barcode button (Add was a tab in the middle of the bar) */}
      {/* On a Restock server's web page there's no shop search (shops turn web pages away), so no search box here: Pantry says where adding is done. */}
      <AddBar />
      {worth.length > 0 && (
        <div className="navy-sum">
          <span>
            {worth.length} of your items {worth.length === 1 ? 'is' : 'are'} on special
          </span>
          <span className="navy-sum-big num">{saving > 0 ? `Save about ${money(saving)}` : 'Worth a look'}</span>
        </div>
      )}
      </div>

      {/* 0.12.10: a shop you stepped out of (or that Android closed): pick it up, or begin again */}
      <TripCard open={allEntries.filter((e) => !e.checked).length} />
      {/* 0.10.12: a newer Restock is out: first thing on Home, until it's installed */}
      <UpdateBanner settings={settings} />
      <RecallBanner />
      <SaveWarning />

      {/* 0.12.0: the "finish setting up" and tour cards are gone from Home (each thing is asked when it's first needed; both are in Settings). The household's offer of a tab it now shares stays. */}
      <TabOffer settings={settings} />

      {Object.entries(refresh.busy ? {} : errors).map(([chain, msg]) =>
        offerUnblock(chain, msg) && chain !== 'other' ? (
          <BlockedCard key={chain} chain={chain as StoreChain} onWorked={runCheck} maybe={!isBlockedError(msg)} />
        ) : (
          <div key={chain} className="banner amber" role="alert">
            <strong>{chainName(chain)}</strong>
            <span style={{ fontSize: 13 }}>{msg}</span>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              {chain === 'other' ? (
                <button className="btn small" onClick={runCheck}>
                  <Icon name="refresh" size={16} /> Try again
                </button>
              ) : (
                <TryAgain chain={chain as StoreChain} onWorked={runCheck} />
              )}
            </div>
          </div>
        ),
      )}

      {/* 0.14.0: a loyalty card about to run out (Cards → its expiry date). */}
      <CardExpiryNotice />

      {sync && recs.length > 0 && needsBackupNudge(settings, recs.length, oldest, now, protection(false, sync).covered) && (
        <div className="card hint" style={{ flexDirection: 'column', gap: 8 }}>
          <strong>Back up your pantry</strong>
          {/* 0.12.0: two lines (it was a paragraph) */}
          <span>{isPad() ? 'Everything is kept on this iPad. A backup is the only way to get it back if the iPad is lost or reset.' : 'Everything is kept on this phone. A backup is the only way to get it back if the phone is lost or reset.'}</span>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn small primary" onClick={backupNow}>
              Back up now
            </button>
            <button className="btn small" onClick={() => updateSettings(putOffBackup(settings))}>
              Not now
            </button>
          </div>
        </div>
      )}

      {failing
        .filter((f) => !errors[f.chain])
        .map((f) =>
          f.stuck ? (
            <NoProductsCard key={f.chain} chain={f.chain} days={f.days} onWorked={runCheck} />
          ) : offerUnblock(f.chain, f.error) ? (
            <BlockedCard key={f.chain} chain={f.chain} onWorked={runCheck} hide maybe={!isBlockedError(f.error)} days={f.days} />
          ) : (
            <div key={f.chain} className="banner amber" role="alert">
              <strong>
                {chainName(f.chain)} hasn't worked for {f.days} day{f.days === 1 ? '' : 's'}
              </strong>
              <span style={{ fontSize: 13 }}>
                Its prices may be out of date.{f.error ? ` Last error: ${f.error.replace(/\.$/, '')}.` : ''}
              </span>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <TryAgain chain={f.chain} onWorked={runCheck} />
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
                {/* The name never breaks inside a word: it gets smaller to fit its longest word (styles.css). */}
                <FitName name={chainName(c)} />
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
function weekDeals(allRecs: Recommendation[], settings: Settings, allEntries: ListEntry[], picked: string[] = []) {
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
 * Home before anything's been added. 0.12.4: one card, "Add what you buy", with Search and Scan
 * (it listed Woolworths' and Coles' half-price specials; a new phone asks the shops for nothing now
 * until you search). Your shops' buttons show under it as soon as you've picked shops.
 */
function FirstHome({ tourSeen }: { tourSeen?: boolean }) {
  const nav = useNav();
  return (
    <>
      <div className="card first-card">
        <strong className="first-card-title">Add what you buy</strong>
        <span className="small">
          Search for it or scan its barcode. Restock watches the price and tells you when it is a real special.
        </span>
        <div className="two">
          <button className="btn primary" onClick={() => nav.push({ name: 'add' })}>
            <Icon name="search" size={18} /> Search
          </button>
          <button className="btn" onClick={() => nav.push({ name: 'add', scan: true })}>
            <Icon name="scan" size={18} /> Scan
          </button>
        </div>
      </div>
      <button
        className="btn ghost"
        onClick={async () => {
          await loadDemo();
          // 0.9.12: on the web page they stay in this browser (they never sync), so it says so.
          nav.toast(
            'Sample items added. Remove them any time in Settings.',
          );
        }}
      >
        Look around with sample items
      </button>
      {!tourSeen && (
        <button className="btn ghost" onClick={() => void startTour()}>
          Take the two-minute tour
        </button>
      )}
    </>
  );
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
        {maybe && <TryAgain chain={chain} onWorked={onWorked} />}
        {hide && <HideForADay chain={chain} />}
      </div>
    </div>
  );
}

/** The longest word's length, in letters (at least 6, so a short name keeps the usual size). */
const longestWord = (name: string): number => Math.max(6, ...name.split(/\s+/).map((w) => w.length));

/**
 * A shop's name on its tile. It breaks only between words and gets smaller to fit its longest word:
 * styles.css sizes it from --w, that word's width at a 1px text size, measured in the font the phone
 * actually uses (an iPhone's letters are wider than most). Until it's measured, a guess from the length.
 */
function FitName({ name }: { name: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [w, setW] = useState(() => longestWord(name) * 0.62);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ctx = document.createElement('canvas').getContext('2d');
    if (!ctx) return;
    const cs = getComputedStyle(el);
    ctx.font = `${cs.fontStyle} ${cs.fontWeight} 100px ${cs.fontFamily}`;
    const widest = Math.max(...name.split(/\s+/).map((word) => ctx.measureText(word).width)) / 100;
    // A little room for rounding, and never bigger than a six-letter word would make it.
    // Measured from the drawn text, so it can only be set once it's on the screen.
    // eslint-disable-next-line react/set-state-in-effect
    if (widest > 0) setW(Math.max(widest * 1.04, 6 * 0.55));
  }, [name]);
  return (
    <span ref={ref} className="shop-tile-name" style={{ '--w': w } as CSSProperties}>
      {name}
    </span>
  );
}

/** The iPhone and iPad app couldn't write its database file (lib/saveState): said plainly, with Try again. */
function SaveWarning() {
  const s = useSyncExternalStore(subscribeSaveState, saveState, saveState);
  const [busy, setBusy] = useState(false);
  if (!saveNeedsWarning(s)) return null;
  return (
    <div className="banner amber" role="alert">
      <strong>Restock couldn’t save your changes</strong>
      <span style={{ fontSize: 13 }}>They’re kept while Restock stays open. Free up some storage on this {deviceWord()}, then try again.</span>
      <button
        className={`btn small${busy ? ' is-busy' : ''}`}
        style={{ alignSelf: 'flex-start' }}
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void saveNow().finally(() => setBusy(false));
        }}
      >
        Try again
      </button>
    </div>
  );
}

/**
 * A shop that Unblock can't fix (health.isStuck): opening its page didn't help, or it's given nothing
 * for a week. Its website has most likely stopped listing products, so the main button turns it off.
 */
function NoProductsCard({ chain, days, onWorked }: { chain: StoreChain; days: number; onWorked: () => void }) {
  const name = chainName(chain);
  return (
    <div className="banner amber" role="alert">
      <strong>
        {name} hasn't worked for {days} day{days === 1 ? '' : 's'}
      </strong>
      <span style={{ fontSize: 13 }}>Restock can’t find products on its website. It may not list them online any more.</span>
      <div className="unblock-actions">
        <TurnOffShop chain={chain} primary />
        <TryAgain chain={chain} onWorked={onWorked} />
        <HideForADay chain={chain} />
      </div>
    </div>
  );
}

/** 0.12.10: "You were shopping": Resume shopping, or Start fresh. Shown while a trip is kept (lib/trip). */
function TripCard({ open }: { open: number }) {
  const nav = useNav();
  const trip = useSyncExternalStore(subscribeTrip, () => loadTrip(), () => undefined);
  if (!trip || !open) return null;
  const shops = trip.chosen.map((c) => chainName(c as StoreChain));
  const done = trip.doneAt.filter((d) => trip.chosen.includes(d)).length;
  return (
    <div className="card trip-card" role="region" aria-label="Shopping you paused">
      <div>
        <div className="title">You were shopping</div>
        <div className="small">
          {shops.length <= 3 ? shops.join(', ') : `${shops.length} shops`}
          {trip.chosen.length > 1 ? ` · ${done} of ${trip.chosen.length} shops done` : ''}
        </div>
      </div>
      <div className="two">
        <button
          className="btn primary"
          onClick={() => {
            askResume();
            nav.setTab('list');
          }}
        >
          Resume shopping
        </button>
        <button
          className="btn"
          onClick={() => {
            clearTrip();
            nav.setTab('list');
            nav.toast('Starting fresh. What you ticked stays ticked.');
          }}
        >
          Start fresh
        </button>
      </div>
    </div>
  );
}
