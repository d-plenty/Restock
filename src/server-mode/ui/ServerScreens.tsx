// Server mode: what the web app adds to (and puts in place of) the phone app's screens: the strip
// along the top, Phones, Activity and Account, the household's settings, loyalty cards greyed out,
// and a plain note where a phone-only screen would be.
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { allCards, getSettings, updateSettings } from '../../lib/db';
import { useLive } from '../../lib/useLive';
import { haPhone } from '../../lib/listPicks';
import { agoText } from '../../lib/sync';
import { SECTION_NAMES, type Section } from '../../shops';
import { Icon, ThemePicker, TopBar, timeAgo } from '../../ui/components';
import { useNav, type Screen } from '../../ui/nav';
import { PROGRAMS } from '../../ui/screens/Cards';
import { api, type Activity, type Device } from '../api';
import { deleteLocalCopy, downloadBackup, householdInfo, memberNames, onStatus, syncNow, syncStatus } from '../live';
import { canChangeVault, inviteCode, session, signOut, signOutEverywhere, type Session } from '../session';
import { PassphraseForm } from './Gate';
import { AddOnServer, PhoneOnlyNote, PhoneOnlyScreen } from './PhoneOnly';
import { Qr } from './Qr';

export const useStatus = () => useSyncExternalStore(onStatus, syncStatus);

/** Ticks every 20 s, so "2 min ago" moves on by itself. */
export function useNow(ms = 20_000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/** Along the top: the household, how fresh it is, and the server's own pages. */
export function ServerStrip() {
  const nav = useNav();
  const st = useStatus();
  const now = useNow();
  const fresh = st.phoneAt ?? st.at;
  const line = st.error ? `Can't reach the server · ${st.error}` : fresh ? `Synced with your phones ${agoText(fresh, now)}` : st.busy ? 'Getting your household…' : 'Not synced yet';
  return (
    <div className={`server-strip${st.error ? ' trouble' : ''}`}>
      <div className="strip-top">
        <span className="strip-name clip">{st.household ?? session()?.household ?? 'Your household'}</span>
        <nav className="strip-links" aria-label="Server">
          <button onClick={() => nav.push({ name: 'server', page: 'phones' })}>Phones</button>
          <button onClick={() => nav.push({ name: 'server', page: 'activity' })}>Activity</button>
          <button onClick={() => nav.push({ name: 'server', page: 'account' })}>Account</button>
        </nav>
      </div>
      <button className="strip-main" onClick={() => void syncNow()} title="Sync now" aria-label={`${line}. Sync now`}>
        <span className="strip-sub clip">
          {st.busy && <span className="strip-dot" aria-hidden />}
          {line}
        </span>
      </button>
    </div>
  );
}

/** The Add tab on a server. */
export function ServerTab() {
  return <AddOnServer />;
}

/** In place of the phone app's screen, on a server (undefined: the usual screen). */
export function serverScreen(top: Screen): ReactNode | undefined {
  switch (top.name) {
    case 'server':
      return top.page === 'phones' ? <PhonesPage /> : top.page === 'activity' ? <ActivityPage /> : <AccountPage />;
    case 'settings':
    case 'household':
      return <ServerSettings />;
    case 'cards':
      return <ServerCards />;
    case 'add':
      return <AddOnServer back />;
    case 'stores':
      return <PhoneOnlyScreen title="Shops" />;
    case 'catalogues':
      return <PhoneOnlyScreen title="Catalogues" />;
    case 'sync':
      return <PhoneOnlyScreen title="Local sync" text="Do this on a phone: phones pair with each other on the Wi-Fi. Add phones to this server on the Phones page." />;
    case 'permissions':
    case 'setup':
      return <PhoneOnlyScreen title="Setup" text="Do this on a phone: notifications, widgets, shop sign-ins and the camera belong to the phone." />;
    case 'diagnostics':
    case 'soon':
      return <PhoneOnlyScreen title="On your phones" text="Do this on a phone." />;
    case 'receipt':
      return top.id ? undefined : <PhoneOnlyScreen title="Add a receipt" text="Do this on a phone: take the photo there, and it comes here when your household shares receipts." />;
    default:
      return undefined;
  }
}

// ---------- Phones ----------

function awayUrl(): string {
  try {
    return localStorage.getItem('restock-server-away') ?? '';
  } catch {
    return '';
  }
}

/** The invite QR for a phone: restock-server:2 with this page's address as home, and the away address if set. */
export function AddPhonePanel({ onAdded }: { onAdded?: () => void }) {
  const [invite, setInvite] = useState<{ code: string; until: number }>();
  const [away, setAway] = useState(awayUrl);
  const [error, setError] = useState<string>();
  const now = useNow(1000);
  const make = async () => {
    setError(undefined);
    try {
      const r = await api.invite();
      const until =
        typeof r.expiresIn === 'number'
          ? Date.now() + r.expiresIn * (r.expiresIn > 100_000 ? 1 : 1000)
          : typeof r.expires === 'number'
            ? r.expires
            : r.expires
              ? Date.parse(r.expires)
              : Date.now() + 10 * 60_000;
      // Home is this page's own address (it's how this browser reached the server); away is what's
      // typed here, else the server's RESTOCK_AWAY_URL.
      setInvite({ code: inviteCode(location.origin, away.trim() || r.away || undefined, r.invite), until });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  useEffect(() => {
    if (!invite) return;
    const t = setInterval(() => void api.devices().then(() => onAdded?.()).catch(() => undefined), 4000);
    return () => clearInterval(t);
  }, [invite, onAdded]);
  const left = invite ? Math.max(0, Math.round((invite.until - now) / 1000)) : 0;
  return (
    <div className="card add-phone">
      <h2 className="card-title">Add a phone</h2>
      {!invite || left === 0 ? (
        <>
          <p className="small" style={{ margin: 0 }}>
            Shows a code for one phone, for 10 minutes. Phones need Restock 0.9.2 or newer, and to be in your household already.
          </p>
          <label className="field">
            <span className="small">Away address (optional): how phones reach this server away from home, like https://restock.example.com</span>
            <input
              className="input"
              inputMode="url"
              placeholder="https://"
              value={away}
              onChange={(e) => {
                setAway(e.target.value);
                try {
                  localStorage.setItem('restock-server-away', e.target.value.trim());
                } catch {
                  // fine
                }
              }}
            />
          </label>
          <button className="btn primary" onClick={() => void make()}>
            <Icon name="plus" size={18} /> {invite ? 'Make a new code' : 'Show a code'}
          </button>
        </>
      ) : (
        <>
          <ol className="small steps">
            <li>On the phone: Restock → Settings → Sync and backups → Restock server → Connect.</li>
            <li>Scan this code. It works once, for {Math.ceil(left / 60)} more min.</li>
          </ol>
          <Qr text={invite.code} label="Code for a phone to scan" />
          <p className="small" style={{ margin: 0 }}>
            At home: <code>{location.origin}</code>
            {away.trim() ? (
              <>
                {' '}
                · Away: <code>{away.trim()}</code>
              </>
            ) : null}
          </p>
          <details className="small">
            <summary>Can't scan it?</summary>
            <code className="sync-code-text">{invite.code}</code>
          </details>
          <button className="btn small" onClick={() => setInvite(undefined)}>
            Done
          </button>
        </>
      )}
      {error && <p className="banner red small">{error}</p>}
    </div>
  );
}

function PhonesPage() {
  const [devices, setDevices] = useState<Device[]>();
  // 0.9.3: the household's one Home Assistant phone (read only: it moves when it's turned on on a phone).
  const ha = useLive(haPhone, []);
  const [error, setError] = useState<string>();
  const names = memberNames();
  const load = () =>
    api
      .devices()
      .then((d) => (setDevices(d), setError(undefined)))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  useEffect(() => {
    void load();
  }, []);
  const remove = async (d: Device) => {
    const name = d.name ?? names.get(d.device) ?? 'this phone';
    if (!window.confirm(`Remove ${name} from this server? It stops syncing here. To take it out of the household too, remove it on the owner phone.`)) return;
    try {
      await api.removeDevice(d.device);
      void load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <div className="screen">
      <TopBar title="Phones" />
      <div className="card flush">
        {devices === undefined && !error && <p className="row small">Loading…</p>}
        {devices?.length === 0 && <p className="row small">No phones use this server yet. Add one below.</p>}
        {devices?.map((d) => (
          <div className="row" key={d.device}>
            <Icon name="phone" />
            <span className="grow">
              <span className="title">{d.name ?? names.get(d.device) ?? 'Phone'}</span>
              <span className="small">
                {(d.lastSeen ?? d.seen) ? `Last seen ${timeAgo(d.lastSeen ?? d.seen)}` : 'Not seen yet'}
                {ha?.device === d.device && !ha.left ? ' · syncs the shopping list with Home Assistant' : ''}
              </span>
            </span>
            <button className="btn small" onClick={() => void remove(d)}>
              Remove
            </button>
          </div>
        ))}
      </div>
      {error && <p className="banner red small">{error}</p>}
      <AddPhonePanel onAdded={() => void load()} />
    </div>
  );
}

// ---------- Activity ----------

export const WHAT: Record<string, string> = {
  upload: 'sent its changes',
  write: 'sent its changes',
  fetch: 'fetched',
  read: 'fetched',
  delete: 'deleted',
  login: 'signed in',
  'login-failed': 'a wrong passphrase',
  'wrong-password': 'a wrong passphrase',
  'locked-out': 'locked out after wrong tries',
  logout: 'signed out',
  'logout-all': 'signed out everywhere',
  passphrase: 'set the passphrase',
  'device-added': 'added a phone',
  'device-removed': 'removed a phone',
  link: 'linked a browser',
  qrlogin: 'signed in with a phone',
  'invite-made': 'made a code to add a phone',
  'passphrase-reset': 'set a new passphrase',
  'phone-removed': 'removed a phone',
  'setup-login': 'signed in to set up',
  'setup-login-refused': 'was refused setting up from outside the home network',
  'signed-out-everywhere': 'signed out everywhere',
  'vault-saved': 'saved its keys (sealed)',
  'web-key-registered': 'registered its key',
  'web-sign-in-with-phone': 'signed in with a phone',
  trashed: 'moved a file to the server’s trash (kept 30 days)',
  'trash-emptied': 'emptied files over 30 days old from the trash',
  'photo-kept': 'let go of a photo another phone put on the server',
  'passphrase-change-refused': 'was refused a new passphrase (not the current one)',
};

/** Who did something on the server: this browser, another browser, or a phone by its name. */
export function activityWho(a: Activity, names: Map<string, string>, me: string | undefined): string {
  const d = a.device ?? a.by ?? a.who;
  if (!d) return a.ip ?? 'Someone';
  if (d === 'web' || d === `web-${me}` || d === me) return 'This browser';
  if (d.startsWith('web')) return 'A browser';
  return names.get(d) ?? d;
}

export function ActivityPage() {
  const [rows, setRows] = useState<Activity[]>();
  const [error, setError] = useState<string>();
  const names = memberNames();
  useEffect(() => {
    api
      .activity()
      .then(setRows)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  const me = session()?.webId;
  const who = (a: Activity) => activityWho(a, names, me);
  return (
    <div className="screen">
      <TopBar title="Activity" />
      <p className="small" style={{ margin: 0 }}>
        Everything sent to or taken from this server. The files are sealed: the server sees who and when, not what's in them.
      </p>
      {error && <p className="banner red small">{error}</p>}
      {rows?.length === 0 && <p className="small">Nothing yet.</p>}
      {rows && rows.length > 0 && (
        <div className="card flush">
          {rows.slice(0, 200).map((a, i) => (
            <div className="row" key={i}>
              <span className="grow">
                <span className="title" style={{ fontSize: 15 }}>
                  {who(a)} {WHAT[a.what] ?? a.what}
                </span>
                <span className="small">
                  {timeAgo(a.at)}
                  {a.file ? ` · ${fileLabel(a.file, names)}` : ''}
                </span>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function fileLabel(f: string, names: Map<string, string>): string {
  const m = /^restock-sync-(.+)\.bin$/.exec(f);
  if (m) return m[1].startsWith('web-') ? "the web's changes" : `${names.get(m[1]) ?? 'a phone'}'s changes`;
  if (f.startsWith('archive/')) return 'price history';
  if (f.startsWith('photos/')) return 'a receipt photo';
  if (f.startsWith('webkeys/')) return 'keys for a browser';
  if (f.endsWith('.json')) return 'household keys';
  return f;
}

// ---------- Account ----------

/** Signs out, then takes this browser's copy away and starts again at the sign-in page. */
export async function leave(how: () => Promise<void>) {
  const id = session()?.webId;
  try {
    await how();
  } finally {
    if (id) await deleteLocalCopy(id);
    location.reload();
  }
}

export function AccountPage({ onSession }: { onSession?: (s: Session) => void }) {
  const s = session();
  const [changing, setChanging] = useState(false);
  const [msg, setMsg] = useState<string>();
  const [busy, setBusy] = useState(false);
  return (
    <div className="screen">
      <TopBar title="Account" />
      <div className="card">
        <span className="small">Signed in as</span>
        <span className="title">{s?.user ?? 'admin'}</span>
        {s?.viaPhone && <span className="small">With a phone: this tab forgets the household when it's closed.</span>}
      </div>
      <div className="card">
        <h2 className="card-title">Passphrase</h2>
        {!canChangeVault() ? (
          <p className="small" style={{ margin: 0 }}>
            {s?.viaPhone ? 'Signed in with a phone: sign in with the passphrase to change it.' : 'Sign in again with the passphrase to change it.'}
          </p>
        ) : changing ? (
          <PassphraseForm
            user={s?.user ?? 'admin'}
            submit="Change the passphrase"
            onDone={(next) => {
              setChanging(false);
              setMsg('Changed. Other browsers need the new passphrase.');
              onSession?.(next);
              window.dispatchEvent(new CustomEvent('restock-server-session'));
            }}
          />
        ) : (
          <button className="btn" onClick={() => setChanging(true)}>
            Change the passphrase
          </button>
        )}
        {msg && <p className="small">{msg}</p>}
      </div>
      <div className="card">
        <h2 className="card-title">Sign out</h2>
        <p className="small" style={{ margin: 0 }}>
          Signing out takes this browser's copy of the household away too.
        </p>
        <div className="two">
          <button className="btn" disabled={busy} onClick={() => void leave(() => signOut())}>
            Sign out
          </button>
          <button
            className="btn danger"
            disabled={busy}
            onClick={async () => {
              if (!window.confirm('Sign out every browser signed in to this server, this one too?')) return;
              setBusy(true);
              await leave(() => signOutEverywhere());
            }}
          >
            Sign out everywhere
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------- the household's settings ----------

function ServerSettings() {
  const nav = useNav();
  const settings = useLive(getSettings, []);
  const h = householdInfo();
  const [saving, setSaving] = useState(false);
  if (!settings) return <div className="screen" />;
  const row = (title: string, sub: string, onClick: () => void) => (
    <button className="row" onClick={onClick}>
      <span className="grow">
        <span className="title">{title}</span>
        <span className="small">{sub}</span>
      </span>
      <Icon name="chevron" size={18} />
    </button>
  );
  return (
    <div className="screen">
      <TopBar title="Settings" />
      <div className="eyebrow">Your household</div>
      <div className="card">
        <span className="title">{h.name ?? 'Your household'}</span>
        <span className="small">
          Shares {h.tabs.map((t) => SECTION_NAMES[t as Section] ?? t).join(', ') || 'nothing yet'}
          {h.receipts ? ', and receipts' : ''}. The owner phone changes what the household shares.
        </span>
      </div>
      <div className="card flush">
        {row('Phones', 'The phones using this server', () => nav.push({ name: 'server', page: 'phones' }))}
        {row('Activity', "What's been sent and fetched", () => nav.push({ name: 'server', page: 'activity' }))}
        {row('Account', 'Passphrase, sign out', () => nav.push({ name: 'server', page: 'account' }))}
        {row('Loyalty cards', 'Kept on your phones', () => nav.push({ name: 'cards' }))}
      </div>
      <div className="eyebrow">This browser</div>
      <div className="card">
        <span className="title">Appearance</span>
        <ThemePicker value={settings.theme} onChange={(theme) => void updateSettings({ theme })} />
      </div>
      <div className="card">
        <span className="title">Download a backup</span>
        <span className="small">Everything this browser has, as a Restock backup file you can keep or restore on a phone. Loyalty card numbers aren't in it: they never leave the phones.</span>
        <button
          className="btn"
          disabled={saving}
          onClick={async () => {
            setSaving(true);
            try {
              await downloadBackup();
            } finally {
              setSaving(false);
            }
          }}
        >
          <Icon name="download" size={18} /> Download a backup
        </button>
      </div>
      <div className="eyebrow">On your phones</div>
      <div className="card">
        <span className="small">Shops, price checks, shop sign-ins, barcode scanning, notifications, widgets, backups to a folder and local sync are set on each phone.</span>
        <PhoneOnlyNote compact />
      </div>
      <p className="small" style={{ textAlign: 'center' }}>
        Restock {__APP_VERSION__} · web
      </p>
    </div>
  );
}

// ---------- loyalty cards ----------

export function ServerCards() {
  const cards = useLive(allCards, []);
  return (
    <div className="screen">
      <TopBar title="Loyalty cards" />
      <p className="small" style={{ margin: 0 }}>
        Kept on your phones for privacy: their numbers and barcodes never come to the server or this browser.
      </p>
      {cards?.length === 0 && <p className="small">No cards shared by your phones.</p>}
      {cards?.map((c) => (
        <div key={c.id} className={`loyalty ${c.program} card-locked`} aria-label={`${c.program === 'other' ? c.label : PROGRAMS[c.program]?.name ?? c.label}: kept on your phones for privacy`}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
            <div style={{ fontSize: 20, fontWeight: 700 }}>{c.program === 'other' ? c.label : (PROGRAMS[c.program]?.name ?? c.label)}</div>
            <div style={{ fontSize: 12 }}>{PROGRAMS[c.program]?.use.split('—')[0]}</div>
          </div>
          <div className="card-locked-panel">
            <Icon name="lock" size={18} /> Kept on your phones for privacy
          </div>
        </div>
      ))}
    </div>
  );
}
