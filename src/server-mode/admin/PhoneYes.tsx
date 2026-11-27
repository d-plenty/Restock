// 0.18.3: "Say yes on an admin phone", like two-factor. Signing in (SignIn.tsx) and every risky
// change (api.ts hands those here) show a two-digit number; an admin phone shows the same one with
// "Is this you?". The phone checks when Restock opens and every few seconds while it's open, so
// the words say to open Restock on it. Every admin phone lost: the recovery key instead.
import { useEffect, useId, useState } from 'react';
import { api3, whenYesNeeded, type ApproveView } from '../api';
import { Dialog, errText } from './ui';

/** What each request is for, as the page says it. */
const WHAT: Record<string, string> = {
  'sign-in': 'Signing in',
  'keep-data': 'Changing how long data is kept',
  'delete-data': 'Deleting data',
  'delete-everything': 'Deleting everything',
  'recovery-key': 'Showing the recovery key',
  passphrase: 'Changing the passphrase',
  'user-name': 'Changing the user name',
  move: 'Moving to a new server',
  erase: 'Erasing this server',
};

export const phonesWords = (phones: string[]) => (phones.length === 0 ? 'an admin phone' : phones.length === 1 ? phones[0] : `${phones.slice(0, -1).join(', ')} or ${phones[phones.length - 1]}`);

export function Digits({ number }: { number: string }) {
  return (
    <div className="sv-digits" role="img" aria-label={`The number to match: ${number.split('').join(' ')}`}>
      {number.split('').map((d, i) => (
        <span key={i}>{d}</span>
      ))}
    </div>
  );
}

function useCountdown(seconds: number): string {
  const [left, setLeft] = useState(seconds);
  useEffect(() => {
    const until = Date.now() + seconds * 1000;
    const t = setInterval(() => setLeft(Math.max(0, Math.round((until - Date.now()) / 1000))), 1000);
    return () => clearInterval(t);
  }, [seconds]);
  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
}

/**
 * The waiting box: the number, which phones were asked, the time left, Cancel and the recovery key.
 * `poll` says how it's going ('yes', 'no', 'expired' or 'waiting'); `recovery` uses the key.
 */
export function WaitForPhone({
  a,
  step,
  poll,
  recovery,
  onDone,
  onCancel,
}: {
  a: ApproveView;
  step?: string;
  poll: () => Promise<string>;
  recovery: (key: string) => Promise<void>;
  onDone: () => void;
  onCancel: () => void;
}) {
  const left = useCountdown(a.expiresIn || 300);
  const [problem, setProblem] = useState<string>();
  const [usingKey, setUsingKey] = useState(false);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const keyId = useId();
  useEffect(() => {
    let on = true;
    const tick = async () => {
      while (on) {
        let s: string;
        try {
          s = await poll();
        } catch (e) {
          if (on) setProblem(errText(e));
          return;
        }
        if (!on) return;
        if (s === 'yes') return onDone();
        if (s === 'no') return setProblem('An admin phone said no.');
        if (s === 'expired') return setProblem('No admin phone said yes in time. Try again.');
        await new Promise((r) => setTimeout(r, 2000));
      }
    };
    void tick();
    return () => {
      on = false;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {step && <p className="sv-eyebrow">{step}</p>}
      <h1 id="yes-title" style={{ margin: 0, fontSize: 26 }}>
        Say yes on an admin phone
      </h1>
      <p className="sv-small" style={{ fontSize: 15 }}>
        {WHAT[a.what] ?? 'This'} needs a yes from <b>{phonesWords(a.phones)}</b>. Open Restock on it: it asks <b>Is this you?</b> with this number.
      </p>
      <Digits number={a.number} />
      {problem ? (
        <p className="sv-error" role="alert">
          {problem}
        </p>
      ) : (
        <p className="sv-small" role="status" style={{ textAlign: 'center' }}>
          Waiting for a phone · {left} left
        </p>
      )}
      {usingKey ? (
        <form
          style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
          onSubmit={(e) => {
            e.preventDefault();
            setBusy(true);
            setProblem(undefined);
            recovery(key)
              .then(onDone)
              .catch((err: unknown) => setProblem(errText(err)))
              .finally(() => setBusy(false));
          }}
        >
          <div className="sv-field">
            <label htmlFor={keyId}>Recovery key</label>
            <input id={keyId} className="sv-input" value={key} autoComplete="off" spellCheck={false} onChange={(e) => setKey(e.target.value)} placeholder="XXXX-XXXX-…" />
            <span className="sv-small">The one you saved when the server was set up.</span>
          </div>
          <button className="sv-btn primary" type="submit" disabled={busy || key.replace(/[^A-Za-z0-9]/g, '').length < 16}>
            Use the recovery key
          </button>
        </form>
      ) : null}
      <div className="sv-row wrap" style={{ justifyContent: 'space-between' }}>
        <button className="sv-btn" type="button" onClick={onCancel}>
          Cancel
        </button>
        {!usingKey && (
          <button className="sv-btn wrap-text" type="button" onClick={() => setUsingKey(true)}>
            Every admin phone lost? Use the recovery key
          </button>
        )}
      </div>
    </div>
  );
}

/** The page's handler for risky changes (api.ts whenYesNeeded): a dialog until a phone says yes. */
export function PhoneYesHost() {
  const [asking, setAsking] = useState<{ a: ApproveView; done: (ok: boolean) => void }>();
  useEffect(() => {
    whenYesNeeded((a) => new Promise<boolean>((done) => setAsking({ a, done })));
    return () => {
      whenYesNeeded(undefined);
    };
  }, []);
  if (!asking) return null;
  const finish = (ok: boolean) => {
    asking.done(ok);
    setAsking(undefined);
  };
  return (
    <Dialog labelledBy="yes-title" onClose={() => finish(false)}>
      <WaitForPhone
        a={asking.a}
        poll={async () => (await api3.approveStatus(asking.a.id)).status}
        recovery={async (key) => {
          await api3.approveByRecovery(asking.a.id, key);
        }}
        onDone={() => finish(true)}
        onCancel={() => {
          void api3.approveCancel(asking.a.id).catch(() => undefined);
          finish(false);
        }}
      />
    </Dialog>
  );
}
