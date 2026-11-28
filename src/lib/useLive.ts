import { useEffect, useState } from 'react';
import { cachedSettings, getSettings } from './db';
import { onChange } from './live';
import { screenReading } from './screensFirst';
import { noteQuiet } from './quietErrors';
import { noteSpeed } from './speedLog';
import { plainName, waitingFor, words } from './waiting';
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
    let lastError: string | undefined;
    // 0.19.0: a run that hasn't answered in STUCK_MS is given up on (its answer still counts if it
    // ever comes) and another is started: before, one read that never answered kept its screen on
    // "Loading…" for good. What's waited for, and why, is noted (lib/waiting.ts) for the screen to say.
    let runNo = 0;
    /** Between a failed run and the next try: still waiting, as far as the screen is concerned. */
    let resting: { done(): void } | undefined;
    const load = () => {
      if (busy || timer) {
        again = true;
        return;
      }
      busy = true;
      const mine = ++runNo;
      const started = Date.now();
      // Background work waits while a screen reads (lib/screensFirst.ts).
      const read = screenReading();
      resting?.done();
      resting = undefined;
      const wait = waitingFor(plainName(query), 'screen', { failures, error: lastError });
      let over = false;
      /** This run is over (answered, failed or given up on): the next may start. */
      const end = (retry: boolean) => {
        if (over) return;
        over = true;
        clearTimeout(stuck);
        read();
        const took = Date.now() - started;
        if (took >= SLOW_MS) noteSpeed('read', took, plainName(query));
        if (mine !== runNo) return;
        busy = false;
        if (retry) again = true;
        if (alive && again) {
          again = false;
          timer = setTimeout(() => {
            timer = undefined;
            if (alive) load();
          }, failures ? Math.min(30_000, 1000 * 2 ** (failures - 1)) : Math.min(2000, Math.max(200, took)));
        }
      };
      const fail = (e: unknown) => {
        console.error('query failed', e);
        failures++;
        lastError = words(e);
        noteQuiet(`screen: ${plainName(query)}`, e);
        wait.failed(e);
        if (alive) resting = waitingFor(plainName(query), 'screen', { failures, error: lastError });
        end(true);
      };
      const stuck = setTimeout(() => {
        if (over) return;
        fail(new Error(`no answer after ${STUCK_MS / 1000} seconds`));
      }, STUCK_MS);
      let run: Promise<T>;
      try {
        run = query();
      } catch (e) {
        fail(e);
        return;
      }
      run.then(
        (v) => {
          // An answer always counts, even from a run already given up on.
          failures = 0;
          lastError = undefined;
          if (alive) setValue(v);
          wait.done();
          end(false);
        },
        (e) => {
          if (over) return;
          fail(e);
        },
      );
    };
    load();
    const off = onChange(load);
    return () => {
      alive = false;
      resting?.done();
      if (timer) clearTimeout(timer);
      off();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return value;
}

/** 0.18.4: a screen's read that takes this long is noted (Diagnostics → Speed). */
const SLOW_MS = 3000;
/** 0.19.0: a read with no answer after this long is tried again. */
export const STUCK_MS = 20_000;

/** The settings, live: straight away from the last read (db.ts cachedSettings), then kept up to date. */
export const useSettings = (): Settings | undefined => useLive(getSettings, [], cachedSettings);

/** The settings as a settings screen shows them (with its unsaved changes: settingsDraft.ts), live. */
export const useDraftSettings = (): Settings | undefined => useLive(draftSettings, [], cachedDraftSettings);
