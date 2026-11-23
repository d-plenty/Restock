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
    version: '0.13.0',
    about: 'A head start for a new pantry, and tabs that all work the same way.',
    changes: [
      'See what Declan and Sarah use: the pantry of the two people who make Restock. Tick what you’d use and add it to yours. It’s at the bottom of the Pantry, and in Settings.',
      'Anything you already have by the same name is left exactly as it is.',
      'The walkthrough uses twenty real items, ten of them on the shopping list.',
      'Bottle shop and Chemist are tabs you make, name and colour like any other.',
      'Every tab has Edit at the top right, and every tab you made says Beta on More.',
      'Adding from a tab has three buttons: the tab, the tab and the shopping list, or the shopping list just this once (no name needed).',
      'Once an item is on your list, its row shows minus, how many, and plus.',
      'Minus down to 0 takes a line off your list after a moment, with Undo.',
      'Your loyalty cards sit in shopping mode’s top bar, and its titles are bigger.',
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
