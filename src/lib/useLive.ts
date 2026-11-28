import { useEffect, useState } from 'react';
import { cachedSettings, getSettings } from './db';
import { onChange } from './live';
import { screenReading } from './screensFirst';
import { noteSpeed } from './speedLog';
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
    // 0.18.1: every answer is shown, even one a change has already overtaken (the next run replaces
    // it). Before, an answer was dropped whenever something changed while it ran, so during a price
    // check on an older iPad (a saved price every moment, each run slower than the gap between them)
    // a screen never got one, and stayed black until the check was done. And the next run waits as
    // long as the last one took (at least a fifth of a second): a busy database leaves the phone time
    // to draw the screen and answer taps, instead of rerunning the same query back to back.
    let busy = false;
    let again = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // 0.18.4: a run that fails is tried again (after 1, 2, 4 … 30 seconds), so a screen never stays
    // on "Loading…" because one answer went wrong; and a slow one is noted for Diagnostics → Speed.
    let failures = 0;
    const name = query.name || 'a screen';
    const load = () => {
      if (busy || timer) {
        again = true;
        return;
      }
      busy = true;
      const started = Date.now();
      // Background work waits while a screen reads (lib/screensFirst.ts).
      const read = screenReading();
      let run: Promise<T>;
      try {
        run = query();
      } catch (e) {
        busy = false;
        read();
        console.error('query failed', e);
        return;
      }
      run
        .then((v) => {
          failures = 0;
          if (alive) setValue(v);
        })
        .catch((e) => {
          console.error('query failed', e);
          failures++;
          again = true;
        })
        .finally(() => {
          busy = false;
          read();
          const took = Date.now() - started;
          if (took >= SLOW_MS) noteSpeed('read', took, name);
          if (alive && again) {
            again = false;
            timer = setTimeout(() => {
              timer = undefined;
              if (alive) load();
            }, failures ? Math.min(30_000, 1000 * 2 ** (failures - 1)) : Math.min(2000, Math.max(200, Date.now() - started)));
          }
        });
    };
    load();
    const off = onChange(load);
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      off();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return value;
}

/** 0.18.4: a screen's read that takes this long is noted (Diagnostics → Speed). */
const SLOW_MS = 3000;

/** The settings, live: straight away from the last read (db.ts cachedSettings), then kept up to date. */
export const useSettings = (): Settings | undefined => useLive(getSettings, [], cachedSettings);

/** The settings as a settings screen shows them (with its unsaved changes: settingsDraft.ts), live. */
export const useDraftSettings = (): Settings | undefined => useLive(draftSettings, [], cachedDraftSettings);
