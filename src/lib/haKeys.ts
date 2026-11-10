// 0.9.3: where Home Assistant's settings are kept in the database's key/value table (homeAssistant.ts).
// On their own here so db.ts and backup.ts can use them without the rest.

/** The address, which list and on/off. Not in Settings: a joining phone takes a copy of those. */
export const HA_CONFIG = 'homeAssistant';
/** Which Restock line is which Home Assistant item, and what both looked like last time. */
export const HA_STATE = 'homeAssistantState';
/** When it last worked, or what went wrong. */
export const HA_STATUS = 'homeAssistantStatus';
/**
 * "Always use this for milk": the words, and the pantry item they mean. 0.9.3: kept in the household's
 * rows now (listPicks.ts); this key is only how backups carry them, and where test builds kept them
 * (moved into the rows at start-up and on a restore's next round).
 */
export const LIST_ALIASES = 'listAliases';

/** 0.9.3: how many products the last price check looked at, and when (PriceChecker.java; the phone's summary for the web). */
export const LAST_CHECK_INFO = 'lastCheckInfo';

/** This phone's own: never in a backup, and a restore keeps this phone's (the token isn't in the database at all). */
export const LOCAL_ONLY_KV: readonly string[] = [HA_CONFIG, HA_STATE, HA_STATUS, LAST_CHECK_INFO];

// A count of the times the pairing (HA_STATE) was started afresh on this phone: a new address or
// list, a restore, Erase everything. A round already under way when that happens doesn't save its
// old pairing over the fresh one (the next round would take what's paired with the old list's items
// off Restock's list).
// 0.9.4: the rounds run in Java (HaSync.java), so it's told too (homeAssistant.ts listens), straight
// away, before the change to the database that follows the reset gets there.
let pairingResets = 0;
const resetListeners = new Set<() => void>();
export const resetHaPairing = (): void => {
  pairingResets++;
  resetListeners.forEach((fn) => fn());
};
export const haPairingResets = (): number => pairingResets;
export function onHaPairingReset(fn: () => void): () => void {
  resetListeners.add(fn);
  return () => void resetListeners.delete(fn);
}
