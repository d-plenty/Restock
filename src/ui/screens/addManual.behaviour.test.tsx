// @vitest-environment jsdom
// 0.15.1: adding by hand from the Add screen, as someone does it (the Add screen was split up in 0.15.1).
import { beforeEach, describe, expect, test } from 'vitest';
import { allGroups, allListEntries } from '../../lib/db';
import { cleanup, freshData, screen, show, tap, type, waitFor } from '../../test/screen';
import { AddScreen } from './Add';

beforeEach(() => freshData({ empty: true }));

describe('Add → More ways to add → Add manually', () => {
  test('Add to both makes the item, with a capital, and puts it on the shopping list', async () => {
    await show(<AddScreen />, 'add');
    await tap(/More ways to add/);
    await tap(/^Add manually/);
    await type('Product name', 'bin liners');
    await tap(/Add to both/);
    await waitFor(async () => expect((await allGroups()).map((g) => g.name)).toEqual(['Bin liners']));
    const [g] = await allGroups();
    expect((await allListEntries()).map((e) => [e.text, e.groupId])).toEqual([['bin liners', g.id]]);
  });

  test('a name another item already has is said (capitals and a full stop make no difference), and nothing is added', async () => {
    const add = async (name: string) => {
      cleanup();
      await show(<AddScreen />, 'add');
      await tap(/More ways to add/);
      await tap(/^Add manually/);
      await type('Product name', name);
      await tap(/Add to both/);
    };
    await add('Rinse aid');
    await waitFor(async () => expect((await allGroups()).length).toBe(1));
    await add('rinse AID.');
    expect(await screen.findByText(/You already have Rinse aid in your pantry\. Give this one a different name\./)).toBeTruthy();
    expect((await allGroups()).length).toBe(1);
    expect((await allListEntries()).length).toBe(1);
  });
});
