import { createContext, useContext } from 'react';

import type { Section, StoreChain } from '../shops';

export type Tab = 'home' | Section | 'add' | 'list';
export const isSectionTab = (t: Tab): t is Section => t === 'pantry' || t === 'keg' || t === 'pharmacy';

export type Screen =
  | { name: 'item'; groupId: string }
  | {
      name: 'add';
      barcode?: string;
      /** Add products to this pantry item instead of making a new one. */
      attachTo?: string;
      /** When attaching: your product at another store, or an alternative. */
      as?: 'main' | 'alt';
      /** Attaching your product: search every shop, not just the ones it isn't at yet (another scent, say). */
      another?: boolean;
      query?: string;
      /** Only search this store (e.g. "find one at Aldi"). */
      chain?: StoreChain;
      /** Which tab's shops to search (when not adding to an item that already has one). */
      section?: Section;
      /** From the shopping list (0.7.3): find the cheapest and add it to the list for this trip only. */
      forList?: boolean;
      /** With forList: the plain list line this replaces ("Nescafe" becomes the product found). */
      replaceEntry?: string;
    }
  | { name: 'settings' }
  | { name: 'catalogues' }
  | { name: 'mycatalogue' }
  | { name: 'permissions' }
  | { name: 'stores'; section?: Section }
  | { name: 'cards' }
  | { name: 'sync'; invite?: boolean }
  | { name: 'restockServer' }
  /** 0.9.3: Settings → Home Assistant (the shopping list both ways). */
  | { name: 'homeAssistant' }
  | { name: 'household' }
  | { name: 'setup' }
  | { name: 'receipts' }
  | { name: 'receipt'; id?: string }
  | { name: 'specials' }
  | { name: 'recalls' }
  | { name: 'diagnostics' }
  | { name: 'soon'; id: string }
  /** 0.9.2: the web app on a Restock server: its Phones, Activity and Account pages (0.9.5: and Data; 0.9.6: More, on a phone). */
  | { name: 'server'; page: 'phones' | 'activity' | 'account' | 'data' | 'data-manage' | 'more' };

export interface Nav {
  tab: Tab;
  /** Switch tab. For the List tab, `section` picks which list opens (else the one looked at last). */
  setTab: (t: Tab, section?: Section) => void;
  /** The Pantry, Keg or Pharmacy tab looked at last, so Add and the list know which shops to use. */
  section: Section;
  push: (s: Screen) => void;
  pop: () => void;
  /** A short message at the bottom. Pass `undo` to offer an Undo button for a few seconds. */
  toast: (msg: string, undo?: () => void | Promise<void>) => void;
}

export const NavContext = createContext<Nav | null>(null);

export function useNav(): Nav {
  const nav = useContext(NavContext);
  if (!nav) throw new Error('NavContext missing');
  return nav;
}
