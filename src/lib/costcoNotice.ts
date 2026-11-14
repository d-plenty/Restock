// Every word about Costco (0.9.6), in one place, so the app, the web page, the README and the
// release notes say exactly the same thing. Plain Australian English, short sentences, no em dashes.
//
// Costco is the one shop Restock reads even though its website terms ask people not to. Declan
// decided to build it for family use. 0.9.7: an ordinary supermarket, picked with the others (off by
// default), shared like them, and still read only when someone presses Search. No Costco logo or artwork.

/** The shop's name in sentences. */
export const COSTCO_NAME = 'Costco';

/** The heading of the Costco setting on the phone. */
export const COSTCO_SETTING_TITLE = 'Costco';

/** The switch's label. */
export const COSTCO_SWITCH_LABEL = 'Use Costco';

/** What the switch does, in one line under it. */
export const COSTCO_SWITCH_HELP = 'Off until you pick it. Online prices, delivery included.';
export const COSTCO_SWITCH_HELP_ON = 'Searched with your other shops when you search. Prices are online prices.';

/** The heading above the disclosure, in the sheet that asks first and in the setting itself. */
export const COSTCO_NOTICE_HEADING = 'About Costco (test)';

/**
 * The disclosure. Shown in full before Costco can be turned on, and kept visible in the setting
 * afterwards. The README, PRIVACY.md, legal.json and the release notes use these same sentences.
 */
// 0.10.7: shorter and friendlier, with the same facts (the terms line stays: it's a real fact people
// should know before switching it on).
export const COSTCO_NOTICE: readonly string[] = [
  'Restock only checks Costco when you search, one page at a time, like you browsing its website.',
  "Costco's website terms don't allow automated collection, so it's your choice to switch it on.",
  "Prices are Costco's online prices, which include delivery, so the warehouse can differ.",
  "If Costco changes or blocks its website, its prices stop until that's sorted. That's on Costco's side, not something you did.",
  // 0.9.14: Send prices back.
  'With Shared prices on, Costco prices you find are shared like the other shops’.',
];

/** The disclosure as one paragraph (README, release notes). */
export const COSTCO_NOTICE_TEXT = COSTCO_NOTICE.join(' ');

/** The button that turns Costco on, after reading the disclosure. */
export const COSTCO_TURN_ON = 'I understand. Use Costco';
export const COSTCO_TURN_OFF = 'Turn off Costco';
export const COSTCO_CANCEL = 'Not now';

/** The tick that lets Costco prices decide the cheapest shop. */
export const COSTCO_BUY_ONLINE = 'I buy from Costco online';
export const COSTCO_BUY_ONLINE_HELP =
  'Ticked: Costco online prices count when Restock works out the cheapest shop. Not ticked: they show for information only, with the comparison price.';

/** What the Costco prices are called, on every line that has one. */
export const COSTCO_PRICE_INCLUDES_DELIVERY = 'Online price, includes delivery';
export const COSTCO_PRICE_SHIPPING_AT_CHECKOUT = 'Online price, shipping added at checkout';
export const COSTCO_PRICE_ONLINE = 'Online price';
export const COSTCO_MEMBER_ONLY = 'Member only';
export const COSTCO_OUT_OF_STOCK = 'Out of stock';

export const costcoMinimum = (n: number) => `Minimum ${n} when buying online`;
export const costcoCantShip = (state: string) => `Can't ship to ${state}`;
export const costcoSpecialUntil = (save: string, until?: string) => (until ? `On special, save ${save}, until ${until}` : `On special, save ${save}`);

/** Shown for the shop in lists on the web page and the server's web UI, which never search Costco. */
export const COSTCO_WEB_NAME = 'Costco';
export const COSTCO_WEB_NOTE = "Costco's prices are online prices, which include delivery. Costco is looked up only when someone searches.";

/** Errors and states in the app. */
export const COSTCO_OFF_MESSAGE = 'Costco is not one of your shops. Pick it in Settings, under shops.';
export const COSTCO_PHONE_ONLY_MESSAGE = 'Signing in to Costco works in the Android app.';
export const COSTCO_BUSY_MESSAGE = 'You have searched Costco a few times in the last minute. Wait a minute, then try again.';
export const costcoBlockedMessage = (detail: string) =>
  `Costco blocked the search (${detail}). Restock has stopped trying for now. Try again later, or type the shelf price in by hand.`;
export const COSTCO_STILL_BLOCKED_MESSAGE =
  'Costco blocked the last search, so Restock is not trying again yet. Try again in a little while, or type the shelf price in by hand.';
export const COSTCO_CHANGED_MESSAGE = "Costco's page looked different from what Restock expects, so nothing could be read. Costco may have changed its pages.";
