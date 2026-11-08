// The search scorecard (0.8.6): for every shop and word, is the right thing first, in the top 3,
// is there junk in the top 3, or nothing right at all? Worked out from saved results with
// Restock's current ranking, so a change can be checked before and after without going back to
// the shops. Labels for what's "right" are in searchExpect.ts.
import {
  intendedKind,
  scoreAll,
  UNLIKELY,
  normaliseQuery,
  type Scored,
} from "./searchHelp";
import type { StoreProduct } from "../stores/types";
import { isRight } from "./searchExpect";

export interface Mark {
  shop: string;
  word: string;
  /** What the person sees first: the shop's results, or the kind it was searched for instead. */
  instead?: string;
  first: boolean;
  top3: boolean;
  junk: number;
  any: boolean;
  shown: string[];
}

/** raw: "shop|word" → results, and "shop|word|kind" → that shop's results for the kind instead. */
export function mark(raw: Record<string, StoreProduct[]>): Mark[] {
  const byWord = new Map<string, Map<string, StoreProduct[]>>();
  for (const [key, items] of Object.entries(raw)) {
    const [shop, word, kind] = key.split("|");
    if (kind) continue;
    if (!byWord.has(word)) byWord.set(word, new Map());
    byWord.get(word)!.set(shop, items);
  }
  const out: Mark[] = [];
  for (const [word, at] of byWord) {
    const text = normaliseQuery(word);
    const scored: Record<string, Scored[]> = {};
    for (const [shop, items] of at) scored[shop] = scoreAll({ text }, items);
    const kind = intendedKind({ text }, scored);
    for (const [shop, list] of Object.entries(scored)) {
      let shown = list;
      let instead: string | undefined;
      if (
        (!list.length || list[0].s < UNLIKELY) &&
        kind &&
        raw[`${shop}|${word}|${kind}`]
      ) {
        shown = scoreAll({ text: kind }, raw[`${shop}|${word}|${kind}`]);
        instead = kind;
      }
      const names = shown.map((x) => x.sp.name);
      const right = (n: string) => isRight(word, n);
      if (right(names[0] ?? "") === undefined && names.length) continue; // no label for this word
      // Nothing like it, and nothing shown: a shop with nothing right is marked right for showing nothing.
      const hidden = !instead && (!list.length || list[0].s < UNLIKELY);
      const top3 = hidden ? [] : names.slice(0, 3);
      out.push({
        shop,
        word,
        instead,
        first: !!top3[0] && !!right(top3[0]),
        top3: top3.some((n) => right(n)),
        junk: top3.filter((n) => !right(n)).length,
        any: names.some((n) => right(n)),
        shown: top3,
      });
    }
  }
  return out;
}

const pct = (n: number, d: number) =>
  d ? `${Math.round((100 * n) / d)}%`.padStart(5) : "    -";

/** The scorecard as text: a line per shop, then every miss. */
export function scorecard(marks: Mark[]): string {
  const lines = [
    "Shop                  words  right 1st  right top 3  junk in top 3  has it, not top 3  hasn't got it",
  ];
  const shops = [...new Set(marks.map((m) => m.shop))];
  const all = (f: (m: Mark) => boolean, list = marks) => list.filter(f).length;
  for (const shop of [...shops, "ALL"]) {
    const m = shop === "ALL" ? marks : marks.filter((x) => x.shop === shop);
    lines.push(
      `${shop.padEnd(20)} ${String(m.length).padStart(6)}  ${pct(
        all((x) => x.first, m),
        m.length,
      )}      ${pct(
        all((x) => x.top3, m),
        m.length,
      )}        ${pct(
        all((x) => x.junk > 0, m),
        m.length,
      )}            ${pct(
        all((x) => x.any && !x.top3, m),
        m.length,
      )}            ${pct(
        all((x) => !x.any, m),
        m.length,
      )}`,
    );
  }
  lines.push(
    "",
    "Misses (the right thing is there but not first, or junk is in the top 3):",
  );
  for (const m of marks.filter((x) => x.any && (!x.first || x.junk > 0)))
    lines.push(
      `  ${m.shop.padEnd(18)} ${m.word.padEnd(24)} ${m.instead ? `[searched "${m.instead}"] ` : ""}${m.shown.map((n) => n.slice(0, 40)).join(" ; ")}`,
    );
  lines.push(
    "",
    "Not there at all (no right answer in what the shop sent back):",
  );
  for (const m of marks.filter((x) => !x.any))
    lines.push(
      `  ${m.shop.padEnd(18)} ${m.word}${m.instead ? ` [searched "${m.instead}"]` : ""}`,
    );
  return lines.join("\n");
}
