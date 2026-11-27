// @vitest-environment jsdom
// 0.18.1: a screen gets its answer even while the database changes all the time (a price check on
// an older iPad saves a price every moment, and each query takes longer than the gap between saves).
// Before, every answer was dropped as already out of date, and the screen stayed black.
import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';

const subs = vi.hoisted(() => new Set<() => void>());
vi.mock('./live', () => ({ onChange: (f: () => void) => (subs.add(f), () => subs.delete(f)) }));
vi.mock('./db', () => ({ getSettings: async () => ({}), cachedSettings: () => undefined }));
vi.mock('./settingsDraft', () => ({ getSettings: async () => ({}), cachedDraftSettings: () => undefined }));
const { useLive } = await import('./useLive');

describe('useLive while the database keeps changing', () => {
  it('shows an answer, and keeps showing newer ones, instead of waiting for a quiet moment', async () => {
    vi.useFakeTimers();
    let n = 0;
    const slow = () => new Promise<number>((r) => setTimeout(() => r(++n), 100));
    function Show() {
      const v = useLive(slow, []);
      return createElement('p', null, v === undefined ? 'blank' : `answer ${v}`);
    }
    render(createElement(Show));
    expect(screen.getByText('blank')).toBeTruthy();
    // A change every 30 ms, for 3 seconds: each query (100 ms) is overtaken by several changes.
    for (let t = 0; t < 100; t++) {
      await act(async () => {
        subs.forEach((f) => f());
        await vi.advanceTimersByTimeAsync(30);
      });
    }
    expect(screen.queryByText('blank')).toBeNull();
    const shown = Number(/answer (\d+)/.exec(document.body.textContent ?? '')?.[1]);
    expect(shown).toBeGreaterThan(3);
    // And it didn't run back to back the whole time: it rested between runs.
    expect(n).toBeLessThan(20);
    vi.useRealTimers();
  });
});
