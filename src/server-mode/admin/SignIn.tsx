// 0.18.3: signing in to the server's page. Scan the code with an admin phone (Restock → Settings →
// Sync → Server admin → Sign in a computer), or the user name and passphrase and then a yes on an
// admin phone (PhoneYes.tsx). A fresh server: name the household (step 2 of the setup page).
import { useEffect, useId, useRef, useState } from 'react';
import { serverInfo } from '../api';
import { isPending, loginV3, setUpHouse, signOut, startPhoneLoginV3, type PendingLogin, type Session } from '../session';
import { Logo } from '../../ui/Logo';
import { WaitForPhone } from './PhoneYes';
import { errText, Qr } from './ui';

function Brand() {
  return (
    <div className="sv-row">
      <Logo size={44} />
      <span>
        <b style={{ display: 'block', fontSize: 17 }}>Restock server</b>
        <span className="sv-small">{serverInfo()?.house ?? 'Your household'}</span>
      </span>
    </div>
  );
}

const keptUser = () => {
  try {
    return localStorage.getItem('restock-server-user') ?? 'admin';
  } catch {
    return 'admin';
  }
};

export function SignIn({ onDone }: { onDone: (s: Session) => void }) {
  const [user, setUser] = useState(keptUser);
  const [pass, setPass] = useState('');
  const [keep, setKeep] = useState(false);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState<PendingLogin>();
  const ids = { user: useId(), pass: useId(), keep: useId() };
  const result = useRef<Session | undefined>(undefined);

  const go = async () => {
    setError(undefined);
    setBusy('Checking the passphrase…');
    try {
      const r = await loginV3(user, pass, keep, setBusy);
      try {
        localStorage.setItem('restock-server-user', user.trim());
      } catch {
        // fine
      }
      setPass('');
      if (isPending(r)) setPending(r);
      else onDone(r);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(undefined);
    }
  };

  if (pending) {
    return (
      <div className="sv-gate">
        <div className="sv-card" role="dialog" aria-labelledby="yes-title">
          <WaitForPhone
            a={pending.approve}
            step="Step 2 of 2"
            poll={async () => {
              // The sign-in's own wait: the session (with its keys) comes with the yes.
              result.current = await pending.wait(() => false);
              return result.current ? 'yes' : 'expired';
            }}
            recovery={async (key) => {
              // The yes; the wait above then brings the session.
              await pending.recovery(key);
            }}
            onDone={() => result.current && onDone(result.current)}
            onCancel={() => {
              void pending.cancel();
              setPending(undefined);
            }}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="sv-gate">
      <main className="sv-card" aria-labelledby="signin-title">
        <Brand />
        <h1 id="signin-title">Sign in to your server</h1>
        <PhoneCode onDone={onDone} />
        <div className="sv-or sv-small">or</div>
        <form
          style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
          onSubmit={(e) => {
            e.preventDefault();
            void go();
          }}
        >
          <div className="sv-field">
            <label htmlFor={ids.user}>User name</label>
            <input id={ids.user} className="sv-input" autoComplete="username" value={user} onChange={(e) => setUser(e.target.value)} />
          </div>
          <div className="sv-field">
            <label htmlFor={ids.pass}>Passphrase</label>
            <input id={ids.pass} className="sv-input" type="password" autoComplete="current-password" value={pass} onChange={(e) => setPass(e.target.value)} />
          </div>
          <div className="sv-row">
            <input id={ids.keep} type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} />
            <label htmlFor={ids.keep} className="sv-grow">
              Keep me signed in on this computer
              <span className="sv-small" style={{ display: 'block' }}>
                Leave it off on a shared computer: closing the tab signs you out.
              </span>
            </label>
          </div>
          {error && (
            <p className="sv-error" role="alert">
              {error}
            </p>
          )}
          <button className="sv-btn primary big" type="submit" disabled={!!busy || !user.trim() || !pass}>
            {busy ?? 'Next'}
          </button>
          <p className="sv-small">Then an admin phone says yes. Your passphrase never leaves this browser.</p>
          <p className="sv-small">
            First time? Set the passphrase on the server's <a href="/setup/">setup page</a> first.
          </p>
        </form>
      </main>
    </div>
  );
}

/** The code an admin phone scans to sign this browser in (no passphrase, no second step). */
function PhoneCode({ onDone }: { onDone: (s: Session) => void }) {
  const [code, setCode] = useState<string>();
  const [error, setError] = useState<string>();
  const [round, setRound] = useState(0);
  useEffect(() => {
    let stopped = false;
    void (async () => {
      try {
        const l = await startPhoneLoginV3();
        if (stopped) return;
        setCode(l.code);
        setError(undefined);
        const s = await l.wait(() => stopped);
        if (stopped) return;
        if (s) onDone(s);
        else setError('That code ran out.');
      } catch (e) {
        if (!stopped) setError(errText(e));
      }
    })();
    return () => {
      stopped = true;
    };
  }, [round, onDone]);
  return (
    <div className="sv-row" style={{ alignItems: 'flex-start' }}>
      {code && !error ? (
        <Qr text={code} label="Sign-in code for an admin phone to scan" small />
      ) : (
        <div className="sv-qr small" style={{ background: 'var(--sv-chip)' }}>
          {error ? (
            <button className="sv-btn sm" type="button" onClick={() => setRound((r) => r + 1)}>
              New code
            </button>
          ) : null}
        </div>
      )}
      <p className="sv-small sv-grow" style={{ margin: 0 }}>
        On an admin phone: Restock → Settings → Sync → Server admin → <b>Sign in a computer</b>, then scan this.
        {error && (
          <>
            <br />
            {error}
          </>
        )}
      </p>
    </div>
  );
}

/** A fresh server: name the household (the setup page did step 1, the passphrase). */
export function NameHousehold({ session, onDone }: { session: Session; onDone: (s: Session) => void }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const id = useId();
  return (
    <div className="sv-gate">
      <main className="sv-card" aria-labelledby="setup-title">
        <Brand />
        <p className="sv-eyebrow">Step 2 of 2</p>
        <h1 id="setup-title">Set up this server</h1>
        <p className="sv-small" style={{ fontSize: 15 }}>
          This server becomes your household's. Phones join it, and what they share stays here, even if a phone is removed.
        </p>
        <form
          style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
          onSubmit={(e) => {
            e.preventDefault();
            if (!name.trim()) return;
            setBusy(true);
            setError(undefined);
            setUpHouse(name)
              .then(onDone)
              .catch((err: unknown) => setError(errText(err)))
              .finally(() => setBusy(false));
          }}
        >
          <div className="sv-field">
            <label htmlFor={id}>Name it</label>
            <input id={id} className="sv-input" value={name} maxLength={60} autoComplete="off" placeholder="Declan and Sarah" onChange={(e) => setName(e.target.value)} />
            <span className="sv-small">Shown on this page and when a phone joins.</span>
          </div>
          <div className="sv-note">Signed in as {session.user}.</div>
          {error && (
            <p className="sv-error" role="alert">
              {error}
            </p>
          )}
          <button className="sv-btn primary big" type="submit" disabled={busy || !name.trim()}>
            {busy ? 'Setting up…' : 'Set up server'}
          </button>
          <span className="sv-small">Next: add your first phone.</span>
          <button className="sv-btn sm" type="button" style={{ alignSelf: 'center' }} onClick={() => void signOut().then(() => location.reload())}>
            Sign out
          </button>
        </form>
      </main>
    </div>
  );
}
