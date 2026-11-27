// 0.17.0: what changed in the versions before this one (0.18.0: 0.17.0 moved here), for someone who skipped some updates: after
// updating from 0.14.6 to 0.17.0, What's new offers 0.16.0, 0.15.2 … down to what they had. Older
// than 0.12.0 is on the GitHub releases page. Newest first. (From each version's own notes:
// fastlane/metadata/android/en-US/changelogs.)
import type { VersionNotes } from './whatsNew';

export const EARLIER: VersionNotes[] = [
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
  {
    version: '0.15.2',
    about: "Faster everywhere, even during a price check: prices are saved in lots, and no screen opens on a blank page.",
    changes: [
      "A price check that's cut off carries on where it got to (unless that was over a day ago).",
      "On iPhone and iPad, prices are checked in the background too: a little at a time, and a longer check from your set time while charging on Wi-Fi.",
    ],
  },
  {
    version: '0.15.1',
    about: "A tidy-up.",
    changes: [
      "A shop you took off Your shops no longer stays on Home.",
      "Check for updates also offers Restock's own F-Droid repo.",
      "On iPhone and iPad, data is now in the system's own database.",
      "If you run a Restock server, update it to 0.15.1 too.",
      "More tests behind the scenes.",
    ],
  },
  {
    version: '0.15.0',
    about: "Update every phone to 0.14.0 or newer: older ones can't sync with this one. iPhone and iPad: hand the owner job to another phone, bring a household onto a server, Nextcloud or WebDAV folders, join a server from the first screen.",
    changes: [
      "A server's web page now looks like the iPad, with Your server in one place.",
      "Opens faster.",
      "Diagnostics shows problems from background work.",
      "Code tidy-up.",
    ],
  },
  {
    version: '0.14.1',
    about: "The photo reader (receipts, and a product's name from a photo) now downloads on first use, about 21 MB, after asking, so the app is about 20 MB smaller.",
    changes: [
      "Settings says less, with the full explanation behind a small i.",
      "General list fixes.",
      "Pharmacy 4 Less removed: its website stopped listing products.",
      "A shop Unblock can't fix offers Turn off. iPhone and iPad: shared prices, recall alerts and app icon colours.",
    ],
  },
  {
    version: '0.14.0',
    about: "Restock now runs on iPhone and iPad too, and an Android phone can sync with one over your Wi-Fi.",
    changes: [
      "Export data can send a copy straight to another phone with a QR code.",
      "Import data takes a file or a code, and adds alongside what's there or replaces it.",
      "Loyalty cards can have an expiry date, with a reminder a month before.",
      "A Restock server is no longer the recommended way to sync: phone sharing is.",
    ],
  },
  {
    version: '0.13.1',
    about: "Inventory, for those who want it.",
    changes: [
      "Turn it on for your Pantry or any tab you made and each item shows how much you have at home: a number, a weight or volume, or roughly (a quarter, half or three quarters of a pack).",
      "Ticking something off while shopping adds it, and Restock can ask or add it to your list when you run low.",
      "Off unless you turn it on.",
      "Also: Restore from a backup on the first screen is a plain tap on the file picker.",
    ],
  },
  {
    version: '0.13.0',
    about: "A head start: see what Declan and Sarah, who make Restock, keep in their pantry and add what you'd use.",
    changes: [
      "The walkthrough uses real items.",
      "Bottle shop and Chemist are tabs you make, name and colour like any other, and every tab has Edit.",
      "Add to a tab, to the tab and the list, or to the list just this once (no name needed).",
      "Minus and plus on a tab's rows once an item is on your list.",
      "Minus to 0 takes it off.",
      "Loyalty cards sit in shopping mode's top bar, with bigger titles.",
    ],
  },
  {
    version: '0.12.10',
    about: "Leave the app mid-shop and your shop is kept, with Resume shopping or Start fresh.",
    changes: [
      "Add to list is in shopping mode.",
      "Two items can't have the same name (capitals don't count).",
      "When Try again on a shop still fails, it goes on to opening the shop's page.",
      "A tab you made always has Edit, to rename it.",
      "Photos are read from more shops.",
      "What's new shows the latest version only.",
    ],
  },
  {
    version: '0.12.9',
    about: "After an update Restock offers What's new, a page of what changed that stays in Settings.",
    changes: [
      "Add another product has a big Done button.",
      "The keyboard opens by itself where you go to type, such as Add to pantry.",
      "While prices are checked, every screen shows one slim line at the top and no longer leaves a big gap.",
      "A product under Also happy with says so in search results.",
    ],
  },
  {
    version: '0.12.8',
    about: "A shopping list item opens its pantry item.",
    changes: [
      "Products I buy is easier to find on an item's page, and adding another product saves as you tap.",
      "No more doubled-up search results.",
      "Loose fruit and veg are priced by the kilo.",
      "Backup reminders come back in a week, then every 30 days (changeable).",
      "Try again on a shop that stopped working says what happened.",
      "Cellarbrations photos.",
      "Pharmacy 4 Less search fixed.",
    ],
  },
  {
    version: '0.12.7',
    about: "You name each item (one short idea to tap).",
    changes: [
      "Also happy with can be chosen while adding.",
      "Start shopping asks which shops today, then where you are first.",
      "Each item is offered at the cheapest shop you're visiting and moves on if you leave without it.",
      "Alternatives only fill gaps.",
      "The General list comes along from every list.",
      "True black has depth.",
      "One title style on every tab.",
    ],
  },
  {
    version: '0.12.6',
    about: "Nothing is picked for you when you add: you tick what you buy at each shop.",
    changes: [
      "The General list comes along when you shop: at the bottom of every shop's page.",
      "A search that finds nothing offers to add what you typed.",
      "A shop's specials say the kind of deal.",
      "Sizes of buttons, boxes and text evened out across the phone, the iPhone web page and the web page.",
    ],
  },
  {
    version: '0.12.5',
    about: "Smoother adding and shopping.",
    changes: [
      "The first search results are marked Recommended, and a shop's page ends with Next shop or Finish: review and add.",
      "More ways to add is one drop-down.",
      "The shopping list has How many on each line and one page per item from the blue i.",
      "The pantry item page puts the best price at each shop first and folds the rest.",
      "More has one Create a custom tab button.",
    ],
  },
  {
    version: '0.12.4',
    about: "Tick as many products as you buy as one item, at any shop, with Finished at each shop.",
    changes: [
      "One look everywhere.",
      "Every screen has the same navy top with curved corners, gold for the main button and green highlights.",
      "The Add screen is search or scan, with Add manually under the results.",
      "The shopping list has Change to switch lists.",
      "A new phone starts with an Add what you buy card.",
      "The shop map library is updated.",
    ],
  },
  {
    version: '0.12.3',
    about: "My catalogue is merged into each shop's page.",
    changes: [
      "Open my catalogue is gone from Home and More.",
      "A shop's page shows only your things on special there (pantry items and shopping list lines), with the shop's catalogue and website at the top.",
      "Home's shop buttons say how many are on special.",
      "More has one row, Your shops.",
      "The server's web page matches.",
    ],
  },
  {
    version: '0.12.2',
    about: "Home is the way in to the catalogues.",
    changes: [
      "Open my catalogue is one big button, and each of your shops has a square button that opens its specials as tiles.",
      "More has two rows, Open my catalogue and Your shops (each shop's catalogue and website).",
      "Bigger More from buttons in search results.",
      "The shop map's credit is plain text.",
    ],
  },
  {
    version: '0.12.1',
    about: "Tidier adding. \"Pick one at Woolworths\" is a page of its own with only that shop's results. \"Not sold here\" is on the pick sheet, beside Change and Pick one myself.",
    changes: [
      "The add screen's title switches between your tabs (the row of tab buttons is gone).",
      "The i on a row has an Open item button.",
    ],
  },
  {
    version: '0.12.0',
    about: "A simpler look.",
    changes: [
      "Setup is three taps (welcome, agree, notifications) and the rest is asked when you first need it.",
      "Four tabs: Home, Pantry, List and More, each with its own add button.",
      "Rows show the photo, the shop, one price and a word.",
      "The i has the rest.",
      "Adding is pick one, then check Restock's pick at each of your other shops.",
      "Bottle shop and Chemist are added as sections when you want them.",
    ],
  },
];
