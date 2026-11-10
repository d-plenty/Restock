// 0.9.5 (look): the Undo message (the toast) never sits over a bar at the bottom of the screen: the
// tab bar, Start shopping, the Save bar, the Add tab's "ticked · tap to add" bar or the select bar.
// Those bars change height with the text size and come and go, so rather than guess, the toast is
// lifted to just above the highest one showing. The web's wide layout puts its toast in a corner
// and has no such bars, so it's left alone there.

/** The bars a toast must clear. */
export const BOTTOM_BARS = '.sticky-cta, .save-bar, .selectbar, .add-mini, nav.tabs, .setup-foot.sticky';

export type Box = { top: number; bottom: number; left: number; right: number };

/**
 * How far above the window's bottom edge (in screen pixels) the toast's bottom should sit: a gap
 * above the highest bar in the bottom part of the window, or `fallback` with no bar there.
 * Bars that are scrolled away (not touching the lower 45% of the window) don't count.
 */
export function liftFor(bars: Box[], windowHeight: number, fallback: number, gap = 8): number {
  const low = bars.filter((b) => b.bottom > b.top && b.bottom > windowHeight * 0.55 && b.top < windowHeight);
  if (!low.length) return fallback;
  const top = Math.min(...low.map((b) => b.top));
  return Math.max(fallback, Math.round(windowHeight - top + gap));
}

/** The visible bars on the page now (a screen pushed over the tabs hides them). */
export function visibleBars(doc: Document = document): Box[] {
  const overlays = [...doc.querySelectorAll<HTMLElement>('.overlay')];
  return [...doc.querySelectorAll<HTMLElement>(BOTTOM_BARS)]
    .filter((el) => {
      const st = getComputedStyle(el);
      if (st.display === 'none' || st.visibility === 'hidden') return false;
      if (el.matches('nav.tabs') && overlays.some((o) => !o.contains(el))) return false;
      return true;
    })
    .map((el) => el.getBoundingClientRect());
}

/** Sets the toast's `bottom` (in its own CSS pixels, so zoomed text sizes come out right). */
export function placeToast(toast: HTMLElement | null): void {
  if (!toast || document.documentElement.classList.contains('server-desk')) return;
  const rect = toast.getBoundingClientRect();
  const cssBottom = parseFloat(getComputedStyle(toast).bottom) || 0;
  // Where the style sheet puts it (above the tabs and the phone's own bar): never lower than that.
  if (toast.dataset.baseBottom === undefined) toast.dataset.baseBottom = String(cssBottom);
  const base = parseFloat(toast.dataset.baseBottom) || 0;
  // Screen pixels per CSS pixel of the toast (its layer is zoomed with the text size).
  const zoom = toast.offsetHeight ? rect.height / toast.offsetHeight : 1;
  const inset = window.innerHeight - rect.bottom - cssBottom * zoom;
  const lift = liftFor(visibleBars(), window.innerHeight, base * zoom + Math.max(0, inset));
  const want = Math.max(0, (lift - Math.max(0, inset)) / zoom);
  if (Math.abs(want - cssBottom) > 1) toast.style.bottom = `${Math.round(want)}px`;
}
