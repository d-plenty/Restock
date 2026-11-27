// 0.18.1: a long list comes in parts: the first rows, then the next lot as you scroll near the end
// (or tap Show more), so an older phone draws a screen's worth at a time instead of hundreds of rows
// at once. 0.18.2: in both designs (it was Simple only): 50 at a time, 40 with Simple.
import { useEffect, useRef, useState } from 'react';
import { isLite } from '../lib/simple';

export const CHUNK = 50;

export function useChunks(stepAsked?: number): { limit: number; more: (total: number) => React.ReactNode } {
  const step = stepAsked ?? (isLite() ? 40 : CHUNK);
  const [limit, setLimit] = useState(step);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = end.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((seen) => seen.some((s) => s.isIntersecting) && setLimit((l) => l + step), { rootMargin: '400px' });
    io.observe(el);
    return () => io.disconnect();
  });
  const more = (total: number) =>
    total > limit ? (
      <div ref={end} className="chunk-more">
        <button type="button" className="btn small" onClick={() => setLimit((l) => l + step)}>
          Show {Math.min(step, total - limit)} more
        </button>
      </div>
    ) : null;
  return { limit, more };
}

/** Sections cut to `limit` rows in all (the empty ones left out once the limit's reached). */
export function chunkSections<T extends { items: unknown[] }>(sections: T[], limit: number): T[] {
  if (!Number.isFinite(limit)) return sections;
  let left = limit;
  const out: T[] = [];
  for (const s of sections) {
    if (left <= 0) break;
    out.push(s.items.length > left ? { ...s, items: s.items.slice(0, left) } : s);
    left -= s.items.length;
  }
  return out;
}
