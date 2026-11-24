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
    version: '0.14.0',
    about: 'Restock on iPhone and iPad, sending your data straight to another phone, and expiry dates on loyalty cards.',
    changes: [
      'Restock now runs on iPhone and iPad as well as Android, with the same screens.',
      'An Android phone and an iPhone can sync with each other over your Wi-Fi: add the iPhone from Phone sharing. The iPhone does its part while Restock is open on it.',
      'Export data: pick what goes in, then save it as a file or send it straight to another phone with a QR code. It works between any two phones on the same Wi-Fi, once.',
      'Import data: from a file, by scanning the other phone’s code, or from a photo of the code. Then add it alongside what’s here (same names are skipped) or replace what’s here.',
      'Loyalty cards can have an expiry date. Restock reminds you a month before, and Home shows it with Update and Remind me later.',
      'Phone sharing is the recommended way to sync now. A Restock server is for people who run one.',
      'With a Restock server, your data stays on your phone too. Leaving the server, or being taken off it, deletes nothing on the phone.',
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
