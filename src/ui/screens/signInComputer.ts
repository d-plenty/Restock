// 0.18.3: Sign in a computer (Restock server, and Server admin on an admin phone): scan the code on
// the server's sign-in page, say yes, and that browser is signed in (no passphrase, no second step).
// Undefined: cancelled. Throws in words.
import { scanBarcode } from '../../lib/barcode';
import { confirmAction } from '../../lib/confirm';
import { RestockNative } from '../../lib/sql/native';
import { webPageCode } from '../../lib/sync';

export async function signInComputer(working: (what: string | undefined) => void): Promise<{ host: string } | undefined> {
  const out = await scanBarcode("Scan the code on your server's sign-in page", {
    accept: webPageCode,
    qr: true,
    wrong: "That isn't a code from your Restock server's page. On the computer, open the server's page: the code is beside the passphrase.",
    typeHint: 'Or paste the code',
  });
  if (!out.ok) return undefined;
  const w = await RestockNative.syncWebCode({ code: out.code });
  const ok = await confirmAction(`Sign in on ${w.host}?`, {
    detail: `The browser showing the code (at ${w.host}) can look after your Restock server, its phones, data and settings, until it signs out. Only say yes if you're signing in on that page yourself, right now. If someone sent you this code or asked you to scan it, say no.`,
    action: 'Sign in',
  });
  if (!ok) return undefined;
  working('Signing the browser in…');
  try {
    await RestockNative.syncWebApprove({ code: out.code });
    return { host: w.host };
  } finally {
    working(undefined);
  }
}
