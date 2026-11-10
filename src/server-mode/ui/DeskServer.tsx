// 0.9.4: Server and phones for a house (protocol v3), as on the approved concept (WebPhones): the
// phones on the server with Rename and Remove (removed and left ones listed, greyed), Add a phone
// (name it, then the code), what's kept on the server, the browsers signed in, and Activity and
// logs. Works at desktop widths and, inside the phone layout, at phone widths. Before the handover
// (a 0.9.4 server in v2 mode) the owner's Take this household code lives here too.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { confirmAction } from '../../lib/confirm';
import { Icon, Sheet, TopBar, timeAgo } from '../../ui/components';
import { useNav } from '../../ui/nav';
import { api3, type Phone } from '../api';
import { refreshHouseKeys, session } from '../session';
import { syncNow } from '../live';
import { Qr } from './Qr';
import { useNow, useStatus } from './ServerScreens';
import { DeskHead, takeStartOn } from './deskShared';
import {
  askThenConfirm,
  canAdmin,
  browserKind,
  dayText,
  errText,
  isThisBrowser,
  newPhoneCode,
  phoneName,
  sharesText,
  useBrowsers,
  useHouseSettings,
  usePhonesV3,
  useServer,
} from './houseData';
import { cardNames, signOutHere } from './settingsData';
import { useLive } from '../../lib/useLive';

/** A page that's wide on a computer and a phone screen (with Back) in the phone layout. */
export function HousePage({ title, sub, actions, narrow, children }: { title: string; sub?: ReactNode; actions?: ReactNode; narrow?: boolean; children: ReactNode }) {
  if (narrow)
    return (
      <div className="screen house-narrow">
        <TopBar title={title} />
        {actions && <div className="house-actions">{actions}</div>}
        {children}
      </div>
    );
  return (
    <div className="dk-page">
      <DeskHead title={title} sub={sub}>
        {actions}
      </DeskHead>
      {children}
    </div>
  );
}

/** Add a phone: name it ("Sister's phone"), then the code it scans (works once, for 10 minutes). */
export function AddPhoneV3({ onAdded, onClose, known }: { onAdded: () => void; onClose?: () => void; known: Phone[] | undefined }) {
  const [label, setLabel] = useState('');
  const [code, setCode] = useState<{ code: string; until: number; label: string }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [joined, setJoined] = useState<string>();
  const now = useNow(1000);
  const before = useRef<Set<string>>(new Set());
  const make = async () => {
    setError(undefined);
    setJoined(undefined);
    setBusy(true);
    try {
      before.current = new Set((known ?? []).map((p) => p.device));
      const c = await newPhoneCode(label);
      setCode({ ...c, label: label.trim() });
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };
  // While the code shows: watch for the phone joining.
  useEffect(() => {
    if (!code) return;
    const t = setInterval(() => {
      void api3
        .phones()
        .then((list) => {
          const fresh = list.find((p) => !before.current.has(p.device));
          if (fresh) {
            setJoined(phoneName(fresh));
            setCode(undefined);
            setLabel('');
            onAdded();
          }
        })
        .catch(() => undefined);
    }, 3000);
    return () => clearInterval(t);
  }, [code, onAdded]);
  const left = code ? Math.max(0, Math.round((code.until - now) / 1000)) : 0;
  return (
    <section className="card house-add" aria-labelledby="house-add-title">
      <div className="dk-section-head">
        <h2 id="house-add-title">Add a phone</h2>
        {onClose && (
          <button className="icon-btn" aria-label="Close Add a phone" onClick={onClose}>
            <Icon name="close" size={20} />
          </button>
        )}
      </div>
      {joined && (
        <p className="banner green small" role="status">
          {joined} joined. It shows up under Phones.
        </p>
      )}
      {!code || left === 0 ? (
        <form
          className="house-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (label.trim()) void make();
          }}
        >
          <label htmlFor="house-add-name" className="house-label">
            Whose phone is it?
          </label>
          <input
            id="house-add-name"
            className="input"
            value={label}
            maxLength={60}
            autoComplete="off"
            placeholder="Sister's phone"
            onChange={(e) => (setLabel(e.target.value), setJoined(undefined))}
            aria-describedby="house-add-help"
          />
          <span id="house-add-help" className="dk-sub">
            The name everyone sees for it on this server. You can rename it later.
          </span>
          {code && left === 0 && <p className="small">That code ran out. Make a new one.</p>}
          <button className="btn primary" type="submit" disabled={busy || !label.trim()}>
            {busy ? 'Making a code…' : 'Show the code'}
          </button>
        </form>
      ) : (
        <>
          <p className="small house-tight">
            For <strong>{code.label}</strong>
          </p>
          <Qr text={code.code} label={`Code for ${code.label} to scan`} />
          <p className="small house-tight">
            On the phone: Restock → Settings → Sync and backups → <strong>Join your server</strong> → Scan. Works once, for{' '}
            {left >= 60 ? `${Math.ceil(left / 60)} more min` : `${left} more seconds`}. Needs Restock 0.9.4 or newer.
          </p>
          <details className="small">
            <summary>Can't scan it?</summary>
            <code className="sync-code-text">{code.code}</code>
          </details>
          <button className="btn small" onClick={() => setCode(undefined)}>
            Cancel the code
          </button>
        </>
      )}
      {error && (
        <p className="banner red small" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

function RenameSheet({ p, onClose, onDone }: { p: Phone; onClose: () => void; onDone: (msg: string) => void }) {
  const [label, setLabel] = useState(phoneName(p));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  return (
    <Sheet title={`Rename ${phoneName(p)}`} onClose={onClose}>
      <form
        className="house-form"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!label.trim()) return;
          setBusy(true);
          try {
            await api3.renamePhone(p.device, label.trim());
            onDone(`Renamed to ${label.trim()}.`);
          } catch (err) {
            setError(errText(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <label htmlFor="house-rename" className="house-label">
          Name on this server
        </label>
        <input id="house-rename" className="input" value={label} maxLength={60} autoFocus onChange={(e) => setLabel(e.target.value)} />
        <span className="dk-sub">Every phone and browser on the server sees this name. The phone keeps its own name for the server.</span>
        {error && (
          <p className="banner red small" role="alert">
            {error}
          </p>
        )}
        <button className="btn primary" type="submit" disabled={busy || !label.trim()}>
          Save
        </button>
        <button className="btn" type="button" onClick={onClose}>
          Cancel
        </button>
      </form>
    </Sheet>
  );
}

function PhonesCard({ phones, error, reload }: { phones?: Phone[]; error?: string; reload: () => void }) {
  const [renaming, setRenaming] = useState<Phone>();
  const [msg, setMsg] = useState<string>();
  const remove = async (p: Phone) => {
    const name = phoneName(p);
    try {
      const done = await askThenConfirm(
        `Remove ${name}?`,
        `${name} stops syncing with this server, and the household gets a new key so it can't read anything changed from now on. Nothing it shared is deleted. To use it here again, add it again.`,
        'Remove',
        (c) => api3.removePhone(p.device, c).then(() => true),
      );
      if (!done) return;
      setMsg(`${name} was removed. Everything it shared is still here.`);
      reload();
      // The household has a new key now: this browser takes it, then syncs with it.
      void refreshHouseKeys()
        .catch(() => false)
        .then(() => syncNow());
    } catch (e) {
      setMsg(errText(e));
    }
  };
  const active = phones?.filter((p) => !p.status || p.status === 'active') ?? [];
  const gone = phones?.filter((p) => p.status && p.status !== 'active') ?? [];
  return (
    <section className="card flush" aria-labelledby="house-phones">
      <h2 id="house-phones" className="dk-card-title">
        Phones
      </h2>
      {phones === undefined && !error && <p className="dk-row small">Loading…</p>}
      {phones && active.length === 0 && <p className="dk-row small">No phones on this server yet. Add one with Add a phone.</p>}
      {active.map((p) => (
        <div key={p.device} className="dk-row">
          <span className="grow">
            <span className="dk-row-title">{phoneName(p)}</span>
            <span className="dk-sub">
              {[
                sharesText(p),
                p.lastSeen ? `synced ${timeAgo(p.lastSeen)}` : 'not synced yet',
                p.api === 2 ? 'needs Restock 0.9.4 or newer' : p.version ? `Restock ${p.version}` : undefined,
              ]
                .filter(Boolean)
                .join(' · ')}
            </span>
          </span>
          <button className="btn small" onClick={() => setRenaming(p)} aria-label={`Rename ${phoneName(p)}`}>
            Rename
          </button>
          {canAdmin() && (
            <button className="btn small house-danger" onClick={() => void remove(p)} aria-label={`Remove ${phoneName(p)}`}>
              Remove
            </button>
          )}
        </div>
      ))}
      {gone.map((p) => (
        <div key={p.device} className="dk-row house-gone">
          <span className="grow">
            <span className="dk-row-title">{phoneName(p)}</span>
            <span className="dk-sub">
              {p.status === 'left' ? 'Left' : 'Removed'}
              {p.statusAt ? ` ${dayText(p.statusAt)}` : ''} · everything it shared is still here
            </span>
          </span>
        </div>
      ))}
      {error && <p className="dk-row banner red small">{error}</p>}
      {msg && (
        <p className="dk-row small" role="status">
          {msg}
        </p>
      )}
      <p className="dk-row dk-sub">
        Removing a phone stops it syncing. Nothing it shared is deleted.{canAdmin() ? '' : ' To remove one, sign in with the passphrase.'}
      </p>
      {renaming && (
        <RenameSheet
          p={renaming}
          onClose={() => setRenaming(undefined)}
          onDone={(m) => {
            setRenaming(undefined);
            setMsg(m);
            reload();
          }}
        />
      )}
    </section>
  );
}

function span(fromIso: string | undefined): string | undefined {
  if (!fromIso) return undefined;
  const days = (Date.now() - Date.parse(fromIso)) / 86_400_000;
  if (!Number.isFinite(days) || days < 0) return undefined;
  if (days >= 365 * 1.5) return `${Math.round(days / 365)} years`;
  if (days >= 60) return `${Math.round(days / 30.4)} months`;
  if (days >= 14) return `${Math.round(days / 7)} weeks`;
  return `${Math.max(1, Math.round(days))} day${Math.round(days) === 1 ? '' : 's'}`;
}

function KeptCard() {
  const nav = useNav();
  // Again after a sync round (at most every half minute): phones' files merge on the server meanwhile.
  const st = useStatus();
  const tick = st.at ? Math.floor(Date.parse(st.at) / 30_000) : 0;
  const { data: stats } = useServer(() => api3.stats(60).catch(() => undefined), [tick]);
  const { data: settings } = useHouseSettings();
  const months = stats?.months ?? [];
  // The oldest month with prices in it (the answer lists every month of the window).
  const first = months.filter((m) => (m.productsTracked ?? 0) > 0).map((m) => m.month).sort()[0];
  const oldest = first ? `${first}-01T00:00:00Z` : undefined;
  const receipts = months.reduce((s, m) => s + (m.receiptCount ?? 0), 0);
  return (
    <section className="card" aria-labelledby="house-kept">
      <h2 id="house-kept">Kept on this server</h2>
      <div className="dk-stats two">
        <div>
          <span className="dk-stat num">{span(oldest) ?? (stats ? 'None yet' : '…')}</span>
          <span className="dk-sub">of prices</span>
        </div>
        <div>
          <span className="dk-stat num">{stats ? receipts : '…'}</span>
          <span className="dk-sub">receipt{receipts === 1 ? '' : 's'}</span>
        </div>
      </div>
      <span className="small">
        Auto delete:{' '}
        <strong>{settings ? (settings.keepMonths === null || settings.keepMonths === undefined ? 'Off' : `after ${settings.keepMonths} months`) : '…'}</strong>. Change it, or see
        what's kept, in Data.
      </span>
      <button className="dk-linkish dk-self-start" onClick={() => nav.push({ name: 'server', page: 'activity' })}>
        Activity and logs
      </button>
    </section>
  );
}

function BrowsersCard() {
  const { data, error, reload } = useBrowsers();
  const [msg, setMsg] = useState<string>();
  const end = async (id: string, label: string) => {
    const ok = await confirmAction(`Sign out ${label}?`, { detail: 'That browser has to sign in again to see the house.', action: 'Sign it out', danger: true });
    if (!ok) return;
    try {
      await api3.endBrowser(id);
      setMsg(`${label} was signed out.`);
      reload();
    } catch (e) {
      setMsg(errText(e));
    }
  };
  return (
    <section className="card flush" aria-labelledby="house-browsers">
      <h2 id="house-browsers" className="dk-card-title">
        Browsers
      </h2>
      {data === undefined && !error && <p className="dk-row small">Loading…</p>}
      {data?.map((b) => {
        const me = isThisBrowser(b);
        const label = b.label || (b.kind === 'phone' ? 'A browser signed in with a phone' : 'A browser');
        return (
          <div key={b.id} className="dk-row">
            <span className="grow">
              <span className="dk-row-title">
                {label}
                {me && <span className="dk-badge green">This browser</span>}
              </span>
              <span className="dk-sub">
                {[browserKind(b), b.lastUsed ? `used ${timeAgo(b.lastUsed)}` : undefined, b.created ? `since ${dayText(b.created)}` : undefined].filter(Boolean).join(' · ')}
              </span>
            </span>
            {me ? (
              <button className="btn small" onClick={() => void signOutHere()}>
                Sign out
              </button>
            ) : (
              <button className="btn small" onClick={() => void end(b.id, label)} aria-label={`Sign out ${label}`}>
                Sign it out
              </button>
            )}
          </div>
        );
      })}
      {error && <p className="dk-row banner red small">{error}</p>}
      {msg && (
        <p className="dk-row small" role="status">
          {msg}
        </p>
      )}
      <p className="dk-row dk-sub">Signing a browser out ends its session and it forgets the house. Phones aren't touched.</p>
    </section>
  );
}

/**
 * Loyalty cards (decided for 0.9.4): only from phones that chose to share cards, and only their
 * names. The number never reaches the server's database or this browser (the engine blanks it as
 * it comes in), so there's nothing to reveal: the mask is all there is.
 */
function CardsCard({ phones }: { phones?: Phone[] }) {
  const cards = useLive(cardNames, []);
  const sharing = phones?.filter((p) => (!p.status || p.status === 'active') && p.shares?.cards) ?? [];
  return (
    <section className="dk-locked" aria-labelledby="house-cards">
      <div className="dk-locked-title">
        <Icon name="lock" size={18} /> <strong id="house-cards">Loyalty cards</strong>
      </div>
      {cards && cards.length > 0 && sharing.length > 0 ? (
        <div className="dk-cardrow">
          {cards.map((name, i) => (
            <div key={i} className="dk-minicard">
              <span>{name}</span>
              <span aria-hidden>•••• ••••</span>
              <span className="sr-only">Number kept on the phone</span>
            </div>
          ))}
        </div>
      ) : (
        <span className="small">{sharing.length ? 'None shared yet.' : 'No phone shares its cards. That\'s the default: they\'re best kept on your phone.'}</span>
      )}
      <span className="small">
        {sharing.length ? `Shared by ${sharing.map(phoneName).join(', ')}. ` : ''}Card numbers stay on the phones: the server blanks them before keeping anything, so this page never has them.
      </span>
    </section>
  );
}

export function ServerAndPhones({ narrow }: { narrow?: boolean }) {
  const st = useStatus();
  const phones = usePhonesV3();
  // Straight after Set up this server: Add a phone is open.
  const [adding, setAdding] = useState(() => takeStartOn() === 'add-phone');
  const name = st.household ?? session()?.household ?? 'Your house';
  return (
    <HousePage
      narrow={narrow}
      title={narrow ? 'Server and phones' : name}
      sub={narrow ? undefined : 'your Restock server'}
      actions={
        !adding && (
          <button className="btn primary" onClick={() => setAdding(true)}>
            <Icon name="plus" size={18} /> Add a phone
          </button>
        )
      }
    >
      <div className="dk-split house-split">
        <div className="dk-wide dk-stack">
          <PhonesCard phones={phones.data} error={phones.error} reload={phones.reload} />
          <BrowsersCard />
        </div>
        <div className="dk-aside house-aside">
          {adding && <AddPhoneV3 known={phones.data} onAdded={phones.reload} onClose={() => setAdding(false)} />}
          <KeptCard />
          <CardsCard phones={phones.data} />
        </div>
      </div>
    </HousePage>
  );
}

/** Before the handover (a 0.9.4 server in v2 mode): the code the owner phone scans to hand the household over. */
export function HandoverCard() {
  const [code, setCode] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const make = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const r = await api3.handover();
      const kex = r.kex ? `&k=${r.kex}` : '';
      setCode(r.code ?? `restock-handover:3?u=${encodeURIComponent(location.origin)}&t=${encodeURIComponent(r.token)}${kex}`);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card house-add" aria-labelledby="house-take">
      <h2 id="house-take">Take this household</h2>
      <p className="small house-tight">
        Make this server the household's owner: it then keeps everything, adds and removes phones itself, and runs Home Assistant. Your phones keep what they
        have.
      </p>
      {!code ? (
        <button className="btn primary dk-self-start" disabled={busy} onClick={() => void make()}>
          {busy ? 'Making a code…' : 'Show the handover code'}
        </button>
      ) : (
        <>
          <ol className="small steps">
            <li>On the owner phone (Restock 0.9.4 or newer): Settings → Sync and backups → Your server → Hand this household to the server.</li>
            <li>Scan this code. It works once, for 10 minutes.</li>
            <li>When the phone says it's done, reload this page and sign in again.</li>
          </ol>
          <Qr text={code} label="Handover code for the owner phone to scan" />
          <button className="btn small" onClick={() => location.reload()}>
            It's done: reload
          </button>
        </>
      )}
      {error && (
        <p className="banner red small" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
