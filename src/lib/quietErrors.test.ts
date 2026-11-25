// 0.15.0: background errors are noted for Diagnostics instead of vanishing.
import { beforeEach, describe, expect, it } from 'vitest';
import { clearQuiet, noteQuiet, quiet, quietErrors } from './quietErrors';

describe('0.15.0: quiet problems', () => {
  beforeEach(() => clearQuiet());
  it('are noted with where they came from, newest first, and the work carries on', async () => {
    expect(await Promise.reject(new Error('server unreachable')).catch(quiet('sync'))).toBeUndefined();
    noteQuiet('check', 'Coles answered 503');
    expect(quietErrors().map((e) => [e.where, e.message])).toEqual([
      ['check', 'Coles answered 503'],
      ['sync', 'server unreachable'],
    ]);
  });
  it('a repeat of the newest counts once, and only the last 50 are kept', () => {
    noteQuiet('sync', new Error('same'));
    noteQuiet('sync', new Error('same'));
    expect(quietErrors()).toHaveLength(1);
    for (let i = 0; i < 60; i++) noteQuiet('check', `n${i}`);
    expect(quietErrors()).toHaveLength(50);
    expect(quietErrors()[0].message).toBe('n59');
  });
});
