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

Both tools are gentle: one shop at a time, with a pause between searches. Neither sends anything
anywhere except to the shops themselves.
