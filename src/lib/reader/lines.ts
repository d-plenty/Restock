// 0.10.7: the text reader finds each bit of writing on its own ("WEET-BIX BITES 500G", then "6.50"
// further along). A receipt needs them back as lines, item and price together, even when the photo
// is a little crooked. This puts them back together.

export interface Point {
  x: number;
  y: number;
}
export interface FoundText {
  text: string;
  /** 0 to 1 */
  confidence: number;
  /** Corners, clockwise from top-left. */
  points: Point[];
}
export interface ReadLine {
  text: string;
  /** Height of the text, in pixels: big text on a pack is usually the product's name. */
  height: number;
  /** 0 to 100 */
  confidence: number;
}

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

/** Puts the found bits of writing back into lines, top to bottom, left to right. */
export function toLines(found: FoundText[]): { text: string; lines: ReadLine[] } {
  const boxes = found
    .filter((f) => f.points.length >= 4 && /[A-Za-z0-9]/.test(f.text))
    .map((f) => {
      const [tl, tr, , bl] = f.points;
      const width = dist(tl, tr);
      const height = dist(tl, bl);
      const cx = f.points.reduce((s, p) => s + p.x, 0) / f.points.length;
      const cy = f.points.reduce((s, p) => s + p.y, 0) / f.points.length;
      return { f, width, height, cx, cy, angle: Math.atan2(tr.y - tl.y, tr.x - tl.x) };
    });
  // How crooked the photo is: the middle angle of the wider bits of writing.
  const angle = median(boxes.filter((b) => b.width > b.height * 2).map((b) => b.angle));
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const level = boxes
    .map((b) => ({ ...b, x: cos * b.cx + sin * b.cy, y: -sin * b.cx + cos * b.cy }))
    .sort((a, b) => a.y - b.y);
  const rows: (typeof level)[] = [];
  for (const b of level) {
    const row = rows[rows.length - 1];
    if (row) {
      const y = row.reduce((s, r) => s + r.y, 0) / row.length;
      const h = Math.min(b.height, median(row.map((r) => r.height)));
      if (Math.abs(b.y - y) < h * 0.5) {
        row.push(b);
        continue;
      }
    }
    rows.push([b]);
  }
  const lines: ReadLine[] = rows.map((row) => {
    const sorted = [...row].sort((a, b) => a.x - b.x);
    return {
      text: sorted.map((r) => r.f.text.trim()).join(' '),
      height: Math.max(...row.map((r) => r.height)),
      confidence: Math.round(Math.min(...row.map((r) => r.f.confidence)) * 100),
    };
  });
  return { text: lines.map((l) => l.text).join('\n'), lines };
}
