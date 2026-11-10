// 0.9.3: Household and phones at desktop widths: the phones and this browser on the server (remove,
// sign out), what the server keeps, recent activity, and what stays on the phones, greyed. The same
// server calls as the Phones, Activity and Account pages (ServerScreens.tsx).
import { useEffect, useState, type ReactNode } from 'react';
import { useLive } from '../../lib/useLive';
import { Icon, timeAgo } from '../../ui/components';
import { useNav } from '../../ui/nav';
import { api, type Activity, type FileInfo } from '../api';
import { memberNames } from '../live';
import { session } from '../session';
import { activityWho, AddPhonePanel, fileLabel, WHAT } from './ServerScreens';
import { DeskHead } from './deskShared';
import { cardNames, homeAssistantPhone, removePhone, serverAccount, signOutHere, usePhones } from './settingsData';

/** "Firefox on Linux", from what the browser says about itself. */
function thisBrowser(): string {
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'A browser';
  const os = /Windows/.test(ua) ? 'Windows' : /Mac OS X|Macintosh/.test(ua) ? 'macOS' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} on ${os}` : browser;
}

function size(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function KeptOnServer() {
  const [files, setFiles] = useState<FileInfo[]>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    api
      .files()
      .then(setFiles)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  const months = files ? new Set(files.filter((f) => f.name.startsWith('archive/')).map((f) => f.name.split('/').pop())).size : 0;
  const photos = files?.filter((f) => f.name.startsWith('photos/')).length ?? 0;
  const bytes = files?.reduce((s, f) => s + (f.size || 0), 0) ?? 0;
  return (
    <section className="card" aria-labelledby="dk-kept">
      <h2 id="dk-kept">Kept on the server</h2>
      {error && <p className="small">{error}</p>}
      {files && (
        <div className="dk-stats">
          <div>
            <span className="dk-stat num">{months}</span>
            <span className="dk-sub">month{months === 1 ? '' : 's'} of older prices</span>
          </div>
          <div>
            <span className="dk-stat num">{photos}</span>
            <span className="dk-sub">receipt photo{photos === 1 ? '' : 's'}</span>
          </div>
          <div>
            <span className="dk-stat num">{size(bytes)}</span>
            <span className="dk-sub">all sealed</span>
          </div>
        </div>
      )}
      <span className="small">Everything here is sealed with your household's key. The server can't open any of it.</span>
    </section>
  );
}

function RecentActivity() {
  const nav = useNav();
  const [rows, setRows] = useState<Activity[]>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    api
      .activity()
      .then(setRows)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  const names = memberNames();
  const me = session()?.webId;
  const time = (iso: string) => {
    const d = new Date(iso);
    return d.toDateString() === new Date().toDateString()
      ? d.toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' }).toLowerCase()
      : d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
  };
  return (
    <section className="card" aria-labelledby="dk-act">
      <div className="dk-section-head">
        <h2 id="dk-act">Activity</h2>
        <button className="dk-linkish" onClick={() => nav.push({ name: 'server', page: 'activity' })}>
          All activity
        </button>
      </div>
      {error && <p className="small">{error}</p>}
      {rows?.length === 0 && <p className="small">Nothing yet.</p>}
      <ul className="dk-activity">
        {rows?.slice(0, 6).map((a, i) => (
          <li key={i}>
            <time dateTime={a.at} className="dk-sub num">
              {time(a.at)}
            </time>
            <span>
              {activityWho(a, names, me)} {WHAT[a.what] ?? a.what}
              {a.file ? <span className="dk-sub-inline"> · {fileLabel(a.file, names)}</span> : null}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function KeptOnPhones() {
  const cards = useLive(cardNames, []);
  const ha = useLive(homeAssistantPhone, []);
  return (
    <aside className="dk-aside" aria-labelledby="dk-onphones">
      <h2 id="dk-onphones">Kept on your phones</h2>
      <p className="small dk-tight">For privacy, or because the shops only let the app do it. You can see these here; change them on a phone.</p>

      <div className="dk-locked" aria-disabled="true">
        <div className="dk-locked-title">
          <Icon name="lock" size={18} /> <strong>Loyalty cards</strong>
        </div>
        {cards && cards.length > 0 ? (
          <div className="dk-cardrow">
            {cards.map((name, i) => (
              <div key={i} className="dk-minicard">
                {/* Never the number: the web doesn't have it. */}
                <span>{name}</span>
                <span aria-hidden>•••• ••••</span>
                <span className="sr-only">Number kept on your phones</span>
              </div>
            ))}
          </div>
        ) : (
          <span className="small">{cards ? 'None shared by your phones.' : ''}</span>
        )}
        <span className="small">Kept on your phones for privacy. Card numbers never leave them.</span>
      </div>

      <div className="dk-locked" aria-disabled="true">
        <div className="dk-locked-title">
          <Icon name="lock" size={18} /> <strong>Shop sign-ins and live prices</strong>
        </div>
        <span className="small">Coles and Woolworths sign-ins stay on each phone. Your phones check prices in the background; this page shows what they found.</span>
      </div>

      <div className="dk-locked" aria-disabled="true">
        <div className="dk-locked-title">
          <Icon name="scan" size={18} /> <strong>Scanning</strong>
        </div>
        <span className="small">Barcodes, receipts and shelf labels use a phone's camera.</span>
      </div>

      <div className="dk-locked" aria-disabled="true">
        <div className="dk-locked-title">
          <Icon name="phone" size={18} /> <strong>Home Assistant and backups</strong>
        </div>
        <span className="small">
          Set up on a phone.{' '}
          {ha
            ? `${ha.name} syncs your shopping list with Home Assistant, for the whole household (one phone does it; turning it on on another phone moves it there).`
            : 'One phone in your household syncs your shopping list with Home Assistant; none does yet.'}{' '}
          Backups to a folder run on each phone.
        </span>
      </div>
    </aside>
  );
}

/** `extra`: 0.9.4 in v2 mode, the Take this household card. */
export function DeskHousehold({ extra }: { extra?: ReactNode } = {}) {
  const nav = useNav();
  const { phones, error, reload } = usePhones();
  const [adding, setAdding] = useState(false);
  const [msg, setMsg] = useState<string>();
  const acct = serverAccount();
  const remove = async (device: string, name: string) => {
    try {
      const done = await removePhone(device, {
        title: `Remove ${name} from this server?`,
        detail: 'It stops syncing here. To take it out of the household too, remove it on the owner phone.',
        action: 'Remove from the server',
      });
      if (!done) return;
      setMsg(`${name} was taken off this server.`);
      reload();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <div className="dk-page">
      <DeskHead title="Server and phones">
        <button className="btn primary" aria-expanded={adding} onClick={() => setAdding(!adding)}>
          <Icon name={adding ? 'close' : 'plus'} size={18} /> {adding ? 'Close' : 'Add a phone'}
        </button>
      </DeskHead>
      <div className="dk-split">
        <div className="dk-wide dk-stack">
          {extra}
          {adding && <AddPhonePanel onAdded={reload} />}
          <section className="card flush" aria-labelledby="dk-onserver">
            <h2 id="dk-onserver" className="dk-card-title">
              On this server
            </h2>
            {phones === undefined && !error && <p className="dk-row small">Loading…</p>}
            {phones?.length === 0 && <p className="dk-row small">No phones use this server yet. Add one with Add a phone.</p>}
            {phones?.map((p) => (
              <div key={p.device} className="dk-row">
                <span className="grow">
                  <span className="dk-row-title">
                    {p.name}
                    {p.isOwner && <span className="dk-badge blue">Owner</span>}
                    {p.homeAssistant && <span className="dk-badge">Home Assistant</span>}
                  </span>
                  <span className="dk-sub">
                    {[p.version ? `Restock ${p.version}` : undefined, p.lastSeen ? `synced ${timeAgo(p.lastSeen)}` : 'not seen yet'].filter(Boolean).join(' · ')}
                  </span>
                </span>
                <button className="btn small" onClick={() => void remove(p.device, p.name)}>
                  Remove
                </button>
              </div>
            ))}
            <div className="dk-row">
              <span className="grow">
                <span className="dk-row-title">
                  This browser <span className="dk-badge green">You</span>
                </span>
                <span className="dk-sub">
                  {thisBrowser()} · {acct.viaPhone ? 'signed in with a phone; forgets the household when the tab closes' : `signed in as ${acct.user} with the passphrase`}
                </span>
              </span>
              <button className="btn small" onClick={() => void signOutHere()}>
                Sign out
              </button>
            </div>
            {error && <p className="dk-row banner red small">{error}</p>}
            {msg && (
              <p className="dk-row small" role="status">
                {msg}
              </p>
            )}
          </section>
          <KeptOnServer />
          <RecentActivity />
          <button className="dk-linkish dk-self-start" onClick={() => nav.push({ name: 'server', page: 'account' })}>
            Passphrase and signing out everywhere
          </button>
        </div>
        <KeptOnPhones />
      </div>
    </div>
  );
}
