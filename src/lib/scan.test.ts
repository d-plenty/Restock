import { describe, expect, it } from 'vitest';
import { blackAndWhite, findPaper, otsu, rotate, warp, type Img, type Quad } from './scan';

/** A dark table with a pale, slightly turned receipt on it. */
function photo(): { img: Img; quad: Quad } {
  const w = 300;
  const h = 400;
  const quad: Quad = [
    { x: 90, y: 40 },
    { x: 220, y: 55 },
    { x: 200, y: 360 },
    { x: 70, y: 345 },
  ];
  const data = new Uint8ClampedArray(w * h * 4);
  const inside = (x: number, y: number) => {
    // Point in convex polygon: same side of every edge.
    let sign = 0;
    for (let i = 0; i < 4; i++) {
      const a = quad[i];
      const b = quad[(i + 1) % 4];
      const c = (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x);
      if (c !== 0) {
        if (sign && Math.sign(c) !== sign) return false;
        sign = Math.sign(c);
      }
    }
    return true;
  };
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const v = inside(x + 0.5, y + 0.5) ? 235 : 60 + ((x * 7 + y * 3) % 25);
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v - 5;
      data[i + 3] = 255;
    }
  return { img: { data, width: w, height: h }, quad };
}

describe('receipt scanner', () => {
  it('finds the receipt’s four corners', () => {
    const { img, quad } = photo();
    const found = findPaper(img)!;
    expect(found).toBeDefined();
    found.forEach((p, i) => {
      expect(Math.abs(p.x - quad[i].x)).toBeLessThan(4);
      expect(Math.abs(p.y - quad[i].y)).toBeLessThan(4);
    });
  });

  it('gives up on a plain picture', () => {
    const data = new Uint8ClampedArray(100 * 100 * 4).fill(128);
    expect(findPaper({ data, width: 100, height: 100 })).toBeUndefined();
  });

  it('straightens it into a pale rectangle of the right shape', () => {
    const { img, quad } = photo();
    const flat = warp(img, quad);
    expect(flat.height / flat.width).toBeGreaterThan(2);
    let pale = 0;
    for (let i = 0; i < flat.data.length; i += 4) if (flat.data[i] > 200) pale++;
    expect(pale / (flat.width * flat.height)).toBeGreaterThan(0.95);
  });

  it('turns and makes black and white', () => {
    const { img } = photo();
    const r = rotate(img, 1);
    expect([r.width, r.height]).toEqual([400, 300]);
    expect(rotate(rotate(img, 2), 2).data).toEqual(img.data);
    const bw = blackAndWhite(img);
    expect(new Set(Array.from(bw.data.filter((_, i) => i % 4 === 0)))).toEqual(new Set([0, 255]));
    expect(otsu(new Uint8Array([10, 10, 10, 200, 200, 200]))).toBeGreaterThanOrEqual(10);
  });
});
