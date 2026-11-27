// 0.18.3: Server admin, on an admin phone (Settings → Sync → Restock server → Server admin). What
// the server's web page does, from the phone: browsers waiting for a yes, the phones and tablets,
// Sign in a computer, Data and how long it's kept, Activity, and Server settings (the household, the
// addresses, signing in, Home Assistant, updates). The passphrase, the user name, backups, import,
// moving and erasing stay on the web page, which has room for their steps.
import { useEffect, useState, type ReactNode } from 'react';
import { askPassword } from '../../lib/confirm';
import { deviceWord } from '../../lib/platform';
import * as admin from '../../lib/serverAdmin';
import { lookForApprovals, useApprovals } from '../../lib/approvalsWatch';
import { isAdminAction, whatOf, whoOf, KIND_NAME } from '../../server-mode/ui/houseWords';
import { Icon, LoadingBar, Sheet, TopBar, timeAgo } from '../components';
import { useNav } from '../nav';
import { ServerPhones } from './ServerPhones';
import { signInComputer } from './signInComputer';

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function bytes(n: number | undefined): string {
  const b = Number(n) || 0;
  if (b < 1024 * 1024) return `${Math.max(0, Math.round(b / 1024))} KB`;
  if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(b < 10 * 1024 ** 2 ? 1 : 0)} MB`;
  return `${(b / 1024 ** 3).toFixed(1)} GB`;
}
const fmt = (n: number | undefined) => (Number(n) || 0).toLocaleString('en-AU');

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

function Seg<T extends string | number>({ label, value, options, onChange, disabled }: { label: string; value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; disabled?: boolean }) {
  return (
    <div className="seg" role="group" aria-label={label} style={{ flexWrap: 'wrap' }}>
      {options.map((o) => (
        <button key={String(o.value)} type="button" aria-pressed={o.value === value} disabled={disabled} onClick={() => o.value !== value && onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Line({ title, sub, children }: { title: ReactNode; sub?: ReactNode; children?: ReactNode }) {
  return (
    <div className="row" style={{ flexWrap: 'wrap' }}>
      <span className="grow" style={{ minWidth: 160 }}>
        <span className="title" style={{ fontSize: 15 }}>
          {title}
        </span>
        {sub && <span className="small">{sub}</span>}
      </span>
      {children}
    </div>
  );
}

const KEEP: { value: number | 'off'; label: string }[] = [
  { value: 3, label: '3 months' },
  { value: 6, label: '6 months' },
  { value: 12, label: '12 months' },
  { value: 24, label: '2 years' },
  { value: 'off', label: 'Until deleted' },
];
const HOURS = [
  { value: 1, label: '1 hour' },
  { value: 24, label: '1 day' },
  { value: 168, label: '7 days' },
  { value: 720, label: '30 days' },
];

export function ServerAdminScreen() {
  const nav = useNav();
  const [tick, setTick] = useState(0);
  const reload = () => setTick((t) => t + 1);
  const settings = useLoad(admin.settings, tick);
  const sum = useLoad(admin.summary, tick);
  const waiting = useApprovals();
  const [working, setWorking] = useState<string>();
  const [error, setError] = useState<string>();
  const [key, setKey] = useState<string>();
  const s = settings.data;
  const label = s?.name ?? 'your server';

  // Requests for a yes: looked for now, and every 3 seconds while this screen is open.
  useEffect(() => {
    void lookForApprovals().catch(() => undefined);
    const t = setInterval(() => void lookForApprovals().catch(() => undefined), 3000);
    return () => clearInterval(t);
  }, []);

  /** A change: the server's answer becomes what shows; a toast says it worked, or the server's words show. */
  const run = async (f: () => Promise<unknown>, done: string) => {
    setError(undefined);
    try {
      const out = await f();
      if (out && typeof out === 'object' && 'name' in out) settings.set(out as admin.HouseSettings);
      nav.toast(done);
      return true;
    } catch (e) {
      setError(errText(e));
      return false;
    }
  };
  const save = (part: Record<string, unknown>, done = 'Saved') => run(() => admin.putSettings(part), done);

  const setKeep = async (v: number | 'off') => {
    const months = v === 'off' ? null : v;
    const was = sum.data?.autoDelete.months ?? null;
    const deletes = months !== null && (was === null || months < was);
    const label = KEEP.find((k) => k.value === v)?.label;
    if (deletes) {
      const pass = await askPassword(`Only keep ${label}?`, { detail: 'Anything older on the server is deleted now, and each night after. Your passphrase to go ahead.', action: 'Delete older data' });
      if (!pass) return;
      setWorking('Checking the passphrase…');
      await run(() => admin.setKeep(months, pass), `Kept for ${label}. Older data was deleted.`);
      setWorking(undefined);
    } else await run(() => admin.setKeep(months), months === null ? 'Kept until deleted' : `Kept for ${label}`);
    reload();
  };

  const showKey = async () => {
    const pass = await askPassword('The recovery key', { detail: 'Your passphrase to see it.', action: 'Show it' });
    if (!pass) return;
    setWorking('Checking the passphrase…');
    try {
      setKey(await admin.recoveryKey(pass));
      setWorking(undefined);
    } catch (e) {
      setWorking(undefined);
      setError(errText(e));
    }
  };

  return (
    <div className="screen">
      <TopBar title="Server admin" />
      {waiting.length > 0 && (
        <>
          <div className="eyebrow">Waiting for your yes</div>
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
        </>
      )}

      <ServerPhones label={label} />

      <div className="card flush">
        <button
          className="row"
          disabled={!!working}
          onClick={() =>
            void signInComputer(setWorking)
              .then((d) => d && nav.toast(`Signed in on ${d.host}`))
              .catch((e: unknown) => setError(errText(e)))
          }
        >
          <Icon name="scan" size={18} />
          <span className="grow">
            <span className="title" style={{ fontSize: 15 }}>
              Sign in a computer
            </span>
            <span className="small">Scan the code on the server's sign-in page: no passphrase to type</span>
          </span>
          <Icon name="chevron" size={18} />
        </button>
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

      <div className="eyebrow">Data on the server</div>
      <div className="card" style={{ gap: 10 }}>
        {!sum.data && !sum.error && <LoadingBar seconds={3} />}
        {sum.error && <span className="small">{sum.error}</span>}
        {sum.data && (
          <>
            {(['prices', 'receipts', 'stats'] as const).map((k) => (
              <Line key={k} title={KIND_NAME[k]} sub={k === 'prices' ? `${fmt(sum.data!.kinds.prices.count)} prices, for ${fmt(sum.data!.kinds.prices.products)} products` : `${fmt(sum.data!.kinds[k].count)}`}>
                <span className="small num">{bytes(sum.data!.kinds[k].bytes)}</span>
              </Line>
            ))}
            <Line title="In all" sub={sum.data.disk ? `${bytes(sum.data.disk.free)} free on the server's computer` : undefined}>
              <span className="small num">{bytes(sum.data.total)}</span>
            </Line>
            <span className="title" style={{ fontSize: 15 }}>
              How long data is kept
            </span>
            <Seg label="How long data is kept" value={sum.data.autoDelete.months ?? 'off'} options={KEEP} onChange={(v) => void setKeep(v)} disabled={!!working} />
            <span className="small">Older prices, receipts and logs are deleted on the server each night. This {deviceWord()} keeps its own 8 weeks either way. Keeping less needs the passphrase.</span>
            <span className="small">Exporting, importing, deleting and backups are on the server's web page.</span>
          </>
        )}
      </div>

      {key && (
        <Sheet title="Your recovery key" onClose={() => setKey(undefined)}>
          <div className="card" style={{ gap: 10 }}>
            <span className="small">Write it down, or keep it in a password manager. It brings the household back on a new server, and says yes when every admin phone is lost.</span>
            <strong style={{ fontSize: 20, textAlign: 'center', wordBreak: 'break-all', userSelect: 'all' }}>{key}</strong>
            <button
              className="btn primary block"
              onClick={() => {
                void admin.recoverySaved().catch(() => undefined);
                setKey(undefined);
                reload();
              }}
            >
              I've saved it
            </button>
          </div>
        </Sheet>
      )}

      <ActivityCard tick={tick} />

      {s && (
        <>
          <div className="eyebrow">Server settings</div>
          <Household s={s} save={save} />
          <Addresses s={s} save={save} />
          <div className="card" style={{ gap: 10 }}>
            <span className="title">Sign-in and security</span>
            <Line title="Sign in by scanning with a phone" sub="An admin phone scans the code on the sign-in page">
              <input type="checkbox" className="switch" aria-label="Sign in by scanning with a phone" checked={s.qrSignIn !== false} onChange={(e) => void save({ qrSignIn: e.target.checked })} />
            </Line>
            <span className="title" style={{ fontSize: 15 }}>
              Sign out after
            </span>
            <Seg label="Sign out after" value={s.sessionHours ?? 720} options={HOURS} onChange={(v) => void save({ sessionHours: v })} />
            <Browsers tick={tick} />
            <Line title="Recovery key" sub={s.recoverySaved ? 'For a new server, or if every admin phone is lost' : 'Not saved yet. For a new server, or if every admin phone is lost.'}>
              <button className="btn small" disabled={!!working} onClick={() => void showKey()}>
                Show…
              </button>
            </Line>
            <span className="small">The passphrase and user name are changed on the server's web page.</span>
          </div>
          <HomeAssistantCard tick={tick} />
          <div className="card" style={{ gap: 10 }}>
            <span className="title">Updates</span>
            <Line title={`Server ${s.version ?? ''}`} sub={s.updates?.newer ? `${s.updates.latest} is out: update it where it runs (Docker or Dockge).` : s.updates?.checked ? `Up to date. Checked ${timeAgo(s.updates.checked)}.` : undefined} />
            <Line title="Check for updates" sub="Once a day, from GitHub. Admin phones are told about a new one.">
              <input type="checkbox" className="switch" aria-label="Check for updates" checked={s.updates?.on !== false} onChange={(e) => void save({ updateCheck: e.target.checked })} />
            </Line>
            <span className="small">Moving to a new server and erasing this one are on the server's web page.</span>
          </div>
        </>
      )}
    </div>
  );
}

function Household({ s, save }: { s: admin.HouseSettings; save: (p: Record<string, unknown>, done?: string) => Promise<boolean> }) {
  const [name, setName] = useState(s.name ?? '');
  const [zone, setZone] = useState(s.timeZone ?? '');
  const versions = [...new Set([s.lowestApp ?? '0.14.0', '0.18.0', s.version ?? ''])].filter((v) => v && (!s.version || v.localeCompare(s.version, undefined, { numeric: true }) <= 0));
  return (
    <div className="card" style={{ gap: 10 }}>
      <span className="title">Household</span>
      <form
        className="field"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim() && name.trim() !== s.name) void save({ name: name.trim() });
        }}
      >
        <label htmlFor="sa-name" className="small">
          Household name
        </label>
        <div style={{ display: 'flex', gap: 8 }}>
          <input id="sa-name" className="input grow" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
          {name.trim() !== (s.name ?? '') && (
            <button className="btn small primary" type="submit" disabled={!name.trim()}>
              Save
            </button>
          )}
        </div>
      </form>
      <form
        className="field"
        onSubmit={(e) => {
          e.preventDefault();
          if (zone.trim() && zone.trim() !== s.timeZone) void save({ timeZone: zone.trim() }, 'Time zone changed');
        }}
      >
        <label htmlFor="sa-zone" className="small">
          Time zone (for Activity times and the nightly tidy-up)
        </label>
        <div style={{ display: 'flex', gap: 8 }}>
          <input id="sa-zone" className="input grow" value={zone} placeholder="Australia/Brisbane" autoCapitalize="off" onChange={(e) => setZone(e.target.value)} />
          {zone.trim() !== (s.timeZone ?? '') && (
            <button className="btn small primary" type="submit" disabled={!zone.trim()}>
              Save
            </button>
          )}
        </div>
      </form>
      <span className="title" style={{ fontSize: 15 }}>
        Oldest Restock that can join
      </span>
      <Seg label="Oldest Restock that can join" value={s.minApp ?? versions[0]} options={versions.map((v) => ({ value: v, label: v }))} onChange={(v) => void save({ minApp: v }, `Restock ${v} or newer from now on`)} />
      <span className="small">Older phones are told to update before they sync again.</span>
    </div>
  );
}

function Addresses({ s, save }: { s: admin.HouseSettings; save: (p: Record<string, unknown>, done?: string) => Promise<boolean> }) {
  const [home, setHome] = useState(s.home ?? '');
  const [away, setAway] = useState(s.away ?? '');
  const changed = home !== (s.home ?? '') || away !== (s.away ?? '');
  return (
    <div className="card" style={{ gap: 10 }}>
      <span className="title">Addresses</span>
      <span className="small">Phones try the home address first, for a moment, then the away one. New phones get both in their code.</span>
      <label htmlFor="sa-home" className="small">
        At home (your network or Tailscale; http:// is fine)
      </label>
      <input id="sa-home" className="input" value={home} disabled={s.homeFixed} placeholder="http://192.168.1.20:8787" autoCapitalize="off" inputMode="url" onChange={(e) => setHome(e.target.value)} />
      <label htmlFor="sa-away" className="small">
        Away from home (a Cloudflare tunnel or your own domain; https://)
      </label>
      <input id="sa-away" className="input" value={away} disabled={s.awayFixed} placeholder="https://restock.example.com" autoCapitalize="off" inputMode="url" onChange={(e) => setAway(e.target.value)} />
      {(s.homeFixed || s.awayFixed) && <span className="small">Set where the server runs (RESTOCK_HOME_URL / RESTOCK_AWAY_URL): change it there.</span>}
      {changed && (
        <button className="btn primary" onClick={() => void save({ ...(home !== (s.home ?? '') ? { home } : {}), ...(away !== (s.away ?? '') ? { away } : {}) }, 'Addresses saved. Phones pick them up when they next sync.')}>
          Save addresses
        </button>
      )}
    </div>
  );
}

function Browsers({ tick }: { tick: number }) {
  const nav = useNav();
  const [n, setN] = useState(0);
  const b = useLoad(admin.browsers, tick + n);
  if (!b.data?.length) return null;
  return (
    <>
      <span className="title" style={{ fontSize: 15 }}>
        Signed-in browsers
      </span>
      {b.data.map((x) => (
        <Line key={x.id} title={x.label ?? 'A browser'} sub={`${x.kind === 'phone' ? 'An admin phone' : 'The passphrase'} · ${x.lastUsed ? timeAgo(x.lastUsed) : ''}`}>
          <button
            className="btn small"
            onClick={() =>
              void admin
                .endBrowser(x.id)
                .then(() => (nav.toast('Signed out'), setN((v) => v + 1)))
                .catch((e: unknown) => nav.toast(errText(e)))
            }
          >
            Sign out
          </button>
        </Line>
      ))}
    </>
  );
}

function HomeAssistantCard({ tick }: { tick: number }) {
  const nav = useNav();
  const ha = useLoad(admin.homeAssistant, tick);
  const d = ha.data;
  if (!d) return null;
  return (
    <div className="card" style={{ gap: 10 }}>
      <span className="title">Home Assistant</span>
      <Line title="Shopping list in Home Assistant" sub={d.lastError ? `Not working: ${d.lastError}` : d.lastAt ? `Connected · synced ${timeAgo(d.lastAt)}` : d.address ? d.address : 'Not set up'}>
        <input
          type="checkbox"
          className="switch"
          aria-label="Shopping list in Home Assistant"
          checked={!!d.enabled}
          disabled={!d.address}
          onChange={(e) =>
            void admin
              .putHomeAssistant({ enabled: e.target.checked })
              .then((v) => (ha.set(v), nav.toast(v.enabled ? 'On' : 'Off')))
              .catch((err: unknown) => nav.toast(errText(err)))
          }
        />
      </Line>
      <span className="small">The address and token are set on the server's web page (or in Settings → Home Assistant before joining).</span>
    </div>
  );
}

function ActivityCard({ tick }: { tick: number }) {
  const [all, setAll] = useState(false);
  const act = useLoad(() => admin.activity(150), tick);
  const rows = (act.data ?? []).filter((a) => all || isAdminAction(a)).slice(0, 12);
  return (
    <>
      <div className="eyebrow">Activity</div>
      <div className="card" style={{ gap: 8 }}>
        <Seg
          label="Which activity"
          value={all ? 'all' : 'admin'}
          onChange={(v) => setAll(v === 'all')}
          options={[
            { value: 'admin', label: 'Admin actions' },
            { value: 'all', label: 'Everything' },
          ]}
        />
        {!act.data && !act.error && <LoadingBar seconds={3} />}
        {act.error && <span className="small">{act.error}</span>}
        {rows.map((a, i) => (
          <span key={a.at + i} className="small">
            <strong>{whoOf(a, undefined)}</strong> {whatOf(a)} · {timeAgo(a.at)}
          </span>
        ))}
        {act.data && rows.length === 0 && <span className="small">Nothing yet.</span>}
      </div>
    </>
  );
}
