import { describe, expect, it } from 'vitest';
import {
  barcodeProblem,
  cardsCount,
  cardsFileName,
  CARDS_FILE_PRIVATE,
  cleanGiftCard,
  cleanLoyaltyCard,
  eanOk,
  expiryState,
  GIFT_HISTORY_MAX,
  guessBarcodeType,
  isReminderId,
  makeCardsFile,
  masked,
  money,
  parseMoney,
  pinProblem,
  readCardsFile,
  reminderAt,
  reminderId,
  reminderText,
  spendLines,
  withBalance,
} from './giftCards';
import { wantedReminders } from './cardReminders';
import type { GiftCard } from '../types';

// 0.9.6 (cards): gift cards beside loyalty cards. Sample cards only (made-up numbers).

const card = (over: Partial<GiftCard> = {}): GiftCard => ({
  id: 'g1',
  name: 'Bunnings',
  barcode: '6280000000001234',
  barcodeType: 'CODE128',
  number: '6280000000001234',
  pin: '4321',
  balance: 50,
  colour: 'navy',
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
  ...over,
});

describe('gift card fields', () => {
  it('takes a PIN of 4 to 8 digits only', () => {
    expect(pinProblem('1234')).toBeUndefined();
    expect(pinProblem('12345678')).toBeUndefined();
    expect(pinProblem('')).toBeUndefined();
    expect(pinProblem('123')).toBe('A PIN is 4 to 8 digits.');
    expect(pinProblem('123456789')).toBeDefined();
    expect(pinProblem('12a4')).toBeDefined();
  });

  it('checks EAN check digits and what each barcode type can draw', () => {
    expect(eanOk('9300633603861')).toBe(true);
    expect(eanOk('9300633603862')).toBe(false);
    expect(eanOk('96385074')).toBe(true);
    expect(barcodeProblem('9300633603862', 'EAN')).toMatch(/check digit/);
    expect(barcodeProblem('ABC-123', 'CODE128')).toBeUndefined();
    expect(barcodeProblem('café', 'CODE128')).toMatch(/Try QR code/);
    expect(barcodeProblem('café', 'QR')).toBeUndefined();
    expect(guessBarcodeType('9300633603861')).toBe('EAN');
    expect(guessBarcodeType('6280000000001234')).toBe('CODE128');
    expect(guessBarcodeType('https://example.com/card/abc')).toBe('QR');
  });

  it('reads amounts in dollars and shows them the Australian way', () => {
    expect(parseMoney('$37.50')).toBe(37.5);
    expect(parseMoney('50')).toBe(50);
    expect(parseMoney('1,000')).toBe(1000);
    expect(parseMoney('12.345')).toBeUndefined();
    expect(parseMoney('-5')).toBeUndefined();
    expect(money(50)).toBe('$50');
    expect(money(37.5)).toBe('$37.50');
    expect(masked('6280 0000 0000 1234')).toBe('•••• 1234');
  });
});

describe('update balance and the spend history', () => {
  it('notes each update, keeps where it started, and says what was spent', () => {
    let g = card();
    g = withBalance(g, 37.5, '2026-11-03T01:00:00.000Z');
    g = withBalance(g, 57.5, '2026-11-04T01:00:00.000Z');
    expect(g.balance).toBe(57.5);
    expect(g.history?.map((h) => h.balance)).toEqual([50, 37.5, 57.5]);
    const lines = spendLines(g);
    expect(lines[0]).toMatchObject({ balance: 57.5, change: 20 });
    expect(lines[1]).toMatchObject({ balance: 37.5, change: -12.5 });
    expect(lines[2].change).toBeUndefined();
  });

  it('keeps a short history only', () => {
    let g = card();
    for (let i = 0; i < 30; i++) g = withBalance(g, 50 - i, new Date(Date.UTC(2026, 10, 1, i)).toISOString());
    expect(g.history).toHaveLength(GIFT_HISTORY_MAX);
    expect(g.balance).toBe(21);
  });
});

describe('expiry and its reminder', () => {
  const now = new Date(2026, 10, 11, 12).getTime();
  it('says how long is left in plain words', () => {
    expect(expiryState(card({ expiry: undefined }), now).kind).toBe('none');
    expect(expiryState(card({ expiry: '2026-11-10' }), now)).toMatchObject({ kind: 'expired', text: 'Expired 10 November 2026' });
    expect(expiryState(card({ expiry: '2026-11-11' }), now)).toMatchObject({ kind: 'soon', text: 'Expires today' });
    expect(expiryState(card({ expiry: '2026-11-12' }), now)).toMatchObject({ text: 'Expires tomorrow' });
    expect(expiryState(card({ expiry: '2026-11-23' }), now)).toMatchObject({ kind: 'soon', days: 12, text: 'Expires in 12 days' });
    expect(expiryState(card({ expiry: '2027-12-03' }), now)).toMatchObject({ kind: 'ok', text: 'Expires 3 December 2027' });
  });

  it('reminds at 9 am the chosen days before, never when off, used up or already past', () => {
    const at = reminderAt(card({ expiry: '2026-12-25', remindDays: 14 }), now)!;
    expect([at.getFullYear(), at.getMonth(), at.getDate(), at.getHours()]).toEqual([2026, 11, 11, 9]);
    expect(reminderAt(card({ expiry: '2026-12-25' }), now)).toBeUndefined();
    expect(reminderAt(card({ expiry: '2026-12-25', remindDays: 14, usedUp: true }), now)).toBeUndefined();
    expect(reminderAt(card({ expiry: '2026-11-15', remindDays: 14 }), now)).toBeUndefined();
    expect(wantedReminders([card({ expiry: '2026-12-25', remindDays: 7 }), card({ id: 'g2' })], now)).toHaveLength(1);
  });

  it("never puts the card's number, PIN or balance in a notification", () => {
    const t = reminderText(card({ expiry: '2026-12-25' }));
    expect(t.title).toBe('Bunnings expires soon');
    const all = t.title + t.body;
    expect(all).not.toContain('1234');
    expect(all).not.toContain('4321');
    expect(all).not.toContain('$50');
    expect(isReminderId(reminderId('g1'))).toBe(true);
    // Clear of notify.ts's own reminders (101 to 103).
    expect(reminderId('anything')).toBeGreaterThanOrEqual(200_000);
  });
});

describe('cards from outside are checked', () => {
  it('drops what a gift card can’t have', () => {
    const g = cleanGiftCard({ ...card(), id: '../x', name: 'X' });
    expect(g).toBeUndefined();
    const ok = cleanGiftCard({ ...card(), pin: '12', barcodeType: 'PDF417', colour: 'hotpink', balance: -3, remindDays: 5, expiry: '2026-13-45' })!;
    expect(ok.pin).toBeUndefined();
    expect(ok.barcodeType).toBe('CODE128');
    expect(ok.colour).toBe('navy');
    expect(ok.balance).toBeUndefined();
    expect(ok.remindDays).toBeUndefined();
    expect(ok.expiry).toBeUndefined();
    expect(cleanLoyaltyCard({ id: 'l1', program: 'bogus', number: '1', label: 'x' })).toBeUndefined();
    expect(cleanLoyaltyCard({ id: 'l1', program: 'flybuys', number: '6008 1234', label: 'Flybuys' })?.number).toBe('60081234');
  });
});

describe('the cards file (phone to browser and back)', () => {
  it('is clearly marked private, and round-trips cards and photos', () => {
    const text = makeCardsFile(
      [{ id: 'l1', program: 'flybuys', label: 'Flybuys', number: '6008943212345678', createdAt: '2026-11-01T00:00:00.000Z' }],
      [card({ photoFront: 'cards/g1-front.jpg' })],
      { 'g1:front': 'AAAA' },
    );
    const raw = JSON.parse(text);
    expect(raw.private).toBe(true);
    expect(raw.warning).toBe(CARDS_FILE_PRIVATE);
    expect(raw.warning).toMatch(/^PRIVATE/);
    expect(cardsFileName('2026-11-11')).toBe('restock-cards-PRIVATE-2026-11-11.json');
    // A path belongs to the phone it was taken on: the photo itself travels.
    expect(raw.gift[0].photoFront).toBeUndefined();
    const got = readCardsFile(text);
    expect(got.loyalty[0].number).toBe('6008943212345678');
    expect(got.gift[0]).toMatchObject({ name: 'Bunnings', pin: '4321', balance: 50 });
    expect(got.photos).toEqual({ 'g1:front': 'AAAA' });
    expect(cardsCount(1, 1)).toBe('1 loyalty card and 1 gift card');
  });

  it('turns away files that aren’t one, are too new, or carry odd photos', () => {
    expect(() => readCardsFile('{')).toThrow("isn't a Restock cards file");
    expect(() => readCardsFile(JSON.stringify({ app: 'restock', version: 2, tables: {} }))).toThrow("isn't a Restock cards file");
    expect(() => readCardsFile(JSON.stringify({ format: 'restock-cards', v: 2 }))).toThrow('newer Restock');
    const got = readCardsFile(
      JSON.stringify({
        format: 'restock-cards',
        v: 1,
        loyalty: [{ id: 'bad' }],
        gift: [card()],
        photos: { 'g1:front': 'not base64!', 'zz:back': 'AAAA', '../g1:front': 'AAAA', 'g1:back': 'AAAA' },
      }),
    );
    expect(got.skipped).toBe(1);
    expect(got.photos).toEqual({ 'g1:back': 'AAAA' });
  });
});
