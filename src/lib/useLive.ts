import { useEffect, useState } from 'react';
import { onChange } from './live';

/** Runs a database query, and runs it again whenever the database changes. */
export function useLive<T>(query: () => Promise<T>, deps: unknown[] = []): T | undefined {
  const [value, setValue] = useState<T | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    // 0.9.0: one run at a time. Changes while a run is going ask for one more run after it, not one
    // each, so a burst of writes (ticking off a few items) reloads once or twice, not once per write.
    let busy = false;
    let again = false;
    const load = () => {
      if (busy) {
        again = true;
        return;
      }
      busy = true;
      let run: Promise<T>;
      try {
        run = query();
      } catch (e) {
        busy = false;
        console.error('query failed', e);
        return;
      }
      run
        .then((v) => {
          // Something changed while it ran: this answer is already out of date, the next run replaces it.
          if (alive && !again) setValue(v);
        })
        .catch((e) => console.error('query failed', e))
        .finally(() => {
          busy = false;
          if (alive && again) {
            again = false;
            load();
          }
        });
    };
    load();
    const off = onChange(load);
    return () => {
      alive = false;
      off();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return value;
}
