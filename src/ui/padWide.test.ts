// @vitest-environment jsdom
// 0.17.0: an Android tablet gets the same side bar as an iPad (ui/padWide.ts), from 1000 px wide.
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

const platform = { name: 'web' };
vi.mock('@capacitor/core', () => ({ Capacitor: { getPlatform: () => platform.name, isNativePlatform: () => platform.name !== 'web' } }));
vi.mock('../lib/platform', () => ({ isIos: () => platform.name === 'ios' }));

let width = 1280;
beforeEach(() => {
  window.matchMedia = ((q: string) => ({
    matches: width >= Number(/(\d+)px/.exec(q)?.[1] ?? 0),
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
});

describe('the side bar on a tablet', () => {
  it('shows on an Android tablet and an iPad held sideways, and not on a phone', async () => {
    const { usePadWide } = await import('./padWide');
    for (const [name, w, want] of [['android', 1280, true], ['ios', 1180, true], ['android', 412, false], ['ios', 820, false]] as const) {
      platform.name = name;
      width = w;
      expect(renderHook(() => usePadWide()).result.current, `${name} ${w}`).toBe(want);
    }
  });
});
