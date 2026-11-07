# Contributing to Restock

Thanks for helping! Restock is a small volunteer project, so every clear report and every fix makes a real difference to people trying to save on their shopping.

You don't have to write code to help. Most of the time, the most useful thing is telling us what happens where *you* shop.

## Reporting a problem

Use the [issue forms](../../issues/new/choose):

- **Bug**: something in the app doesn't work or looks wrong.
- **Store stopped working**: searching or price checks fail for a supermarket, bottle shop or pharmacy.
- **Wrong product or price**: a search result, barcode match or price that doesn't match the shelf.

Please include the app version (Settings, at the very bottom), your phone and Android version, and a screenshot if you can.

### A shop isn't working? Send its search details

This is the single most useful thing you can attach:

1. In Restock, open **Settings → Troubleshooting → Diagnostics**.
2. Under **Send search details**, pick the shop, type something it sells, and tap **Search and save the details**.
3. Share the file it makes, and attach it to your **Store stopped working** issue.

The file has the shop's own answer to that one search, and nothing about you, your items or your list. With it, a broken connection can usually be fixed in one go.

### Keep it private

Issues are public. Leave out loyalty card numbers, backup files, your address and anything else personal, and crop screenshots if needed. To report a security problem, see [SECURITY.md](SECURITY.md) instead.

## Ideas

Start a thread in [Discussions → Ideas](../../discussions/categories/ideas). Say what you'd like to do in the shop and why; the "why" helps most. The plan is in the README under **What's next**.

## Working on the code

Setup and build steps are in [BUILD.md](BUILD.md). In short:

```bash
git clone https://github.com/d-plenty/Restock.git restock
cd restock
npm ci
VITE_FAKE_STORES=1 npm run dev   # click through in a browser with made-up shops
npm run typecheck
npm test
```

### Good places to start

- Issues labelled [`good first issue`](../../labels/good%20first%20issue) and [`help wanted`](../../labels/help%20wanted).
- **Shop connections** (`src/stores/`, plus `android/.../StoreClient.java` for background checks). A **Store stopped working** issue with its search details file attached is a self-contained job.
- **Accessibility**: screen reader labels, contrast, bigger text.
- **Tests** for anything that parses a shop's data. Save a real answer as a fixture and test against it (see `src/stores/*.test.ts`).

### Sending a pull request

1. Fork the repo and make a branch: `git checkout -b fix-bws-search`.
2. Keep each pull request to one change, with a plain-words description of what it fixes and how you tested it.
3. `npm run typecheck` and `npm test` must pass.
4. If you changed anything a user sees, add a screenshot.

### House rules

- **Local first.** No accounts, analytics, ads, trackers or Google Play services. Anything that contacts a new service must be added to the privacy policy (`src/lib/legal.json`) in the same pull request.
- **Ask for permissions just in time.** A permission is asked for the first time its feature is used, with a plain reason.
- **Keep the twins in step.** `Deals.java` mirrors `src/lib/verdict.ts`, `StoreClient.java` mirrors `src/stores/`, and `Shops.java` mirrors `src/shops.ts`. Change both together.
- **Migrations are append-only.** Add new entries at the end of `MIGRATIONS` in `src/lib/sql/schema.ts`; never edit a shipped one.
- **Be gentle with the shops.** Requests go one at a time with a pause between them, and only for items people track. No bulk scraping, and nothing from paywalled or private price databases.
- **Plain words.** Interface text should be short, friendly and free of jargon. Australian spelling.

### Privacy policy and fine print

Both are written once in `src/lib/legal.json`, which the app shows in setup and Settings. `PRIVACY.md` and `DISCLAIMER.md` match it. If you change one, change the `updated` date too.

## Licence

By contributing, you agree your contribution is released under the project's licence, the [GNU General Public License v3.0](LICENSE).

## Be kind

Everyone here is a volunteer. See the [Code of Conduct](CODE_OF_CONDUCT.md).
