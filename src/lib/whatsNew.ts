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
    version: '0.15.2',
    about: 'Faster, even while prices are being checked, and iPhone checks in the background.',
    changes: [
      'Screens stay quick during a price check: prices are saved in lots, not one at a time.',
      'No more blank page when you open Settings, Receipts and other screens.',
      'A price check that stops part way carries on where it got to next time (unless that was over a day ago).',
      'iPhone and iPad: prices are checked in the background too. A little at a time, and a longer check from your set time while it’s charging and on Wi-Fi. Pick the days and time in Settings, as on Android.',
      'iPhone and iPad: Check now keeps going when you leave Restock (iOS 26 and later), with its progress on the Lock Screen.',
      'iPhone and iPad: deal alerts after a check in the background, as on Android.',
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
