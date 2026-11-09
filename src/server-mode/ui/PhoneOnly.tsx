// Server mode: where a phone-only button would be, a plain note instead.
import { useState } from 'react';
import { findProductByBarcode } from '../../lib/db';
import { Icon, TopBar } from '../../ui/components';
import { useNav } from '../../ui/nav';
import { productCode } from '../../lib/barcode';

export const PHONE_ONLY = "Do this on a phone: shops don't let a web page check prices or search.";

export function PhoneOnlyNote({ compact, text = PHONE_ONLY }: { compact?: boolean; text?: string }) {
  return (
    <p className={`phone-only${compact ? ' compact' : ''}`} role="note">
      <Icon name="phone" size={compact ? 16 : 18} />
      <span>{text}</span>
    </p>
  );
}

/** A whole screen that only works on a phone (shop search, shop sign-ins, pairing, …). */
export function PhoneOnlyScreen({ title, text, back = true }: { title: string; text?: string; back?: boolean }) {
  return (
    <div className="screen">
      <TopBar title={title} back={back} />
      <PhoneOnlyNote text={text} />
    </div>
  );
}

/**
 * The Add tab on a server: shop search is phone-only, but a barcode typed in can be found among
 * the household's own products (no camera, nothing asked of the shops).
 */
export function AddOnServer({ back }: { back?: boolean }) {
  const nav = useNav();
  const [code, setCode] = useState('');
  const [msg, setMsg] = useState<string>();
  const look = async () => {
    const c = productCode(code.trim()) ?? code.replace(/\D/g, '');
    if (!c) return setMsg('Type the numbers under the barcode.');
    const p = await findProductByBarcode(c);
    if (!p) return setMsg("None of your household's products has that barcode. Add it on a phone.");
    const { allGroups } = await import('../../lib/db');
    const g = (await allGroups()).find((x) => x.usualProductId === p.id || x.sameProductIds.includes(p.id) || x.altProductIds.includes(p.id));
    if (g) nav.push({ name: 'item', groupId: g.id });
    else setMsg(`${p.name}: in your household's products, but not on a list. Add it to one on a phone.`);
  };
  return (
    <div className="screen">
      <TopBar title="Add" back={!!back} />
      <PhoneOnlyNote />
      <div className="card">
        <h2 style={{ margin: 0, fontSize: 18 }}>Look up a barcode</h2>
        <p className="small" style={{ margin: 0 }}>
          Finds it among your household's own products.
        </p>
        <form
          style={{ display: 'flex', gap: 8 }}
          onSubmit={(e) => {
            e.preventDefault();
            void look();
          }}
        >
          <input className="input" inputMode="numeric" aria-label="Barcode number" placeholder="9300633…" value={code} onChange={(e) => (setCode(e.target.value), setMsg(undefined))} />
          <button className="btn primary" type="submit">
            Find
          </button>
        </form>
        {msg && <p className="small">{msg}</p>}
      </div>
    </div>
  );
}
