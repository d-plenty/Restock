// 0.12.9: the keyboard opens by itself where you go to type (Add to pantry, Add by hand, a rename).
// The page puts the cursor in the box (autoFocus); Android's WebView doesn't always raise the
// keyboard for a cursor the page placed, so the app asks Android to show it. A box you tapped
// yourself raises it the usual way and is left alone. On the web the browser decides (an iPhone
// only opens it for a tap).
import { RestockNative } from './sql/native';
import { isNative } from '../stores/http';

const TEXT_TYPES = /^(text|search|email|url|tel|password|number|)$/;

/** Whether typing goes into this element. */
export function typesText(el: EventTarget | null): boolean {
  const e = el as HTMLElement | null;
  if (!e || typeof e.tagName !== 'string') return false;
  if (e.tagName === 'TEXTAREA') return !(e as HTMLTextAreaElement).readOnly && !(e as HTMLTextAreaElement).disabled;
  if (e.tagName !== 'INPUT') return false;
  const i = e as HTMLInputElement;
  return TEXT_TYPES.test((i.getAttribute('type') ?? '').toLowerCase()) && !i.readOnly && !i.disabled;
}

/** A cursor the page placed (not a tap on the box itself): the one that needs the keyboard asked for. */
export function placedByPage(focused: EventTarget | null, lastTap: { target: EventTarget | null; at: number }, now: number): boolean {
  if (!typesText(focused)) return false;
  const tapped = lastTap.target as Node | null;
  const onIt = !!tapped && now - lastTap.at < 700 && (tapped === focused || (focused as Node).contains?.(tapped) || (tapped as Node).contains?.(focused as Node));
  return !onIt;
}

/** Asks Android for the keyboard whenever the page puts the cursor in a text box. */
export function wireKeyboard(): () => void {
  if (!isNative()) return () => undefined;
  const lastTap: { target: EventTarget | null; at: number } = { target: null, at: 0 };
  const onDown = (e: Event) => {
    lastTap.target = e.target;
    lastTap.at = Date.now();
  };
  const onFocus = (e: FocusEvent) => {
    if (!placedByPage(e.target, lastTap, Date.now())) return;
    // after the WebView has taken the cursor in
    window.setTimeout(() => {
      if (document.activeElement === e.target) void RestockNative.showKeyboard().catch(() => undefined);
    }, 80);
  };
  document.addEventListener('pointerdown', onDown, true);
  document.addEventListener('focusin', onFocus, true);
  return () => {
    document.removeEventListener('pointerdown', onDown, true);
    document.removeEventListener('focusin', onFocus, true);
  };
}
