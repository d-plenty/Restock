import { useEffect, useState } from 'react';

/**
 * The time now, for what a screen shows ("checked 3 days ago", "2 min ago"). It ticks every `ms`
 * (20 s unless said), so what it shows moves on by itself. 0.15.1: a screen reads the clock here,
 * not while it draws (React may draw a screen more than once, and each draw should look the same).
 */
export function useNow(ms = 20_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}
