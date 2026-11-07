import { RestockNative } from './sql/native';
import { isNative } from '../stores/http';

// Receipt photos live in Restock's own private storage (not the phone's photo gallery), one JPEG
// per receipt at receipts/<id>.jpg. In a desktop browser (testing) they're kept in memory.

const memory = new Map<string, string>();

export const photoPath = (id: string, page = 1) => (page > 1 ? `receipts/${id}-${page}.jpg` : `receipts/${id}.jpg`);

/** Save a photo (base64 JPEG, no "data:" prefix). */
export async function writePhoto(path: string, base64: string): Promise<void> {
  if (isNative()) await RestockNative.writeAppFile({ path, data: base64 });
  else memory.set(path, base64);
}

export async function readPhoto(path: string): Promise<string | undefined> {
  try {
    return isNative() ? (await RestockNative.readAppFile({ path })).data : memory.get(path);
  } catch {
    return undefined;
  }
}

export async function deletePhoto(path: string): Promise<void> {
  try {
    if (isNative()) await RestockNative.deleteAppFile({ path });
    else memory.delete(path);
  } catch {
    // Already gone.
  }
}

/** Bytes used by receipt photos. */
export async function photosSize(): Promise<number> {
  if (!isNative()) return [...memory.values()].reduce((n, v) => n + Math.round((v.length * 3) / 4), 0);
  try {
    return (await RestockNative.appFilesSize({ dir: 'receipts' })).bytes;
  } catch {
    return 0;
  }
}

export const dataUrl = (base64: string) => `data:image/jpeg;base64,${base64}`;
