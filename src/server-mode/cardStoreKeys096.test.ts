import { describe, expect, it } from 'vitest';
import type { LoyaltyCard } from '../types';
import { askAboutOtherCards, askKeepCards, cardsDbName, householdIdOf, memoryBackend, memoryPlaces, thisBrowserCards, type Ask, type CardsBackend } from './cardStore';

// 0.9.6 (review M2): the web's cards are kept per server and household, never shown to another.
// Sample cards only.

const card = (id: string): LoyaltyCard => ({ id, program: 'everyday', label: 'Everyday Rewards', number: '9355 0000 1111', createdAt: '2026-11-02T00:00:00.000Z' });

function browser() {
  const dbs = new Map<string, CardsBackend>();
  const backendOf = (name: string) => {
    if (!dbs.has(name)) dbs.set(name, memoryBackend());
    return dbs.get(name)!;
  };
  return { dbs, deps: { places: memoryPlaces(), backendOf } };
}
const record = (answer: string | undefined) => {
  const asked: Parameters<Ask>[] = [];
  const ask: Ask = async (...a) => (asked.push(a), answer);
  return { ask, asked };
};

const houseA = { ownerPub: 'OWNER-A', household: 'Plenty', webId: 'w1', sid: 's1' };
const houseB = { ownerPub: 'OWNER-B', household: 'Plenty', webId: 'w2', sid: 's2' };

describe('cards per server and household', () => {
  it('names the store by server and household (owner key first)', () => {
    expect(householdIdOf(houseA)).toBe('owner:OWNER-A');
    expect(householdIdOf({ household: 'Plenty', webId: 'w' })).toBe('name:Plenty');
    expect(householdIdOf({ webId: 'w' })).toBe('web:w');
    const a = cardsDbName('https://restock.example', householdIdOf(houseA));
    expect(a).toMatch(/^restock-cards-[0-9a-f]{32}$/);
    expect(cardsDbName('https://other.example', householdIdOf(houseA))).not.toBe(a);
    expect(cardsDbName('https://restock.example', householdIdOf(houseB))).not.toBe(a);
    expect(cardsDbName('https://restock.example', householdIdOf(houseA))).toBe(a);
  });

  it('another household, or the same household on another server, never sees the cards', async () => {
    const b = browser();
    const deps = { ...b.deps, origin: 'https://restock.example' };
    await thisBrowserCards(houseA, deps).addLoyalty(card('l1'));
    expect(await thisBrowserCards(houseA, deps).count()).toBe(1);
    // Delete everything, set up again: a new owner key, a new household.
    expect(await thisBrowserCards(houseB, deps).count()).toBe(0);
    expect(await thisBrowserCards(houseA, { ...deps, origin: 'https://other.example' }).count()).toBe(0);
  });

  it('with no one signed in, there are no cards', async () => {
    const none = thisBrowserCards(undefined);
    expect(await none.count()).toBe(0);
  });

  it('signing out with Remove takes only this household’s cards', async () => {
    const b = browser();
    const deps = { ...b.deps, origin: 'https://restock.example' };
    await thisBrowserCards(houseA, deps).addLoyalty(card('l1'));
    await thisBrowserCards(houseB, deps).addLoyalty(card('l2'));
    const mine = thisBrowserCards(houseB, deps);
    expect(await askKeepCards(record('remove').ask, mine, false)).toBe('remove');
    await mine.removeAll();
    expect(await thisBrowserCards(houseB, deps).count()).toBe(0);
    expect(await thisBrowserCards(houseA, deps).count()).toBe(1);
  });
});

describe('next sign-in: "Keep your cards?"', () => {
  it('asks nothing when the cards are this household’s own', async () => {
    const b = browser();
    const deps = { ...b.deps, origin: 'https://restock.example' };
    await thisBrowserCards(houseA, deps).addLoyalty(card('l1'));
    const r = record('remove');
    expect(await askAboutOtherCards(r.ask, { ...houseA, sid: 's9' }, deps, false)).toBe('none');
    expect(r.asked).toHaveLength(0);
  });

  it('a session the server ended (no question asked) leaves them; another household is asked, and Remove clears them', async () => {
    const b = browser();
    const deps = { ...b.deps, origin: 'https://restock.example' };
    await thisBrowserCards(houseA, deps).addLoyalty(card('l1'));
    await thisBrowserCards(houseA, deps).addLoyalty(card('l2'));
    // Household A's session is revoked: nothing runs. Household B signs in.
    thisBrowserCards(houseB, deps);
    const r = record('remove');
    expect(await askAboutOtherCards(r.ask, houseB, deps, false)).toBe('remove');
    const [title, detail, choices] = r.asked[0];
    expect(title).toBe('Keep your cards?');
    expect(detail).toContain('2 cards from an earlier sign-in to another household or server are kept on this browser');
    expect(detail).toContain('shown here');
    expect(choices.map((c) => c.id)).toEqual(['remove', 'keep']);
    expect(await thisBrowserCards(houseA, deps).count()).toBe(0);
    // Asked and done: nothing more to ask.
    expect(await askAboutOtherCards(record('keep').ask, { ...houseB, sid: 's3' }, deps, false)).toBe('none');
  });

  it('Keep keeps them locked away, asks once per sign-in, and on the home screen Keep comes first', async () => {
    const b = browser();
    const deps = { ...b.deps, origin: 'https://restock.example' };
    await thisBrowserCards(houseA, deps).addLoyalty(card('l1'));
    const r = record('keep');
    expect(await askAboutOtherCards(r.ask, houseB, deps, true)).toBe('keep');
    expect(r.asked[0][2].map((c) => c.id)).toEqual(['keep', 'remove']);
    expect(r.asked[0][1]).toContain('One card from an earlier sign-in');
    expect(await askAboutOtherCards(record('remove').ask, houseB, deps, true)).toBe('none');
    // A new sign-in asks again; closing the question leaves them for next time.
    expect(await askAboutOtherCards(record(undefined).ask, { ...houseB, sid: 's7' }, deps, true)).toBe('later');
    expect(await thisBrowserCards(houseA, deps).count()).toBe(1);
    // Household A, back here, sees its card.
    expect(await askAboutOtherCards(record('remove').ask, { ...houseA, sid: 's8' }, deps, true)).toBe('none');
  });
});
