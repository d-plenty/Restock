// 0.18.3: the page before this one kept a copy of the household in the browser (its lists, prices,
// receipts and loyalty cards) for the shopping screens. This page keeps none, so the first time it
// opens, those copies are deleted from this browser: nothing of the household is left behind on a
// shared computer. Done once (restock-server-tidied).
const DONE = 'restock-server-tidied';
const OLD_KEYS = ['restock-server-webid', 'restock-pwa-server', 'restock-cards-places'];

export async function tidyOldCopies(): Promise<number> {
  try {
    if (localStorage.getItem(DONE)) return 0;
  } catch {
    return 0;
  }
  let gone = 0;
  const drop = (name: string) =>
    new Promise<void>((res) => {
      try {
        const r = indexedDB.deleteDatabase(name);
        r.onsuccess = () => {
          gone++;
          res();
        };
        r.onerror = r.onblocked = () => res();
      } catch {
        res();
      }
    });
  try {
    const all = (await indexedDB.databases?.()) ?? [];
    for (const d of all) if (d.name && /^restock-(server-|cards)/.test(d.name)) await drop(d.name);
    if (!all.length) {
      // No list of them in this browser: the one the old page named.
      const webId = localStorage.getItem('restock-server-webid');
      if (webId) await drop(`restock-server-${webId}`);
      await drop('restock-cards');
    }
    for (const k of OLD_KEYS) localStorage.removeItem(k);
    localStorage.setItem(DONE, '1');
  } catch {
    // tried again next time
  }
  return gone;
}

/**
 * 0.19.0: the page keeps no copy of itself in the browser now (pwa/sw.ts takes the old worker off):
 * this takes off any worker and kept copy from the page's own side too, every time it opens.
 */
export async function retireServiceWorker(): Promise<void> {
  try {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister();
    if (typeof caches !== 'undefined') for (const k of await caches.keys()) if (k.startsWith('restock-')) await caches.delete(k);
  } catch {
    // a private window may refuse: nothing was kept there anyway
  }
}
