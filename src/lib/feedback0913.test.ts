import { beforeEach, describe, expect, it, vi } from 'vitest';

const kv = new Map<string, unknown>();
vi.mock('./db', () => ({
  getKV: async (k: string) => kv.get(k),
  putKV: async (k: string, v: unknown) => void kv.set(k, v),
  getSettings: async () => ({}),
  marketStatus: async () => ({ count: 0, byChain: {} }),
  uid: () => 'install-1',
}));
vi.mock('./diagnostics', () => ({ problems: async () => [] }));
vi.mock('../stores/http', () => ({ isNative: () => false }));
vi.mock('../server-mode/flag', () => ({ serverMode: false }));

import { makeMessage, sendFeedback, sendWaiting, waitingCount, withoutSecrets } from './feedback';

const reply = (status: number, body: unknown = {}) => async () => new Response(JSON.stringify(body), { status });
const offline = async () => {
  throw new TypeError('Failed to fetch');
};

describe('0.9.13 feedback', () => {
  beforeEach(() => kv.clear());

  it('takes passwords, keys and tokens out of what it sends', () => {
    expect(withoutSecrets({ a: 1, helperKey: 'x', nested: { passphrase: 'y', token: 'z', ok: 'fine' } })).toEqual({
      a: 1,
      helperKey: '(removed)',
      nested: { passphrase: '(removed)', token: '(removed)', ok: 'fine' },
    });
  });

  it("makes a message in the collector's format, without diagnostics when they're off", async () => {
    const m = await makeMessage({ kind: 'idea', message: '  More shops  ', email: ' ', withDiagnostics: false, screenshots: [] });
    expect(m).toMatchObject({ format: 'restock-feedback', install: 'install-1', kind: 'idea', message: 'More shops', platform: 'web' });
    expect(m.email).toBeUndefined();
    expect(m.diagnostics).toBeUndefined();
  });

  it('keeps it for later with no connection, and sends it then', async () => {
    const m = await makeMessage({ kind: 'wrong', message: 'Broken', withDiagnostics: true, screenshots: [] });
    expect(m.diagnostics).toBeDefined();
    expect(await sendFeedback(m, offline as unknown as typeof fetch)).toBe('kept');
    expect(await waitingCount()).toBe(1);
    expect(await sendWaiting(offline as unknown as typeof fetch)).toBe(0);
    expect(await waitingCount()).toBe(1);
    expect(await sendWaiting(reply(200, { ok: true }) as unknown as typeof fetch)).toBe(1);
    expect(await waitingCount()).toBe(0);
  });

  it("says why when the server won't take it", async () => {
    const m = await makeMessage({ kind: 'other', message: 'Hi', withDiagnostics: false, screenshots: [] });
    await expect(sendFeedback(m, reply(429, { error: 'That’s a lot of feedback today' }) as unknown as typeof fetch)).rejects.toThrow(/a lot of feedback/);
    expect(await waitingCount()).toBe(0);
    expect(await sendFeedback(m, reply(200, { ok: true, id: 'x' }) as unknown as typeof fetch)).toBe('sent');
  });
});
