// 0.15.0: what the iPhone's two sync screens (IcloudSync.tsx, WifiSync.tsx) had copied between them:
// the status, looked at every 3 seconds and after each sync, and running an action with a busy line
// and its error in words.
import { useLatest } from '../useLatest';
import { useCallback, useEffect, useRef, useState } from 'react';
import { RestockNative } from '../../lib/sql/native';

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function useSyncStatus<T>(status: () => Promise<T>) {
  const [st, setSt] = useState<T>();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const alive = useRef(true);
  const get = useLatest(status);

  // 0.15.1: the status comes from the database, which answers later.
  const load = useCallback(() => {
    void get
      .current()
      .then((s) => {
        if (alive.current) setSt(s);
      })
      .catch(() => undefined); // the data isn't open yet: the next look tries again
  }, [get]);
  useEffect(() => {
    alive.current = true;
    // The first look as the screen opens.
    load();
    const t = setInterval(load, 3000);
    const h = RestockNative.addListener('syncDone', load);
    return () => {
      alive.current = false;
      clearInterval(t);
      void h.then((x) => x.remove()).catch(() => undefined);
    };
  }, [load]);

  /** Runs one action: the busy line while it runs, its error (in words) if it fails, then a fresh look. */
  const run = async (what: string, job: () => Promise<void>) => {
    setError(undefined);
    setBusy(what);
    try {
      await job();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(undefined);
      load();
    }
  };
  return { st, busy, error, setError, load, run };
}
