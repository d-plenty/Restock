import initSqlJs from 'sql.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { addCard, allCards, ensureDefaults, initDb, setCardExpiry } from './db';
import { wantedReminders } from './cardReminders';
import { cardsToMention, cleanLoyaltyCard, expiresWords, loyaltyReminderAt, putOffCard } from './giftCards';
import { createSqlJsDriver } from './sql/sqljs';
import type { LoyaltyCard } from '../types';

// 0.14.0: a loyalty card can have an expiry date; Restock says so a month before, on Home and as a notification.

beforeEach(async () => {
  await initDb(await createSqlJsDriver({ load: () => initSqlJs() }));
  await ensureDefaults();
});

const card = (id: string, expiry?: string): LoyaltyCard => ({ id, program: 'flybuys', label: 'Flybuys', number: '123', createdAt: '2026-11-01T00:00:00Z', ...(expiry ? { expiry } : {}) });
const at = (day: string) => new Date(`${day}T12:00:00`).getTime();

describe('0.14.0: loyalty card expiry dates', () => {
  it('keeps the date with the card, changes it and takes it off', async () => {
    await addCard(card('c1', '2027-03-01'));
    await addCard(card('c2'));
    expect((await allCards()).map((c) => c.expiry)).toEqual(['2027-03-01', undefined]);
    await setCardExpiry('c2', '2027-06-30');
    await setCardExpiry('c1', undefined);
    expect((await allCards()).map((c) => c.expiry)).toEqual([undefined, '2027-06-30']);
    await setCardExpiry('c2', 'not a date');
    expect((await allCards())[1].expiry).toBeUndefined();
    expect(cleanLoyaltyCard({ ...card('c3', '2027-13-45') })?.expiry).toBeUndefined();
    expect(cleanLoyaltyCard(card('c3', '2027-03-01'))?.expiry).toBe('2027-03-01');
  });

  it('says so a month before, counts down, and can be put off', () => {
    const c = card('c1', '2027-03-01');
    expect(expiresWords(c, at('2027-01-15'))).toBeUndefined();
    expect(expiresWords(c, at('2027-01-30'))).toEqual({ words: 'expires in 1 month', expired: false });
    expect(expiresWords(c, at('2027-02-17'))).toEqual({ words: 'expires in 12 days', expired: false });
    expect(expiresWords(c, at('2027-02-28'))).toEqual({ words: 'expires tomorrow', expired: false });
    expect(expiresWords(c, at('2027-03-01'))).toEqual({ words: 'expires today', expired: false });
    expect(expiresWords(c, at('2027-03-02'))).toEqual({ words: 'has expired', expired: true });
    expect(expiresWords(card('c2'), at('2027-03-02'))).toBeUndefined();

    const now = at('2027-02-01');
    expect(cardsToMention([c, card('c2')], {}, now).map((x) => x.card.id)).toEqual(['c1']);
    // Remind me later: a week, then it's back.
    const later = putOffCard(c, {}, now);
    expect(cardsToMention([c], later, now)).toEqual([]);
    expect(cardsToMention([c], later, now + 6 * 86_400_000)).toEqual([]);
    expect(cardsToMention([c], later, now + 8 * 86_400_000).length).toBe(1);
    // A week or less to go: it only waits a day.
    const close = at('2027-02-26');
    expect(cardsToMention([c], putOffCard(c, {}, close), close + 2 * 86_400_000).length).toBe(1);
  });

  it('schedules one notification, a month before at 9 am, with no card number in it', () => {
    const c = card('c1', '2027-03-01');
    const when = loyaltyReminderAt(c, at('2027-01-01'));
    expect(when?.getHours()).toBe(9);
    expect(when && Math.round((new Date('2027-03-01T00:00:00').getTime() - when.getTime()) / 86_400_000)).toBe(30);
    expect(loyaltyReminderAt(c, at('2027-02-10'))).toBeUndefined();
    const want = wantedReminders([], at('2027-01-01'), [c, card('c2')]);
    expect(want.length).toBe(1);
    expect(want[0].title).toBe('Flybuys expires in 1 month');
    expect(want[0].body).not.toContain('123');
  });
});
