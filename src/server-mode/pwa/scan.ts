// 0.9.5: scanning a barcode on the web (an iPhone's camera, say) and doing what the web's Add does
// with it: find the household's own product with that barcode and put its item on the Shopping
// list. All in this browser's copy (it works offline); nothing is looked up anywhere else, unless
// the household turned on "Let the web page search the shops" and a search is handed in below.
import { addListEntry, allGroups, allListEntries, findProductByBarcode, groupProductIds, nowIso, uid, updateListEntry } from '../../lib/db';
import { productCode } from '../../lib/barcode';
import type { Section } from '../../shops';

/** Why the camera can't be used here, in plain words (undefined: it can). */
export function scanBlocked(env: { secure: boolean; camera: boolean }): string | undefined {
  if (!env.secure) return "Scanning needs the server's https address (for example your Cloudflare tunnel).";
  if (!env.camera) return "This browser can't use the camera. Type the barcode number instead.";
  return undefined;
}

export const scanEnv = () => ({
  secure: typeof window !== 'undefined' && window.isSecureContext,
  camera: typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia,
});

export type ScanResult =
  | { kind: 'added'; name: string; more: boolean }
  | { kind: 'searched'; text: string }
  | { kind: 'none'; code: string }
  | { kind: 'bad' };

/**
 * The shop search for a barcode no household product has (another part of the web, when the
 * household's "Let the web page search the shops" is on). It says what it did, or undefined to
 * leave it. Only ever called when someone has just scanned.
 */
export type BarcodeSearch = (code: string, section: Section) => Promise<string | undefined>;
let search: BarcodeSearch | undefined;
export const setBarcodeSearch = (fn: BarcodeSearch | undefined) => (search = fn);

/** A scanned (or typed) code onto the Shopping list, as the web's Add does. */
export async function addScanned(raw: string, section: Section): Promise<ScanResult> {
  const code = productCode(raw);
  if (!code) return { kind: 'bad' };
  const product = await findProductByBarcode(code);
  const group = product ? (await allGroups()).find((g) => groupProductIds(g).includes(product.id)) : undefined;
  if (group) {
    const sec = (group.section ?? section) as Section;
    // Already on the list and not ticked: one more, as the list's own add does.
    const open = (await allListEntries()).find((e) => !e.checked && e.groupId === group.id);
    if (open) await updateListEntry(open.id, { qty: (open.qty ?? 1) + 1 });
    else await addListEntry({ id: uid(), text: group.name, groupId: group.id, qty: 1, section: sec, checked: false, createdAt: nowIso() });
    return { kind: 'added', name: group.name, more: !!open };
  }
  if (search) {
    const said = await search(code, section).catch(() => undefined);
    if (said) return { kind: 'searched', text: said };
  }
  return { kind: 'none', code };
}

/** What to say after a scan. */
export function scanSaid(r: ScanResult): string {
  switch (r.kind) {
    case 'added':
      return r.more ? `One more ${r.name} on your Shopping list` : `${r.name} added to your Shopping list`;
    case 'searched':
      return r.text;
    case 'none':
      return `None of your household's things has barcode ${r.code}. Type its name to add it.`;
    case 'bad':
      return "That isn't a product barcode.";
  }
}
