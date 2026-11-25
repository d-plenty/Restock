// @vitest-environment jsdom
// 0.15.1: what the Pantry tab does, as someone using it sees it (in place of reading its code).
import { beforeEach, describe, expect, test } from 'vitest';
import { freshData, screen, show, tap, type, waitFor } from '../../test/screen';
import { PantryScreen } from './Pantry';

describe('Pantry: searching your items', () => {
  beforeEach(() => freshData());

  test('finds your item as you type', async () => {
    await show(<PantryScreen />);
    await type('Search your pantry', 'milk');
    await waitFor(() => expect(screen.getAllByText(/milk/i).length).toBeGreaterThan(0));
    expect(screen.queryByRole('status')?.textContent ?? '').not.toMatch(/isn't in your pantry/);
  });

  test("a search that finds nothing offers to add it, carrying over what you typed", async () => {
    const nav = await show(<PantryScreen />);
    await type('Search your pantry', 'chopsticks');
    expect(await screen.findByText('"chopsticks" isn\'t in your pantry yet.')).toBeTruthy();
    await tap('Add chopsticks to pantry');
    expect(nav.pushed).toEqual([{ name: 'add', section: 'pantry', toPantry: true, query: 'chopsticks' }]);
  });
});
