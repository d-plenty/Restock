// 0.18.3: the server page's frame. The sidebar has Phones and admins, Data, and under a "Server
// settings" heading each settings page of its own: Household, Addresses, Sign-in and security,
// Home Assistant, This browser, Updates and moving. The page is in the address (#/addresses), so
// Back and a bookmark work.
import { useEffect, useState, type ReactNode } from 'react';
import { serverInfo } from '../api';
import { session, signOut } from '../session';
import { Logo } from '../../ui/Logo';
import { Icon, type IconName } from './ui';

export type PageId = 'phones' | 'data' | 'household' | 'addresses' | 'security' | 'ha' | 'browser' | 'upkeep';

const TOP: { id: PageId; title: string; icon: IconName }[] = [
  { id: 'phones', title: 'Phones and admins', icon: 'phone' },
  { id: 'data', title: 'Data', icon: 'data' },
];
const SETTINGS: { id: PageId; title: string; icon: IconName }[] = [
  { id: 'household', title: 'Household', icon: 'home' },
  { id: 'addresses', title: 'Addresses', icon: 'globe' },
  { id: 'security', title: 'Sign-in and security', icon: 'shield' },
  { id: 'ha', title: 'Home Assistant', icon: 'ha' },
  { id: 'browser', title: 'This browser', icon: 'screen' },
  { id: 'upkeep', title: 'Updates and moving', icon: 'wrench' },
];
const ALL = [...TOP, ...SETTINGS];
const titleOf = (id: PageId) => ALL.find((p) => p.id === id)?.title ?? '';

const fromHash = (): PageId => {
  const h = (typeof location !== 'undefined' ? location.hash : '').replace(/^#\/?/, '');
  return (ALL.find((p) => p.id === h)?.id ?? 'phones') as PageId;
};

/** The page showing, from the address; go() changes it (with Back working). */
export function usePage(): [PageId, (p: PageId) => void] {
  const [page, setPage] = useState<PageId>(fromHash);
  useEffect(() => {
    const on = () => setPage(fromHash());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  useEffect(() => {
    document.title = `${titleOf(page)} · Restock server`;
    // The new page's title for screen readers and the keyboard.
    requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-page-title]')?.focus({ preventScroll: true }));
  }, [page]);
  return [page, (p) => (location.hash = '#/' + p)];
}

export function Shell({ page, go, children, waiting }: { page: PageId; go: (p: PageId) => void; children: ReactNode; waiting?: number }) {
  const s = session();
  const nav = (p: { id: PageId; title: string; icon: IconName }) => (
    <a
      key={p.id}
      className="sv-nav"
      href={'#/' + p.id}
      aria-current={p.id === page ? 'page' : undefined}
      onClick={(e) => {
        e.preventDefault();
        go(p.id);
      }}
    >
      <Icon name={p.icon} size={p.id === 'phones' || p.id === 'data' ? 20 : 18} />
      {p.title}
      {p.id === 'phones' && waiting ? <span className="sv-tag admin sv-badge">{waiting}</span> : null}
    </a>
  );
  return (
    <div className="sv">
      <a className="sv-skip" href="#sv-main">
        Skip to the page
      </a>
      <nav className="sv-side" aria-label="Server">
        <div className="sv-brand">
          <Logo size={38} />
          <span>
            <b>Restock server</b>
            <span>{s?.household ?? serverInfo()?.house ?? ''}</span>
          </span>
        </div>
        {TOP.map(nav)}
        <p className="sv-group" id="sv-settings-group">
          Server settings
        </p>
        <ul className="sv-sub" aria-labelledby="sv-settings-group">
          {SETTINGS.map((p) => (
            <li key={p.id}>{nav(p)}</li>
          ))}
        </ul>
        <div className="sv-foot">
          <span>
            Signed in as {s?.viaPhone ? 'an admin phone' : (s?.user ?? 'admin')}
            {serverInfo()?.version ? ` · Server ${serverInfo()!.version}` : ''}
          </span>
          <button type="button" onClick={() => void signOut().then(() => location.reload())}>
            <Icon name="out" size={16} /> Sign out
          </button>
        </div>
      </nav>
      <main className="sv-main" id="sv-main" key={page}>
        {children}
      </main>
    </div>
  );
}
