// 0.9.2: the web app a Restock server serves (npm run build:server-web turns VITE_SERVER_MODE on).
// Every phone-only feature is hidden behind this one flag. The server mode's own screens are
// handed to the app at start (src/server-mode/main.tsx), so the phone build never carries them.
import type { ComponentType, ReactNode } from 'react';
import type { Screen } from '../ui/nav';
import type { ListEntry, PriceReading } from '../types';
import type { ListSection, Section } from '../shops';

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
  /**
   * 0.9.4: one product's older prices from the server (a house keeps years; this browser only weeks),
   * from `from` (ISO) on. Empty when the server has none to give (a 0.9.3-style server).
   */
  olderPrices?: (productId: string, from: string) => Promise<PriceReading[]>;
  /**
   * 0.9.5 (web search): "Let the web page search the shops". The Pick sheet's Search the shops (its
   * button, or why not, and the results in place of the phone's Add), and on the phone layout's
   * Shopping list the same as the desktop list's add box (a Scan button, Search the shops, results).
   */
  webSearch?: {
    PickButton: ComponentType<{ typed: string; pantryShown: boolean; busy: boolean; onSearch: (q: string) => void; auto?: boolean }>;
    PickResults: ComponentType<{ query: string; section?: Section; entry: ListEntry; word: string; always: boolean; onAlways: (on: boolean) => void; onDone: (said: string | undefined) => void; toPantry?: boolean; wantId?: string }>;
    ListButton: ComponentType<{ text: string; list: ListSection }>;
    ListPanel: ComponentType<{ list: ListSection; onAdded?: () => void }>;
    Scan: ComponentType<{ section: Section }>;
  };
}

export const serverUi: { current?: ServerUi } = {};

