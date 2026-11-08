// Re-marks a saved run with Restock's current ranking, without going to the shops (0.8.6):
//   npx vitest run --config tools/search-test/scorecard.config.ts
//   RAW=/path/to/raw.json npx vitest run --config tools/search-test/scorecard.config.ts
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { it } from "vitest";
import { mark, scorecard } from "../../src/lib/searchScore";

it("marks a saved run", () => {
  const file = process.env.RAW ?? "tools/search-test/out/raw.json";
  if (!existsSync(file)) {
    console.log(`No saved run at ${file}. Run the big search test first.`);
    return;
  }
  const text = scorecard(mark(JSON.parse(readFileSync(file, "utf8"))));
  writeFileSync(file.replace(/raw\.json$/, "scorecard.txt"), text);
  console.log(text.split("\n\n")[0]);
});
