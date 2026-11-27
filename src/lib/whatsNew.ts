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
    version: '0.18.0',
    about: 'Add phones and tablets from an admin phone, each holiday on or off, plain colours, and lots of fixes.',
    changes: [
      'Admin phones: an admin adds phones and tablets, removes them, and makes others admins, from Settings → Sync → Your Restock server. Your server says who’s an admin.',
      'Look and colours: 14 plain colours for the accent and the app icon (the same ones, so Match my accent colour matches exactly), and each holiday has its own switch.',
      'Australia Day shows for the week leading up to it (19–27 January).',
      'The opening is smoother: 2.5 seconds, or 3.5 on a holiday.',
      'True black and the app icon colours say it in a line, with the rest behind ⓘ.',
      'Fixes: the tab bar on Android sat on the gesture line, and a few things on iPad.',
    ],
  },
];

const KEY = 'restock.seenVersion';
// 0.17.0: the version before this update, kept so What's new can offer every version skipped since.
const FROM_KEY = 'restock.updatedFrom';

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
    const before = window.localStorage.getItem(KEY);
    if (before && before !== version) window.localStorage.setItem(FROM_KEY, before);
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

/** The version this phone had before its last update, if known. */
export function updatedFrom(): string | undefined {
  try {
    return window.localStorage.getItem(FROM_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

/** "0.14.6" < "0.17.0", number by number. */
export function versionBefore(a: string, b: string): boolean {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0);
  }
  return false;
}

/**
 * 0.17.0: the versions skipped between the one this phone had and this one (newest first): after
 * 0.14.6 → 0.17.0, that's 0.16.0 down to 0.15.0. None when no update was skipped, or it isn't known.
 */
export function skippedNotes(from: string | undefined, current: string, earlier: VersionNotes[]): VersionNotes[] {
  if (!from || !versionBefore(from, current)) return [];
  return earlier.filter((v) => versionBefore(from, v.version) && versionBefore(v.version, current));
}
