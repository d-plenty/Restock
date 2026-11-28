// How saving the database to the device is going, where the app has to do the saving itself (the
// iPhone and iPad app: its database runs in memory and is written out as a file after each change).
// A failed save used to be swallowed; now it's counted, shown in Diagnostics, and Home says so when
// it keeps failing.

interface SaveState {
  /** Where the database is kept: a file in the app's own storage, or the web view's storage. */
  where?: 'file' | 'web';
  /** When it was last written, ms. */
  lastOk?: number;
  /** Failed saves in a row (0 when the last one worked). */
  failed: number;
  error?: string;
  /** The size of the last file written, bytes. */
  bytes?: number;
}

let state: SaveState = { failed: 0 };
const heard = new Set<() => void>();

export const saveState = (): SaveState => state;
export function subscribeSaveState(fn: () => void): () => void {
  heard.add(fn);
  return () => void heard.delete(fn);
}
const set = (next: SaveState) => {
  state = next;
  heard.forEach((fn) => fn());
};

export function noteSaved(where: 'file' | 'web', bytes: number, at = Date.now()): void {
  set({ where, lastOk: at, failed: 0, bytes });
}
export function noteSaveFailed(error: unknown): void {
  set({ ...state, failed: state.failed + 1, error: error instanceof Error ? error.message : String(error) });
}
/** Home says so once this many saves in a row have failed (one failure can be a blip). */
const SAVE_WARN_AFTER = 2;
export const saveNeedsWarning = (s: SaveState = state): boolean => s.failed >= SAVE_WARN_AFTER;

/** Set by the app's start-up where there is something to flush: saves now, and says how it went. */
let flusher: (() => Promise<void>) | undefined;
export const setSaveFlusher = (fn: (() => Promise<void>) | undefined) => (flusher = fn);
export const saveNow = async (): Promise<void> => flusher?.();
