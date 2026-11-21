// 0.12.9: what changed in each version, in plain words, kept in the app itself: nothing is fetched
// to show it. After an update Restock offers it once ("See what's new" / "I'll figure it out"),
// and it stays in Settings → What's new. The newest version is first; the README has the long form.
export interface VersionNotes {
  version: string;
  /** One line that sums the version up. */
  about: string;
  changes: string[];
}

export const WHATS_NEW: VersionNotes[] = [
  {
    version: '0.12.9',
    about: 'Less tapping, and a page that tells you what changed.',
    changes: [
      "What's new: after an update Restock offers this page once. It's always in Settings, under Help.",
      'Add another product has a big Done button at the bottom that takes you back to the item.',
      'The keyboard opens by itself where you go to type, such as Add to pantry and Add manually.',
      'While prices are being checked, every screen shows the same one slim line at the top. It no longer pushes the page down.',
      'A product you have under Also happy with says so in search results (it said In your pantry).',
    ],
  },
  {
    version: '0.12.8',
    about: 'Getting to your products, and a tidy-up of things testers ran into.',
    changes: [
      'Tap an item on the shopping list and there is an Open in Pantry button.',
      'What I buy is called Products I buy, and is easier to spot on an item’s page.',
      'Adding another product to an item is one tap on +, with Undo.',
      'A shop’s search no longer shows the same product twice.',
      'Loose fruit and veg are priced by the kilo, with the price for one under it.',
      'Backup reminders come back a week after Not now, then every 30 days. You can change that in Settings.',
      'Try again on a shop’s card says what happened.',
      'Cellarbrations, The Bottle-O and Porters show product photos.',
    ],
  },
  {
    version: '0.12.7',
    about: 'You name things, shopping follows your day, and true black has depth.',
    changes: [
      'You name each item yourself when you add it.',
      'Start shopping asks which shops you’re going to today, and where you are first.',
      'Each item is offered at the cheapest shop you’re visiting today.',
      'Also happy with products only fill gaps, such as when yours is out of stock.',
      'The General list comes along from every list.',
      'True black has depth: bars and cards are a step lighter than the page.',
    ],
  },
  {
    version: '0.12.6',
    about: 'You pick everything yourself, and the look is evened out.',
    changes: [
      'Nothing is picked for you: each shop stays empty until you tick a product there.',
      'A search that finds nothing offers the next step.',
      'A shop’s specials say the kind of deal.',
      'Buttons, boxes and headings are one size on every screen.',
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
