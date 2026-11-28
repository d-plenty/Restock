// 0.17.0: inventory isn't pushed on anyone. The Pantry's Inventory button only shows once it's on,
// and after Restock has been used for a while (a full pantry, a few shopping trips finished) it
// asks once whether to turn it on. Either answer is final; Settings → Inventory turns it on or off
// any time. This phone's own (settings.tripsDone, settings.inventoryAsked).
import { cachedSettings, updateSettings } from './db';

/** Asked when the pantry has at least this many items… */
const ASK_ITEMS = 20;
/** …and this many shopping trips have been finished on this phone. */
const ASK_TRIPS = 3;

/** A shopping trip finished (everything got, or Done). */
export async function noteTripDone(): Promise<void> {
  const s = cachedSettings();
  await updateSettings({ tripsDone: Math.min(1000, (s?.tripsDone ?? 0) + 1) }).catch(() => undefined);
}

/** Time to ask? Not if it's been asked, or inventory is already on somewhere. */
export function shouldAskInventory(s: { tripsDone?: number; inventoryAsked?: boolean } | undefined, items: number, anyOn: boolean): boolean {
  return !!s && !s.inventoryAsked && !anyOn && items >= ASK_ITEMS && (s.tripsDone ?? 0) >= ASK_TRIPS;
}

export const inventoryAsked = () => updateSettings({ inventoryAsked: true });
