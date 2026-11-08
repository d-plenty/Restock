# Search test tools

Two tools for making shop searches better, run on a computer (not the phone).

## Shop probe (`tools/probe`)

Opens each shop's search in a real browser window, searches a few test words the way a person
would, and saves what the shop sent back: the data behind the results, the finished page and a
screenshot. Those files are what's needed to build a shop's connection and to test Restock's
search against real results.

```bash
cd tools/probe
npm install
npx playwright install chromium
node probe.mjs                      # every shop, three words each (about 25 minutes)
node probe.mjs --shops pharmacy     # or pantry, keg, or ids: chemistwarehouse,bws
node probe.mjs --words "butter,milk"
```

A browser window opens and goes from shop to shop. Leave it alone; if a shop shows an "I'm not a
robot" box, tick it. At the end it prints the `.tar.gz` file it made in `tools/probe/out`.

## Live search check (`tools/live-search`)

Runs Restock's own shop connections and ranking against the real shops from the computer, and
writes the top results for each word to `tools/live-search/out/report.txt`.

```bash
npx vitest run --config tools/live-search/vitest.config.ts
SHOPS=coles,bws WORDS="butter,beer" npx vitest run --config tools/live-search/vitest.config.ts
```

Shops that only work through the phone's hidden browser say "Needs the phone"; the probe covers those.

## Check saved probe pages (`tools/probe-check`)

Reads the pages the probe saved with Restock's own page reader, offline, and writes what it would
find on each (how many products, and the top few) to `tools/probe-check/out/report.txt`. Handy
after changing how shop pages are read.

```bash
npx vitest run --config tools/probe-check/vitest.config.ts
PROBE=/path/to/probe/out npx vitest run --config tools/probe-check/vitest.config.ts
```

## Ranking tests from real results

`src/stores/rank.real.test.ts` holds real results saved by the big search test, and what should
come first for each. It runs with `npm test`, so a ranking change that makes "milk" or "nutella"
worse fails straight away. To add a case, copy the shop's results for that word from the big
search test's `raw.json` into `src/stores/fixtures-search-real.json` and add a line to `CASES`.

Both tools are gentle: one shop at a time, with a pause between searches. Neither sends anything
anywhere except to the shops themselves.

## Big search test (`tools/search-test`)

Searches a long list of everyday words (plain, with brands and sizes, Aussie names, typos) at
every shop the way Restock does, and saves everything that came back, how Restock ranked it, and
what it would recommend at your other shops after you tick the top result. About an hour for
everything; `TABS=pantry` (or `keg`, `pharmacy`) does one tab.

```bash
npx vitest run --config tools/search-test/vitest.config.ts
```

The files land in `tools/search-test/out`: `report.txt` to read, and `ranked.json`,
`recommend.json` and `raw.json` for working on search.
