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
    version: '0.16.0',
    about: 'A fresh look, your name on Home, a new logo, and holiday themes.',
    changes: [
      'A fresh look on every screen: rounder cards, pill-shaped buttons and fields, and a floating tab bar.',
      'Restock asks what to call you, and says hello on Home ("Good morning, Sam"). Change it at the top of Settings.',
      'Your name also labels this phone in your household, and is in your backup’s file name.',
      'A new logo, and a short opening animation when Restock starts (a still picture with Less motion on).',
      'Holiday themes: Christmas, New Year, Australia Day, Easter and Halloween, each with its own opening (a day and a night look) and colours.',
      'Settings → Look and colours: turn the opening animation or the holiday themes off, and see every holiday’s opening any time.',
      '“Australian theme” is now called the default theme.',
      'Tablets, iPads and computers use the whole screen.',
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
