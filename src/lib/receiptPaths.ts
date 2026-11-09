// 0.9.0: the only paths a receipt photo can have in Restock's private storage: receipts/<id>.jpg,
// and receipts/<id>-2.jpg … for the later photos of a long receipt (receiptFiles.ts photoPath).
// A path from anywhere else (a backup file, say) that isn't one of these is never read, written
// or deleted, so it can't reach any other file Restock keeps.

const PHOTO_PATH = /^receipts\/[A-Za-z0-9_-]{1,80}\.jpg$/;

export const isPhotoPath = (path: unknown): path is string => typeof path === 'string' && PHOTO_PATH.test(path);
