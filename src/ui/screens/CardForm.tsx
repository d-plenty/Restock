// 0.9.6 (cards): adding and changing cards on the Cards screen, the same on the phone and the web.
// "Add a card" asks which kind first (loyalty card or gift card); a gift card has its barcode, card
// number, PIN, balance, expiry, reminder, notes, photos and colour. Update balance keeps a short
// spend history.
import { useRef, useState } from 'react';
import { CARD_SCAN, scanBarcode } from '../../lib/barcode';
import type { CardStore } from '../../lib/cardStore';
import { nowIso, uid } from '../../lib/db';
import {
  BARCODE_TYPES,
  barcodeProblem,
  CARD_COLOURS,
  guessBarcodeType,
  money,
  parseMoney,
  pinProblem,
  REMIND_CHOICES,
  withBalance,
} from '../../lib/giftCards';
import { ensureNotificationPermission } from '../../lib/notify';
import type { CardProgram, GiftBarcodeType, GiftCard, LoyaltyCard } from '../../types';
import { searchBrands, type CardBrand } from '../../lib/cardBrands';
import { CardCode } from './CardCode';
import { Icon, Sheet, SearchField } from '../components';
import { useNav } from '../nav';

export const PROGRAMS: Record<CardProgram, { name: string; use: string }> = {
  flybuys: { name: 'Flybuys', use: 'Coles member prices' },
  everyday: { name: 'Everyday Rewards', use: 'Woolworths member prices' },
  other: { name: 'Other card', use: 'Any barcode card, not linked to prices' },
};

/** Where the cards are kept, in plain words (the same on the add sheet and the screen). */
export function keptText(store: CardStore, kind: 'loyalty' | 'gift'): string {
  if (store.where === 'browser') return 'Cards in the web page are kept only in this browser; they are not sent to the server.';
  return kind === 'gift'
    ? "Gift cards stay on this phone. They aren't shared with your household or sent to a Restock server."
    : 'Stored on this phone, and on your household’s phones only if you chose to share loyalty cards.';
}

/** A photo from the camera or a file, made smaller (longest side 1400 px) as a base64 JPEG. */
async function shrinkPhoto(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error("That photo couldn't be opened."));
      i.src = url;
    });
    const scale = Math.min(1, 1400 / Math.max(img.naturalWidth, img.naturalHeight, 1));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(img.naturalWidth * scale));
    c.height = Math.max(1, Math.round(img.naturalHeight * scale));
    c.getContext('2d')?.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.78).replace(/^data:image\/jpeg;base64,/, '');
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** "Add a card": loyalty card or gift card. */
export function AddCardSheet({
  store,
  onClose,
  onAdded,
}: {
  store: CardStore;
  onClose: () => void;
  onAdded: (kind: 'loyalty' | 'gift', id: string) => void;
}) {
  const [kind, setKind] = useState<'loyalty' | 'gift'>('loyalty');
  return (
    <Sheet title="Add a card" onClose={onClose}>
      <div className="seg cc-seg" role="group" aria-label="Kind of card">
        <button type="button" aria-pressed={kind === 'loyalty'} onClick={() => setKind('loyalty')}>
          Loyalty card
        </button>
        <button type="button" aria-pressed={kind === 'gift'} onClick={() => setKind('gift')}>
          Gift card
        </button>
      </div>
      <p className="small" style={{ margin: 0 }}>
        {kind === 'loyalty'
          ? 'Flybuys, Everyday Rewards, IGA Rewards, Bunnings PowerPass or any card with a barcode. Member prices count once Flybuys or Everyday Rewards is added.'
          : 'A gift card with a balance: barcode, card number, PIN and expiry date.'}
      </p>
      {kind === 'loyalty' ? (
        <LoyaltyFields store={store} onAdded={(id) => onAdded('loyalty', id)} />
      ) : (
        <GiftFields store={store} onSaved={(id) => onAdded('gift', id)} />
      )}
    </Sheet>
  );
}

/** 0.10.3: a small drawing of each kind of barcode, to pick the one on the card. */
function CodePicture({ type }: { type: GiftBarcodeType | 'auto' }) {
  if (type === 'QR')
    return (
      <svg viewBox="0 0 40 40" width="40" height="40" aria-hidden="true">
        <rect width="40" height="40" rx="4" fill="#fff" />
        {[
          [4, 4],
          [24, 4],
          [4, 24],
        ].map(([x, y]) => (
          <g key={`${x}${y}`}>
            <rect x={x} y={y} width="12" height="12" fill="#111" />
            <rect x={x + 3} y={y + 3} width="6" height="6" fill="#fff" />
          </g>
        ))}
        <path d="M22 22h4v4h-4zM28 26h4v4h-4zM24 30h4v6h-4zM32 22h4v4h-4zM32 32h4v4h-4z" fill="#111" />
      </svg>
    );
  if (type === 'auto')
    return (
      <svg viewBox="0 0 40 40" width="40" height="40" aria-hidden="true">
        <rect width="40" height="40" rx="4" fill="#fff" />
        <path d="M14 15a6 6 0 1 1 8.5 5.4c-1.6.8-2.5 2-2.5 3.6v1M20 30v.5" fill="none" stroke="#111" strokeWidth="3" strokeLinecap="round" />
      </svg>
    );
  const bars = [2, 1, 3, 1, 1, 2, 1, 3, 2, 1, 1, 2, 3, 1, 2];
  let x = 4;
  return (
    <svg viewBox="0 0 64 40" width="64" height="40" aria-hidden="true">
      <rect width="64" height="40" rx="4" fill="#fff" />
      {bars.map((w, i) => {
        const r = i % 2 === 0 ? <rect key={i} x={x} y="5" width={w * 1.3} height={type === 'EAN' ? 24 : 30} fill="#111" /> : null;
        x += w * 1.3 + 1.2;
        return r;
      })}
      {type === 'EAN' && (
        <text x="32" y="37" textAnchor="middle" fontSize="8" fontFamily="monospace" fill="#111">
          9 312345 678901
        </text>
      )}
    </svg>
  );
}

const CODE_KINDS: { id: GiftBarcodeType | 'auto'; name: string; sub: string }[] = [
  { id: 'CODE128', name: 'Barcode', sub: 'Black lines, like most loyalty cards' },
  { id: 'EAN', name: 'Barcode with numbers under it', sub: 'Lines with a row of numbers' },
  { id: 'QR', name: 'QR code', sub: 'A square of dots' },
  { id: 'auto', name: "Not sure", sub: 'Scan it and Restock works it out' },
];

/**
 * 0.10.3: Set up a card, in three steps: what kind of barcode is on it (with a picture of each),
 * scan it (or type its number), then whose card it is, from a search of the cards Restock knows
 * (Flybuys, Everyday Rewards, IGA Rewards, Bunnings PowerPass, Petbarn and more) or Other with
 * any name. A known card is drawn in its shop's colours.
 */
function LoyaltyFields({ store, onAdded }: { store: CardStore; onAdded: (id: string) => void }) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [type, setType] = useState<GiftBarcodeType | 'auto'>('auto');
  const [number, setNumber] = useState('');
  const [q, setQ] = useState('');
  const [brand, setBrand] = useState<CardBrand>();
  // Other with the name typed: tapped, or nothing Restock knows matches it.
  const [other, setOther] = useState(false);
  const [error, setError] = useState<string>();

  const clean = number.replace(/\s+/g, '');
  const kind: GiftBarcodeType = type === 'auto' ? guessBarcodeType(clean) : type;
  const codeBad = clean ? barcodeProblem(clean, kind) : undefined;

  const scan = async () => {
    const out = await scanBarcode('Scan your card', CARD_SCAN);
    if (!out.ok) return;
    setNumber(out.code);
    if (type === 'auto') setType(guessBarcodeType(out.code));
  };

  // One save at a time, so a double tap doesn't add the card twice.
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const matches = searchBrands(q);
  const name = brand ? brand.name : other || (q.trim() && !matches.length) ? q.trim() : '';
  const save = async () => {
    if (!clean || !name || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    const card: LoyaltyCard = {
      id: uid(),
      program: brand?.program ?? 'other',
      label: brand && brand.program !== 'other' ? PROGRAMS[brand.program].name : name.slice(0, 80),
      number: clean,
      createdAt: nowIso(),
    };
    try {
      await store.addLoyalty(card);
      await store.setCodeType?.(card.id, kind).catch(() => undefined);
      onAdded(card.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const back = (to: 1 | 2) => (
    <button type="button" className="btn ghost small" style={{ alignSelf: 'flex-start', minHeight: 44 }} onClick={() => setStep(to)}>
      <span style={{ display: 'inline-flex', transform: 'rotate(180deg)' }}>
        <Icon name="chevron" size={16} />
      </span>{' '}
      Back
    </button>
  );

  if (step === 1)
    return (
      <>
        <div className="eyebrow">Step 1 of 3 · What's on the card?</div>
        <div className="cc-kinds" role="group" aria-label="Kind of barcode">
          {CODE_KINDS.map((k) => (
            <button
              key={k.id}
              type="button"
              className="cc-kind"
              aria-pressed={type === k.id}
              onClick={() => {
                setType(k.id);
                setStep(2);
              }}
            >
              <CodePicture type={k.id} />
              <span className="cc-kind-text">
                <span className="title" style={{ fontSize: 15 }}>
                  {k.name}
                </span>
                <span className="small">{k.sub}</span>
              </span>
            </button>
          ))}
        </div>
      </>
    );

  if (step === 2)
    return (
      <>
        {back(1)}
        <div className="eyebrow">Step 2 of 3 · Scan it</div>
        <button className="btn primary" type="button" onClick={() => void scan()}>
          <Icon name="scan" /> Scan the card
        </button>
        <label className="field">
          <span>Or type the number on it</span>
          <input
            className="input num"
            inputMode={kind === 'QR' ? 'text' : 'numeric'}
            autoComplete="off"
            value={number}
            onChange={(e) => setNumber(e.target.value)}
            placeholder="Card number"
          />
        </label>
        {clean && !codeBad && (
          <div className="barcode-panel">
            <CardCode value={clean} type={kind} cache={store.codeCache} />
          </div>
        )}
        {codeBad && (
          <p className="small" role="alert">
            {codeBad}
          </p>
        )}
        <button className="btn primary" disabled={!clean || !!codeBad} onClick={() => setStep(3)}>
          Next
        </button>
      </>
    );

  const found = matches;
  const typed = q.trim().toLowerCase();
  const exact = found.some((b) => b.name.toLowerCase() === typed || !!b.aka?.includes(typed));
  return (
    <>
      {back(2)}
      <div className="eyebrow">Step 3 of 3 · Whose card is it?</div>
      <SearchField
        value={q}
        onValue={(v) => {
          setQ(v);
          setBrand(undefined);
          setOther(false);
        }}
        placeholder="Type the shop, like Bunnings"
        aria-label="Search for the card's shop"
      />
      <div className="card flush cc-brands" role="list">
        {found.map((b) => (
          <button key={b.id} type="button" role="listitem" className="row" aria-pressed={brand?.id === b.id} onClick={() => (setBrand(b), setOther(false))}>
            <span className="swatch" style={{ background: b.bg }} aria-hidden="true" />
            <span className="grow">
              <span className="title" style={{ fontSize: 15 }}>
                {b.name}
              </span>
              <span className="small">{b.use}</span>
            </span>
            {brand?.id === b.id && <Icon name="check" size={18} />}
          </button>
        ))}
        {q.trim() && !exact && (
          <button type="button" role="listitem" className="row" aria-pressed={!brand && !!name} onClick={() => (setBrand(undefined), setOther(true))}>
            <span className="swatch other" aria-hidden="true" />
            <span className="grow">
              <span className="title" style={{ fontSize: 15 }}>
                Other: “{q.trim()}”
              </span>
              <span className="small">Any card with a barcode, called what you typed</span>
            </span>
            {!brand && !!name && <Icon name="check" size={18} />}
          </button>
        )}
        {!q.trim() && !brand && (
          <div className="row" role="listitem">
            <span className="small">Not listed? Type its name, and pick Other.</span>
          </div>
        )}
      </div>
      {brand && brand.program !== 'other' && <p className="small" style={{ margin: 0 }}>{brand.name}: member prices count once it's added.</p>}
      <p className="small">{keptText(store, 'loyalty')}</p>
      {error && (
        <p className="small" role="alert">
          {error}
        </p>
      )}
      <button className="btn primary" disabled={!name || saving} onClick={() => void save()}>
        {name ? `Add ${name}` : q.trim() ? 'Pick one above' : 'Pick or type a name'}
      </button>
    </>
  );
}

/** Change a gift card. */
export function EditGiftSheet({ store, card, onClose }: { store: CardStore; card: GiftCard; onClose: () => void }) {
  return (
    <Sheet title={`Change ${card.name}`} onClose={onClose}>
      <GiftFields store={store} card={card} onSaved={onClose} />
    </Sheet>
  );
}

type Side = 'front' | 'back';
/** A photo picked but not saved yet (base64), or taken off (null). */
type PendingPhotos = Partial<Record<Side, string | null>>;

function GiftFields({ store, card, onSaved }: { store: CardStore; card?: GiftCard; onSaved: (id: string) => void }) {
  const nav = useNav();
  const [name, setName] = useState(card?.name ?? '');
  const [barcode, setBarcode] = useState(card?.barcode ?? '');
  const [type, setType] = useState<GiftBarcodeType>(card?.barcodeType ?? 'CODE128');
  const [number, setNumber] = useState(card?.number ?? '');
  const [pin, setPin] = useState(card?.pin ?? '');
  const [showPin, setShowPin] = useState(false);
  const [balance, setBalance] = useState(card?.balance === undefined ? '' : String(card.balance));
  const [expiry, setExpiry] = useState(card?.expiry ?? '');
  const [remind, setRemind] = useState(card?.remindDays ?? 0);
  const [notes, setNotes] = useState(card?.notes ?? '');
  const [colour, setColour] = useState(card?.colour ?? CARD_COLOURS[0].id);
  const [photos, setPhotos] = useState<PendingPhotos>({});
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const inputs = { front: useRef<HTMLInputElement>(null), back: useRef<HTMLInputElement>(null) };

  const scan = async () => {
    const out = await scanBarcode('Scan the gift card', CARD_SCAN);
    if (!out.ok) return;
    setBarcode(out.code);
    setType(guessBarcodeType(out.code));
  };

  const codeProblem = barcodeProblem(barcode, type);
  const pinBad = pinProblem(pin);
  const balanceBad = balance.trim() && parseMoney(balance) === undefined ? 'Type the balance in dollars, like 50 or 37.50.' : undefined;
  const problem = !name.trim() ? undefined : (codeProblem ?? pinBad ?? balanceBad);

  const picked = async (side: Side, file?: File) => {
    if (!file) return;
    try {
      const data = await shrinkPhoto(file);
      setPhotos((p) => ({ ...p, [side]: data }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const has = (side: Side) => (photos[side] === null ? false : !!photos[side] || !!(side === 'front' ? card?.photoFront : card?.photoBack));

  const save = async () => {
    if (!name.trim() || problem || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError(undefined);
    try {
      const at = nowIso();
      const id = card?.id ?? uid();
      const amount = balance.trim() ? parseMoney(balance) : undefined;
      let next: GiftCard = {
        ...(card ?? { id, createdAt: at, colour }),
        id,
        name: name.trim(),
        barcode: barcode.trim() || undefined,
        barcodeType: type,
        number: number.replace(/\s+/g, '') || undefined,
        pin: pin.trim() || undefined,
        expiry: expiry || undefined,
        remindDays: expiry && remind ? remind : undefined,
        notes: notes.trim() || undefined,
        colour,
        updatedAt: at,
      } as GiftCard;
      // A balance typed here counts as an update (it goes in the history) when it changed.
      if (amount !== undefined && amount !== card?.balance) next = withBalance({ ...next, balance: card?.balance }, amount, at);
      else if (amount === undefined) next.balance = undefined;
      for (const side of ['front', 'back'] as Side[]) {
        const key = side === 'front' ? 'photoFront' : 'photoBack';
        const p = photos[side];
        if (p === null) {
          await store.deletePhoto(next[key]);
          next[key] = undefined;
        } else if (p) next[key] = await store.writePhoto(id, side, p);
      }
      await store.saveGift(next, card ? `${next.name} changed` : `${next.name} added`);
      if (next.remindDays && store.canRemind && !(await ensureNotificationPermission())) {
        nav.toast('Saved. To get the reminder, allow notifications for Restock in Android settings.');
      }
      onSaved(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  return (
    <>
      <label className="field">
        <span>Card or shop name</span>
        <input className="input" value={name} maxLength={200} onChange={(e) => setName(e.target.value)} placeholder="e.g. Bunnings" />
      </label>

      <label className="field">
        <span>Barcode</span>
        <input
          className="input num"
          autoComplete="off"
          value={barcode}
          onChange={(e) => setBarcode(e.target.value)}
          placeholder="Type it or scan the card"
          aria-describedby={codeProblem ? 'gc-code-problem' : undefined}
        />
      </label>
      <button className="btn" type="button" onClick={scan}>
        <Icon name="scan" /> Scan the card's barcode
      </button>
      <div className="field">
        <span id="gc-type">Barcode type</span>
        <div className="seg cc-seg" role="group" aria-labelledby="gc-type">
          {BARCODE_TYPES.map((b) => (
            <button key={b.id} type="button" aria-pressed={type === b.id} onClick={() => setType(b.id)}>
              {b.name}
            </button>
          ))}
        </div>
        {codeProblem && (
          <span className="small" id="gc-code-problem" role="alert">
            {codeProblem}
          </span>
        )}
      </div>

      <label className="field">
        <span>Card number</span>
        <input className="input num" autoComplete="off" value={number} onChange={(e) => setNumber(e.target.value)} placeholder="The number printed on the card" />
      </label>
      {barcode.trim() && !number.trim() && (
        <button className="linkish small cc-link" type="button" onClick={() => setNumber(barcode.trim())}>
          Same as the barcode
        </button>
      )}

      <div className="field">
        <label htmlFor="gc-pin">
          <span className="cc-label">PIN</span>
        </label>
        <div className="cc-inline">
          <input
            id="gc-pin"
            className="input num"
            type={showPin ? 'text' : 'password'}
            inputMode="numeric"
            autoComplete="off"
            maxLength={8}
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
            placeholder="4 to 8 digits, if it has one"
          />
          <button className="btn" type="button" onClick={() => setShowPin((v) => !v)} aria-pressed={showPin}>
            {showPin ? 'Hide' : 'Show'}
          </button>
        </div>
        {pinBad && pin && (
          <span className="small" role="alert">
            {pinBad}
          </span>
        )}
      </div>

      <label className="field">
        <span>Balance</span>
        <input className="input num" inputMode="decimal" autoComplete="off" value={balance} onChange={(e) => setBalance(e.target.value)} placeholder="$0.00" />
        {balanceBad && (
          <span className="small" role="alert">
            {balanceBad}
          </span>
        )}
      </label>

      <label className="field">
        <span>Expiry date</span>
        <input className="input" type="date" value={expiry} onChange={(e) => setExpiry(e.target.value)} />
      </label>
      {expiry &&
        (store.canRemind ? (
          <label className="field">
            <span>Remind me</span>
            <select className="input" value={remind} onChange={(e) => setRemind(Number(e.target.value))}>
              {REMIND_CHOICES.map((c) => (
                <option key={c.days} value={c.days}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <p className="small" style={{ margin: 0 }}>
            Expiry reminders come from the Restock app on a phone. The web page shows how long is left.
          </p>
        ))}

      <label className="field">
        <span>Notes</span>
        <textarea className="input cc-notes" value={notes} maxLength={1000} onChange={(e) => setNotes(e.target.value)} placeholder="Where it came from, what it's for" />
      </label>

      <div className="field">
        <span>Photos (optional)</span>
        <div className="cc-photos">
          {(['front', 'back'] as Side[]).map((side) => (
            <div key={side} className="cc-photo-pick">
              <input ref={inputs[side]} type="file" accept="image/*" capture="environment" hidden onChange={(e) => void picked(side, e.target.files?.[0])} />
              <button className="btn" type="button" onClick={() => inputs[side].current?.click()}>
                <Icon name="camera" size={18} /> {has(side) ? `New photo of the ${side}` : `Photo of the ${side}`}
              </button>
              {has(side) && (
                <button className="btn" type="button" onClick={() => setPhotos((p) => ({ ...p, [side]: null }))} aria-label={`Take off the ${side} photo`}>
                  <Icon name="trash" size={18} />
                </button>
              )}
            </div>
          ))}
        </div>
        <span className="small">{store.where === 'browser' ? 'Kept in this browser only.' : "Kept in Restock's own storage, not your gallery."}</span>
      </div>

      <div className="field">
        <span id="gc-colour">Colour</span>
        <div className="cc-colours" role="radiogroup" aria-labelledby="gc-colour">
          {CARD_COLOURS.map((c) => (
            <button
              key={c.id}
              type="button"
              role="radio"
              aria-checked={colour === c.id}
              aria-label={c.name}
              className="cc-colour"
              style={{ background: c.bg, color: c.ink }}
              onClick={() => setColour(c.id)}
            >
              {colour === c.id && <Icon name="check" size={18} />}
            </button>
          ))}
        </div>
      </div>

      <p className="small">{keptText(store, 'gift')}</p>
      {error && (
        <p className="small" role="alert">
          {error}
        </p>
      )}
      <button className="btn primary" disabled={!name.trim() || !!problem || saving} onClick={() => void save()}>
        {card ? 'Save changes' : 'Add gift card'}
      </button>
    </>
  );
}

/** "Update balance": the new balance, or what was just spent. */
export function BalanceSheet({ store, card, onClose }: { store: CardStore; card: GiftCard; onClose: () => void }) {
  const [how, setHow] = useState<'balance' | 'spent'>(card.balance === undefined ? 'balance' : 'spent');
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const amount = parseMoney(text);
  const next = amount === undefined ? undefined : how === 'balance' ? amount : (card.balance ?? 0) - amount;
  const problem =
    text.trim() && amount === undefined
      ? 'Type an amount in dollars, like 12.50.'
      : next !== undefined && next < 0
        ? `That's more than the ${money(card.balance ?? 0)} left.`
        : undefined;
  const save = async () => {
    if (next === undefined || problem || saving) return;
    setSaving(true);
    try {
      await store.saveGift(withBalance(card, next, nowIso()), `${card.name}: balance ${money(next)}`);
      onClose();
    } finally {
      setSaving(false);
    }
  };
  return (
    <Sheet title="Update balance" onClose={onClose}>
      <p className="small" style={{ margin: 0 }}>
        {card.balance === undefined ? `${card.name} has no balance yet.` : `${card.name} has ${money(card.balance)} left.`}
      </p>
      <div className="seg cc-seg" role="group" aria-label="What to type">
        <button type="button" aria-pressed={how === 'spent'} disabled={card.balance === undefined} onClick={() => setHow('spent')}>
          I spent
        </button>
        <button type="button" aria-pressed={how === 'balance'} onClick={() => setHow('balance')}>
          New balance
        </button>
      </div>
      <label className="field">
        <span>{how === 'spent' ? 'Amount spent' : 'Balance now'}</span>
        <input className="input num" inputMode="decimal" autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder="$0.00" />
      </label>
      {problem ? (
        <p className="small" role="alert">
          {problem}
        </p>
      ) : (
        next !== undefined && how === 'spent' && <p className="small">{money(next)} left after this.</p>
      )}
      <button className="btn primary" disabled={next === undefined || !!problem || saving} onClick={() => void save()}>
        Save balance
      </button>
    </Sheet>
  );
}
