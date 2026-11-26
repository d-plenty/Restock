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
    version: '0.17.0',
    about: 'Tidier everywhere: the same sizes on every screen, shorter Settings, and what’s new for every update you skipped.',
    changes: [
      'The same button and box sizes on every screen, a tighter top on Home, and the tab bar lower down.',
      'Inventory stays out of the way until you want it: Restock asks once, after you’ve used it for a while.',
      'Settings: your name explains where it’s used, Setup is a short checklist, and Sync and Backups have a page each.',
      'Prices and deals, Shared prices and the backup settings say it in fewer words, with the rest behind ⓘ.',
      'Look and colours: 11 accent and app icon colours plus the colour wheel, the icons shown as the real icon, and See the animations with a picture of each.',
      'Holiday dates: Australia Day 2–27 January, Easter the three weeks up to Easter Monday, and Halloween 11 October – 1 November.',
      'Skipped an update or two? What’s new now has every version since the one you had.',
      'On a Restock server, each browser is named after you and itself, like “Sam’s Chrome”.',
      'Fixes: the square box behind search bars in true black, the Feedback page layout, the Advanced icon, an animation you couldn’t get out of, and pop-ups on tablets and iPads dimming only a strip of the screen.',
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
