import { useEffect, useState } from 'react';
import { setConfirmListener, type ConfirmRequest } from '../lib/confirm';
import { Sheet } from './components';

/** Mounted once in App; shows the sheet whenever confirmAction() or askPassword() is called. */
export function ConfirmHost() {
  const [req, setReq] = useState<ConfirmRequest>();
  const [text, setText] = useState('');
  useEffect(() => {
    setConfirmListener((r) => {
      setText('');
      setReq(r);
    });
    return () => setConfirmListener(undefined);
  }, []);
  if (!req) return null;
  if (req.password) {
    return (
      <Sheet title={req.title} onClose={() => req.resolve(false)}>
        {req.detail && <p style={{ color: 'var(--ink-2)' }}>{req.detail}</p>}
        <form
          style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
          onSubmit={(e) => {
            e.preventDefault();
            if (text) req.resolve(true, text);
          }}
        >
          <input className="input" type="password" autoFocus autoComplete="current-password" aria-label="Password" value={text} onChange={(e) => setText(e.target.value)} />
          <button className="btn primary" type="submit" disabled={!text}>
            {req.action}
          </button>
          <button className="btn" type="button" onClick={() => req.resolve(false)}>
            Cancel
          </button>
        </form>
      </Sheet>
    );
  }
  return (
    <Sheet title={req.title} onClose={() => req.resolve(false)}>
      {req.detail && <p style={{ color: 'var(--ink-2)' }}>{req.detail}</p>}
      <button className={`btn ${req.danger ? 'danger' : 'primary'}`} onClick={() => req.resolve(true)}>
        {req.action}
      </button>
      <button className="btn" onClick={() => req.resolve(false)}>
        Cancel
      </button>
    </Sheet>
  );
}
