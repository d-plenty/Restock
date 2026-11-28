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

// 0.19.0: a read that never answers, or fails every time, used to keep its screen on "Loading…" for
// good and say nothing. Now it's tried again, and what's waited for (and why) can be shown.
describe('useLive when a read never answers or keeps failing', () => {
  it('gives up on a read with no answer and tries again; the screen gets the next answer', async () => {
    vi.useFakeTimers();
    const { waitingReport, resetWaiting, nameReads } = await import('./waiting');
    resetWaiting();
    let calls = 0;
    nameReads([[yourItems, 'your items']]);
    function yourItems(): Promise<string> {
      calls++;
      return calls === 1 ? new Promise<string>(() => undefined) : Promise.resolve('here');
    }
    function Show() {
      const v = useLive(yourItems, []);
      return createElement('p', null, v ?? 'blank');
    }
    render(createElement(Show));
    await act(async () => void (await vi.advanceTimersByTimeAsync(10_000)));
    expect(screen.getByText('blank')).toBeTruthy();
    // Meanwhile it's known what the screen waits for, and for how long.
    expect(waitingReport().join('\n')).toMatch(/Waiting for: your items, 10 s/);
    await act(async () => void (await vi.advanceTimersByTimeAsync(12_000)));
    expect(calls).toBe(2);
    expect(screen.getByText('here')).toBeTruthy();
    expect(waitingReport()).toEqual([]);
    vi.useRealTimers();
  });

  it('says what went wrong while it keeps trying, and shows the answer once one comes', async () => {
    vi.useFakeTimers();
    const { waitingReport, resetWaiting } = await import('./waiting');
    resetWaiting();
    let calls = 0;
    function yourList(): Promise<string> {
      calls++;
      return calls < 4 ? Promise.reject(new Error('SQL query failed: no such column: x')) : Promise.resolve('the list');
    }
    function Show() {
      const v = useLive(yourList, []);
      return createElement('p', null, v ?? 'blank');
    }
    render(createElement(Show));
    await act(async () => void (await vi.advanceTimersByTimeAsync(1500)));
    expect(calls).toBe(2);
    expect(waitingReport().join('\n')).toMatch(/Waiting for: part of this screen, .*failed 2×\. Last problem: SQL query failed: no such column: x/);
    await act(async () => void (await vi.advanceTimersByTimeAsync(8000)));
    expect(screen.getByText('the list')).toBeTruthy();
    expect(waitingReport()).toEqual([]);
    vi.useRealTimers();
  });

  it('an answer that comes late from a read already given up on still shows', async () => {
    vi.useFakeTimers();
    let first: ((v: string) => void) | undefined;
    let calls = 0;
    function slowItems(): Promise<string> {
      calls++;
      return calls === 1 ? new Promise<string>((r) => (first = r)) : new Promise<string>(() => undefined);
    }
    function Show() {
      const v = useLive(slowItems, []);
      return createElement('p', null, v ?? 'blank');
    }
    render(createElement(Show));
    await act(async () => void (await vi.advanceTimersByTimeAsync(22_000)));
    expect(calls).toBe(2);
    await act(async () => {
      first?.('late but right');
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(screen.getByText('late but right')).toBeTruthy();
    vi.useRealTimers();
  });
});
