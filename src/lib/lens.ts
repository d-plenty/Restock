import { RestockNative } from './sql/native';
import { isNative } from '../stores/http';

// 0.10.7: "Search with Google Lens", the backup when Restock's own reader can't make out a pack.
// Only ever when the person taps it, and the button says the photo goes to Google. On Android the
// photo goes to the Google app; without it (and on the web page, an iPhone or a computer) Google
// Lens opens in the browser, where the photo is added by hand (or through the share menu where the
// browser can share a photo). Google can't send its answer back to Restock: the name comes back by
// "Restock: Search shops" in the share menu, or copied and pasted.

export const LENS_PAGE = 'https://lens.google.com/';
const KEY = 'restock.lensFor';
/** A name shared back within this long is for the barcode Lens was asked about. */
const FRESH_MS = 20 * 60_000;

/** The barcode Lens was last asked about, if it was recent: what a shared-back name is for. */
export function lensBarcode(): string | undefined {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return undefined;
    const { barcode, at } = JSON.parse(raw) as { barcode?: string; at: number };
    return barcode && Date.now() - at < FRESH_MS ? barcode : undefined;
  } catch {
    return undefined;
  }
}

function remember(barcode?: string) {
  try {
    if (barcode) localStorage.setItem(KEY, JSON.stringify({ barcode, at: Date.now() }));
    else localStorage.removeItem(KEY);
  } catch {
    // only used to attach the barcode again: fine without
  }
}

async function jpegOf(photo: Blob, max = 1600): Promise<Blob> {
  const bmp = await createImageBitmap(photo, { imageOrientation: 'from-image' });
  const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * k);
  c.height = Math.round(bmp.height * k);
  c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close();
  return new Promise((ok, fail) => c.toBlob((b) => (b ? ok(b) : fail(new Error("Couldn't prepare the photo"))), 'image/jpeg', 0.85));
}

const base64 = (b: Blob) =>
  new Promise<string>((ok, fail) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => fail(r.error);
    r.readAsDataURL(b);
  });

/**
 * Sends the photo to Google Lens. 'app': the Google app has it. 'shared': the browser's share menu
 * took it (pick Google there). 'web': Google Lens opened in the browser; add the photo there.
 */
export async function searchWithLens(photo: Blob, barcode?: string): Promise<'app' | 'shared' | 'web'> {
  remember(barcode);
  const jpeg = await jpegOf(photo);
  if (isNative()) {
    const r = await RestockNative.lensSearch({ jpeg: await base64(jpeg) }).catch(() => ({ opened: false }));
    if (r.opened) return 'app';
  } else {
    const file = new File([jpeg], 'pack.jpg', { type: 'image/jpeg' });
    const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
    // Phones' browsers can hand a photo to the Google app through the share menu; computers can't.
    if (nav.canShare?.({ files: [file] }) && /Android|iPhone|iPad/i.test(navigator.userAgent)) {
      try {
        await nav.share({ files: [file], title: 'Search with Google Lens' });
        return 'shared';
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') return 'shared';
      }
    }
  }
  window.open(LENS_PAGE, '_blank', 'noopener');
  return 'web';
}
