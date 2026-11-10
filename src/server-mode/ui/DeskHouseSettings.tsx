// 0.9.4: the house's own settings on the web (protocol v3): Keep data for, the passphrase, the
// encrypted backup, the recovery key, Home Assistant, the household's default branch per shop, and
// the sign-out options, each one saying what it does. Used by Settings (DeskSettings.tsx) at both
// widths.
import { useState, type ReactNode } from 'react';
import { confirmAction } from '../../lib/confirm';
import { keepCutoff } from '../engine';
import { useLive } from '../../lib/useLive';
import { Icon, Sheet } from '../../ui/components';
import { useNav } from '../../ui/nav';
import { checkPassphrase } from '../passphrase';
import { changeHousePassphrase, session } from '../session';
import {
  ADMIN_NOTE,
  askThenConfirm,
  canAdmin,
  branchShops,
  downloadEncryptedBackup,
  errText,
  KEEP_CHOICES,
  keepLabel,
  pruneBefore,
  recoveryKey,
  saveHouseSettings,
  setDefaultBranch,
  useHouseSettings,
  type DefaultBranch,
} from './houseData';
import { signOutAll, signOutHere } from './settingsData';

type LineProps = { title: string; sub?: ReactNode; children?: ReactNode; greyed?: boolean; htmlFor?: string };

/** Keep data for: 3, 6, 9 or 12 months, or Until I delete (then Delete older data now). */
export function KeepDataFor({ Line }: { Line: (p: LineProps) => ReactNode }) {
  const nav = useNav();
  const { data, error, reload } = useHouseSettings();
  const [busy, setBusy] = useState(false);
  const [before, setBefore] = useState('');
  const change = async (v: string) => {
    const months = v === 'forever' ? null : Number(v);
    const was = data?.keepMonths === undefined ? 12 : data.keepMonths;
    setBusy(true);
    try {
      // Shorter than now: what's older goes at once, so the passphrase again first (0.9.4).
      if (months !== null && (was === null || months < was)) {
        const done = await askThenConfirm(
          `Keep data for ${keepLabel(months).toLowerCase()}?`,
          `Prices, receipts (unless pinned), their photos and logs older than ${keepLabel(months).toLowerCase()} are deleted from the server now. Each phone keeps its own copy for as long as it keeps prices.`,
          'Keep less',
          (c) => saveHouseSettings({ keepMonths: months }, c),
        );
        if (!done) return;
      } else await saveHouseSettings({ keepMonths: months });
      nav.toast(`Keeping data for ${keepLabel(months).toLowerCase()}`);
      reload();
    } catch (e) {
      nav.toast(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const prune = async () => {
    if (!before) return;
    const iso = new Date(`${before}T00:00:00`).toISOString();
    try {
      const done = await askThenConfirm(
        `Delete everything before ${new Date(iso).toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' })}?`,
        "Prices (each product keeps its latest), receipts that aren't pinned, their photos and logs. This can't be undone. Phones keep their own copies.",
        'Delete older data',
        (c) => pruneBefore(iso, c),
      );
      if (!done) return;
      nav.toast('Deleted older data from the server');
    } catch (e) {
      nav.toast(errText(e));
    }
  };
  const value = data ? (data.keepMonths === null ? 'forever' : String(data.keepMonths ?? 12)) : '';
  const cut = data?.keepMonths ? keepCutoff(data.keepMonths, Date.now()) : null;
  return (
    <>
      <Line
        title="Keep data for"
        htmlFor="dk-keep"
        sub={
          error ??
          (cut
            ? `Prices, receipts, photos and logs from before ${new Date(cut).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' })} are deleted, once a day. Each product keeps its latest price.`
            : 'Nothing is deleted until you say so.')
        }
      >
        <select id="dk-keep" className="input dk-select" disabled={!data || busy || !canAdmin()} title={canAdmin() ? undefined : ADMIN_NOTE} value={value} onChange={(e) => void change(e.target.value)}>
          {KEEP_CHOICES.map((c) => (
            <option key={String(c.months)} value={c.months === null ? 'forever' : String(c.months)}>
              {c.label}
            </option>
          ))}
        </select>
      </Line>
      {data?.keepMonths === null && (
        <Line title="Delete older data now" htmlFor="dk-prune" sub="Everything from before this day: prices (each product keeps its latest), receipts that aren't pinned, and logs.">
          <span className="dk-btns">
            <input id="dk-prune" type="date" className="input dk-select" value={before} max={new Date().toISOString().slice(0, 10)} onChange={(e) => setBefore(e.target.value)} />
            <button className="btn small danger" disabled={!before} onClick={() => void prune()}>
              Delete
            </button>
          </span>
        </Line>
      )}
    </>
  );
}

/** Change the house's passphrase: the current one, then the new one twice. Other browsers are signed out. */
export function PassphraseV3({ onDone, onCancel }: { onDone: (msg: string) => void; onCancel: () => void }) {
  const user = session()?.user ?? 'admin';
  const [cur, setCur] = useState('');
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const c = checkPassphrase(a, user);
  const same = a === b;
  return (
    <form
      className="dk-set dk-set-form house-form"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!c.ok || !same || !cur) return;
        setBusy(true);
        setError(undefined);
        try {
          await changeHousePassphrase(cur, a);
          onDone('Changed. Every other browser was signed out and needs the new passphrase.');
        } catch (err) {
          setError(errText(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <label className="field">
        <span className="small">Current passphrase</span>
        <input className="input" type="password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} autoFocus />
      </label>
      <label className="field">
        <span className="small">New passphrase</span>
        <input className="input" type="password" autoComplete="new-password" value={a} onChange={(e) => setA(e.target.value)} aria-describedby="pp3-meter" />
      </label>
      <div id="pp3-meter" className={`meter s${c.score}`} aria-live="polite">
        <div className="meter-bar">
          <span style={{ width: a ? `${(c.score + 1) * 20}%` : 0 }} />
        </div>
        <span className="small">
          {a ? c.label : 'At least 20 characters, or 4 words.'}
          {c.problem ? ` · ${c.problem}` : ''}
        </span>
      </div>
      <label className="field">
        <span className="small">The same again</span>
        <input className="input" type="password" autoComplete="new-password" value={b} onChange={(e) => setB(e.target.value)} />
      </label>
      {b && !same && <p className="small">They don't match yet.</p>}
      {error && (
        <p className="banner red small" role="alert">
          {error}
        </p>
      )}
      <span className="dk-btns">
        <button className="btn primary" type="submit" disabled={busy || !cur || !c.ok || !same}>
          {busy ? 'Saving… (a few seconds)' : 'Change the passphrase'}
        </button>
        <button className="btn" type="button" onClick={onCancel}>
          Cancel
        </button>
      </span>
    </form>
  );
}

/** The encrypted backup (D15): a backup passphrase typed now seals it before it leaves the server. */
export function BackupSheet({ onClose }: { onClose: () => void }) {
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  // 0.9.4: the sign-in passphrase again (the backup holds everything, keys too).
  const [me, setMe] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; bad?: boolean }>();
  const c = checkPassphrase(a, session()?.user ?? 'admin');
  return (
    <Sheet title="Download an encrypted backup" onClose={onClose}>
      <p className="small">
        Everything on the server (the household, its keys, years of prices, receipts and photos, the phones' list) in one file, encrypted with a backup
        passphrase you choose now. Keep the passphrase somewhere safe: without it the file can't be opened, by anyone. The server's README says how to restore
        it.
      </p>
      <form
        className="house-form"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!c.ok || a !== b || !me) return;
          setBusy(true);
          setMsg(undefined);
          try {
            const name = await downloadEncryptedBackup(a, me);
            setA('');
            setB('');
            setMe('');
            setMsg({ text: `Saved as ${name}.` });
          } catch (err) {
            setMsg({ text: errText(err), bad: true });
          } finally {
            setBusy(false);
          }
        }}
      >
        <label className="field">
          <span className="small">Backup passphrase</span>
          <input className="input" type="password" autoComplete="new-password" value={a} onChange={(e) => setA(e.target.value)} autoFocus />
        </label>
        <span className="small" aria-live="polite">
          {a ? `${c.label}${c.problem ? ` · ${c.problem}` : ''}` : 'At least 20 characters, or 4 words. It can be different from your sign-in passphrase.'}
        </span>
        <label className="field">
          <span className="small">The same again</span>
          <input className="input" type="password" autoComplete="new-password" value={b} onChange={(e) => setB(e.target.value)} />
        </label>
        <label className="field">
          <span className="small">Your passphrase (the one you sign in with), to make sure it's you</span>
          <input className="input" type="password" autoComplete="current-password" value={me} onChange={(e) => setMe(e.target.value)} />
        </label>
        {msg && (
          <p className={`banner ${msg.bad ? 'red' : 'green'} small`} role={msg.bad ? 'alert' : 'status'}>
            {msg.text}
          </p>
        )}
        <button className="btn primary" type="submit" disabled={busy || !c.ok || a !== b || !me}>
          <Icon name="download" size={18} /> {busy ? 'Making the backup… (a few seconds)' : 'Download'}
        </button>
        <button className="btn" type="button" onClick={onClose}>
          Close
        </button>
      </form>
    </Sheet>
  );
}

/** The recovery key (D16): shown when asked, to write down or save. */
export function RecoverySheet({ onClose }: { onClose: () => void }) {
  const [key, setKey] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  // 0.9.4: the passphrase again before the key is shown.
  const [pass, setPass] = useState('');
  return (
    <Sheet title="Recovery key" onClose={onClose}>
      <p className="small">
        If this server is ever lost, a phone can take the household back with this key (Settings → Sync and backups → Take over). Save it somewhere only
        you can get to, like a password manager. Anyone with it and one of your phones' backups can become the household's owner.
      </p>
      {key ? (
        <>
          <code className="house-recovery" aria-label="Recovery key">
            {key}
          </code>
          <button
            className="btn"
            onClick={() =>
              void navigator.clipboard
                ?.writeText(key)
                .then(() => setError(undefined))
                .catch(() => setError('Copy it by hand.'))
            }
          >
            Copy
          </button>
        </>
      ) : (
        <form
          className="house-form"
          onSubmit={async (ev) => {
            ev.preventDefault();
            if (!pass) return;
            setBusy(true);
            setError(undefined);
            try {
              setKey(await recoveryKey(pass));
              setPass('');
            } catch (e) {
              setError(errText(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          <label className="field">
            <span className="small">Your passphrase, to make sure it's you</span>
            <input className="input" type="password" autoComplete="current-password" value={pass} onChange={(e) => setPass(e.target.value)} autoFocus />
          </label>
          <button className="btn primary" type="submit" disabled={busy || !pass}>
            {busy ? 'Checking… (a few seconds)' : 'Show the recovery key'}
          </button>
        </form>
      )}
      {error && <p className="small">{error}</p>}
      <button className="btn" onClick={onClose}>
        Done
      </button>
    </Sheet>
  );
}

/** Which branch: the household's default branch for each shop, for phones that haven't picked their own. */
export function BranchSheet({ onClose }: { onClose: () => void }) {
  const nav = useNav();
  const groups = useLive(branchShops, []);
  const [edits, setEdits] = useState<Record<string, DefaultBranch>>({});
  const save = async (chain: string, name: string, b: DefaultBranch | undefined) => {
    try {
      const next = b && b.name.trim() ? b : null;
      await setDefaultBranch(chain, next);
      nav.toast(next ? `${name}: ${next.name} for every phone that hasn't picked its own` : `${name}: no default branch`);
    } catch (e) {
      nav.toast(errText(e));
    }
  };
  return (
    <Sheet title="Which branch" onClose={onClose}>
      <p className="small">
        The household's usual branch of each shop. Phones that haven't picked their own branch use it; a phone's own pick always wins. Shop sign-ins stay on
        each phone.
      </p>
      {groups?.map((g) => (
        <fieldset key={g.section} className="card flush dk-fieldset">
          <legend className="house-legend">{g.title}</legend>
          {g.shops.map((s) => {
            const cur = edits[s.chain] ?? s.branch ?? { name: '' };
            const set = (p: Partial<DefaultBranch>) => setEdits((e) => ({ ...e, [s.chain]: { ...cur, ...p } }));
            return (
              <form
                key={s.chain}
                className="row house-branch"
                onSubmit={(e) => {
                  e.preventDefault();
                  void save(s.chain, s.name, edits[s.chain] ?? s.branch);
                }}
              >
                <label htmlFor={`br-${s.chain}`} className="house-branch-name">
                  {s.name}
                </label>
                <input
                  id={`br-${s.chain}`}
                  className="input"
                  placeholder={`Your ${s.name} branch`}
                  value={cur.name}
                  maxLength={80}
                  onChange={(e) => set({ name: e.target.value })}
                />
                {s.chain === 'coles' && (
                  <input
                    className="input house-storeno"
                    inputMode="numeric"
                    aria-label="Coles store number (optional)"
                    placeholder="Store no."
                    value={cur.storeNo ?? ''}
                    maxLength={5}
                    onChange={(e) => set({ storeNo: e.target.value.replace(/\D/g, '') || undefined })}
                  />
                )}
                <button className="btn small" type="submit" aria-label={`Save the ${s.name} branch`}>
                  Save
                </button>
              </form>
            );
          })}
          {g.shops.length === 0 && <p className="row small">No shops picked on this tab.</p>}
        </fieldset>
      ))}
      <button className="btn" onClick={onClose}>
        Done
      </button>
    </Sheet>
  );
}

/** Sign out, and Sign out everywhere, each saying what it does. */
export function SignOutChoices({ Line }: { Line: (p: LineProps) => ReactNode }) {
  return (
    <>
      <Line title="Sign out" sub="Ends this browser's session and deletes its copy of the household from this computer. Other browsers and your phones carry on.">
        <button className="btn small" onClick={() => void signOutHere()}>
          Sign out
        </button>
      </Line>
      <Line
        title="Sign out everywhere"
        sub="Ends every browser's session on this server, this one too: each has to sign in again with the passphrase or a phone. Phones keep syncing; to stop a phone, Remove it on Server and phones."
      >
        <button
          className="btn small danger"
          onClick={async () => {
            const ok = await confirmAction('Sign out every browser?', {
              detail: 'Every browser signed in to this server, this one too. Your phones keep syncing.',
              action: 'Sign out everywhere',
              danger: true,
            });
            if (ok) await signOutAll();
          }}
        >
          Sign out everywhere
        </button>
      </Line>
    </>
  );
}
