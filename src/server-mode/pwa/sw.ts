// 0.9.5: the web app's service worker (built to sw.js at the app's root by vite.server.config.ts).
// It keeps the app shell so the web app opens with no connection (on an iPhone's home screen, say),
// and nothing else: answers from /api/ are never cached here. The rules are in swCore.ts.
//
// Updates: a new build is a new worker with a new shell. It waits until the page says to take over
// ("A new version is ready · Reload"), then deletes the old shell.
import { cacheName, routeOf, SHELL_MARKER, staleCaches, type ShellManifest } from './swCore';

// Just the parts of the worker's global scope used here (the project's types are for pages).
interface ExtendableEvent extends Event {
  waitUntil(p: Promise<unknown>): void;
}
interface FetchEvent extends ExtendableEvent {
  request: Request;
  respondWith(r: Response | Promise<Response>): void;
}
interface MessageEventLike extends ExtendableEvent {
  data: unknown;
  source?: { postMessage(m: unknown): void } | null;
}
interface WorkerScope {
  registration: { scope: string };
  skipWaiting(): Promise<void>;
  clients: { claim(): Promise<void> };
  addEventListener(type: 'install' | 'activate', fn: (e: ExtendableEvent) => void): void;
  addEventListener(type: 'fetch', fn: (e: FetchEvent) => void): void;
  addEventListener(type: 'message', fn: (e: MessageEventLike) => void): void;
}

const sw = self as unknown as WorkerScope;
// Swapped for the real list by the build. (A string, so minifying can't change it.)
const SHELL: ShellManifest = JSON.parse(SHELL_MARKER) as ShellManifest;
const CACHE = cacheName(SHELL.build);
const FILES = new Set(SHELL.files);
const PAGE = 'index.html';
/** How long the page waits for the server before showing the kept copy. */
const PAGE_WAIT_MS = 4000;

const at = (rel: string) => new URL(rel, sw.registration.scope).href;

sw.addEventListener('install', (e) => {
  e.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // cache: 'reload' skips the browser's own cache, so the shell is exactly this build's files.
      await cache.addAll(SHELL.files.map((f) => new Request(at(f), { cache: 'reload', credentials: 'same-origin' })));
    })(),
  );
});

sw.addEventListener('activate', (e) => {
  e.waitUntil(
    (async () => {
      for (const n of staleCaches(await caches.keys(), SHELL.build)) await caches.delete(n);
      await sw.clients.claim();
    })(),
  );
});

sw.addEventListener('message', (e) => {
  const d = e.data as { type?: string } | null;
  if (d?.type === 'skip-waiting') void sw.skipWaiting();
  if (d?.type === 'shell') e.source?.postMessage({ type: 'shell', build: SHELL.build, files: SHELL.files });
});

async function page(req: Request): Promise<Response> {
  const kept = () => caches.open(CACHE).then((c) => c.match(at(PAGE)));
  try {
    const net = fetch(req);
    net.catch(() => undefined); // a late failure after the kept page was shown isn't an error
    const timeout = new Promise<undefined>((ok) => setTimeout(() => ok(undefined), PAGE_WAIT_MS));
    const first = await Promise.race([net, timeout]);
    if (first) return first;
    // Slow: the kept page if there is one, else keep waiting for the server.
    return (await kept()) ?? (await net);
  } catch {
    const k = await kept();
    if (k) return k;
    throw new Error('offline');
  }
}

async function shellFile(req: Request): Promise<Response> {
  const hit = await caches.open(CACHE).then((c) => c.match(req));
  return hit ?? fetch(req);
}

sw.addEventListener('fetch', (e) => {
  const req = e.request;
  const route = routeOf(req.method, req.url, sw.registration.scope, req.mode === 'navigate', FILES);
  if (route === 'bypass') return;
  e.respondWith(route === 'page' ? page(req) : shellFile(req));
});
