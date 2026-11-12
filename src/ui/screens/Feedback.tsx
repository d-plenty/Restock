import { useEffect, useRef, useState } from 'react';
import { diagnostics, FEEDBACK_KINDS, makeMessage, sendFeedback, sendWaiting, shrinkPicture, waitingCount, type FeedbackKind, type Screenshot } from '../../lib/feedback';
import { Icon, Sheet, TopBar } from '../components';
import { useNav } from '../nav';

// 0.9.13: Settings → Feedback, on the phone, the web page and the iPhone web app. It goes to
// Restock's own server (lib/feedback.ts); nothing is sent until Send is pressed.

/** What's typed is kept while Restock is open, so going back to look at something doesn't lose it. */
const draft: { kind: FeedbackKind; message: string; email: string; withDiagnostics: boolean; shots: Screenshot[] } = {
  kind: 'wrong',
  message: '',
  email: '',
  withDiagnostics: true,
  shots: [],
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function FeedbackScreen() {
  const nav = useNav();
  const [kind, setKind] = useState(draft.kind);
  const [message, setMessage] = useState(draft.message);
  const [email, setEmail] = useState(draft.email);
  const [withDiagnostics, setWithDiagnostics] = useState(draft.withDiagnostics);
  const [shots, setShots] = useState<Screenshot[]>(draft.shots);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const [showing, setShowing] = useState<string>();
  const [waiting, setWaiting] = useState(0);
  const file = useRef<HTMLInputElement>(null);

  useEffect(() => {
    Object.assign(draft, { kind, message, email, withDiagnostics, shots });
  }, [kind, message, email, withDiagnostics, shots]);

  // Anything that couldn't go last time goes now.
  useEffect(() => {
    void sendWaiting()
      .then((n) => {
        if (n) nav.toast(n === 1 ? 'Your earlier feedback has been sent' : `Your ${n} earlier messages have been sent`);
      })
      .catch(() => undefined)
      .finally(() => void waitingCount().then(setWaiting));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const emailBad = !!email.trim() && !EMAIL.test(email.trim());
  const canSend = message.trim().length > 0 && !emailBad && !busy;

  const addPictures = async (files: FileList | null) => {
    if (!files?.length) return;
    setErr(undefined);
    const room = 3 - shots.length;
    const picked = Array.from(files).slice(0, room);
    try {
      const made = await Promise.all(picked.map((f) => shrinkPicture(f)));
      setShots((s) => [...s, ...made].slice(0, 3));
      if (files.length > room) setErr('Up to 3 screenshots: the first ones were added.');
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const send = async () => {
    if (!canSend) return;
    setBusy(true);
    setErr(undefined);
    try {
      const m = await makeMessage({ kind, message, email, withDiagnostics, screenshots: shots });
      const how = await sendFeedback(m);
      Object.assign(draft, { kind: 'wrong', message: '', email: '', withDiagnostics: true, shots: [] });
      nav.toast(how === 'sent' ? 'Thank you! Your feedback has been sent' : "Thank you! No connection right now, so it'll send next time");
      nav.pop();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="screen">
      <TopBar title="Feedback" />
      <div className="card">
        <p style={{ marginTop: 0 }}>
          <strong>Thank you so much for taking the time.</strong> We really appreciate your feedback. Good or bad, it always helps us make Restock a better app for
          you.
        </p>
        <p className="small" style={{ marginBottom: 0 }}>
          It goes to the people who make Restock, and only when you press Send. We only write back if you leave an email.
        </p>
      </div>

      {waiting > 0 && (
        <p className="small" role="status">
          {waiting === 1 ? '1 message is' : `${waiting} messages are`} waiting to send. It goes when you're back online.
        </p>
      )}

      <div className="card">
        <span className="title" id="fb-kind">
          What's it about?
        </span>
        <div className="seg" role="group" aria-labelledby="fb-kind" style={{ marginTop: 8, display: 'grid', gridAutoFlow: 'row', gridTemplateColumns: '1fr 1fr' }}>
          {FEEDBACK_KINDS.map((k) => (
            <button key={k.id} type="button" aria-pressed={kind === k.id} onClick={() => setKind(k.id)}>
              {k.label}
            </button>
          ))}
        </div>

        <label className="field" style={{ marginTop: 14, display: 'block' }}>
          <span className="title">Your message</span>
          <textarea
            className="input"
            rows={6}
            maxLength={5000}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder={
              kind === 'wrong'
                ? 'What happened, and what did you expect? Which screen were you on?'
                : kind === 'idea'
                  ? "What would you like Restock to do?"
                  : kind === 'like'
                    ? 'What do you like about it?'
                    : 'Tell us anything'
            }
            style={{ width: '100%', marginTop: 6, height: 'auto', fontSize: 16 }}
          />
        </label>
        {message.length > 4500 && <span className="small">{5000 - message.length} characters left</span>}
      </div>

      <div className="card">
        <span className="title">Screenshots</span>
        <p className="small" style={{ margin: '4px 0 8px' }}>
          Up to 3, from your gallery. A picture often says it best.
        </p>
        {shots.length > 0 && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
            {shots.map((s, i) => (
              <div key={i} style={{ position: 'relative' }}>
                <img src={`data:${s.type};base64,${s.data}`} alt={`Screenshot ${i + 1}`} style={{ width: 96, height: 144, objectFit: 'cover', borderRadius: 8, display: 'block' }} />
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={`Take off screenshot ${i + 1}`}
                  onClick={() => setShots((all) => all.filter((_, j) => j !== i))}
                  style={{ position: 'absolute', top: 4, right: 4, background: 'var(--card)', borderRadius: 999 }}
                >
                  <Icon name="close" size={16} />
                </button>
              </div>
            ))}
          </div>
        )}
        <input
          ref={file}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => {
            void addPictures(e.target.files);
            e.target.value = '';
          }}
        />
        <button type="button" className="btn" disabled={shots.length >= 3} onClick={() => file.current?.click()}>
          <Icon name="image" size={18} /> {shots.length >= 3 ? '3 screenshots added' : shots.length ? 'Add another screenshot' : 'Attach screenshots'}
        </button>
      </div>

      <div className="card">
        <label className="check">
          <input type="checkbox" checked={withDiagnostics} onChange={(e) => setWithDiagnostics(e.target.checked)} />
          <span style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
            <span className="title">Attach diagnostics</span>
            <span className="small">Restock's version, your phone, your settings and recent problems with shops. Helps us find what went wrong.</span>
          </span>
        </label>
        <button
          type="button"
          className="linkish"
          onClick={async () => {
            const d = await diagnostics().catch((e) => ({ error: String(e) }));
            setShowing(JSON.stringify(d, null, 2));
          }}
        >
          See what's included
        </button>
      </div>

      <div className="card">
        <label className="field" style={{ display: 'block' }}>
          <span className="title">Your email (optional)</span>
          <span className="small" style={{ display: 'block' }}>
            Only if you'd like a reply. It's used for nothing else.
          </span>
          <input className="input" type="email" inputMode="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} style={{ width: '100%', marginTop: 6 }} />
        </label>
        {emailBad && (
          <span className="small warn" role="alert">
            That doesn't look like an email address.
          </span>
        )}
      </div>

      {err && (
        <p className="small warn" role="alert">
          {err}
        </p>
      )}
      <button type="button" className="btn primary block" disabled={!canSend} onClick={() => void send()}>
        <Icon name="share" size={18} /> {busy ? 'Sending…' : 'Send feedback'}
      </button>
      {!message.trim() && <p className="small">Write a message to send it.</p>}
      <p className="small">
        Prefer GitHub? You can also{' '}
        <a href="https://github.com/d-plenty/Restock/issues" target="_blank" rel="noreferrer">
          open an issue on Restock's GitHub page
        </a>
        . The privacy policy (Settings → About) says how feedback is kept.
      </p>

      {showing && (
        <Sheet title="What's included" onClose={() => setShowing(undefined)}>
          <p className="small">
            This is sent with your message when Attach diagnostics is on. Passwords, keys and tokens are taken out. Your pantry, lists, cards, receipts and prices
            are never included.
          </p>
          <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12, maxHeight: '55vh', overflow: 'auto' }}>{showing}</pre>
        </Sheet>
      )}
    </div>
  );
}
