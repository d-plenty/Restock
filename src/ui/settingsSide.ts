// 0.18.1: an iPad (or Android tablet, or the web page) held sideways shows Settings side by side:
// the list on the left, the page on the right. A Settings page opened from inside that page
// (Look and colours → Animations, say) opens on the right too. Held upright, it's one page at a time.
import { createContext, useContext, useSyncExternalStore } from 'react';
import { useNav } from './nav';
import { usePadWide } from './padWide';

/** Opens a Settings page on the right, while Settings is side by side. */
export const SettingsSideContext = createContext<((page: string) => void) | null>(null);

/** Open a Settings page: on the right while side by side, otherwise as its own screen. */
export function useOpenSettingsPage(): (page: string) => void {
  const nav = useNav();
  const side = useContext(SettingsSideContext);
  return (page) => (side ? side(page) : nav.push({ name: 'settings', page } as never));
}

const landscape = () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(orientation: landscape)') : undefined);
const subscribe = (fn: () => void) => {
  const q = landscape();
  q?.addEventListener('change', fn);
  return () => q?.removeEventListener('change', fn);
};

/** Wide (the side bar's showing) and held sideways. */
export function useSettingsSplit(): boolean {
  const wide = usePadWide();
  const across = useSyncExternalStore(
    subscribe,
    () => !!landscape()?.matches,
    () => false,
  );
  return wide && across;
}
