// 0.12.9: what changed in each version, in plain words, kept in the app itself: nothing is fetched
// to show it. After an update Restock offers it once ("See what's new" / "I'll figure it out"),
// and it stays in Settings → What's new. 0.12.10: only the latest version is kept here (the page
// showed the last four); older ones are on the GitHub page the screen links to.
export interface VersionNotes {
  version: string;
  /** One line that sums the version up. */
  about: string;
  changes: string[];
}

export const WHATS_NEW: VersionNotes[] = [
  {
    version: '0.13.1',
    about: 'Inventory, for those who want it: how much of each thing you have at home.',
    changes: [
      'Every tab has an Inventory button beside Edit. It’s off until you turn it on, tab by tab, and can be turned off again there or in Settings.',
      'With it on, each item shows a small “Have” box. Tap it to change the amount.',
      'Count each item its own way: a number, a weight or volume, or roughly (a quarter, half or three quarters of a pack, plus unopened ones).',
      'The Inventory page lists the whole tab with minus and plus, and filters for Running low and Out.',
      'When something runs out or gets low, Restock asks to put it on your list, or adds it by itself if you choose that in Settings → Inventory.',
      'Ticking something off while shopping adds what you bought to what you have.',
      'It’s shared with your household, kept in backups, and works on the web page and iPhone web app too.',
      'Restore from a backup on the first screen opens the file picker with a plain tap.',
    ],
  },
];

const KEY = 'restock.seenVersion';

/** The version this phone or browser last opened, if it has been noted. */
export function seenVersion(): string | undefined {
  try {
    return window.localStorage.getItem(KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

export function noteSeenVersion(version: string): void {
  try {
    window.localStorage.setItem(KEY, version);
  } catch {
    // Private windows may refuse: the box may show again next time, nothing else.
  }
}

/**
 * Whether to offer "See what's new": this version hasn't been opened here before, by someone
 * already set up. A brand-new install is never asked (everything is new). On a Restock server's
 * web page a browser's first visit can't be told from a new household's, so it isn't asked either
 * (`firstVisitAsks` false): that browser is asked from the next update on.
 */
export function shouldOfferWhatsNew(current: string, seen: string | undefined, onboarded: boolean, firstVisitAsks = true): boolean {
  if (!onboarded || seen === current) return false;
  if (seen === undefined && !firstVisitAsks) return false;
  return WHATS_NEW.some((v) => v.version === current);
}
