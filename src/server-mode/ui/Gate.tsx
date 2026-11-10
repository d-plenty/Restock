// Server mode: before the app opens. Sign in (passphrase, or with a phone), set the passphrase on
// first start, and link this browser with the household once.
// 0.9.4, a house (v3): sign in with a challenge (no vault, no link), and on a fresh server the
// second setup step, Set up this server (the server's own setup page does the first, the passphrase).
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon, Logo } from '../../ui/components';
import { ApiError, isV3, serverInfo } from '../api';
import { checkPassphrase } from '../passphrase';
import { login, loginV3, setPassphrase, setUpHouse, startLink, startPhoneLogin, startPhoneLoginV3, signOut, type Session } from '../session';
import { Qr } from './Qr';
import { InstallHelpLink } from '../pwa/InstallHelp'; // 0.9.5 (PWA)

function Frame({ title, children, foot }: { title: string; children: ReactNode; foot?: ReactNode }) {
  return (
    <div className="app server-gate">
      <div className="screen">
        <div className="gate-head">
          <Logo size={44} />
          <div>
            <div className="small">Restock server</div>
            <h1 style={{ margin: 0, fontSize: 24 }}>{title}</h1>
          </div>
        </div>
        {children}
        {foot}
      </div>
    </div>
  );
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function LoginScreen({ onDone, onSetup }: { onDone: (s: Session) => void; onSetup: (user: string) => void }) {
  const [user, setUser] = useState(() => {
    try {
      return localStorage.getItem('restock-server-user') ?? 'admin';
    } catch {
      return 'admin';
    }
  });
  const [pass, setPass] = useState('');
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [phone, setPhone] = useState(false);
  const house = isV3();
  const [keep, setKeep] = useState(false);
  if (phone) return <PhoneLoginScreen onDone={onDone} onBack={() => setPhone(false)} />;
  const go = async () => {
    setError(undefined);
    setBusy('Signing in…');
    try {
      const r = house ? { mustChange: false as const, session: await loginV3(user, pass, keep, setBusy) } : await login(user, pass, setBusy);
      try {
        localStorage.setItem('restock-server-user', user.trim());
      } catch {
        // fine
      }
      setPass('');
      if (r.mustChange) onSetup(user.trim());
      else onDone(r.session);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(undefined);
    }
  };
  return (
    <Frame title="Sign in">
      <p className="small" style={{ margin: 0 }}>
        {house
          ? `${serverInfo()?.house ? `${serverInfo()!.house}: your` : 'Your'} house's lists, prices and receipts. Your passphrase never leaves this browser, and what the server sends is sealed for this sign-in only.`
          : "Your household's lists, prices and receipts, from your phones. They're unlocked here, in this browser; the server only keeps them sealed."}
      </p>
      <form
        className="card gate-form"
        onSubmit={(e) => {
          e.preventDefault();
          void go();
        }}
      >
        <label className="field">
          <span className="small">User name</span>
          <input className="input" autoComplete="username" value={user} onChange={(e) => setUser(e.target.value)} />
        </label>
        <label className="field">
          <span className="small">Passphrase</span>
          <input className="input" type="password" autoComplete="current-password" value={pass} onChange={(e) => setPass(e.target.value)} autoFocus />
        </label>
        {house && (
          <label className="check gate-keep">
            <input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} aria-describedby="gate-keep-help" />
            <span className="grow">
              Keep me signed in on this computer
              <span id="gate-keep-help" className="small">
                For 30 days of not using it. Leave it off on a shared computer: then closing the tab signs you out.
              </span>
            </span>
          </label>
        )}
        {error && (
          <p className="banner red small" role="alert">
            {error}
          </p>
        )}
        <button className="btn primary block" type="submit" disabled={!!busy || !user.trim() || !pass}>
          {busy ?? 'Sign in'}
        </button>
        {house ? (
          <p className="small" style={{ margin: 0 }}>
            First time? Set the passphrase on the server's <a href="/setup/">setup page</a>, then sign in here with it.
          </p>
        ) : (
          <p className="small" style={{ margin: 0 }}>
            First time? Sign in with the user name and password the server started with (<code>admin</code> unless it was set up with others).
          </p>
        )}
      </form>
      <button className="btn block" onClick={() => setPhone(true)}>
        <Icon name="phone" size={18} /> Sign in with a phone
      </button>
      {/* 0.9.5 (PWA): "On iPhone?" steps. */}
      {house && <InstallHelpLink className="linkish small gate-install" />}
    </Frame>
  );
}

/** QR sign-in: a joined phone scans it and says yes. The keys stay in this tab only. */
function PhoneLoginScreen({ onDone, onBack }: { onDone: (s: Session) => void; onBack: () => void }) {
  const [code, setCode] = useState<string>();
  const [error, setError] = useState<string>();
  const [round, setRound] = useState(0);
  useEffect(() => {
    let stopped = false;
    setCode(undefined);
    setError(undefined);
    void (async () => {
      try {
        const l = await (isV3() ? startPhoneLoginV3() : startPhoneLogin());
        if (stopped) return;
        setCode(l.code);
        const s = await l.wait(() => stopped);
        if (stopped) return;
        if (s) onDone(s);
        else setError('That code ran out. Make a new one.');
      } catch (e) {
        if (!stopped) setError(message(e));
      }
    })();
    return () => {
      stopped = true;
    };
  }, [round, onDone]);
  return (
    <Frame title="Sign in with a phone">
      <ol className="small steps">
        <li>On a phone in your household: Restock → Settings → Sync and backups → Restock server.</li>
        <li>
          Tap <b>Scan the web page's code</b> and point it at this code.
        </li>
        <li>Say yes on the phone. This page opens by itself.</li>
      </ol>
      {code && <Qr text={code} label="Sign-in code for a phone to scan" />}
      {error && (
        <p className="banner amber small" role="alert">
          {error}
        </p>
      )}
      <p className="small">
        {isV3()
          ? "Signed in this way, this tab can see the house for 12 hours, or until it's closed. It can't change the passphrase."
          : "Signed in this way, this tab can see the household until it's closed. It can't change the passphrase."}
      </p>
      <div className="two">
        <button className="btn" onClick={onBack}>
          Back
        </button>
        <button className="btn" onClick={() => setRound((r) => r + 1)}>
          New code
        </button>
      </div>
    </Frame>
  );
}

export function PassphraseForm({ user, onDone, submit = 'Set the passphrase' }: { user: string; onDone: (s: Session) => void; submit?: string }) {
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const c = checkPassphrase(a, user);
  const same = a === b;
  const go = async () => {
    setError(undefined);
    setBusy(true);
    try {
      onDone(await setPassphrase(user, a));
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="card gate-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (c.ok && same) void go();
      }}
    >
      <label className="field">
        <span className="small">New passphrase</span>
        <input className="input" type="password" autoComplete="new-password" value={a} onChange={(e) => setA(e.target.value)} autoFocus aria-describedby="pp-meter" />
      </label>
      <div id="pp-meter" className={`meter s${c.score}`} aria-live="polite">
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
      <button className="btn primary block" type="submit" disabled={busy || !c.ok || !same}>
        {busy ? 'Saving…' : submit}
      </button>
      <p className="small" style={{ margin: 0 }}>
        A few words only you would put together work well: <i>kettle under the mango tree</i>. It never leaves this browser: the server keeps
        only a check of it. If it's forgotten, whoever runs the server can reset it (the server's README says how), and you link this
        browser with a phone again.
      </p>
    </form>
  );
}

export function SetPassphraseScreen({ user, onDone }: { user: string; onDone: (s: Session) => void }) {
  return (
    <Frame title="Set a passphrase" foot={<SignOutLink />}>
      <p className="small" style={{ margin: 0 }}>
        The server's first password only works once, to set this. From now on you sign in as <b>{user}</b> with your passphrase.
      </p>
      <PassphraseForm user={user} onDone={onDone} />
    </Frame>
  );
}

function SignOutLink() {
  return (
    <button className="linkish small" style={{ alignSelf: 'center' }} onClick={() => void signOut().then(() => location.reload())}>
      Sign out
    </button>
  );
}

/** Once, after setting the passphrase: a joined phone hands this browser the household's keys. */
export function LinkScreen({ onDone, addPhone }: { onDone: (s: Session) => void; addPhone?: ReactNode }) {
  const [code, setCode] = useState<string>();
  const [error, setError] = useState<string>();
  const [round, setRound] = useState(0);
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    let stopped = false;
    setCode(undefined);
    setError(undefined);
    void (async () => {
      try {
        const l = await startLink();
        if (stopped) return;
        setCode(l.code);
        const s = await l.wait(() => stopped);
        if (stopped) return;
        if (s) done.current(s);
        else setError('That code ran out. Make a new one.');
      } catch (e) {
        if (!stopped) setError(e instanceof ApiError && e.status === 401 ? 'Signed out. Sign in again.' : message(e));
      }
    })();
    return () => {
      stopped = true;
    };
  }, [round]);
  return (
    <Frame title="Link with a phone" foot={<SignOutLink />}>
      <p className="small" style={{ margin: 0 }}>
        Once only: a phone already using this server lets this browser see the household. It needs to be a phone in the household that's been
        added to this server.
      </p>
      <ol className="small steps">
        <li>On that phone: Restock → Settings → Sync and backups → Restock server.</li>
        <li>
          Tap <b>Scan the web page's code</b> and point it at this code.
        </li>
        <li>
          It asks <i>Let this browser see your household?</i> Say yes.
        </li>
      </ol>
      {code && <Qr text={code} label="Link code for a phone to scan" />}
      {code && (
        <details className="small">
          <summary>Can't scan it?</summary>
          <code className="sync-code-text">{code}</code>
        </details>
      )}
      {error && (
        <p className="banner amber small" role="alert">
          {error}
        </p>
      )}
      <button className="btn" onClick={() => setRound((r) => r + 1)}>
        New code
      </button>
      {addPhone && (
        <details className="card">
          <summary className="title">No phone on this server yet? Add one first</summary>
          {addPhone}
        </details>
      )}
    </Frame>
  );
}

/**
 * 0.9.4, a fresh server: step 2 of 2 (the server's setup page did the passphrase). Makes the house:
 * its key, its owner key and its record, all on the server. Then Server and phones, to add a phone.
 */
export function SetUpServerScreen({ session, onDone }: { session: Session; onDone: (s: Session) => void }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const go = async () => {
    setError(undefined);
    setBusy(true);
    try {
      onDone(await setUpHouse(name));
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="setup-house">
      <main className="setup-card" aria-labelledby="setup-title">
        <div className="setup-brand">
          <span className="setup-mark" aria-hidden>
            R
          </span>
          <strong>Restock server</strong>
        </div>
        <div className="setup-steps" role="img" aria-label="Step 2 of 2">
          <span className="done" />
          <span className="done" />
        </div>
        <h1 id="setup-title">Set up this server</h1>
        <p className="setup-lede">This server becomes your house. Phones join it, and what they share stays here, even if a phone is removed.</p>
        <form
          className="setup-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) void go();
          }}
        >
          <div className="field">
            <label htmlFor="setup-name" className="setup-label">
              Name it
            </label>
            <input
              id="setup-name"
              className="input setup-input"
              value={name}
              maxLength={60}
              autoFocus
              autoComplete="off"
              placeholder="Declan and Sarah"
              onChange={(e) => setName(e.target.value)}
              aria-describedby="setup-name-help"
            />
            <span id="setup-name-help" className="setup-help">
              Shown on this page and when a phone joins. Each phone can call it what it likes ("Home").
            </span>
          </div>
          <div className="setup-note">
            <strong>Signed in as {session.user}</strong>
            <span>
              You've already swapped the starting password for your own passphrase. Changes between phones and this server are encrypted on the way, even on
              plain http at home.
            </span>
          </div>
          {error && (
            <p className="banner red small" role="alert">
              {error}
            </p>
          )}
          <button className="btn primary block setup-go" type="submit" disabled={busy || !name.trim()}>
            {busy ? 'Setting up…' : 'Set up server'}
          </button>
          <span className="setup-help center">Next: add your first phone.</span>
        </form>
      </main>
    </div>
  );
}

/** 0.9.4: a phone took the household back with its recovery key; this server no longer owns it. */
export function ReleasedScreen() {
  return (
    <Frame title="Your household was taken back">
      <p className="small" style={{ margin: 0 }}>
        A phone took the household back with its recovery key, so this server isn't its owner any more and phones don't sync here. Whoever runs the
        server can start it afresh (the server's README says how).
      </p>
      <SignOutLink />
    </Frame>
  );
}

export function Checking({ text = 'Opening…', error, onRetry }: { text?: string; error?: string; onRetry?: () => void }) {
  return (
    <Frame title={error ? "Can't reach the server" : text}>
      {error && <p className="banner amber small">{error}</p>}
      {onRetry && (
        <button className="btn primary" onClick={onRetry}>
          Try again
        </button>
      )}
    </Frame>
  );
}
