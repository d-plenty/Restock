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
    version: '0.12.10',
    about: 'Shopping that survives leaving the app, and fewer doubles.',
    changes: [
      'Leave the app mid-shop and your shop is kept. Home and the list offer Resume shopping or Start fresh.',
      'The top button in shopping mode says Pause while there are things left to get.',
      'Add to list is in shopping mode, so the trolley total keeps up with what you pick up.',
      'Two items can’t have the same name. Capitals don’t count: Rinse aid and Rinse Aid are the same.',
      'Adding a product you already have says which item it is in.',
      'When Try again on a shop still fails, it goes on to opening the shop’s page, which usually fixes it.',
      'A tab you made always has Edit at the top right, to rename it or change its icon and shops.',
      'Photos are read from more shops, and a shop no longer shows 0 as a size.',
      'This page shows the latest version only.',
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
