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
    version: '0.15.0',
    about: 'iPhone and iPad catch up on sync, and the server’s web page looks like the iPad.',
    changes: [
      'Update every phone in your household to 0.14.0 or newer: from this version, older ones can’t sync with this one or with a Restock server.',
      'iPhone and iPad: hand the household’s owner job to another phone, bring a household onto a new Restock server, and keep the household’s folder on Nextcloud or another WebDAV server.',
      'iPhone and iPad: Join your household on the first screen joins a server straight away, and Home’s shop buttons fit on a narrow screen.',
      'On a Restock server’s web page, a computer gets the same screens as the phone with a side bar, and Your server holds the server’s own pages in one place.',
      'The app opens faster, and Diagnostics lists problems from background work that used to go unseen.',
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
