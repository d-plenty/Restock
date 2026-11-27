// 0.18.3: "Is this you?" on an admin phone: a browser wants to sign in to the server's page with
// the passphrase, or make a risky change there, and waits for a yes (lib/approvalsWatch.ts). It
// shows the number the browser shows, which browser and from where. Yes lets it; No blocks it (a
// sign-in that's said no to is signed out). Shows over whatever screen is open.
import { useState } from 'react';
import { answer } from '../lib/serverAdmin';
import { doneWith, useApprovals } from '../lib/approvalsWatch';
import { Sheet } from './components';

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function ApprovalSheet() {
  const list = useApprovals();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const a = list[0];
  if (!a) return null;
  const go = async (yes: boolean) => {
    setBusy(true);
    setError(undefined);
    try {
      await answer(a.id, yes);
      doneWith(a.id);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const when = new Date(a.asked).toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' });
  return (
    <Sheet title="Is this you?" onClose={() => doneWith(a.id)}>
      <div className="card" style={{ gap: 12 }}>
        <span style={{ fontSize: 16 }}>
          A browser wants to <strong>{a.words}</strong> on your Restock server{a.what === 'sign-in' ? ' with the passphrase' : ''}.
        </span>
        <span className="small">
          {a.browser}
          {a.ip ? ` · ${a.ip}` : ''} · {when}
        </span>
        <span>Does it show this number?</span>
        <div className="approve-digits" role="img" aria-label={`The number: ${a.number.split('').join(' ')}`}>
          {a.number.split('').map((d, i) => (
            <span key={i}>{d}</span>
          ))}
        </div>
        {error && (
          <div className="banner amber" role="alert">
            {error}
          </div>
        )}
        <button className="btn primary block" disabled={busy} onClick={() => void go(true)}>
          Yes, it's me
        </button>
        <button className="btn block" disabled={busy} onClick={() => void go(false)}>
          No, block it
        </button>
        <span className="small">If you didn't just do this on a computer, say no and change the passphrase on the server's page.</span>
      </div>
    </Sheet>
  );
}
