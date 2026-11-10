# Contributing to Restock

Thanks for helping! Restock is a small volunteer project, so every clear report and every fix makes a real difference to people trying to save on their shopping.

You don't have to write code to help. Most of the time, the most useful thing is telling us what happens where *you* shop.

## Reporting a problem

Use the [issue forms](../../issues/new/choose):

- **Bug**: something in the app doesn't work or looks wrong.
- **Shop stopped working**: searching or price checks fail for a supermarket, bottle shop or chemist.
- **Local sync problem**: phones won't pair, can't find each other, or something doesn't sync.
- **Wrong product or price**: a search result, barcode match or price that doesn't match the shelf.

Please include the app version (Settings, at the very bottom), your phone and Android version, and a screenshot if you can. Not sure if it's a bug? Ask in [Discussions → Q&A](../../discussions/categories/q-a) first.

**A problem with your Restock server** (it won't start, a phone can't reach it, its web page, Restock on iPhone)? Use [the server's issue forms](https://github.com/d-plenty/restock-server/issues/new/choose) instead.

### A shop isn't working? Send its search details

This is the single most useful thing you can attach:

1. In Restock, open **Settings → Troubleshooting → Diagnostics**.
2. Under **Send search details**, pick the shop, type something it sells, and tap **Search and save the details**.
3. Share the file it makes, and attach it to your **Shop stopped working** issue.

The file has the shop's own answer to that one search, and nothing about you, your items or your list. With it, a broken connection can usually be fixed in one go.

### Search gave you the wrong things? Send them

Under any shop's results in Restock, tap **Wrong results? Save them for the developer** and attach the file to a **Wrong product or price** issue, with what you expected to see. It has the search and that shop's results, nothing else. To help more widely, run **Settings → Troubleshooting → Diagnostics → Search test**: it searches a list of everyday words at your shops and saves one file to attach.

### Keep it private

Issues are public. Leave out loyalty card numbers, backup files, export files, your address and anything else personal, and crop screenshots if needed. To report a security problem, see [SECURITY.md](SECURITY.md) instead.

## Ideas

Start a thread in [Discussions → Ideas](../../discussions/categories/ideas). Say what you'd like to do in the shop and why; the "why" helps most. The plan is in the README under **[Coming soon](README.md#coming-soon)**.

## Know the Apple side?

Restock already works on iPhone through your own server, as a web app on the home screen. It's still looking for someone to build a real iPhone app and publish it on the App Store, ideally someone who already has an Apple developer account and knows Xcode, TestFlight and App Store review. The details are in the README: [Wanted: someone to bring Restock to iPhone](README.md#wanted-someone-to-bring-restock-to-iphone).

## Working on the code

Setup and build steps are in [BUILD.md](BUILD.md). In short:

```bash
git clone https://github.com/d-plenty/Restock.git restock
cd restock
npm ci
VITE_FAKE_STORES=1 npm run dev   # click through in a browser with made-up shops
npm run typecheck
npm test
npm run build:server-core && (cd server && npm test)   # the Restock server, if you changed it or what it shares
```

### Good places to start

- Issues labelled [`good first issue`](../../labels/good%20first%20issue) and [`help wanted`](../../labels/help%20wanted).
- **Shop connections** (`src/stores/`, plus `android/.../StoreClient.java` for background checks). A **Shop stopped working** issue with its search details file attached is a self-contained job.
- **Accessibility**: screen reader labels, contrast, bigger text.
- **Tests** for anything that parses a shop's data. Save a real answer as a fixture and test against it (see `src/stores/*.test.ts`).

### Sending a pull request

1. Fork the repo and make a branch: `git checkout -b fix-bws-search`.
2. Keep each pull request to one change, with a plain-words description of what it fixes and how you tested it.
3. `npm run typecheck` and `npm test` must pass.
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
- **Keep older phones working.** Internal ids stay as they are (the Health tab is still `pharmacy` inside), and new kinds of record must be held, not dropped, by phones and servers that don't know them yet.

### Privacy policy and fine print

Both are written once in `src/lib/legal.json`, which the app shows in setup and Settings. `PRIVACY.md` and `DISCLAIMER.md` are that file written out, word for word; `src/lib/privacy090.test.ts` checks `PRIVACY.md` and shows how it's laid out. If you change one, change the `updated` date too.

## Licence

By contributing, you agree your contribution is released under the project's licence, the [GNU General Public License v3.0](LICENSE).

## Be kind

Everyone here is a volunteer. See the [Code of Conduct](CODE_OF_CONDUCT.md).
