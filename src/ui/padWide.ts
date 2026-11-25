// 0.13.2: an iPad held sideways. The iPhone app's own screens, with the tabs down the left side and
// More's rows listed under them, so everything is one tap away. Held upright it's the phone layout.
// 0.15.0: the web page on a Restock server too, in a wide window (in place of its own desktop
// pages), with Your server as one more row.
import { useSyncExternalStore } from 'react';
import { isIos } from '../lib/platform';
import { serverMode } from '../server-mode/flag';

/** Wide enough for the side bar (an iPad in landscape, a large one upright, or a computer). */
const PAD_WIDE_MIN = 1000;

const query = () => ((serverMode || isIos()) && typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(`(min-width: ${PAD_WIDE_MIN}px)`) : undefined);
const subscribe = (fn: () => void) => {
  const q = query();
  q?.addEventListener('change', fn);
  return () => q?.removeEventListener('change', fn);
};

/** Is this the iPhone and iPad app (or the web page) in a window wide enough for the side bar? Always false on Android. */
export function usePadWide(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => !!query()?.matches,
    () => false,
  );
}

/** More's rows (screens/More.tsx), as the side bar lists them. */
const PAD_SIDE = [
  { screen: 'catalogues', label: 'Your shops', icon: 'shop' },
  { screen: 'receipts', label: 'Receipts', icon: 'receipt' },
  { screen: 'cards', label: 'Cards', icon: 'card' },
  { screen: 'settings', label: 'Settings', icon: 'settings' },
] as const;
/** 0.15.0: the web page's side bar: the same rows, and the server's own pages under Your server. */
const PAD_SIDE_WEB = [...PAD_SIDE, { screen: 'server', label: 'Your server', icon: 'server' }] as const;
export type PadSide = (typeof PAD_SIDE_WEB)[number]['screen'];
export const padSide = () => (serverMode ? PAD_SIDE_WEB : PAD_SIDE);
