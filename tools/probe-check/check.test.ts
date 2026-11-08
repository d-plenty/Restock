// Reads the pages the shop probe saved (tools/probe/out) with Restock's own page reader, and
// says what Restock would find on each: how many products, and the top few after ranking.
//   PROBE=tools/probe/out npx vitest run --config tools/probe-check/vitest.config.ts
import {
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { DOMParser } from "linkedom";
import { it } from "vitest";
import { extractProducts } from "../../src/stores/webPage";
import { rankAll } from "../../src/stores/rank";

const parse = (html: string) =>
  new DOMParser().parseFromString(html, "text/html") as unknown as Document;

it("reads every saved page", () => {
  const root = process.env.PROBE ?? "tools/probe/out";
  const lines: string[] = [];
  for (const run of readdirSync(root)
    .filter((d) => d.startsWith("probe-") && !d.endsWith(".gz"))
    .sort()) {
    for (const shop of readdirSync(join(root, run))) {
      const dir = join(root, run, shop);
      if (!existsSync(dir) || shop.endsWith(".json")) continue;
      for (const word of readdirSync(dir)) {
        const page = join(dir, word, "page.html");
        if (!existsSync(page)) continue;
        const sum = JSON.parse(
          readFileSync(join(dir, word, "summary.json"), "utf8"),
        ) as { url: string; word: string };
        const html = readFileSync(page, "utf8");
        let items: ReturnType<typeof extractProducts> = [];
        let err = "";
        try {
          items = extractProducts(shop as never, html, sum.url, parse);
        } catch (e) {
          err = (e as Error).message;
        }
        const ranked = rankAll({ text: sum.word }, items);
        const priced = items.filter((p) => p.price !== undefined).length;
        lines.push(
          `${run.slice(6, 22)} ${shop.padEnd(20)} ${sum.word.padEnd(15)} ${String(items.length).padStart(3)} found, ${String(priced).padStart(3)} priced ${err}`,
        );
        for (const p of ranked.slice(0, 4))
          lines.push(
            `      ${p.name.slice(0, 70)} [${p.size ?? ""}] ${p.price ?? "$?"}${p.imageUrl ? "" : " (no photo)"}`,
          );
      }
    }
  }
  mkdirSync("tools/probe-check/out", { recursive: true });
  writeFileSync("tools/probe-check/out/report.txt", lines.join("\n"));
});
