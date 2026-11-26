import { useEffect, useState } from 'react';
import { cachedSettings, getSettings } from './db';
import { onChange } from './live';
import { cachedDraftSettings, getSettings as draftSettings } from './settingsDraft';
import type { Settings } from '../types';

/**
 * Runs a database query, and runs it again whenever the database changes. 0.15.2: `initial` is what
 * to show until the first answer (the last one already known), so a screen needn't open blank.
 */
export function useLive<T>(query: () => Promise<T>, deps: unknown[] = [], initial?: () => T | undefined): T | undefined {
  const [value, setValue] = useState<T | undefined>(initial);
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

/** The settings, live: straight away from the last read (db.ts cachedSettings), then kept up to date. */
export const useSettings = (): Settings | undefined => useLive(getSettings, [], cachedSettings);

/** The settings as a settings screen shows them (with its unsaved changes: settingsDraft.ts), live. */
export const useDraftSettings = (): Settings | undefined => useLive(draftSettings, [], cachedDraftSettings);
