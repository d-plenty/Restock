// 0.9.6 (cards): photos of a gift card's front and back, in Restock's own private storage on the
// phone (like receipt photos, receiptFiles.ts), never the phone's gallery. One JPEG per side at
// cards/<card id>-front.jpg and cards/<card id>-back.jpg. They're never synced or sent to a Restock
// server (the sync only ever reads receipts/). In a browser (the preview, tests) they're kept in memory.
import { RestockNative } from './sql/native';
import { isNative } from '../stores/http';

const CARD_PHOTO = /^cards\/[A-Za-z0-9_-]{1,80}-(front|back)\.jpg$/;
export const isCardPhotoPath = (p: unknown): p is string => typeof p === 'string' && CARD_PHOTO.test(p);
export const cardPhotoPath = (id: string, side: 'front' | 'back') => `cards/${id}-${side}.jpg`;

const memory = new Map<string, string>();

export async function writeCardPhoto(path: string, base64: string): Promise<void> {
  if (!isCardPhotoPath(path)) throw new Error('That isn’t a card photo.');
  if (isNative()) await RestockNative.writeAppFile({ path, data: base64 });
  else memory.set(path, base64);
}

export async function readCardPhoto(path: string | undefined): Promise<string | undefined> {
  if (!isCardPhotoPath(path)) return undefined;
  try {
    return isNative() ? (await RestockNative.readAppFile({ path })).data : memory.get(path);
  } catch {
    return undefined;
  }
}

export async function deleteCardPhoto(path: string | undefined): Promise<void> {
  if (!isCardPhotoPath(path)) return;
  try {
    if (isNative()) await RestockNative.deleteAppFile({ path });
    else memory.delete(path);
  } catch {
    // Already gone.
  }
}
