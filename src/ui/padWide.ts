// 0.13.2: an iPad held sideways. The iPhone app's own screens, with the tabs down the left side and
// More's rows listed under them, so everything is one tap away. Held upright it's the phone layout.
import { useSyncExternalStore } from 'react';
import { isIos } from '../lib/platform';
import { serverMode } from '../server-mode/flag';

/** Wide enough for the side bar (an iPad in landscape, or a large one upright). */
export const PAD_WIDE_MIN = 1000;

const query = () => (!serverMode && isIos() && typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(`(min-width: ${PAD_WIDE_MIN}px)`) : undefined);
const subscribe = (fn: () => void) => {
  const q = query();
  q?.addEventListener('change', fn);
  return () => q?.removeEventListener('change', fn);
};

/** Is this the iPhone and iPad app in a window wide enough for the side bar? Always false elsewhere. */
export function usePadWide(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => !!query()?.matches,
    () => false,
  );
}

/** More's rows (screens/More.tsx), as the side bar lists them. */
export const PAD_SIDE = [
  { screen: 'catalogues', label: 'Your shops', icon: 'shop' },
  { screen: 'receipts', label: 'Receipts', icon: 'receipt' },
  { screen: 'cards', label: 'Cards', icon: 'card' },
  { screen: 'settings', label: 'Settings', icon: 'settings' },
] as const;
export type PadSide = (typeof PAD_SIDE)[number]['screen'];
