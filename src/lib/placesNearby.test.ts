import { describe, expect, it } from 'vitest';
import { OVERPASS, overpassInTurn, overpassQuery, roundCoord } from './places';

// 0.9.0: "near me" sends a position rounded to about 100 m, to one map server at a time.

describe('looking for nearby shops (0.9.0)', () => {
  it('rounds a position to 3 decimal places before it goes anywhere', () => {
    expect(roundCoord(-19.312345)).toBe(-19.312);
    expect(roundCoord(146.6896)).toBe(146.69);
    expect(overpassQuery(-19.312345, 146.689612, 25000)).toContain('(around:25000,-19.31200,146.69000)');
  });

  it('asks overpass-api.de first, then overpass.private.coffee, and nothing else', () => {
    expect(OVERPASS.map((u) => new URL(u).host)).toEqual(['overpass-api.de', 'overpass.private.coffee']);
  });

  it('asks the next server only when the one before fails', async () => {
    const asked: string[] = [];
    const first = await overpassInTurn(['a', 'b'], async (s) => {
      asked.push(s);
      return s;
    });
    expect(first).toBe('a');
    expect(asked).toEqual(['a']);

    asked.length = 0;
    const second = await overpassInTurn(['a', 'b'], async (s) => {
      asked.push(s);
      if (s === 'a') throw new Error('busy');
      return s;
    });
    expect(second).toBe('b');
    expect(asked).toEqual(['a', 'b']);

    await expect(
      overpassInTurn(['a', 'b'], async (s) => {
        throw new Error(`${s} down`);
      }),
    ).rejects.toThrow('b down');

    // The answer came from the backup meanwhile: the second server isn't asked.
    asked.length = 0;
    let answered = false;
    await expect(
      overpassInTurn(
        ['a', 'b'],
        async (s) => {
          asked.push(s);
          answered = true;
          throw new Error('slow');
        },
        () => answered,
      ),
    ).rejects.toThrow('slow');
    expect(asked).toEqual(['a']);
  });
});
