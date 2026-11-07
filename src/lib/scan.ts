// The receipt scanner's picture work, done on the phone in plain JavaScript: find the receipt in
// the photo, straighten it (a "perspective" fix, like a document scanner), and make it crisp
// black and white. No downloads needed: receipts are pale paper on a darker table, so finding
// the brightest large shape and its four corners works well, and the corners can be dragged
// if it's off.

export interface Img {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export interface Pt {
  x: number;
  y: number;
}

/** Top-left, top-right, bottom-right, bottom-left. */
export type Quad = [Pt, Pt, Pt, Pt];

const lum = (d: Uint8ClampedArray, i: number) => (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;

/** Otsu's threshold: the grey level that best splits the picture into dark and light. */
export function otsu(gray: Uint8Array): number {
  const hist = new Array<number>(256).fill(0);
  for (const g of gray) hist[g]++;
  const total = gray.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let at = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) {
      best = between;
      at = t;
    }
  }
  return at;
}

function grayOf(img: Img): Uint8Array {
  const g = new Uint8Array(img.width * img.height);
  for (let p = 0, i = 0; p < g.length; p++, i += 4) g[p] = lum(img.data, i);
  return g;
}

/** The whole picture, slightly inside the edges (when no receipt can be found). */
export function fullQuad(w: number, h: number, inset = 0.04): Quad {
  const dx = w * inset;
  const dy = h * inset;
  return [
    { x: dx, y: dy },
    { x: w - dx, y: dy },
    { x: w - dx, y: h - dy },
    { x: dx, y: h - dy },
  ];
}

/**
 * Finds the receipt: the largest bright shape, and its four corners. `img` should be small
 * (about 400 px on the long side); the corners are in its pixels. Undefined if nothing
 * receipt-like stands out.
 */
export function findPaper(img: Img): Quad | undefined {
  const { width: w, height: h } = img;
  const gray = grayOf(img);
  const t = otsu(gray);
  // Nothing to separate (a plain picture), or the whole thing is bright.
  const bright = new Uint8Array(w * h);
  let count = 0;
  for (let p = 0; p < bright.length; p++)
    if (gray[p] > t) {
      bright[p] = 1;
      count++;
    }
  if (count < w * h * 0.05 || count > w * h * 0.97) return undefined;

  // Largest connected bright shape.
  const label = new Int32Array(w * h);
  const stack = new Int32Array(w * h);
  let bestLabel = 0;
  let bestSize = 0;
  let next = 0;
  for (let start = 0; start < bright.length; start++) {
    if (!bright[start] || label[start]) continue;
    next++;
    let top = 0;
    stack[top++] = start;
    label[start] = next;
    let size = 0;
    while (top) {
      const p = stack[--top];
      size++;
      const x = p % w;
      const y = (p - x) / w;
      if (x > 0 && bright[p - 1] && !label[p - 1]) ((label[p - 1] = next), (stack[top++] = p - 1));
      if (x < w - 1 && bright[p + 1] && !label[p + 1]) ((label[p + 1] = next), (stack[top++] = p + 1));
      if (y > 0 && bright[p - w] && !label[p - w]) ((label[p - w] = next), (stack[top++] = p - w));
      if (y < h - 1 && bright[p + w] && !label[p + w]) ((label[p + w] = next), (stack[top++] = p + w));
    }
    if (size > bestSize) {
      bestSize = size;
      bestLabel = next;
    }
  }
  if (bestSize < w * h * 0.04) return undefined;

  // Corners: the shape's points furthest towards each corner of the picture.
  let tl = { x: 0, y: 0, v: Infinity };
  let br = { x: 0, y: 0, v: -Infinity };
  let tr = { x: 0, y: 0, v: -Infinity };
  let bl = { x: 0, y: 0, v: -Infinity };
  for (let p = 0; p < label.length; p++) {
    if (label[p] !== bestLabel) continue;
    const x = p % w;
    const y = (p - x) / w;
    if (x + y < tl.v) tl = { x, y, v: x + y };
    if (x + y > br.v) br = { x, y, v: x + y };
    if (x - y > tr.v) tr = { x, y, v: x - y };
    if (y - x > bl.v) bl = { x, y, v: y - x };
  }
  const q: Quad = [tl, tr, br, bl].map(({ x, y }) => ({ x: x + 0.5, y: y + 0.5 })) as Quad;
  // A sliver isn't a receipt.
  if (Math.min(dist(q[0], q[1]), dist(q[1], q[2])) < Math.min(w, h) * 0.12) return undefined;
  return q;
}

export const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

/** The 3×3 matrix taking the unit square's corners to a quad. */
function squareToQuad(q: Quad): number[] {
  const [p0, p1, p2, p3] = q;
  const dx1 = p1.x - p2.x;
  const dx2 = p3.x - p2.x;
  const dy1 = p1.y - p2.y;
  const dy2 = p3.y - p2.y;
  const sx = p0.x - p1.x + p2.x - p3.x;
  const sy = p0.y - p1.y + p2.y - p3.y;
  const den = dx1 * dy2 - dx2 * dy1;
  const g = den ? (sx * dy2 - dx2 * sy) / den : 0;
  const hh = den ? (dx1 * sy - sx * dy1) / den : 0;
  return [p1.x - p0.x + g * p1.x, p3.x - p0.x + hh * p3.x, p0.x, p1.y - p0.y + g * p1.y, p3.y - p0.y + hh * p3.y, p0.y, g, hh, 1];
}

/** How big the straightened receipt should be: its real proportions, at most `maxSide` px. */
export function outputSize(q: Quad, maxSide = 2200): { width: number; height: number } {
  const wide = Math.max(dist(q[0], q[1]), dist(q[3], q[2]));
  const tall = Math.max(dist(q[0], q[3]), dist(q[1], q[2]));
  const k = Math.min(1, maxSide / Math.max(wide, tall));
  return { width: Math.max(1, Math.round(wide * k)), height: Math.max(1, Math.round(tall * k)) };
}

/** Straightens the part of `src` inside the quad into a flat rectangle. */
export function warp(src: Img, q: Quad, size = outputSize(q)): Img {
  const { width: W, height: H } = size;
  const m = squareToQuad(q);
  const out = new Uint8ClampedArray(W * H * 4);
  const sw = src.width;
  const sh = src.height;
  const d = src.data;
  for (let y = 0; y < H; y++) {
    const v = (y + 0.5) / H;
    for (let x = 0; x < W; x++) {
      const u = (x + 0.5) / W;
      const z = m[6] * u + m[7] * v + 1;
      const fx = Math.min(sw - 1.001, Math.max(0, (m[0] * u + m[1] * v + m[2]) / z - 0.5));
      const fy = Math.min(sh - 1.001, Math.max(0, (m[3] * u + m[4] * v + m[5]) / z - 0.5));
      const x0 = fx | 0;
      const y0 = fy | 0;
      const ax = fx - x0;
      const ay = fy - y0;
      const i00 = (y0 * sw + x0) * 4;
      const i10 = i00 + 4;
      const i01 = i00 + sw * 4;
      const i11 = i01 + 4;
      const o = (y * W + x) * 4;
      for (let c = 0; c < 3; c++) {
        const top = d[i00 + c] + (d[i10 + c] - d[i00 + c]) * ax;
        const bot = d[i01 + c] + (d[i11 + c] - d[i01 + c]) * ax;
        out[o + c] = top + (bot - top) * ay;
      }
      out[o + 3] = 255;
    }
  }
  return { data: out, width: W, height: H };
}

/**
 * Crisp black and white, like a photocopy: each pixel is compared with the brightness around
 * it, so shadows and uneven light don't turn into black patches.
 */
export function blackAndWhite(src: Img, strength = 12): Img {
  const { width: w, height: h } = src;
  const gray = grayOf(src);
  // Running sums for a fast average over a square around each pixel.
  const sum = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += gray[y * w + x];
      sum[(y + 1) * (w + 1) + x + 1] = sum[y * (w + 1) + x + 1] + row;
    }
  }
  const r = Math.max(8, Math.round(Math.min(w, h) / 40));
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r);
    const y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(w, x + r + 1);
      const area = (x1 - x0) * (y1 - y0);
      const s = sum[y1 * (w + 1) + x1] - sum[y0 * (w + 1) + x1] - sum[y1 * (w + 1) + x0] + sum[y0 * (w + 1) + x0];
      const v = gray[y * w + x] < s / area - strength ? 0 : 255;
      const o = (y * w + x) * 4;
      out[o] = out[o + 1] = out[o + 2] = v;
      out[o + 3] = 255;
    }
  }
  return { data: out, width: w, height: h };
}

/** Greys only (softer than black and white, keeps faint print). */
export function greyscale(src: Img): Img {
  const out = new Uint8ClampedArray(src.data.length);
  for (let i = 0; i < out.length; i += 4) {
    const g = lum(src.data, i);
    out[i] = out[i + 1] = out[i + 2] = g;
    out[i + 3] = 255;
  }
  return { data: out, width: src.width, height: src.height };
}

/** Turns the picture a quarter turn clockwise (`turns` times). */
export function rotate(src: Img, turns: number): Img {
  const t = ((turns % 4) + 4) % 4;
  if (!t) return src;
  const { width: w, height: h, data } = src;
  const W = t === 2 ? w : h;
  const H = t === 2 ? h : w;
  const out = new Uint8ClampedArray(data.length);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [nx, ny] = t === 1 ? [h - 1 - y, x] : t === 2 ? [w - 1 - x, h - 1 - y] : [y, w - 1 - x];
      const i = (y * w + x) * 4;
      const o = (ny * W + nx) * 4;
      out[o] = data[i];
      out[o + 1] = data[i + 1];
      out[o + 2] = data[i + 2];
      out[o + 3] = data[i + 3];
    }
  return { data: out, width: W, height: H };
}

/** A copy shrunk so its long side is at most `max` px (nearest pixel: fine for finding the receipt). */
export function shrink(src: Img, max: number): { img: Img; scale: number } {
  const k = Math.min(1, max / Math.max(src.width, src.height));
  if (k === 1) return { img: src, scale: 1 };
  const W = Math.max(1, Math.round(src.width * k));
  const H = Math.max(1, Math.round(src.height * k));
  const out = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    const sy = Math.min(src.height - 1, Math.floor(y / k));
    for (let x = 0; x < W; x++) {
      const sx = Math.min(src.width - 1, Math.floor(x / k));
      const i = (sy * src.width + sx) * 4;
      const o = (y * W + x) * 4;
      out[o] = src.data[i];
      out[o + 1] = src.data[i + 1];
      out[o + 2] = src.data[i + 2];
      out[o + 3] = 255;
    }
  }
  return { img: { data: out, width: W, height: H }, scale: k };
}
