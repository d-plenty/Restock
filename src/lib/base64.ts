// Base64, for files the phone saves through the native side (which takes and gives base64) and for
// the locked-backup format. Done in chunks so a big backup doesn't overflow the call stack.

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function base64ToBytes(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Text (UTF-8) as base64. */
export const textToBase64 = (text: string): string => bytesToBase64(new TextEncoder().encode(text));

/** Base64 back to text (UTF-8). */
export const base64ToText = (s: string): string => new TextDecoder().decode(base64ToBytes(s));
