import { useState } from 'react';
import { getSettings } from '../../lib/db';
import { useLive } from '../../lib/useLive';
import { chainName } from '../../shops';
import { wooliesAccount } from '../../types';
import { isNative, viaBrowser } from '../../stores/http';
import { Icon, Sheet } from '../components';
import { useNav } from '../nav';

// Shopping list → send a shop's lines to the Coles or Woolworths app.
//
// Neither shop offers an official way for another app to fill your trolley, so there are two ways:
// stepping through (each item opens in the shop's app or website, you tap "Add to trolley", come
// back for the next), and an experimental automatic one for Woolworths that adds them from inside
// their website after you've signed in there. The automatic way may stop working whenever
// Woolworths changes its site, and probably isn't allowed under their terms.

export interface SendLine {
  name: string;
  qty: number;
  /** The shop's own product number, when the line is linked to a product there. */
  id?: string;
  productName?: string;
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

export function productLink(chain: 'woolworths' | 'coles', l: SendLine): string {
  if (chain === 'woolworths')
    return l.id
      ? `https://www.woolworths.com.au/shop/productdetails/${l.id}`
      : `https://www.woolworths.com.au/shop/search/products?searchTerm=${encodeURIComponent(l.name)}`;
  return l.id && l.productName
    ? `https://www.coles.com.au/product/${slug(l.productName)}-${l.id}`
    : `https://www.coles.com.au/search/products?q=${encodeURIComponent(l.productName ?? l.name)}`;
}

export function SendToShopSheet({ chain, lines, onClose }: { chain: 'woolworths' | 'coles'; lines: SendLine[]; onClose: () => void }) {
  const nav = useNav();
  const settings = useLive(getSettings, []);
  const [opened, setOpened] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const name = chainName(chain);
  const nextIndex = lines.findIndex((_, i) => !opened.has(i));
  const open = (i: number) => {
    setOpened((o) => new Set(o).add(i));
    window.open(productLink(chain, lines[i]), '_blank');
  };
  // Signed in to Woolworths in Restock: fill the trolley straight away, as you, from its website.
  const signedIn = chain === 'woolworths' && wooliesAccount(settings);

  const automatic = async () => {
    setBusy(true);
    let ok = 0;
    const failed: string[] = [];
    try {
      for (const l of lines) {
        if (!l.id) {
          failed.push(l.name);
          continue;
        }
        const r = await viaBrowser('woolworths', 'POST', '/apis/ui/Trolley/Update', {
          items: [{ stockcode: Number(l.id), quantity: l.qty, source: 'ProductDetail', diagnostics: '0' }],
        });
        if (r.status >= 200 && r.status < 300 && !r.text.trim().startsWith('<')) ok++;
        else failed.push(l.name);
      }
    } catch {
      // reported below
    } finally {
      setBusy(false);
    }
    nav.toast(
      failed.length
        ? `Added ${ok} of ${lines.length}. Use "One at a time" for the rest${ok ? '' : ' (are you signed in to Woolworths?)'}.`
        : `Added all ${ok} to your Woolworths trolley. Check it in the Woolworths app.`,
    );
  };

  return (
    <Sheet title={`Send to ${name}`} onClose={onClose}>
      {signedIn ? (
        <>
          <p className="small" style={{ margin: 0 }}>
            You're signed in to Woolworths, so Restock adds every linked item to your trolley the way the Woolworths website does. Then open the
            Woolworths app to check out.
          </p>
          <button className="btn primary block" disabled={!isNative() || busy} onClick={() => void automatic()}>
            <Icon name="cartPlus" size={18} /> {busy ? 'Adding…' : `Add ${lines.filter((l) => l.id).length} to my Woolworths trolley`}
          </button>
          <p className="small" style={{ margin: 0 }}>
            Or one at a time:
          </p>
        </>
      ) : (
        <p className="small" style={{ margin: 0 }}>
          {name} doesn't let other apps fill your trolley, so Restock opens each item in the {name} app (or website) for you to add. Tap "Add to
          trolley" there, come back, and open the next one.
        </p>
      )}
      <div className="card flush">
        {lines.map((l, i) => (
          <button key={l.name + i} className="row" onClick={() => open(i)}>
            <span className="grow">
              <span className="title" style={{ fontSize: 14 }}>
                {l.qty > 1 ? `${l.qty} × ` : ''}
                {l.name}
              </span>
              <span className="small">{l.id ? (l.productName ?? 'Opens the product') : `Searches ${name} for it`}</span>
            </span>
            {opened.has(i) ? <Icon name="check" size={18} /> : <Icon name="external" size={16} />}
          </button>
        ))}
      </div>
      <button className={`btn ${signedIn ? '' : 'primary '}block`} disabled={nextIndex < 0} onClick={() => open(nextIndex)}>
        {nextIndex < 0 ? 'All opened' : opened.size ? `Open the next one (${nextIndex + 1} of ${lines.length})` : 'One at a time: open the first'}
      </button>

      {chain === 'woolworths' && !signedIn && (
        <div className="card hint" style={{ flexDirection: 'column', gap: 6 }}>
          <strong>Skip the tapping: sign in to Woolworths</strong>
          <span className="small">
            Sign in to your Woolworths account in Restock (Settings → My shops) and Restock puts the whole list in your Woolworths trolley in one go.
            It's waiting in the Woolworths app when you open it.
          </span>
          <button
            className="btn small"
            style={{ alignSelf: 'flex-start' }}
            onClick={() => (onClose(), nav.push({ name: 'stores', section: 'pantry' }))}
          >
            Sign in to Woolworths
          </button>
        </div>
      )}
    </Sheet>
  );
}
