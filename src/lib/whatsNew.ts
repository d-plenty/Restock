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
    version: '0.14.1',
    about: 'More on iPhone and iPad, a smaller app, and less writing in Settings.',
    changes: [
      'iPhone and iPad: shared prices both ways, recall alerts, app icon colours, and your data saved as a real file with a warning if a save ever fails.',
      'The photo reader (receipts, and reading a product’s name from a photo) is downloaded the first time you use it, about 21 MB, after asking. Settings can remove it or get it again. The app is about 20 MB smaller.',
      'Less writing: Settings and its screens say one short line, with the full explanation behind a small ⓘ.',
      '“Pick my …” on a General list line searches your shops straight away, and an item you add takes over its General line.',
      'Pharmacy 4 Less is no longer a shop to pick: its website stopped listing products. What you saved from it stays.',
      'A shop that Unblock can’t fix now offers Turn off, and adding your own shop says up front that not every shop works.',
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
