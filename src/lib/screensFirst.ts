// 0.18.1: screens first. While a screen is reading what it shows (useLive), background work (a price
// check on the iPhone and iPad, where it runs in the app itself, and the iPhone's sync rounds) waits
// for it, so on an older iPad a page opens straight away instead of queueing behind the check. The
// wait is short (a second and a half at most), so the work always carries on.

let reading = 0;
let waiters: (() => void)[] = [];

/** A screen started reading (call the function it returns when it has its answer). */
export function screenReading(): () => void {
  reading++;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    reading = Math.max(0, reading - 1);
    if (reading === 0) {
      const w = waiters;
      waiters = [];
      w.forEach((f) => f());
    }
  };
}

/** How many screens are reading right now. */
export const screensReading = (): number => reading;

/**
 * Background work calls this between steps: it lets the phone draw (a pause of `restMs`), and while
 * a screen is reading, waits for it (at most `maxMs`).
 */
export async function screensFirst(restMs = 0, maxMs = 1500): Promise<void> {
  await new Promise((r) => setTimeout(r, restMs));
  if (reading === 0) return;
  await new Promise<void>((resolve) => {
    const t = setTimeout(() => {
      waiters = waiters.filter((f) => f !== go);
      resolve();
    }, maxMs);
    const go = () => {
      clearTimeout(t);
      resolve();
    };
    waiters.push(go);
  });
}

// 0.18.1: when Restock opens, the screens come first: the one showing gets its answer and the others'
// code is loaded (ui/lazyScreen.ts preloadScreens) before the first sync and the price catch-up start.
let settled: (() => void) | undefined;
const settledOnce = new Promise<void>((r) => (settled = r));
/** The screens are ready (App.tsx calls it once the others are loaded). */
export const screensReady = (): void => settled?.();
/** Background work at start-up waits for the screens (at most `maxMs`), then for any screen still reading. */
export async function afterScreens(maxMs = 8000): Promise<void> {
  await Promise.race([settledOnce, new Promise((r) => setTimeout(r, maxMs))]);
  await screensFirst(0);
}
