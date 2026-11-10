// 0.9.2 security review: what the web app leaves behind in the browser.
import { afterEach, describe, expect, it } from 'vitest';
import { localCopyStore } from './live';
import type { Session } from './session';

const session = (more: Partial<Session> = {}): Session => ({ user: 'admin', webId: 'webAAAAAAAA', webPriv: 'x', webPub: 'y', keys: { '1': 'k' }, ...more });

/** A stand-in IndexedDB that only notes which databases were opened. */
function fakeIdb() {
  const opened: string[] = [];
  (globalThis as { indexedDB?: unknown }).indexedDB = {
    open(name: string) {
      opened.push(name);
      const req: Record<string, unknown> = {};
      setTimeout(() => (req.onerror as (() => void) | undefined)?.(), 0);
      return req;
    },
  };
  return opened;
}

afterEach(() => {
  delete (globalThis as { indexedDB?: unknown }).indexedDB;
});

describe('the local copy of the household', () => {
  it('a passphrase browser keeps it in IndexedDB, per web id', async () => {
    const opened = fakeIdb();
    const st = localCopyStore(session());
    await st.restore();
    await st.persist(new Uint8Array([1]));
    expect(opened).toEqual(['restock-server-webAAAAAAAA', 'restock-server-webAAAAAAAA']);
  });

  it('a tab signed in with a phone keeps nothing (it says it forgets the household when it closes)', async () => {
    const opened = fakeIdb();
    const st = localCopyStore(session({ viaPhone: true, webPriv: '' }));
    expect(await st.restore()).toBeUndefined();
    await st.persist(new Uint8Array([1, 2, 3]));
    expect(opened).toEqual([]);
  });

  it('0.9.4, a house: a passphrase session keeps its copy per web id; one signed in with a phone keeps nothing', async () => {
    const opened = fakeIdb();
    await localCopyStore(session({ v: 3, webId: 'w3web', webPriv: '', webPub: '', sid: 's', sessionKey: 'k' })).persist(new Uint8Array([1]));
    await localCopyStore(session({ v: 3, webId: 'w3web', webPriv: '', webPub: '', viaPhone: true })).persist(new Uint8Array([1]));
    expect(opened).toEqual(['restock-server-w3web']);
  });
});
