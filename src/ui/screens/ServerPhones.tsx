// 0.18.0: Settings → Sync → Restock server, on an admin phone: Phones and tablets. The phones on
// the server with Admin on the admins; tap one for Rename, Make admin / Make user and Remove; Add a
// phone or tablet shows the code it scans (once, for 10 minutes), for a user or (Make admin) an
// admin. The same as the server's web page does (server-mode/admin/PhonesPage.tsx), from the phone.
// 0.18.3: inside Server admin (ServerAdmin.tsx); the only admin phone can't be made a user.
import { useEffect, useRef, useState } from 'react';
import { confirmAction } from '../../lib/confirm';
import { deviceWord } from '../../lib/platform';
import { newCode, phoneLabel, removePhone, renamePhone, serverPhones, setRole, type Phone } from '../../lib/serverPhones';
import { notePhones } from '../../lib/adminNotices';
import { useNow } from '../useNow';
import { Icon, LoadingBar, Sheet, timeAgo } from '../components';
import { useNav } from '../nav';
import { CodeText, PairingQr } from './SyncCodes';

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const isAdmin = (p: Phone) => p.role === 'admin';

function AddSheet({ onClose, onJoined, known }: { onClose: () => void; onJoined: (name: string) => void; known: Phone[] }) {
  const [label, setLabel] = useState('');
  const [makeAdmin, setMakeAdmin] = useState(false);
  const [code, setCode] = useState<{ code: string; until: number; label: string; admin: boolean }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const now = useNow(1000);
  const before = useRef(new Set(known.map((p) => p.device)));
  const make = async () => {
    setError(undefined);
    // 0.18.1: an admin's changes are asked about first (Are you sure?)
    const name = label.trim();
    const ok = await confirmAction(makeAdmin ? `Add ${name} as an admin?` : `Add ${name}?`, {
      detail: makeAdmin
        ? `A code shows for ${name} to scan, once, for 10 minutes. As an admin it can add phones and tablets, remove them, and make others admins or users.`
        : `A code shows for ${name} to scan, once, for 10 minutes. It joins as a user: it syncs, without looking after the phones.`,
      action: 'Show the code',
      danger: false,
    });
    if (!ok) return;
    setBusy(true);
    try {
      before.current = new Set(known.map((p) => p.device));
      const c = await newCode(label, makeAdmin);
      setCode({ ...c, label: label.trim(), admin: makeAdmin });
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };
  // While the code shows: watch for the new phone joining.
  useEffect(() => {
    if (!code) return;
    const t = setInterval(() => {
      void serverPhones()
        .then((list) => {
          const fresh = list.find((p) => !before.current.has(p.device) && (!p.status || p.status === 'active'));
          if (fresh) onJoined(phoneLabel(fresh));
        })
        .catch(() => undefined);
    }, 3000);
    return () => clearInterval(t);
  }, [code, onJoined]);
  const left = code ? Math.max(0, Math.round((code.until - now) / 1000)) : 0;
  return (
    <Sheet title="Add a phone or tablet" onClose={onClose} unsaved={!!code && left > 0}>
      {!code || left === 0 ? (
        <form
          className="card"
          style={{ gap: 10 }}
          onSubmit={(e) => {
            e.preventDefault();
            if (label.trim()) void make();
          }}
        >
          <label htmlFor="sp-name" className="title" style={{ fontSize: 15 }}>
            Whose phone or tablet is it?
          </label>
          <input id="sp-name" className="input" value={label} maxLength={60} autoComplete="off" placeholder="Sarah's iPad" onChange={(e) => setLabel(e.target.value)} />
          <span className="small">The name everyone sees for it on the server.</span>
          <label className="row" style={{ padding: 0 }}>
            <span className="grow">
              <span className="title" style={{ fontSize: 15 }}>
                Make admin
              </span>
              <span className="small">An admin can add phones and tablets, remove them, and make others admins.</span>
            </span>
            <input type="checkbox" className="switch" checked={makeAdmin} onChange={(e) => setMakeAdmin(e.target.checked)} />
          </label>
          {code && left === 0 && <span className="small">That code ran out. Make a new one.</span>}
          <button className="btn primary" type="submit" disabled={busy || !label.trim()}>
            {busy ? 'Making a code…' : 'Show the code'}
          </button>
          {busy && <LoadingBar seconds={4} />}
        </form>
      ) : (
        <div className="card" style={{ gap: 10 }}>
          <span className="small">
            For <strong>{code.label}</strong>
            {code.admin ? ' · joins as an admin' : ''}
          </span>
          <PairingQr code={code.code} label={`Code for ${code.label} to scan`} />
          <span className="small">
            On the new phone or tablet: Restock → Settings → Sync → Join your server → Scan. Works once, for{' '}
            {left >= 60 ? `${Math.ceil(left / 60)} more min` : `${left} more seconds`}.
          </span>
          <CodeText code={code.code} />
          <button className="btn small" onClick={() => setCode(undefined)}>
            Cancel the code
          </button>
        </div>
      )}
      {error && (
        <div className="banner amber" role="alert">
          {error}
        </div>
      )}
    </Sheet>
  );
}

function PhoneSheet({ p, onClose, onDone, onlyAdmin }: { p: Phone; onClose: () => void; onDone: (msg: string) => void; /** 0.18.1: this is the server's only admin phone */ onlyAdmin: boolean }) {
  const [label, setLabel] = useState(phoneLabel(p));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const name = phoneLabel(p);
  const run = async (f: () => Promise<string | undefined>) => {
    setError(undefined);
    setBusy(true);
    try {
      const msg = await f();
      if (msg) onDone(msg);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const changed = label.trim() !== name;
  return (
    <Sheet title={name} onClose={onClose} unsaved={changed}>
      <form
        className="card"
        style={{ gap: 10 }}
        onSubmit={(e) => {
          e.preventDefault();
          if (label.trim() && changed) void run(async () => (await renamePhone(p.device, label), `Renamed to ${label.trim()}.`));
        }}
      >
        <label htmlFor="sp-rename" className="title" style={{ fontSize: 15 }}>
          Name on the server
        </label>
        <input id="sp-rename" className="input" value={label} maxLength={60} onChange={(e) => setLabel(e.target.value)} />
        <button className="btn primary" type="submit" disabled={busy || !label.trim() || !changed}>
          Save the name
        </button>
      </form>
      <div className="card flush">
        <button
          className="row"
          // 0.18.3: the only admin phone can't be made a user (the server says no too).
          disabled={busy || (isAdmin(p) && onlyAdmin)}
          onClick={() =>
            void run(async () => {
              if (!isAdmin(p)) {
                const ok = await confirmAction(`Make ${name} an admin?`, {
                  detail: `${name} can then add phones and tablets, remove them, and make others admins or users.`,
                  action: 'Make admin',
                  danger: false,
                });
                if (!ok) return undefined;
              } else if (p.me) {
                const ok = await confirmAction('Make this phone a user?', {
                  detail: 'It stops being able to add, remove or change phones. Another admin, or the web page, can make it an admin again.',
                  action: 'Make user',
                  danger: false,
                });
                if (!ok) return undefined;
              } else {
                // 0.18.1: Make user for another phone is asked about too
                const ok = await confirmAction(`Make ${name} a user?`, {
                  detail: `${name} keeps syncing, but can't add, remove or change phones any more. You can make it an admin again.`,
                  action: 'Make user',
                  danger: false,
                });
                if (!ok) return undefined;
              }
              await setRole(p.device, isAdmin(p) ? 'user' : 'admin');
              return isAdmin(p) ? `${name} is a user now.` : `${name} is an admin now.`;
            })
          }
        >
          <Icon name="shield" size={18} />
          <span className="grow">
            <span className="title" style={{ fontSize: 15 }}>
              {isAdmin(p) ? 'Make user' : 'Make admin'}
            </span>
            <span className="small">
              {isAdmin(p) && onlyAdmin
                ? "It's the only admin phone. Make another phone an admin first, so there's always one to look after the phones and say yes to sign-ins."
                : isAdmin(p)
                  ? 'Syncs as before, without looking after the phones.'
                  : 'Can add, remove and change phones and tablets, and say yes to sign-ins.'}
            </span>
          </span>
        </button>
        {!p.me && (
          <button
            className="row"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const ok = await confirmAction(`Remove ${name}?`, {
                  detail: `${name} stops syncing with the server, and the household gets a new key so it can't read anything changed from now on. Nothing it shared is deleted. To use it here again, add it again.`,
                  action: 'Remove',
                });
                if (!ok) return undefined;
                await removePhone(p.device);
                return `${name} was removed. Everything it shared is still on the server.`;
              })
            }
          >
            <Icon name="close" size={18} />
            <span className="grow">
              <span className="title" style={{ fontSize: 15, color: 'var(--red-ink)' }}>
                Remove {name}
              </span>
              <span className="small">It stops syncing. Nothing it shared is deleted.</span>
            </span>
          </button>
        )}
      </div>
      {busy && <LoadingBar seconds={4} />}
      {error && (
        <div className="banner amber" role="alert">
          {error}
        </div>
      )}
    </Sheet>
  );
}

/** Phones and tablets on the server, for an admin phone. */
export function ServerPhones({ label }: { label: string }) {
  const nav = useNav();
  const [phones, setPhones] = useState<Phone[]>();
  const [error, setError] = useState<string>();
  const [tick, setTick] = useState(0);
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<Phone>();
  useEffect(() => {
    let live = true;
    serverPhones().then(
      // 0.18.1: what's seen here isn't sent as a notification later (lib/adminNotices.ts)
      (l) => live && (setPhones(l), setError(undefined), void notePhones(l)),
      (e) => live && setError(errText(e)),
    );
    return () => {
      live = false;
    };
  }, [tick]);
  const reload = () => setTick((t) => t + 1);
  const active = phones?.filter((p) => !p.status || p.status === 'active') ?? [];
  const onlyAdmin = active.filter(isAdmin).length === 1 && active.some((p) => p.me && isAdmin(p));
  return (
    <>
      <div className="eyebrow">Phones and tablets on {label}</div>
      <div className="card flush">
        {phones === undefined && !error && (
          <div className="row" role="status">
            <span className="grow small">Loading…</span>
          </div>
        )}
        {active.map((p) => (
          <button key={p.device} className="row" onClick={() => setOpen(p)}>
            <Icon name="phone" size={18} />
            <span className="grow">
              <span className="title" style={{ fontSize: 15 }}>
                {phoneLabel(p)}
                {p.me ? ` (this ${deviceWord()})` : ''}
                {isAdmin(p) && <span className="tag rec-tag">Admin</span>}
              </span>
              <span className="small">{[p.lastSeen ? `Synced ${timeAgo(p.lastSeen)}` : 'Not synced yet', p.version ? `Restock ${p.version}` : undefined].filter(Boolean).join(' · ')}</span>
            </span>
            <Icon name="chevron" size={18} />
          </button>
        ))}
        <button className="row" onClick={() => setAdding(true)} disabled={!phones}>
          <Icon name="plus" size={18} />
          <span className="grow">
            <span className="title" style={{ fontSize: 15 }}>
              Add a phone or tablet
            </span>
            <span className="small">Shows a code for it to scan</span>
          </span>
          <Icon name="chevron" size={18} />
        </button>
        {error && (
          <div className="banner amber" role="alert" style={{ margin: '0 14px 12px' }}>
            {error}
          </div>
        )}
        <p className="small" style={{ padding: '4px 14px 12px', margin: 0 }}>
          You're an admin: you look after the phones on this server and say yes to sign-ins, as its web page does.
        </p>
      </div>
      {adding && phones && (
        <AddSheet
          known={phones}
          onClose={() => setAdding(false)}
          onJoined={(name) => {
            setAdding(false);
            reload();
            nav.toast(`${name} joined`);
          }}
        />
      )}
      {open && (
        <PhoneSheet
          p={open}
          onlyAdmin={onlyAdmin}
          onClose={() => setOpen(undefined)}
          onDone={(msg) => {
            setOpen(undefined);
            reload();
            nav.toast(msg);
          }}
        />
      )}
    </>
  );
}
