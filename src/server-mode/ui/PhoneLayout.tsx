// 0.9.6 (iPhone): the web app on a phone-sized screen looks like the Android app. The phone screens
// are the app's own (src/ui/screens, through App.tsx); this file adds what a server needs around
// them, in place of 0.9.5's navy strip along the top:
// - the bottom tab bar, the phone's own (Home, Pantry, Keg, Health, List: same order, icons and
//   words, the same .tabs styles), with More where the phone has Add (adding by shop search is on
//   the List here). More holds what the strip had (Server, Activity, Data, Account), Settings,
//   Specials and catalogues, Cards and Receipts, the way the phone keeps them off the bar.
// - the notices (new version, offline, home screen) at the top, below the notch.
// Wide windows (from 1000 px) keep the desktop layout (Desktop.tsx); nothing here shows there.
import { useEffect, useRef, useSyncExternalStore, type ReactNode } from 'react';
import { getSettings } from '../../lib/db';
import { agoText } from '../../lib/sync';
import { useLive } from '../../lib/useLive';
import { activeSections } from '../../shops';
import { betaFor, Icon, TopBar } from '../../ui/components';
import { isSectionTab, useNav, type Screen, type Tab } from '../../ui/nav';
import { isV3 } from '../api';
import { syncNow, unsentChanges } from '../live';
import { session } from '../session';
import { PwaBanners, useIsOffline } from '../pwa/Banners';
import { InstallHelpLink } from '../pwa/InstallHelp';
import { NEEDS_SIGNAL, type SignalPage } from '../pwa/offlineData';
import { useNow, useStatus } from './ServerScreens';
import { peekStartOn } from './deskShared';
import '../phone.css';

// ---------- is More the screen showing? (for the tab bar) ----------

let moreOpen = 0;
const moreSubs = new Set<() => void>();
const onMore = (fn: () => void) => (moreSubs.add(fn), () => void moreSubs.delete(fn));
const setMore = (d: number) => {
  moreOpen += d;
  document.documentElement.classList.toggle('pt-more-open', moreOpen > 0);
  moreSubs.forEach((f) => f());
};
const useMoreOpen = () => useSyncExternalStore(onMore, () => moreOpen > 0);

const BAR: { id: Tab; label: string; icon: string }[] = [
  { id: 'home', label: 'Home', icon: 'home' },
  { id: 'pantry', label: 'Pantry', icon: 'pantry' },
  { id: 'keg', label: 'Keg', icon: 'keg' },
  { id: 'pharmacy', label: 'Health', icon: 'pharmacy' },
  { id: 'list', label: 'List', icon: 'cart' },
];

/** The phone's tab bar, with More in place of Add. */
function PhoneTabs() {
  const nav = useNav();
  const settings = useLive(getSettings, []);
  const more = useMoreOpen();
  const bar = useRef<HTMLElement>(null);
  const ready = !!settings;
  useEffect(() => {
    const el = bar.current;
    if (!el) return;
    const set = () => document.documentElement.style.setProperty('--pt-bar-h', `${el.offsetHeight}px`);
    set();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(set) : undefined;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, [ready]);
  if (!settings) return null;
  // As App.tsx: Keg and Health show when they're on and not hidden from the bar.
  const on = activeSections(settings);
  const inBar = on.filter((sec) => sec === 'pantry' || !settings.hiddenTabs?.includes(sec));
  const tabs = BAR.filter((t) => !isSectionTab(t.id) || inBar.includes(t.id));
  const shown: Tab = isSectionTab(nav.tab) && !inBar.includes(nav.tab) ? 'pantry' : nav.tab;
  const n = tabs.length + 1;
  return (
    <nav ref={bar} className="tabs pt-tabs" aria-label="Main" style={{ gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` }}>
      {tabs.map((t) => (
        <button
          key={t.id}
          className={`tab${t.id === 'pharmacy' ? ' pharm' : ''}`}
          aria-current={!more && shown === t.id ? 'page' : undefined}
          onClick={() => nav.setTab(t.id)}
        >
          <Icon name={t.icon} />
          {t.label}
          {betaFor(t.id, true)}
        </button>
      ))}
      <button
        className="tab"
        aria-current={more ? 'page' : undefined}
        onClick={() => {
          if (!more) nav.push({ name: 'server', page: 'more' });
        }}
      >
        <Icon name="more" />
        More
      </button>
    </nav>
  );
}

/**
 * In the phone layout, in place of 0.9.5's strip: the notices at the top and the tab bar at the
 * bottom (placed there by CSS order, App.tsx's own bar is hidden).
 */
export function PhoneChrome() {
  const nav = useNav();
  // Straight after Set up this server: Server and phones, with Add a phone open (as the strip did).
  useEffect(() => {
    if (peekStartOn() === 'add-phone') nav.push({ name: 'server', page: 'phones' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const top = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = document.documentElement;
    root.classList.add('web-phone');
    // The notices' and the tab bar's heights, so screens opened on top sit between them (phone.css).
    const measure = () => {
      const h = top.current?.offsetHeight ?? 0;
      root.style.setProperty('--pt-top-h', `${h}px`);
      root.classList.toggle('pt-has-top', h > 0);
    };
    measure();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : undefined;
    if (top.current) ro?.observe(top.current);
    window.addEventListener('resize', measure);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', measure);
      root.classList.remove('web-phone', 'pt-has-top');
      root.style.removeProperty('--pt-top-h');
      root.style.removeProperty('--pt-bar-h');
    };
  }, []);
  return (
    <>
      <div className="pt-top" ref={top}>
        <PwaBanners />
      </div>
      <PhoneTabs />
    </>
  );
}

// ---------- More ----------

function Row({ icon, title, sub, onClick, warn }: { icon: string; title: string; sub?: ReactNode; onClick: () => void; warn?: boolean }) {
  return (
    <button className="row pt-row" onClick={onClick}>
      <span className="pt-row-icon" aria-hidden>
        <Icon name={icon} size={20} />
      </span>
      <span className="grow">
        <span className="title">{title}</span>
        {sub && <span className={`small${warn ? ' pt-warn' : ''}`}>{sub}</span>}
      </span>
      <Icon name="chevron" size={18} />
    </button>
  );
}

/** The household, how fresh this phone's copy is, and Sync now. */
function SyncCard() {
  const st = useStatus();
  const now = useNow();
  const offline = useIsOffline();
  const fresh = st.phoneAt ?? st.at;
  const unsent = unsentChanges();
  const line = offline
    ? 'Offline'
    : st.error
      ? `Can't reach the server. ${st.error}`
      : st.busy && !fresh
        ? 'Getting your household…'
        : fresh
          ? `Synced with your phones ${agoText(fresh, now)}`
          : 'Not synced yet';
  return (
    <div className="card pt-sync">
      <div className="pt-sync-text">
        <span className="title clip">{st.household ?? session()?.household ?? 'Your household'}</span>
        <span className="small" role="status">
          {st.busy && <span className="strip-dot" aria-hidden />} {line}
          {unsent > 0 ? ` · ${unsent} change${unsent === 1 ? '' : 's'} to send` : ''}
        </span>
      </div>
      <button className="btn" onClick={() => void syncNow()} disabled={st.busy}>
        <Icon name="refresh" size={18} /> {st.busy ? 'Syncing…' : 'Sync now'}
      </button>
    </div>
  );
}

/** More: what the phone keeps off its tab bar, and the server's own pages. */
export function MorePage() {
  const nav = useNav();
  const settings = useLive(getSettings, []);
  const offline = useIsOffline();
  const house = isV3();
  useEffect(() => {
    setMore(1);
    return () => setMore(-1);
  }, []);
  const go = (s: Screen) => nav.push(s);
  const signal = (sub: string) => (offline ? 'Needs signal' : sub);
  return (
    <div className="screen pt-more">
      <TopBar title="More" back={false} />
      <SyncCard />
      <div className="card flush">
        <Row icon="flame" title="Specials and catalogues" sub={offline ? 'As last saved on this phone' : 'What your phones found on special'} onClick={() => go({ name: 'specials' })} />
        <Row icon="card" title="Cards" sub="Loyalty and gift cards, on this phone" onClick={() => go({ name: 'cards' })} />
        {settings?.receipts.enabled && <Row icon="receipt" title="Receipts" sub="Shared by your phones" onClick={() => go({ name: 'receipts' })} />}
      </div>
      <div className="eyebrow">Your household</div>
      <div className="card flush">
        <Row icon="settings" title="Settings" sub="Shops, lists, look and colours" onClick={() => go({ name: 'settings' })} />
        <Row icon="server" title={house ? 'Server and phones' : 'Phones'} sub={signal('The phones using this server')} warn={offline} onClick={() => go({ name: 'server', page: 'phones' })} />
        {house && <Row icon="chart" title="Data" sub={signal('Spending, prices, export and import')} warn={offline} onClick={() => go({ name: 'server', page: 'data' })} />}
        <Row icon="list" title="Activity" sub={signal("What's been sent and fetched")} warn={offline} onClick={() => go({ name: 'server', page: 'activity' })} />
      </div>
      <div className="eyebrow">This phone</div>
      <div className="card flush">
        <Row icon="lock" title="Account" sub="Passphrase, sign out" onClick={() => go({ name: 'server', page: 'account' })} />
        <div className="row pt-help">
          <InstallHelpLink className="linkish pt-help-link" />
        </div>
      </div>
      <p className="small pt-version">Restock {__APP_VERSION__} · web</p>
    </div>
  );
}

// ---------- pages that need signal ----------

/** In place of a page that asks the server each time, while offline. */
export function NeedsSignal({ title, page }: { title: string; page: SignalPage }) {
  const st = useStatus();
  return (
    <div className="screen">
      <TopBar title={title} />
      <p className="pwa-note warn" role="status">
        <Icon name="wifi" size={18} />
        <span>
          <strong>Needs signal.</strong> {NEEDS_SIGNAL[page]} works when you're back online. Your lists, pantry and cards work now.
        </span>
      </p>
      <button className="btn" onClick={() => void syncNow()} disabled={st.busy}>
        <Icon name="refresh" size={18} /> {st.busy ? 'Trying…' : 'Try again'}
      </button>
    </div>
  );
}

/** The page, or Needs signal while offline. */
export function OnlineOnly({ title, page, children }: { title: string; page: SignalPage; children: ReactNode }) {
  const offline = useIsOffline();
  return offline ? <NeedsSignal title={title} page={page} /> : <>{children}</>;
}

/** "Search the shops · Needs signal", in place of a search button while offline. */
export function SearchNeedsSignal() {
  return (
    <button type="button" className="btn" disabled aria-disabled>
      <Icon name="wifi" size={18} /> <span className="clip">Search the shops · Needs signal</span>
    </button>
  );
}
