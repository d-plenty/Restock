// 0.11.3: an item's name starts with a capital. "baked beans" typed in a hurry sat among "Bagels" and
// "Barbecue sauce" looking unfinished. Only a name that starts with a small letter and has no capital
// anywhere is touched, so a name written on purpose ("iPhone cable", "pH strips") stays as typed.
export function tidyItemName(name: string): string {
  const n = name.replace(/\s+/g, ' ').trim();
  if (!n || /[A-Z]/.test(n) || !/^[a-z]/.test(n)) return n;
  return n[0].toUpperCase() + n.slice(1);
}
