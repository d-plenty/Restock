// Server mode: before the app opens. Sign in (passphrase, or with a phone).
// 0.9.4, a house (v3): sign in with a challenge (no vault, no link), and on a fresh server the
// second setup step, Set up this server (the server's own setup page does the first, the passphrase).
// 0.15.0: only a house: the 0.9.3 household's sign-in, passphrase and link screens are gone.
import { useResetOn } from '../../ui/useResetOn';
import { useEffect, useState, type ReactNode } from 'react';
import { Icon, Logo } from '../../ui/components';
import { serverInfo } from '../api';
import { loginV3, setUpHouse, startPhoneLoginV3, signOut, type Session } from '../session';
import { Qr } from './Qr';
import { InstallHelpLink, isInstalled } from '../pwa/InstallHelp';

/** 0.9.6: a phone-sized window (under 600 px) (the words say "phone", not "computer"). */
const phoneSized = () => typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia('(max-width: 599px)').matches;

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

export function LoginScreen({ onDone }: { onDone: (s: Session) => void }) {
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
  // 0.9.6 (iPhone): from the home screen, Keep me signed in starts ticked: it's what lets the app
  // open with no signal (a session kept for the tab only is gone when iOS closes the app).
  const [keep, setKeep] = useState(() => isInstalled());
  const onPhone = phoneSized();
  if (phone) return <PhoneLoginScreen onDone={onDone} onBack={() => setPhone(false)} />;
  const go = async () => {
    setError(undefined);
    setBusy('Signing in…');
    try {
      const s = await loginV3(user, pass, keep, setBusy);
      try {
        localStorage.setItem('restock-server-user', user.trim());
      } catch {
        // fine
      }
      setPass('');
      onDone(s);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(undefined);
    }
  };
  return (
    <Frame title="Sign in">
      <p className="small" style={{ margin: 0 }}>
        {`${serverInfo()?.house ? `${serverInfo()!.house}: your` : 'Your'} house's lists, prices and receipts. Your passphrase never leaves this browser, and what the server sends is sealed for this sign-in only.`}
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
        <label className="check gate-keep">
            <input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} aria-describedby="gate-keep-help" />
            <span className="grow">
              {onPhone ? 'Keep me signed in on this phone' : 'Keep me signed in on this computer'}
              <span id="gate-keep-help" className="small">
                {onPhone
                  ? 'For 30 days of not using it. Needed to open Restock with no signal. Leave it off on a shared phone.'
                  : 'For 30 days of not using it. Leave it off on a shared computer: then closing the tab signs you out.'}
              </span>
            </span>
          </label>
        {error && (
          <p className="banner red small" role="alert">
            {error}
          </p>
        )}
        <button className="btn primary block" type="submit" disabled={!!busy || !user.trim() || !pass}>
          {busy ?? 'Sign in'}
        </button>
        <p className="small" style={{ margin: 0 }}>
          First time? Set the passphrase on the server's <a href="/setup/">setup page</a>, then sign in here with it.
        </p>
      </form>
      <button className="btn block" onClick={() => setPhone(true)}>
        <Icon name="phone" size={18} /> Sign in with a phone
      </button>
      {/* 0.9.5 (PWA): "On iPhone?" steps. */}
      <InstallHelpLink className="linkish small gate-install" />
    </Frame>
  );
}

/** QR sign-in: a joined phone scans it and says yes. The keys stay in this tab only. */
function PhoneLoginScreen({ onDone, onBack }: { onDone: (s: Session) => void; onBack: () => void }) {
  const [code, setCode] = useState<string>();
  const [error, setError] = useState<string>();
  const [round, setRound] = useState(0);
  useResetOn([round], () => {
    setCode(undefined);
    setError(undefined);
  });
  useEffect(() => {
    let stopped = false;
    void (async () => {
      try {
        const l = await startPhoneLoginV3();
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
        <li>On a phone in your household: Restock → Settings → Sync → Restock server.</li>
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
        Signed in this way, this tab can see the house for 12 hours, or until it's closed. It can't change the passphrase.
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

function SignOutLink() {
  return (
    <button className="linkish small" style={{ alignSelf: 'center' }} onClick={() => void signOut().then(() => location.reload())}>
      Sign out
    </button>
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
/** 0.15.0: a server still keeping a 0.9.3 household: what to do first (the server says it in words). */
export function OldHouseholdScreen({ why }: { why?: string }) {
  return (
    <Frame title="One step first">
      <p className="banner amber small" role="alert" style={{ margin: 0 }}>
        {why ||
          'This server still keeps a household from Restock 0.9.3, which this version no longer does. Run restock-server 0.14.1 once, hand the household to it from the owner phone, then update to this version.'}
      </p>
    </Frame>
  );
}

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
