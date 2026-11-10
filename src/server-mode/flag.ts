// 0.9.2: the web app a Restock server serves (npm run build:server-web turns VITE_SERVER_MODE on).
// Every phone-only feature is hidden behind this one flag. The server mode's own screens are
// handed to the app at start (src/server-mode/main.tsx), so the phone build never carries them.
import { useSyncExternalStore, type ComponentType, type ReactNode } from 'react';
import type { Screen, Tab } from '../ui/nav';

export const serverMode = import.meta.env.VITE_SERVER_MODE === '1';

/** 0.9.3: what the app hands the desktop layout (src/server-mode/ui/Desktop.tsx). */
export interface DesktopProps {
  /** The tabs this household uses, in order (no Add tab on a server). */
  tabs: Tab[];
  /** The tab showing. */
  tab: Tab;
  /** The screens opened on top of the tab, oldest first. */
  stack: Screen[];
  /** What the phone layout would show for the top screen (the server's own version where it has one). */
  overlay?: ReactNode;
}

export interface ServerUi {
  /** Along the top of the app: the household, how fresh it is, Phones, Activity, Account. */
  Strip: ComponentType;
  /** In place of the Add tab. */
  Tab: ComponentType;
  /** In place of a phone-only screen (undefined: the usual one). */
  screen: (top: Screen) => ReactNode | undefined;
  /** Sync with the server now; what to say afterwards. */
  refresh: () => Promise<string>;
  /** 0.9.3: the whole app at desktop widths (a sidebar and wide pages). */
  Desktop?: ComponentType<DesktopProps>;
}

export const serverUi: { current?: ServerUi } = {};

/** 0.9.3: from this width the web app on a server uses its desktop layout. */
export const DESKTOP_MIN = 1000;

const wideQuery = () =>
  serverMode && typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(`(min-width: ${DESKTOP_MIN}px)`) : undefined;
const onWide = (fn: () => void) => {
  const q = wideQuery();
  q?.addEventListener('change', fn);
  return () => q?.removeEventListener('change', fn);
};
const isWide = () => !!wideQuery()?.matches;

/** Is this the web app on a server, in a window wide enough for the desktop layout? Always false on a phone. */
export function useDesktopWidth(): boolean {
  return useSyncExternalStore(onWide, isWide, () => false);
}
