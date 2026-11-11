// 0.9.6 (cards): where the Cards screen keeps its cards. One screen (ui/screens/Cards.tsx) for the
// phone and the web; this says where the cards live:
// - the phone: its database (loyalty cards in `cards`, synced only if the person shares them;
//   gift cards in `gift_cards`, never synced) and its own private storage for card photos;
// - the web: this browser only (server-mode/cardStore.ts, IndexedDB), never the server.
import type { GiftCard, LoyaltyCard } from '../types';
import { addCard, allCards, allGiftCards, deleteCard, deleteGiftCard, saveGiftCard } from './db';
import { onChange } from './live';
import { act } from './undo';
import { cardPhotoPath, deleteCardPhoto, readCardPhoto, writeCardPhoto } from './cardPhotos';
import { scheduleCardReminders } from './cardReminders';

export interface CardStore {
  /** Where the cards are kept, for the words on the screen. */
  where: 'phone' | 'browser';
  loyalty(): Promise<LoyaltyCard[]>;
  addLoyalty(c: LoyaltyCard): Promise<void>;
  removeLoyalty(id: string): Promise<void>;
  gifts(): Promise<GiftCard[]>;
  /** Adds or changes a gift card. `label` says what happened (for Undo). */
  saveGift(g: GiftCard, label: string): Promise<void>;
  removeGift(g: GiftCard): Promise<void>;
  /** A card photo (base64 JPEG), by the path on the card. */
  readPhoto(path: string | undefined): Promise<string | undefined>;
  /** Keeps a photo for a card's side; resolves to the path to put on the card. */
  writePhoto(cardId: string, side: 'front' | 'back', base64: string): Promise<string>;
  deletePhoto(path: string | undefined): Promise<void>;
  /** Runs `fn` whenever the cards change; returns the way to stop. */
  onChange(fn: () => void): () => void;
  /** Expiry reminders can be set here (the phone; the web can't notify). */
  canRemind: boolean;
  /** Undo shows for changes here (the phone and web's Undo work on the database only). */
  undoable: boolean;
  /** A drawn QR code kept for offline (the web: its QR maker isn't kept offline). */
  codeCache?: { get(key: string): Promise<string | undefined>; set(key: string, svg: string): Promise<void> };
}

const reschedule = async () => scheduleCardReminders(await allGiftCards());

/** The phone's cards. */
export const phoneCards: CardStore = {
  where: 'phone',
  loyalty: allCards,
  addLoyalty: (c) => act(`${c.label} added`, () => addCard(c)),
  removeLoyalty: (id) => act('Card removed. Member prices for that shop stop counting.', () => deleteCard(id)),
  gifts: allGiftCards,
  async saveGift(g, label) {
    await act(label, () => saveGiftCard(g));
    await reschedule();
  },
  async removeGift(g) {
    await act(`${g.name} removed`, async (ctx) => {
      // The photos go too, and come back with Undo.
      const kept: [string, string][] = [];
      for (const p of [g.photoFront, g.photoBack]) {
        const data = p ? await readCardPhoto(p) : undefined;
        if (p && data) kept.push([p, data]);
        await deleteCardPhoto(p);
      }
      ctx.onUndo(async () => {
        for (const [p, data] of kept) await writeCardPhoto(p, data).catch(() => undefined);
      });
      await deleteGiftCard(g.id);
    });
    await reschedule();
  },
  readPhoto: readCardPhoto,
  async writePhoto(cardId, side, base64) {
    const path = cardPhotoPath(cardId, side);
    await writeCardPhoto(path, base64);
    return path;
  },
  deletePhoto: deleteCardPhoto,
  onChange,
  canRemind: true,
  undoable: true,
};
