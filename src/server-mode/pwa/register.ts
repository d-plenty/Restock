// 0.9.5: the page's side of the service worker: register it (built pages on https or localhost
// only), and notice a new version waiting ("A new version is ready · Reload").
import { useSyncExternalStore } from 'react';
import { sameVersion, shellPath, SW_FILE } from './swCore';

let waiting: ServiceWorker | undefined;
const listeners = new Set<() => void>();
const tell = () => listeners.forEach((f) => f());
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

/** Is a new version waiting to take over? */
export function useUpdateWaiting(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => !!waiting,
    () => false,
  );
}

/** The scripts this page started with, as shell paths. */
function pageScripts(scope: string): string[] {
  return [...document.querySelectorAll<HTMLScriptElement>('script[type="module"][src]')]
    .map((s) => shellPath(s.src, scope))
    .filter((s): s is string => !!s);
}

/** Asks a waiting worker what it holds: the same build as this page takes over quietly. */
function consider(w: ServiceWorker, scope: string) {
  let answered = false;
  const onAnswer = (e: MessageEvent) => {
    const d = e.data as { type?: string; files?: string[] } | null;
    if (d?.type !== 'shell' || answered) return;
    answered = true;
    navigator.serviceWorker.removeEventListener('message', onAnswer);
    if (Array.isArray(d.files) && sameVersion(pageScripts(scope), d.files)) w.postMessage({ type: 'skip-waiting' });
    else {
      waiting = w;
      tell();
    }
  };
  // The worker answers the page that asked (e.source in the worker).
  navigator.serviceWorker.addEventListener('message', onAnswer);
  w.postMessage({ type: 'shell' });
  // No answer (an older worker): offer the reload.
  setTimeout(() => {
    if (answered) return;
    answered = true;
    navigator.serviceWorker.removeEventListener('message', onAnswer);
    waiting = w;
    tell();
  }, 3000);
}

/** Take the new version: the waiting worker takes over and the page reloads on it. */
export function applyUpdate(): void {
  const w = waiting;
  if (!w) return location.reload();
  let done = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (done) return;
    done = true;
    location.reload();
  });
  w.postMessage({ type: 'skip-waiting' });
  // If the switch is slow, reload anyway.
  setTimeout(() => !done && location.reload(), 3000);
}

/** Can this page have a service worker? (https, or localhost while testing.) */
export const canUseWorker = () => typeof navigator !== 'undefined' && 'serviceWorker' in navigator && typeof window !== 'undefined' && window.isSecureContext;

/** Registers the worker once the page has loaded. Built pages only (the dev server has no sw.js). */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || !canUseWorker()) return;
  const go = async () => {
    try {
      const reg = await navigator.serviceWorker.register(`./${SW_FILE}`, { scope: './', updateViaCache: 'none' });
      const watch = (w: ServiceWorker | null) => {
        if (!w) return;
        const check = () => {
          // "installed" with a controller already: an update, waiting its turn.
          if (w.state === 'installed' && navigator.serviceWorker.controller) consider(w, reg.scope);
        };
        w.addEventListener('statechange', check);
        check();
      };
      watch(reg.waiting);
      reg.addEventListener('updatefound', () => watch(reg.installing));
      // Look for a new version when the app comes back to the front (iPhones keep it running).
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') void reg.update().catch(() => undefined);
      });
    } catch {
      // Not allowed here (a private window, say): the app works, just not offline.
    }
  };
  if (document.readyState === 'complete') void go();
  else window.addEventListener('load', () => void go(), { once: true });
}
