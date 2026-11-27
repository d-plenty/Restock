// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { EVENT_MS, FADE_MS, lessMotion, Opening, OPENING_MS, openingPlayed, resetOpening } from './Opening';

// 0.16.0: the opening animation (Opening.tsx).
beforeEach(() => {
  resetOpening();
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('the opening animation', () => {
  test('plays once a start, then hands over', () => {
    const done = vi.fn();
    expect(openingPlayed()).toBe(false);
    render(<Opening onDone={done} />);
    expect(screen.getByText('Restock')).toBeTruthy();
    expect(screen.getByText('Half price? Prove it.')).toBeTruthy();
    expect(openingPlayed()).toBe(true);
    // 0.18.0: 2.5 seconds in all for the usual one (3.5 for a holiday), the fade included.
    expect(OPENING_MS + FADE_MS).toBe(2500);
    expect(EVENT_MS + FADE_MS).toBe(3500);
    act(() => void vi.advanceTimersByTime(OPENING_MS + FADE_MS - 1));
    expect(done).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(2));
    expect(done).toHaveBeenCalledTimes(1);
  });

  test('a tap ends it early, and there are no words asking for one', () => {
    const done = vi.fn();
    render(<Opening onDone={done} />);
    expect(screen.queryByText(/tap to skip/i)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /restock is starting/i }));
    act(() => void vi.advanceTimersByTime(260));
    expect(done).toHaveBeenCalledTimes(1);
  });

  test("each holiday has its own words", () => {
    for (const [h, words] of [
      ['christmas', 'Merry Christmas'],
      ['newyear', 'Happy New Year'],
      ['halloween', 'Happy Halloween'],
      ['easter', 'Happy Easter'],
      ['australia', 'Happy Australia Day'],
    ] as const) {
      const { unmount, container } = render(<Opening holiday={h} onDone={() => undefined} />);
      expect(screen.getByText(words)).toBeTruthy();
      expect(container.querySelector(`.op-${h}`)).toBeTruthy();
      unmount();
    }
  });

  test('day in light mode and night in dark mode, and the big pictures load when they play', async () => {
    vi.useRealTimers();
    const { container, unmount } = render(<Opening holiday="christmas" look="day" onDone={() => undefined} />);
    expect(container.querySelector('.op-day')).toBeTruthy();
    await screen.findByText('Merry Christmas');
    await vi.waitFor(() => expect(container.querySelector('.op-picture svg')).toBeTruthy());
    unmount();
    const night = render(<Opening holiday="easter" look="night" onDone={() => undefined} />);
    expect(night.container.querySelector('.op-easter.op-night .op-firefly')).toBeTruthy();
    night.unmount();
  });

  test('with less motion, a still picture for the same time', () => {
    expect(lessMotion(true)).toBe(true);
    const done = vi.fn();
    const { container } = render(<Opening holiday="halloween" still onDone={done} />);
    expect(container.querySelector('.opening.op-still')).toBeTruthy();
    act(() => void vi.advanceTimersByTime(EVENT_MS + FADE_MS));
    expect(done).toHaveBeenCalledTimes(1);
  });

  test('the usual one is the same, day and night', () => {
    const { container } = render(<Opening look="day" onDone={() => undefined} />);
    expect(container.querySelector('.op-none.op-night')).toBeTruthy();
    expect(screen.getByText('Half price? Prove it.')).toBeTruthy();
  });
});
