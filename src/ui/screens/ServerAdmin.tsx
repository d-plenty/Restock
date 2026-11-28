// 0.18.3: Server admin, on an admin phone (Settings → Sync → Restock server → Server admin).
// 0.18.4: just what's wanted on the go, a page each: the phones and tablets, Sign in a computer, the
// passphrase, and the basics (the household's name, the addresses, Home Assistant on or off), with
// browsers waiting for a yes at the top. Everything else (data, activity, the recovery key, sign-in
// settings, updates, backups) is on the server's web page, which has the room for it.
import { useEffect, useId, useState, type ReactNode } from 'react';
import * as admin from '../../lib/serverAdmin';
import { lookForApprovals, useApprovals } from '../../lib/approvalsWatch';
import { checkPassphrase } from '../../server-mode/passphrase';
import { Icon, LoadingBar, TopBar, timeAgo } from '../components';
import { useNav } from '../nav';
import { ServerPhones } from './ServerPhones';
import { signInComputer } from './signInComputer';
import { PhoneBackupCard } from './PhoneBackup';
import { turnOnBackups } from '../../lib/serverBackup';
import { askPassword } from '../../lib/confirm';
import { RestockNative } from '../../lib/sql/native';

type ServerAdminPage = 'phones' | 'passphrase' | 'settings' | 'backups';

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Something from the server, with what went wrong in words. */
function useLoad<T>(load: () => Promise<T>, tick = 0): { data?: T; error?: string; set: (v: T) => void } {
  const [data, set] = useState<T>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let on = true;
    load().then(
      (v) => on && (set(v), setError(undefined)),
      (e) => on && setError(errText(e)),
    );
    return () => {
      on = false;
    };
  }, [tick]); // eslint-disable-line react-hooks/exhaustive-deps
  return { data, error, set };
}

/** A row that opens something: an icon, a title, a line under it, and the arrow. */
function Opens({ icon, title, sub, onClick, disabled }: { icon: Parameters<typeof Icon>[0]['name']; title: string; sub?: ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <button className="row" onClick={onClick} disabled={disabled}>
      <Icon name={icon} size={18} />
      <span className="grow">
        <span className="title" style={{ fontSize: 15 }}>
          {title}
        </span>
        {sub && <span className="small">{sub}</span>}
      </span>
      <Icon name="chevron" size={18} />
    </button>
  );
}

export function ServerAdminScreen({ page }: { page?: ServerAdminPage }) {
  if (page === 'phones') return <PhonesPage />;
  if (page === 'passphrase') return <PassphrasePage />;
  if (page === 'settings') return <BasicsPage />;
  if (page === 'backups') return <BackupsPage />;
  return <MenuPage />;
}

function MenuPage() {
  const nav = useNav();
  const settings = useLoad(admin.settings);
  const waiting = useApprovals();
  const [working, setWorking] = useState<string>();
  const [error, setError] = useState<string>();
  const s = settings.data;
  const page = s?.away || s?.home;

  // Requests for a yes: looked for now, and every 3 seconds while this screen is open.
  useEffect(() => {
    void lookForApprovals().catch(() => undefined);
    const t = setInterval(() => void lookForApprovals().catch(() => undefined), 3000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="screen">
      <TopBar title="Server admin" />
      {waiting.length > 0 && (
        <div className="card flush">
          {waiting.map((a) => (
            <div key={a.id} className="row">
              <Icon name="shield" size={18} />
              <span className="grow">
                <span className="title" style={{ fontSize: 15 }}>
                  A browser wants to {a.words}
                </span>
                <span className="small">
                  {a.browser} · number {a.number}
                </span>
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="card flush">
        <Opens icon="phone" title="Phones and tablets" sub="Add, remove, make admin" onClick={() => nav.push({ name: 'serverAdmin', page: 'phones' })} />
        <Opens
          icon="scan"
          title="Sign in a computer"
          sub="Scan the code on the server's sign-in page"
          disabled={!!working}
          onClick={() =>
            void signInComputer(setWorking)
              .then((d) => d && nav.toast(`Signed in on ${d.host}`))
              .catch((e: unknown) => setError(errText(e)))
          }
        />
        <Opens icon="lock" title="Passphrase" sub="Change the server's passphrase" onClick={() => nav.push({ name: 'serverAdmin', page: 'passphrase' })} />
        <Opens icon="settings" title="Basic settings" sub="Name, addresses, Home Assistant" onClick={() => nav.push({ name: 'serverAdmin', page: 'settings' })} />
        <Opens icon="download" title="Phone backups" sub="Each phone's backup, for putting a lost one back" onClick={() => nav.push({ name: 'serverAdmin', page: 'backups' })} />
      </div>

      {working && (
        <div className="card" role="status">
          <span className="small">{working}</span>
          <LoadingBar seconds={6} />
        </div>
      )}
      {(error || settings.error) && (
        <div className="banner amber" role="alert">
          {error ?? settings.error}
        </div>
      )}
      {s?.updates?.newer && (
        <div className="banner" role="status">
          Restock server {s.updates.latest} is out (this one is {s.version}). Update it where it runs.
        </div>
      )}
      <p className="small" style={{ padding: '0 4px' }}>
        Data, activity, the recovery key, backups and the rest of the settings are on the server's web page
        {page ? (
          <>
            : <span style={{ userSelect: 'all', wordBreak: 'break-all' }}>{page}</span>
          </>
        ) : null}
        .
      </p>
    </div>
  );
}

function PhonesPage() {
  const settings = useLoad(admin.settings);
  return (
    <div className="screen">
      <TopBar title="Phones and tablets" />
      <ServerPhones label={settings.data?.name ?? 'your server'} />
    </div>
  );
}

function PassphrasePage() {
  const nav = useNav();
  const settings = useLoad(admin.settings);
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const ids = { a: useId(), b: useId(), c: useId() };
  const strength = next ? checkPassphrase(next, settings.data?.user ?? '') : undefined;
  const ok = !!cur && !!strength?.ok && next === again;
  return (
    <div className="screen">
      <TopBar title="Passphrase" />
      <form
        className="card"
        style={{ gap: 12 }}
        onSubmit={(e) => {
          e.preventDefault();
          if (!ok || busy) return;
          setBusy(true);
          setError(undefined);
          admin
            .changePassphrase(cur, next)
            .then(() => {
              nav.toast('Passphrase changed. Every browser was signed out.');
              nav.pop();
            })
            .catch((err: unknown) => setError(errText(err)))
            .finally(() => setBusy(false));
        }}
      >
        <span className="small">For signing in to the server's web page. Phones keep syncing as they are.</span>
        <div className="field">
          <label htmlFor={ids.a} className="small">
            Current passphrase
          </label>
          <input id={ids.a} className="input" type="password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor={ids.b} className="small">
            New passphrase
          </label>
          <input id={ids.b} className="input" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} aria-invalid={!!next && !strength?.ok} />
          <span className="small">{next && !strength?.ok ? strength?.problem : 'Four or more words you can remember is good.'}</span>
        </div>
        <div className="field">
          <label htmlFor={ids.c} className="small">
            The new one again
          </label>
          <input id={ids.c} className="input" type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} aria-invalid={!!again && again !== next} />
          {again && again !== next && <span className="small">They're not the same yet.</span>}
        </div>
        {busy && <LoadingBar seconds={5} />}
        {error && (
          <div className="banner amber" role="alert">
            {error}
          </div>
        )}
        <button className="btn primary block" type="submit" disabled={!ok || busy}>
          {busy ? 'Changing…' : 'Change the passphrase'}
        </button>
      </form>
    </div>
  );
}

function BasicsPage() {
  const nav = useNav();
  const settings = useLoad(admin.settings);
  const ha = useLoad(admin.homeAssistant);
  const [error, setError] = useState<string>();
  const s = settings.data;
  const save = async (part: Record<string, unknown>, done = 'Saved') => {
    setError(undefined);
    try {
      settings.set(await admin.putSettings(part));
      nav.toast(done);
    } catch (e) {
      setError(errText(e));
    }
  };
  return (
    <div className="screen">
      <TopBar title="Basic settings" />
      {!s && !settings.error && <LoadingBar seconds={3} />}
      {(error || settings.error) && (
        <div className="banner amber" role="alert">
          {error ?? settings.error}
        </div>
      )}
      {s && (
        <>
          <NameCard s={s} save={save} />
          <Addresses s={s} save={save} />
        </>
      )}
      {ha.data && (
        <div className="card flush">
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <span className="grow" style={{ minWidth: 160 }}>
              <span className="title" style={{ fontSize: 15 }}>
                Shopping list in Home Assistant
              </span>
              <span className="small">{ha.data.lastError ? `Not working: ${ha.data.lastError}` : ha.data.lastAt ? `Connected · synced ${timeAgo(ha.data.lastAt)}` : ha.data.address ? ha.data.address : 'Set it up on the web page'}</span>
            </span>
            <input
              type="checkbox"
              className="switch"
              aria-label="Shopping list in Home Assistant"
              checked={!!ha.data.enabled}
              disabled={!ha.data.address}
              onChange={(e) =>
                void admin
                  .putHomeAssistant({ enabled: e.target.checked })
                  .then((v) => (ha.set(v), nav.toast(v.enabled ? 'On' : 'Off')))
                  .catch((err: unknown) => setError(errText(err)))
              }
            />
          </div>
        </div>
      )}
    </div>
  );
}

function BackupsPage() {
  const nav = useNav();
  const [tick, setTick] = useState(0);
  const key = useLoad(() => RestockNative.serverAdmin({ method: 'GET', path: '/backupkey' }) as Promise<{ pub?: string; at?: string }>, tick);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const turnOn = async () => {
    const pass = await askPassword('Turn on phone backups', { detail: "The server's passphrase. Backups are locked with it: putting one back on a new phone asks for it.", action: 'Turn on' });
    if (!pass) return;
    setBusy(true);
    setError(undefined);
    try {
      await turnOnBackups(pass);
      nav.toast('Phone backups are on. Each phone backs up once a day while Restock is open.');
      setTick((t) => t + 1);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="screen">
      <TopBar title="Phone backups" />
      {!key.data && !key.error && <LoadingBar seconds={3} />}
      {(error || key.error) && (
        <div className="banner amber" role="alert">
          {error ?? key.error}
        </div>
      )}
      {key.data && (
        <div className="card" style={{ gap: 8 }}>
          {key.data.pub ? (
            <span className="small">On{key.data.at ? ` since ${new Date(key.data.at).toLocaleDateString('en-AU')}` : ''}. Each phone keeps its own backup here, locked with the server's passphrase: the server can't read them.</span>
          ) : (
            <>
              <span className="small">Off. Turned on, each phone keeps its whole backup on the server, so a lost or broken one can be put back on a new one. They're locked with the server's passphrase: the server can't read them.</span>
              <button className="btn primary" disabled={busy} onClick={() => void turnOn()}>
                {busy ? 'Turning on…' : 'Turn on phone backups'}
              </button>
            </>
          )}
        </div>
      )}
      <div className="eyebrow">This phone</div>
      <PhoneBackupCard key={tick} />
      <p className="small" style={{ padding: '0 4px' }}>
        To put a lost phone back: Phones and tablets → Add a phone or tablet → Replaces a lost or broken phone. The server's web page can download any phone's backup too.
      </p>
    </div>
  );
}

function NameCard({ s, save }: { s: admin.HouseSettings; save: (p: Record<string, unknown>, done?: string) => Promise<void> }) {
  const [name, setName] = useState(s.name ?? '');
  const id = useId();
  return (
    <form
      className="card"
      style={{ gap: 8 }}
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim() && name.trim() !== s.name) void save({ name: name.trim() });
      }}
    >
      <label htmlFor={id} className="title" style={{ fontSize: 15 }}>
        Household name
      </label>
      <div style={{ display: 'flex', gap: 8 }}>
        <input id={id} className="input grow" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
        {name.trim() !== (s.name ?? '') && (
          <button className="btn small primary" type="submit" disabled={!name.trim()}>
            Save
          </button>
        )}
      </div>
    </form>
  );
}

function Addresses({ s, save }: { s: admin.HouseSettings; save: (p: Record<string, unknown>, done?: string) => Promise<void> }) {
  const [home, setHome] = useState(s.home ?? '');
  const [away, setAway] = useState(s.away ?? '');
  const ids = { h: useId(), a: useId() };
  const changed = home !== (s.home ?? '') || away !== (s.away ?? '');
  return (
    <div className="card" style={{ gap: 8 }}>
      <span className="title" style={{ fontSize: 15 }}>
        Addresses
      </span>
      <span className="small">Phones try home first, for a moment, then away.</span>
      <label htmlFor={ids.h} className="small">
        At home (http:// is fine)
      </label>
      <input id={ids.h} className="input" value={home} disabled={s.homeFixed} placeholder="http://192.168.1.20:8787" autoCapitalize="off" inputMode="url" onChange={(e) => setHome(e.target.value)} />
      <label htmlFor={ids.a} className="small">
        Away from home (https://)
      </label>
      <input id={ids.a} className="input" value={away} disabled={s.awayFixed} placeholder="https://restock.example.com" autoCapitalize="off" inputMode="url" onChange={(e) => setAway(e.target.value)} />
      {(s.homeFixed || s.awayFixed) && <span className="small">Set where the server runs (RESTOCK_HOME_URL / RESTOCK_AWAY_URL): change it there.</span>}
      {changed && (
        <button className="btn primary" onClick={() => void save({ ...(home !== (s.home ?? '') ? { home } : {}), ...(away !== (s.away ?? '') ? { away } : {}) }, 'Addresses saved. Phones pick them up when they next sync.')}>
          Save addresses
        </button>
      )}
    </div>
  );
}
