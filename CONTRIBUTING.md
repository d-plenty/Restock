# Contributing to Restock

Thanks for helping! Restock is a small volunteer project, so every clear report and every fix makes a real difference to people trying to save on their shopping.

You don't have to write code to help. Most of the time, the most useful thing is telling us what happens where *you* shop.

## Reporting a problem

No GitHub account? Use **Settings → Send feedback** in the app (or on your Restock server's web page): it goes straight to the people who make Restock, with screenshots and diagnostics if you like.

On GitHub, use the [issue forms](../../issues/new/choose):

- **Bug**: something in the app doesn't work or looks wrong.
- **Shop stopped working**: searching or price checks fail for a supermarket, bottle shop or chemist.
- **Local sync problem**: phones won't pair, can't find each other, or something doesn't sync.
- **Wrong product or price**: a search result, barcode match or price that doesn't match the shelf.

Please include the app version (Settings, at the very bottom), your phone and Android version, and a screenshot if you can. Not sure if it's a bug? Ask in [Discussions → Q&A](../../discussions/categories/q-a) first.

**A problem with your Restock server** (it won't start, a phone can't reach it, its web page, Restock on iPhone)? Use [the server's issue forms](https://github.com/d-plenty/restock-server/issues/new/choose) instead.

### A shop isn't working? Send its search details

This is the single most useful thing you can attach:

1. In Restock, open **Settings → Advanced**, tap **Turn on testing features**, then **Diagnostics**.
2. Under **Send search details**, pick the shop, type something it sells, and tap **Search and save the details**.
3. Share the file it makes, and attach it to your **Shop stopped working** issue.

The file has the shop's own answer to that one search, and nothing about you, your items or your list. With it, a broken connection can usually be fixed in one go.

### Search gave you the wrong things? Send them

Under any shop's results in Restock, tap **Wrong results? Save them for the developer** and attach the file to a **Wrong product or price** issue, with what you expected to see. It has the search and that shop's results, nothing else. To help more widely, run **Settings → Troubleshooting → Diagnostics → Search test**: it searches a list of everyday words at your shops and saves one file to attach.

### Keep it private

Issues are public. Leave out card numbers and PINs, backup files, export files, your address and anything else personal, and crop screenshots if needed. To report a security problem, see [SECURITY.md](SECURITY.md) instead.

## Ideas

Start a thread in [Discussions → Ideas](../../discussions/categories/ideas). Say what you'd like to do in the shop and why; the "why" helps most. The plan is in the README under **[Coming soon](README.md#coming-soon)**.

## Know the Apple side?

Restock runs on iPhone and iPad as its own app (installed from a computer for now; see [docs/IPHONE.md](docs/IPHONE.md)), and through your own server as a web app on the home screen. It isn't on the App Store yet: help from someone who already has an Apple developer account and knows TestFlight and App Store review is welcome. The details are in the README: [Wanted: someone to bring Restock to iPhone](README.md#wanted-someone-to-bring-restock-to-iphone).

## Working on the code

Setup and build steps are in [BUILD.md](BUILD.md). In short:

```bash
git clone https://github.com/d-plenty/Restock.git restock
cd restock
npm ci
VITE_FAKE_STORES=1 npm run dev   # click through in a browser with made-up shops
npm run typecheck
npm run lint        # the linter (oxlint, .oxlintrc.json)
npm test
ORGJSON=~/json.jar bash tools/sync-test/run.sh          # the Android sync tests (org.json jar from github.com/stleary/JSON-java)
```

The Restock server is its own repo ([d-plenty/restock-server](https://github.com/d-plenty/restock-server)). If you changed it, or what it shares with this one, clone it next to this repo and run `RESTOCK_DIR=../restock npm test` there (the sync tests above use it too).

### Finding your way around

- **`src/ui/screens/`**: one file per screen. The biggest ones are split, with the parts in files named after them: `List.tsx` and `ShoppingMode.tsx`; `Item.tsx`, `ItemSheets.tsx` and `ItemHistory.tsx`; `Add.tsx` and `AddSheets.tsx`; `Settings.tsx` and `SettingsParts.tsx`; `Sync.tsx`, `SyncCodes.tsx`, `SyncServer.tsx` and `SyncSheets.tsx`. Tests that read a screen's code use `src/lib/readSource.ts`, which reads a split screen as a whole: add a new part to its list there.
- **`src/lib/`**: everything that isn't a screen (the database, prices and verdicts, sync, backups). `src/lib/sql/schema.ts` has the tables and migrations.
- **`src/stores/`**: talking to each shop.
- **`src/ios/`**: the iPhone and iPad app's own parts (its database file, sync, shop pages). **`ios/`** is the Xcode project.
- **`android/`**: the Android app's Java (background checks, sync, the price helper).
- **`src/server-mode/`**: the web page a Restock server shows. It uses the phone's own screens; on a wide window they sit beside the iPad's side bar (`src/ui/padWide.ts`).
- **Errors that background work catches** (a sync round, a price check) are noted with `quiet('where')` from `src/lib/quietErrors.ts`, not dropped, and show in Diagnostics under **Quiet problems**.

### Good places to start

- Issues labelled [`good first issue`](../../labels/good%20first%20issue) and [`help wanted`](../../labels/help%20wanted).
- **Shop connections** (`src/stores/`, plus `android/.../StoreClient.java` for background checks). A **Shop stopped working** issue with its search details file attached is a self-contained job.
- **Accessibility**: screen reader labels, contrast, bigger text.
- **Tests** for anything that parses a shop's data. Save a real answer as a fixture and test against it (see `src/stores/*.test.ts`).

### Sending a pull request

1. Fork the repo and make a branch: `git checkout -b fix-bws-search`.
2. Keep each pull request to one change, with a plain-words description of what it fixes and how you tested it.
3. `npm run typecheck`, `npm run lint` and `npm test` must pass. GitHub runs them on every pull request, along with the Android sync tests and an Android build (`.github/workflows/ci.yml`). Tests are named for what they cover (`shopAround.test.ts`), not for a version.
4. If you changed anything a user sees, add a screenshot.

### House rules

- **Local first.** The phone works fully offline and never needs a server; only searching the shops needs the internet. No accounts, analytics, ads, trackers or Google Play services. Anything that contacts a new service must be added to the privacy policy (`src/lib/legal.json`) in the same pull request.
- **The server never contacts the shops,** except through the opt-in setting **Let the web page search the shops**, and then only when someone presses Search. Nothing in the background.
- **Ask for permissions just in time.** A permission is asked for the first time its feature is used, with a plain reason.
- **Keep the twins in step.** `Deals.java` mirrors `src/lib/verdict.ts`, `StoreClient.java` mirrors `src/stores/`, and `Shops.java` mirrors `src/shops.ts`. Change both together.
- **Migrations are append-only.** Add new entries at the end of `MIGRATIONS` in `src/lib/sql/schema.ts`; never edit a shipped one.
- **Mind local sync.** Tables that sync between phones are listed in `SYNCED` in `src/lib/sql/schema.ts` and in `TABLES` in `SyncEngine.java`; keep the two in step. Phone-only things (look, receipts, backups, shop sign-ins) must never be added to them.
- **Be gentle with the shops.** Requests go one at a time with a pause between them, and only for items people track. No bulk scraping, and nothing from paywalled or private price databases.
- **Plain words.** Interface text should be short, friendly and free of jargon. Australian spelling. Say **shop** (not store), **phone** (not device), **usual price**, **on special**, **Shopping list**, **Add to list**, and **Health** for the tab (chemists for the shops). No em dashes in the interface.
- **Every platform the same.** Android, iPhone and iPad, the web page and the server do the same things the same way. Where an iPhone works differently, the screen just says how it works there; only something Apple doesn't allow at all says so ("not possible on iPhone due to Apple's restrictions").
- **Colours.** A main button is green on a light background, and gold only on navy.
- **Keep older phones working.** Internal ids stay as they are (the Health tab is still `pharmacy` inside), and new kinds of record must be held, not dropped, by phones and servers that don't know them yet. The oldest app a server still syncs with is set in `src/lib/minVersion.ts`.

### Privacy policy and fine print

Both are written once in `src/lib/legal.json`, which the app shows in setup and Settings. `PRIVACY.md` and `DISCLAIMER.md` are that file written out, word for word; `src/lib/privacy.test.ts` checks `PRIVACY.md` and shows how it's laid out. If you change one, change the `updated` date too.

## Licence

By contributing, you agree your contribution is released under the project's licence, the [GNU General Public License v3.0](LICENSE).

## Be kind

Everyone here is a volunteer. See the [Code of Conduct](CODE_OF_CONDUCT.md).
