// 0.9.3: the web app on a Restock server at desktop widths: a navy sidebar and wide pages. The same
// navigation as the phone layout (nav.ts tabs and screens); App.tsx hands over here from 1000 px.
// Narrower windows keep the phone layout.
// 0.9.4: Server and phones (a house's own page), Activity and logs, Home Assistant on the server,
// Specials and catalogues from what phones shared, and Sync now and Sign out always in the foot.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { allListEntries, getSettings } from '../../lib/db';
import { agoText } from '../../lib/sync';
import { useLive } from '../../lib/useLive';
import { SECTION_NAMES } from '../../shops';
import { Icon } from '../../ui/components';
import { isSectionTab, useNav, type Screen, type Tab } from '../../ui/nav';
import { api, api3, isV3, serverInfo } from '../api';
import type { DesktopProps } from '../flag';
import { syncNow } from '../live';
import { session } from '../session';
import { ActivityLogs } from './DeskActivity';
import { HandoverCard, ServerAndPhones } from './DeskServer';
import { DeskSpecials } from './DeskSpecials';
import { ServerHomeAssistant } from './ServerHomeAssistant';
import { peekStartOn } from './deskShared';
import { signOutHere } from './settingsData';
import { DeskHome } from './DeskHome';
import { DeskHousehold } from './DeskHousehold';
import { DeskList } from './DeskList';
import { DeskPantry } from './DeskPantry';
import { DeskSettings } from './DeskSettings';
import { useNow, useStatus } from './ServerScreens';
import '../desk.css';

type Place = Tab | 'specials' | 'receipts' | 'household' | 'settings';

/** Which sidebar entry a screen belongs to (by the first screen opened over the tab). */
function placeOf(tab: Tab, stack: Screen[]): Place {
  const s = stack[0];
  if (!s) return tab;
  if (s.name === 'specials' || s.name === 'catalogues' || s.name === 'mycatalogue') return 'specials';
  if (s.name === 'receipts' || s.name === 'receipt') return 'receipts';
  if (s.name === 'server' || s.name === 'cards') return 'household';
  if (s.name === 'settings' || s.name === 'household' || s.name === 'homeAssistant') return 'settings';
  return tab;
}

/** The desktop's own pages in place of a phone screen (undefined: the phone screen, centred). */
function deskScreen(top: Screen): ReactNode | undefined {
  const house = isV3();
  if (top.name === 'settings' || top.name === 'household') return <DeskSettings />;
  if (top.name === 'server' && top.page === 'phones')
    return house ? (
      <ServerAndPhones />
    ) : (
      <DeskHousehold extra={serverInfo()?.api === 3 && serverInfo()?.mode === 'v2' ? <HandoverCard /> : undefined} />
    );
  if (top.name === 'server' && top.page === 'activity' && house) return <ActivityLogs />;
  if (top.name === 'homeAssistant' && house) return <ServerHomeAssistant />;
  if (top.name === 'specials' || top.name === 'catalogues') return <DeskSpecials />;
  return undefined;
}

const TAB_ICON: Record<string, string> = { home: 'home', pantry: 'pantry', keg: 'keg', pharmacy: 'pharmacy' };

/** How many phones use this server, checked when a sync round finishes (at most once a minute). */
function usePhoneCount(at: string | undefined): number | undefined {
  const [n, setN] = useState<number>();
  const last = useRef(0);
  useEffect(() => {
    if (Date.now() - last.current < 15_000 && n !== undefined) return;
    last.current = Date.now();
    (isV3() ? api3.phones().then((p) => p.filter((x) => !x.status || x.status === 'active')) : api.devices())
      .then((d) => setN(d.length))
      .catch(() => undefined);
  }, [at, n]);
  return n;
}

function SyncFoot() {
  const st = useStatus();
  const now = useNow();
  const phones = usePhoneCount(st.at);
  const fresh = st.phoneAt ?? st.at;
  const line = st.error ? "Can't reach the server" : st.busy && !fresh ? 'Getting your household…' : fresh ? `Synced ${agoText(fresh, now)}` : 'Not synced yet';
  const sub = st.error ?? (phones === undefined ? '' : phones === 1 ? '1 phone on this server' : `${phones} phones on this server`);
  return (
    <div className={`dk-sync${st.error ? ' trouble' : ''}`}>
      <button className="dk-foot-btn primary" onClick={() => void syncNow()} disabled={st.busy} aria-describedby="dk-sync-status">
        <Icon name="refresh" size={18} /> {st.busy ? 'Syncing…' : 'Sync now'}
      </button>
      <button className="dk-foot-btn" onClick={() => void signOutHere()}>
        Sign out
      </button>
      <span id="dk-sync-status" className="dk-sync-status" role="status">
        <span className="dk-sync-line">
          <span className={`dk-sync-dot${st.busy ? ' busy' : ''}`} aria-hidden />
          {line}
        </span>
        {sub && <span className="dk-sync-sub">{sub}</span>}
      </span>
    </div>
  );
}

function SideNav({ tabs, place, go }: { tabs: Tab[]; place: Place; go: (p: Place) => void }) {
  const st = useStatus();
  const entries = useLive(allListEntries, []);
  const settings = useLive(getSettings, []);
  const toBuy = entries?.filter((e) => !e.checked).length ?? 0;
  const item = (p: Place, label: string, icon: string, extra?: ReactNode) => (
    <button key={p} className="dk-nav-item" aria-current={place === p ? 'page' : undefined} onClick={() => go(p)}>
      <Icon name={icon} size={20} />
      <span className="dk-nav-label">{label}</span>
      {extra}
    </button>
  );
  return (
    <nav className="dk-nav" aria-label="Restock">
      <div className="dk-brand">
        <span className="dk-mark" aria-hidden>
          R
        </span>
        <span className="dk-brand-text">
          <strong>Restock</strong>
          <span className="clip">{st.household ?? session()?.household ?? 'Your household'}</span>
        </span>
      </div>
      {tabs
        .filter((t) => t === 'home' || isSectionTab(t))
        .map((t) => item(t, t === 'home' ? 'Home' : SECTION_NAMES[t as keyof typeof SECTION_NAMES], TAB_ICON[t] ?? 'home'))}
      {item(
        'list',
        'Shopping list',
        'list',
        toBuy > 0 ? (
          <span className="dk-count" aria-label={`${toBuy} to buy`}>
            {toBuy}
          </span>
        ) : undefined,
      )}
      {item('specials', 'Specials and catalogues', 'flame')}
      {settings?.receipts.enabled && item('receipts', 'Receipts', 'receipt')}
      <div className="dk-nav-rule" role="separator" />
      {item('household', 'Server and phones', 'phone')}
      {item('settings', 'Settings', 'settings')}
      <div className="dk-nav-foot">
        <SyncFoot />
      </div>
    </nav>
  );
}

export function Desktop({ tabs, tab, stack, overlay }: DesktopProps) {
  const nav = useNav();
  const main = useRef<HTMLElement>(null);
  const place = placeOf(tab, stack);
  const top = stack[stack.length - 1];

  useEffect(() => {
    document.documentElement.classList.add('server-desk');
    return () => document.documentElement.classList.remove('server-desk');
  }, []);
  // Straight after Set up this server: Server and phones, with Add a phone open.
  useEffect(() => {
    if (peekStartOn() === 'add-phone') {
      nav.setTab(tab);
      nav.push({ name: 'server', page: 'phones' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // A new page starts at its top.
  useEffect(() => {
    main.current?.scrollTo({ top: 0 });
  }, [place, top]);

  const go = (p: Place) => {
    // The list opens on the tab being looked at (Keg's list from Keg), else the grocery list.
    if (p === 'list') nav.setTab('list', isSectionTab(tab) ? tab : 'pantry');
    else if (p === 'home' || isSectionTab(p as Tab)) nav.setTab(p as Tab);
    else {
      // Opened over the tab showing, the way the phone opens them (Back goes to the tab).
      nav.setTab(tab);
      nav.push(
        p === 'specials' ? { name: 'specials' } : p === 'receipts' ? { name: 'receipts' } : p === 'household' ? { name: 'server', page: 'phones' } : { name: 'settings' },
      );
    }
    // Keyboard and screen reader users land on the new page.
    requestAnimationFrame(() => main.current?.focus({ preventScroll: true }));
  };

  let page: ReactNode;
  if (top) page = deskScreen(top) ?? <div className="dk-phone-page">{overlay}</div>;
  else if (tab === 'home') page = <DeskHome />;
  else if (isSectionTab(tab)) page = <DeskPantry key={tab} section={tab} />;
  else if (tab === 'list') page = <DeskList />;
  else page = <DeskHome />;

  return (
    <div className="app dk">
      <a className="dk-skip" href="#dk-main" onClick={(e) => (e.preventDefault(), main.current?.focus())}>
        Skip to the page
      </a>
      <SideNav tabs={tabs} place={place} go={go} />
      <main className="dk-main" id="dk-main" ref={main} tabIndex={-1}>
        {page}
      </main>
    </div>
  );
}
