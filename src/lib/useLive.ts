import { useEffect, useState } from 'react';
import { onChange } from './live';

/** Runs a database query, and runs it again whenever the database changes. */
export function useLive<T>(query: () => Promise<T>, deps: unknown[] = []): T | undefined {
  const [value, setValue] = useState<T | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    let run = 0;
    const load = () => {
      const mine = ++run;
      query()
        .then((v) => {
          if (alive && mine === run) setValue(v);
        })
        .catch((e) => console.error('query failed', e));
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
