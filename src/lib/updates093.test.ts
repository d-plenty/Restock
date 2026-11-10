import { afterEach, describe, expect, it, vi } from 'vitest';

// 0.9.3: when the release's APK was replaced after the last check, ask GitHub once more.

const MISMATCH = "The download didn't match what GitHub published, so it wasn't installed. Try again later.";
const calls: { url: string; sha256?: string }[] = [];
let good = '';
vi.mock('./sql/native', () => ({
  RestockNative: {
    installUpdate: async (o: { url: string; sha256?: string }) => {
      calls.push(o);
      if (o.sha256 !== good) throw new Error(MISMATCH);
      return { started: true };
    },
  },
}));
vi.mock('../stores/http', () => ({ isNative: () => true }));

const OLD = 'a'.repeat(64);
const NEW = 'b'.repeat(64);
const URL = 'https://github.com/d-plenty/Restock/releases/download/v0.9.3/restock.apk';
const latest = (digest: string) => ({
  tag_name: 'v0.9.3',
  html_url: 'https://github.com/d-plenty/Restock/releases/tag/v0.9.3',
  body: 'notes',
  assets: [{ name: 'restock.apk', browser_download_url: URL, digest: `sha256:${digest}` }],
});

afterEach(() => {
  calls.length = 0;
  vi.unstubAllGlobals();
});

describe('a release whose APK changed since the check', () => {
  it('asks GitHub again once and installs with the new SHA-256', async () => {
    const { installUpdate } = await import('./updates');
    good = NEW;
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify(latest(NEW)), { status: 200 }));
    await expect(installUpdate(URL, OLD)).resolves.toBe('started');
    expect(calls.map((c) => c.sha256)).toEqual([OLD, NEW]);
  });
  it('still refuses when GitHub says the same, or the file still does not match', async () => {
    const { installUpdate } = await import('./updates');
    good = 'c'.repeat(64);
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify(latest(OLD)), { status: 200 }));
    await expect(installUpdate(URL, OLD)).rejects.toThrow(/didn't match/);
    expect(calls).toHaveLength(1);
    calls.length = 0;
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify(latest(NEW)), { status: 200 }));
    await expect(installUpdate(URL, OLD)).rejects.toThrow(/didn't match/);
    expect(calls.map((c) => c.sha256)).toEqual([OLD, NEW]);
  });
  it("doesn't retry other errors or a different APK address", async () => {
    const { installUpdate } = await import('./updates');
    good = NEW;
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ ...latest(NEW), assets: [{ name: 'restock.apk', browser_download_url: URL + 'x', digest: `sha256:${NEW}` }] }), { status: 200 }));
    await expect(installUpdate(URL, OLD)).rejects.toThrow(/didn't match/);
    expect(calls).toHaveLength(1);
  });
});

describe('0.9.3: how often update checks run', () => {
  it('every 24 hours by default, every 7 days when chosen', async () => {
    const { weeklyCheckDue } = await import('./updates');
    const now = Date.parse('2026-11-10T00:00:00Z');
    const twoDays = '2026-11-08T00:00:00Z';
    expect(weeklyCheckDue({ notify: true, lastCheck: twoDays }, now)).toBe(true);
    expect(weeklyCheckDue({ notify: true, lastCheck: '2026-11-09T12:00:00Z' }, now)).toBe(false);
    expect(weeklyCheckDue({ notify: true, lastCheck: twoDays, everyDays: 7 }, now)).toBe(false);
    expect(weeklyCheckDue({ notify: true, lastCheck: '2026-11-02T00:00:00Z', everyDays: 7 }, now)).toBe(true);
    expect(weeklyCheckDue({ notify: false }, now)).toBe(false);
  });
});
