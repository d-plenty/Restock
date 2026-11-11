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
import { Icon, Sheet } from '../components';
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
          ? 'Flybuys, Everyday Rewards or another member card. Member prices count once the card is added.'
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

function LoyaltyFields({ store, onAdded }: { store: CardStore; onAdded: (id: string) => void }) {
  const [program, setProgram] = useState<CardProgram>('flybuys');
  const [label, setLabel] = useState('');
  const [number, setNumber] = useState('');
  const [error, setError] = useState<string>();

  const scan = async () => {
    const out = await scanBarcode('Scan your card', CARD_SCAN);
    if (out.ok) setNumber(out.code);
  };

  // One save at a time, so a double tap doesn't add the card twice.
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const save = async () => {
    const clean = number.replace(/\s+/g, '');
    if (!clean || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    const card: LoyaltyCard = {
      id: uid(),
      program,
      label: program === 'other' ? label.trim() || 'Card' : PROGRAMS[program].name,
      number: clean,
      createdAt: nowIso(),
    };
    try {
      await store.addLoyalty(card);
      onAdded(card.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  return (
    <>
      <div className="seg cc-seg" role="group" aria-label="Card type">
        {(Object.keys(PROGRAMS) as CardProgram[]).map((p) => (
          <button key={p} type="button" aria-pressed={program === p} onClick={() => setProgram(p)}>
            {p === 'other' ? 'Other' : PROGRAMS[p].name}
          </button>
        ))}
      </div>
      {program === 'other' && (
        <label className="field">
          <span>Card name</span>
          <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Library card" />
        </label>
      )}
      <label className="field">
        <span>Card number</span>
        <input
          className="input num"
          inputMode="numeric"
          autoComplete="off"
          value={number}
          onChange={(e) => setNumber(e.target.value)}
          placeholder="Type it or scan the card"
        />
      </label>
      <button className="btn" type="button" onClick={scan}>
        <Icon name="scan" /> Scan the card's barcode
      </button>
      <p className="small">{keptText(store, 'loyalty')}</p>
      {error && (
        <p className="small" role="alert">
          {error}
        </p>
      )}
      <button className="btn primary" disabled={!number.trim() || saving} onClick={save}>
        Add card
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
