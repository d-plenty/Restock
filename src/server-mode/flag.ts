// 0.9.2: the web app a Restock server serves (npm run build:server-web turns VITE_SERVER_MODE on).
// Every phone-only feature is hidden behind this one flag. The server mode's own screens are
// handed to the app at start (src/server-mode/main.tsx), so the phone build never carries them.
import type { ComponentType, ReactNode } from 'react';
import type { Screen } from '../ui/nav';

export const serverMode = import.meta.env.VITE_SERVER_MODE === '1';

export interface ServerUi {
  /** Along the top of the app: the household, how fresh it is, Phones, Activity, Account. */
  Strip: ComponentType;
  /** In place of the Add tab. */
  Tab: ComponentType;
  /** In place of a phone-only screen (undefined: the usual one). */
  screen: (top: Screen) => ReactNode | undefined;
  /** Sync with the server now; what to say afterwards. */
  refresh: () => Promise<string>;
}

export const serverUi: { current?: ServerUi } = {};
