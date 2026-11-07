import { useEffect, useState } from 'react';
import { setConfirmListener, type ConfirmRequest } from '../lib/confirm';
import { Sheet } from './components';

/** Mounted once in App; shows the sheet whenever confirmAction() is called. */
export function ConfirmHost() {
  const [req, setReq] = useState<ConfirmRequest>();
  useEffect(() => {
    setConfirmListener(setReq);
    return () => setConfirmListener(undefined);
  }, []);
  if (!req) return null;
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
