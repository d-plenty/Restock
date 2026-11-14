import { beforeEach, describe, expect, it, vi } from 'vitest';

// No browser here: a small stand-in for this phone's storage.
const box = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => box.get(k) ?? null,
  setItem: (k: string, v: string) => void box.set(k, v),
  removeItem: (k: string) => void box.delete(k),
  clear: () => box.clear(),
});

describe('0.10.10 removing barcodes you no longer need', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });
  it('removes one, or all still to match, and Undo puts them back in order', async () => {
    const q = await import('./scanQueue');
    vi.useFakeTimers();
    for (const [i, code] of ['111', '222', '333'].entries()) {
      vi.setSystemTime(new Date(2026, 10, 14, 10, i));
      q.addScanLine({ code, name: `Barcode ${code}`, status: 'new' });
    }
    vi.setSystemTime(new Date(2026, 10, 14, 10, 5));
    q.addScanLine({ code: '444', name: 'Milk', status: 'added', groupId: 'g1' });
    vi.useRealTimers();
    const gone = q.removeWaiting(['222']);
    expect(gone.map((l) => l.code)).toEqual(['222']);
    expect(q.scanLines().map((l) => l.code)).toEqual(['444', '333', '111']);
    q.putBack(gone);
    expect(q.scanLines().map((l) => l.code)).toEqual(['444', '333', '222', '111']);
    q.putBack(gone);
    expect(q.scanLines()).toHaveLength(4);
    const all = q.removeWaiting();
    expect(all).toHaveLength(3);
    expect(q.scanLines().map((l) => l.code)).toEqual(['444']);
    expect(q.toMatch()).toBe(0);
    q.putBack(all);
    expect(q.toMatch()).toBe(3);
    expect(JSON.parse(localStorage.getItem('restock.scanQueue')!)).toHaveLength(4);
  });
});
