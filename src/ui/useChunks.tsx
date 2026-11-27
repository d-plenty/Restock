// 0.18.1: with the Simple design (lib/simple.ts isLite), a long list comes in parts: the first 40
// rows, then the next 40 as you scroll to the end (or tap Show more), so an older phone draws a
// screen's worth at a time instead of hundreds of rows at once. Otherwise everything shows.
import { useEffect, useRef, useState } from 'react';
import { isLite } from '../lib/simple';

export const CHUNK = 40;

export function useChunks(step = CHUNK): { limit: number; more: (total: number) => React.ReactNode } {
  const lite = isLite();
  const [limit, setLimit] = useState(step);
  const end = useRef<HTMLDivElement>(null);
  const shown = lite ? limit : Infinity;
  useEffect(() => {
    const el = end.current;
    if (!lite || !el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((seen) => seen.some((s) => s.isIntersecting) && setLimit((l) => l + step), { rootMargin: '400px' });
    io.observe(el);
    return () => io.disconnect();
  });
  const more = (total: number) =>
    lite && total > limit ? (
      <div ref={end} className="chunk-more">
        <button type="button" className="btn small" onClick={() => setLimit((l) => l + step)}>
          Show {Math.min(step, total - limit)} more
        </button>
      </div>
    ) : null;
  return { limit: shown, more };
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
