// 0.9.4: the house's own settings on the web (protocol v3): Keep data for (0.9.5: Auto delete, now in Data), the passphrase, the
// encrypted backup, the recovery key, Home Assistant, the household's default branch per shop, and
// the sign-out options, each one saying what it does. Used by Settings (DeskSettings.tsx) at both
// widths.
import { useState, type ReactNode } from 'react';
import { confirmAction } from '../../lib/confirm';
import { useLive } from '../../lib/useLive';
import { Icon, Sheet } from '../../ui/components';
import { useNav } from '../../ui/nav';
import { checkPassphrase } from '../passphrase';
import { changeHousePassphrase, session } from '../session';
import {
  branchShops,
  downloadEncryptedBackup,
  errText,
  recoveryKey,
  setDefaultBranch,
  useHouseSettings,
  type DefaultBranch,
} from './houseData';
import { signOutAll, signOutHere } from './settingsData';

type LineProps = { title: string; sub?: ReactNode; children?: ReactNode; greyed?: boolean; htmlFor?: string };

/**
 * 0.9.5: Auto delete (0.9.4's Keep data for) moved to the Data tab, with the two checks before
 * anything is deleted; Settings says where it is and what it's set to.
 */
export function KeepDataFor({ Line }: { Line: (p: LineProps) => ReactNode }) {
  const nav = useNav();
  const { data } = useHouseSettings();
  const m = data?.keepMonths;
  const now = m === undefined ? '' : m === null ? ' It is off.' : ` It deletes data older than ${m} months.`;
  return (
    <Line title="Auto delete" sub={`Auto delete is in Data, with cleaning up and deleting what's on the server.${now}`}>
      <button className="btn small" onClick={() => nav.push({ name: 'server', page: 'data-manage' })}>
        Open Data
      </button>
    </Line>
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
                    aria-label="Coles branch number (optional)"
                    placeholder="Branch no."
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
