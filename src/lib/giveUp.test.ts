import { describe, expect, it, vi } from 'vitest';
import { giveUpAfter } from './giveUp';

describe('giveUpAfter', () => {
  it('ends a request that never answers, and not before its time', async () => {
    vi.useFakeTimers();
    const s = giveUpAfter(15_000);
    const waiting = new Promise<string>((_, no) => s.addEventListener('abort', () => no(s.reason)));
    vi.advanceTimersByTime(14_999);
    expect(s.aborted).toBe(false);
    vi.advanceTimersByTime(1);
    expect(s.aborted).toBe(true);
    await expect(waiting).rejects.toMatchObject({ name: 'TimeoutError' });
    vi.useRealTimers();
  });
});
