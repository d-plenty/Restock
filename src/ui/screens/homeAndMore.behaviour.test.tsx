// @vitest-environment jsdom
// 0.15.1: Home, More, Add, the shopping list and an item's page, as someone using them sees them
// (these were checks on the screens' code: homeAndMore.test.ts, 0.12.5).
import { beforeEach, describe, expect, test } from 'vitest';
import { allGroups, addListEntry } from '../../lib/db';
import { freshData, screen, show, tap, waitFor } from '../../test/screen';
import { AddScreen } from './Add';
import { HomeScreen } from './Home';
import { ItemScreen } from './Item';
import { ListScreen } from './List';
import { MoreScreen } from './More';

beforeEach(() => freshData());

describe('Home and More', () => {
  test('Home has no Settings cog', async () => {
    await show(<HomeScreen />, 'home');
    await waitFor(() => expect(document.body.textContent).not.toBe(''));
    expect(screen.queryByRole('button', { name: 'Settings' })).toBeNull();
  });
  test('More offers one Create a custom tab button', async () => {
    await show(<MoreScreen />, 'more');
    await waitFor(() => expect(screen.getAllByRole('button', { name: /Create a custom tab/ }).length).toBe(1));
  });
});

describe('the Add screen', () => {
  test('More ways to add is one button that opens to the other ways in', async () => {
    await show(<AddScreen />, 'add');
    const more = await screen.findByRole('button', { name: /More ways to add/ });
    expect(more.getAttribute('aria-expanded')).toBe('false');
    await tap(/More ways to add/);
    expect(more.getAttribute('aria-expanded')).toBe('true');
    for (const way of [/Scan several barcodes/, /Find it from a photo/, /Scan a receipt/]) expect(await screen.findByRole('button', { name: way })).toBeTruthy();
  });
});

describe('the shopping list', () => {
  test('a line has How many on it, and the i that opens its page', async () => {
    const g = { name: 'Bin bags' };
    await addListEntry({ id: 'line1', text: g.name, qty: 2, checked: false, createdAt: new Date().toISOString() });
    await show(<ListScreen />, 'list');
    // Each shop starts folded down to one line.
    await tap(/^Open all/);
    const howMany = await screen.findByRole('group', { name: `How many ${g.name}` });
    expect(howMany.textContent).toContain('2');
    await tap(`About ${g.name}: details and options`);
    expect(await screen.findByText(/Edit this item/)).toBeTruthy();
  });
});

describe("an item's page", () => {
  test('has the best price at each shop, and the Also happy with fold', async () => {
    const [g] = await allGroups();
    await show(<ItemScreen groupId={g.id} />);
    expect(await screen.findByText('Best price at each shop')).toBeTruthy();
    expect(screen.getAllByText(/Also happy with/).length).toBeGreaterThan(0);
  });
});
