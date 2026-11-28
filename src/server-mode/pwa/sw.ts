/// <reference lib="webworker" />
// 0.19.0: the server's page keeps no copy of itself in the browser any more. It needs the server for
// everything it does, and a kept copy could show an older page after the server was updated. This
// worker replaces the one browsers already have (same address, sw.js): it deletes the kept copies,
// takes itself off, and reloads the open pages so they come straight from the server.
declare const self: ServiceWorkerGlobalScope;

self.addEventListener('install', () => void self.skipWaiting());
self.addEventListener('activate', (e) =>
  e.waitUntil(
    (async () => {
      for (const k of await caches.keys()) await caches.delete(k);
      await self.registration.unregister();
      for (const c of await self.clients.matchAll({ type: 'window' })) void c.navigate(c.url).catch(() => undefined);
    })(),
  ),
);
export {};
