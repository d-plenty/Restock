// The Cards screen (0.9.6: was "Loyalty cards"): loyalty cards and gift cards, with each card's
// barcode drawn big for the till. The same screen on the phone and the web; `store` says where the
// cards live (lib/cardStore.ts: the phone's database, or on the web this browser only).
import { useResetOn } from '../useResetOn';
import { isLocked, lockBackup, unlockBackup } from '../../lib/backupLock';
import JsBarcode from 'jsbarcode';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { scheduleCardReminders } from '../../lib/cardReminders';
import { phoneCards, type CardStore } from '../../lib/cardStore';
import { askPassword, confirmAction } from '../../lib/confirm';
import {
  cardsCount,
  cardsFileName,
  CARDS_FILE_PRIVATE,
  colourOf,
  expiryState,
  makeCardsFile,
  masked,
  money,
  readCardsFile,
  spendLines,
} from '../../lib/giftCards';
import { shareTextFile } from '../../lib/shareFile';
import { localDay } from '../../lib/verdict';
import type { GiftBarcodeType, GiftCard, LoyaltyCard } from '../../types';
import { brandOf, loyaltyCodeType } from '../../lib/cardBrands';
import { Icon, LoadingBar, Sheet, TopBar } from '../components';
import { useNav } from '../nav';
import { CardCode } from './CardCode';
import { AddCardSheet, BalanceSheet, EditGiftSheet, keptText, PROGRAMS } from './CardForm';
import '../cards.css';

export { PROGRAMS };

/** A loyalty card's barcode (Code 128), as shop mode on the Shopping list shows it too. */
export function CardBarcode({ value }: { value: string }) {
  const ref = useRef<SVGSVGElement>(null);
  // The number that couldn't be drawn (a new number gets its own try).
  const [failedFor, setFailedFor] = useState<string>();
  const failed = failedFor === value;
  useEffect(() => {
    if (!ref.current) return;
    try {
      JsBarcode(ref.current, value, { format: 'CODE128', displayValue: false, height: 90, margin: 0, width: 2.2 });
    } catch {
      // The drawing library is what says the number can't be drawn.
      // eslint-disable-next-line react/set-state-in-effect
      setFailedFor(value);
    }
  }, [value]);
  return failed ? (
    <p className="small">This number can't be drawn as a barcode. Show the number at checkout.</p>
  ) : (
    <svg ref={ref} role="img" aria-label="Card barcode" />
  );
}

/** The cards in a store, read again whenever they change. */
function useCards(store: CardStore): { loyalty: LoyaltyCard[]; gifts: GiftCard[] } | undefined {
  const [v, setV] = useState<{ loyalty: LoyaltyCard[]; gifts: GiftCard[] }>();
  useEffect(() => {
    let alive = true;
    let run = 0;
    const load = () => {
      const mine = ++run;
      void Promise.all([store.loyalty(), store.gifts()])
        .then(([loyalty, gifts]) => alive && mine === run && setV({ loyalty, gifts }))
        .catch(() => alive && mine === run && setV((x) => x ?? { loyalty: [], gifts: [] }));
    };
    load();
    const off = store.onChange(load);
    return () => {
      alive = false;
      off();
    };
  }, [store]);
  return v;
}

type Pick = { kind: 'loyalty' | 'gift'; id: string };
const loyaltyName = (c: LoyaltyCard) => (c.program === 'other' ? c.label : (PROGRAMS[c.program]?.name ?? c.label));
// 0.10.3: a known card (by its name: Bunnings PowerPass, IGA Rewards) is drawn in its shop's colours.
const loyaltyUse = (c: LoyaltyCard) => (c.program === 'other' ? (brandOf(c)?.use ?? PROGRAMS.other.use) : (PROGRAMS[c.program]?.use ?? ''));
function loyaltySwatch(c: LoyaltyCard) {
  const b = c.program === 'other' ? brandOf(c) : undefined;
  return <span className={`swatch ${b ? 'brand' : c.program}`} style={b ? { background: b.bg } : undefined} aria-hidden="true" />;
}
const shortDay = (iso: string) => new Date(iso).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });

export function CardsScreen({
  store = phoneCards,
  intro,
  extra,
  back = true,
}: {
  store?: CardStore;
  /** Above the cards (the web: where its cards are kept). */
  intro?: ReactNode;
  /** Below everything (the web: the loyalty cards the phones share, names only). */
  extra?: ReactNode;
  back?: boolean;
}) {
  const data = useCards(store);
  const nav = useNav();
  const [picked, setPicked] = useState<Pick>();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<GiftCard>();
  const [balanceOf, setBalanceOf] = useState<GiftCard>();
  const [showUsed, setShowUsed] = useState(false);
  const [msg, setMsg] = useState<string>();
  const fileInput = useRef<HTMLInputElement>(null);

  // The phone: reminders follow the cards (after an Undo or a restore, too), once each time Cards opens.
  const rescheduled = useRef(false);
  useEffect(() => {
    if (!data || store.where !== 'phone' || rescheduled.current) return;
    rescheduled.current = true;
    void scheduleCardReminders(data.gifts, data.loyalty);
  }, [data, store]);

  if (!data) return <div className="screen" />;
  const { loyalty, gifts } = data;
  const active = gifts.filter((g) => !g.usedUp);
  const used = gifts.filter((g) => g.usedUp);
  const selLoyalty = picked?.kind === 'loyalty' ? loyalty.find((c) => c.id === picked.id) : undefined;
  const selGift = picked?.kind === 'gift' ? gifts.find((c) => c.id === picked.id) : undefined;
  // Nothing picked (or it's gone): the first loyalty card, else the first gift card.
  const shownLoyalty = selLoyalty ?? (!selGift ? loyalty[0] : undefined);
  const shownGift = selGift ?? (!shownLoyalty ? active[0] : undefined);
  const say = (m: string) => (store.undoable ? nav.toast(m) : setMsg(m));

  const removeLoyalty = async (c: LoyaltyCard) => {
    if (!store.undoable && !(await confirmAction(`Delete ${loyaltyName(c)}?`, { detail: 'It goes from this browser.', action: 'Delete' }))) return;
    setPicked(undefined);
    await store.removeLoyalty(c.id);
  };
  const removeGift = async (g: GiftCard) => {
    const ok = await confirmAction(`Delete ${g.name}?`, {
      detail: store.undoable
        ? 'Its number, PIN, balance history and photos go from this phone. Undo brings it back for a while.'
        : 'Its number, PIN, balance history and photos go from this browser.',
      action: 'Delete',
    });
    if (!ok) return;
    setPicked(undefined);
    await store.removeGift(g);
  };
  const setUsed = async (g: GiftCard, usedUp: boolean) => {
    await store.saveGift({ ...g, usedUp: usedUp || undefined, updatedAt: new Date().toISOString() }, usedUp ? `${g.name} moved to Used up` : `${g.name} put back`);
    if (usedUp) setPicked(undefined);
  };

  // ---------- the cards file ----------
  const saveFile = async () => {
    if (!loyalty.length && !gifts.length) return say('No cards to save yet.');
    // 0.11.0: the file is locked with a passphrase (it was plain text: anyone who got the file had
    // every card number and PIN). The same lock as a backup's (backupLock.ts).
    const pw = await askPassword('Passphrase for this cards file', {
      detail: `${CARDS_FILE_PRIVATE} You'll need this passphrase to open the file, here or on another phone. At least 8 characters.`,
      action: 'Next',
    });
    if (pw === undefined) return;
    if (pw.length < 8) return say('Use at least 8 characters. Nothing was saved.');
    const again = await askPassword('Type it again', { action: 'Save the file' });
    if (again === undefined) return;
    if (again !== pw) return say("Those didn't match. Nothing was saved.");
    const photos: Record<string, string> = {};
    for (const g of gifts)
      for (const side of ['front', 'back'] as const) {
        const data = await store.readPhoto(side === 'front' ? g.photoFront : g.photoBack);
        if (data) photos[`${g.id}:${side}`] = data;
      }
    const name = cardsFileName(localDay(new Date().toISOString()));
    await shareTextFile(name, await lockBackup(makeCardsFile(loyalty, gifts, photos), pw), 'application/json', 'Restock cards (private)');
    say(`Saved ${cardsCount(loyalty.length, gifts.length)}: ${name}, locked with your passphrase.`);
  };
  const openFile = async (file?: File) => {
    if (fileInput.current) fileInput.current.value = '';
    if (!file) return;
    try {
      let text = await file.text();
      // 0.11.0: a locked file asks for its passphrase (a file saved before 0.11.0 isn't locked, and still opens)
      if (isLocked(text)) {
        const pw = await askPassword('Passphrase for this cards file', { detail: 'The one typed in when the file was saved.', action: 'Open the file' });
        if (pw === undefined) return;
        try {
          text = await unlockBackup(text, pw);
        } catch (e) {
          return say(e instanceof Error && /isn.t one Restock made/.test(e.message) ? e.message : "That passphrase didn't open the file.");
        }
      }
      const got = readCardsFile(text);
      // Already here (same card, or the same loyalty number): passed over.
      const haveL = new Set(loyalty.flatMap((c) => [c.id, `${c.program}|${c.number}`]));
      const newL = got.loyalty.filter((c) => !haveL.has(c.id) && !haveL.has(`${c.program}|${c.number}`));
      const haveG = new Map(gifts.map((g) => [g.id, g]));
      if (!newL.length && !got.gift.length) return say(got.skipped ? "None of the cards in that file could be read." : 'Those cards are already here.');
      const ok = await confirmAction(`Add ${cardsCount(newL.length, got.gift.length)}?`, {
        detail: `${got.gift.some((g) => haveG.has(g.id)) ? 'A gift card that is already here is replaced by the one in the file. ' : ''}No card here is removed. ${keptText(store, 'gift')}`,
        action: 'Add them',
        danger: false,
      });
      if (!ok) return;
      for (const c of newL) await store.addLoyalty(c);
      for (const g of got.gift) {
        const had = haveG.get(g.id);
        const next: GiftCard = { ...g, photoFront: had?.photoFront, photoBack: had?.photoBack };
        for (const side of ['front', 'back'] as const) {
          const p = got.photos[`${g.id}:${side}`];
          if (p) next[side === 'front' ? 'photoFront' : 'photoBack'] = await store.writePhoto(g.id, side, p);
        }
        await store.saveGift(next, `${g.name} added from a file`);
      }
      say(`Added ${cardsCount(newL.length, got.gift.length)}.${got.skipped ? ` ${got.skipped} couldn't be read.` : ''} You can delete the file now.`);
    } catch (e) {
      say(e instanceof Error ? e.message : String(e));
    }
  };

  const listRow = (key: string, kind: Pick['kind'], title: string, sub: string, swatch: ReactNode, on: boolean) => (
    <button key={key} className={`card cc-row${on ? ' on' : ''}`} onClick={() => setPicked({ kind, id: key })} aria-current={on ? 'true' : undefined}>
      {swatch}
      <span className="cc-row-text">
        <span className="title">{title}</span>
        <span className="small">{sub}</span>
      </span>
      {on ? <span className="small cc-showing">Showing</span> : <Icon name="chevron" size={18} />}
    </button>
  );
  const giftSub = (g: GiftCard) => {
    const e = expiryState(g);
    return [g.balance !== undefined ? `${money(g.balance)} left` : 'Gift card', e.kind === 'expired' || e.kind === 'soon' ? e.text : ''].filter(Boolean).join(' · ');
  };
  const giftSwatch = (g: GiftCard) => <span className="swatch" style={{ background: colourOf(g.colour).bg }} aria-hidden="true" />;

  return (
    <div className="screen">
      <TopBar title="Cards" back={back} />
      {intro}

      {shownLoyalty && <LoyaltyView store={store} card={shownLoyalty} />}
      {shownGift && <GiftView key={shownGift.id} store={store} card={shownGift} />}

      {shownGift && (
        <div className="cc-actions">
          <button className="btn primary" onClick={() => setBalanceOf(shownGift)}>
            Update balance
          </button>
          <button className="btn" onClick={() => setEditing(shownGift)}>
            <Icon name="pencil" size={18} /> Change
          </button>
          <button className="btn" onClick={() => void setUsed(shownGift, !shownGift.usedUp)}>
            {shownGift.usedUp ? 'Put back' : 'Used up'}
          </button>
          <button className="btn danger" onClick={() => void removeGift(shownGift)}>
            <Icon name="trash" size={18} /> Delete
          </button>
        </div>
      )}
      {shownGift && <GiftDetails store={store} card={shownGift} />}

      {loyalty.length > 0 && <div className="eyebrow">Loyalty cards</div>}
      {loyalty.map((c) =>
        listRow(c.id, 'loyalty', loyaltyName(c), loyaltyUse(c), loyaltySwatch(c), c.id === shownLoyalty?.id),
      )}
      {active.length > 0 && <div className="eyebrow">Gift cards</div>}
      {active.map((g) => listRow(g.id, 'gift', g.name, giftSub(g), giftSwatch(g), g.id === shownGift?.id))}

      <button className="btn add" onClick={() => setAdding(true)}>
        <Icon name="plus" size={18} /> Add a card
      </button>

      {shownLoyalty && <LoyaltyExpiry key={shownLoyalty.id} store={store} card={shownLoyalty} />}

      {shownLoyalty && (
        <button className="btn danger" onClick={() => void removeLoyalty(shownLoyalty)}>
          <Icon name="trash" size={18} /> Delete this card
        </button>
      )}

      {used.length > 0 && (
        <>
          <button className="btn cc-used-toggle" aria-expanded={showUsed} onClick={() => setShowUsed((v) => !v)}>
            Used up ({used.length}) <Icon name={showUsed ? 'up' : 'down'} size={18} />
          </button>
          {showUsed && used.map((g) => listRow(g.id, 'gift', g.name, 'Used up', giftSwatch(g), g.id === shownGift?.id))}
        </>
      )}

      <div className="banner grey" style={{ fontSize: 13 }}>
        Without a linked loyalty card, member-only prices are shown but never count as your best price.
      </div>

      <div className="card">
        <h2 className="cc-h2">Move your cards</h2>
        <p className="small" style={{ margin: 0 }}>
          {store.where === 'browser'
            ? 'Save them to a private file, then open it in Restock on your phone (Cards → Open a cards file), or the other way round.'
            : 'Save them to a private file, then open it in the Restock web page or on another phone, or the other way round.'}{' '}
          The file has your card numbers and PINs, so it's locked with a passphrase you choose.
        </p>
        {/* 0.12.6: one under the other (side by side their words wrapped to two and three lines) */}
        <div className="stack-btns">
          <button className="btn" onClick={() => void saveFile()}>
            <Icon name="download" size={18} /> Save cards to a file
          </button>
          <button className="btn" onClick={() => fileInput.current?.click()}>
            <Icon name="folder" size={18} /> Open a cards file
          </button>
        </div>
        <input ref={fileInput} type="file" accept="application/json,.json" hidden onChange={(e) => void openFile(e.target.files?.[0])} />
        {msg && (
          <p className="small" role="status">
            {msg}
          </p>
        )}
      </div>

      {extra}

      {adding && (
        <AddCardSheet
          store={store}
          onClose={() => setAdding(false)}
          onAdded={(kind, id) => {
            setAdding(false);
            setPicked({ kind, id });
          }}
        />
      )}
      {editing && <EditGiftSheet store={store} card={editing} onClose={() => setEditing(undefined)} />}
      {balanceOf && <BalanceSheet store={store} card={balanceOf} onClose={() => setBalanceOf(undefined)} />}
    </div>
  );
}

function LoyaltyView({ store, card }: { store: CardStore; card: LoyaltyCard }) {
  const [reveal, setReveal] = useState(false);
  const [types, setTypes] = useState<Partial<Record<string, GiftBarcodeType>>>();
  useResetOn([card.id], () => setReveal(false));
  useEffect(() => {
    let alive = true;
    void (store.codeTypes?.() ?? Promise.resolve({})).then((t) => alive && setTypes(t)).catch(() => alive && setTypes({}));
    return () => {
      alive = false;
    };
  }, [store, card.id]);
  const b = card.program === 'other' ? brandOf(card) : undefined;
  return (
    <div className={`loyalty ${b ? 'brand' : card.program}`} style={b ? { background: b.bg, color: b.ink } : undefined}>
      <div className="cc-head">
        <div className="cc-name">{loyaltyName(card)}</div>
        <div style={{ fontSize: 12 }}>{loyaltyUse(card).split(',')[0]}</div>
      </div>
      <div className="barcode-panel">
        {types ? <CardCode value={card.number} type={loyaltyCodeType(card, types)} cache={store.codeCache} /> : <LoadingBar seconds={1} />}
        <button className="num cc-reveal" onClick={() => setReveal((v) => !v)} aria-label={reveal ? 'Hide card number' : 'Show card number'}>
          {reveal ? card.number : masked(card.number)}
        </button>
      </div>
      <div style={{ fontSize: 13, textAlign: 'center' }}>Turn your screen brightness up at the checkout.</div>
    </div>
  );
}

/** 0.14.0: a loyalty card's expiry date: shown, and set or changed here. */
function LoyaltyExpiry({ store, card }: { store: CardStore; card: LoyaltyCard }) {
  const [value, setValue] = useState(card.expiry ?? '');
  const e = expiryState(card);
  const save = (v: string) => {
    setValue(v);
    if (v !== (card.expiry ?? '') && (v === '' || /^\d{4}-\d{2}-\d{2}$/.test(v))) void store.setLoyaltyExpiry(card.id, v || undefined);
  };
  return (
    <div className="card flush">
      <label className="check">
        <span style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
          <span className="title" style={{ fontSize: 15 }}>
            Expiry date
          </span>
          <span className="small" style={e.kind === 'expired' || e.kind === 'soon' ? { color: e.kind === 'expired' ? 'var(--red-ink)' : 'var(--amber-ink, inherit)', fontWeight: 700 } : undefined}>
            {e.kind === 'none' ? 'Optional. Restock tells you a month before the card runs out.' : e.text}
          </span>
        </span>
        <input className="input" style={{ width: 'auto' }} type="date" value={value} aria-label="Expiry date" onChange={(ev) => save(ev.target.value)} />
      </label>
      {card.expiry && (
        <button className="row" onClick={() => save('')}>
          <span className="grow">
            <span className="small" style={{ fontWeight: 700 }}>
              Remove the expiry date
            </span>
          </span>
        </button>
      )}
    </div>
  );
}

/** The expiry on the card itself: "3 December 2027", "In 12 days", "Today", "Expired". */
function expiryShort(card: GiftCard): string {
  const e = expiryState(card);
  if (e.kind === 'none') return 'None set';
  if (e.kind === 'expired') return 'Expired';
  if (e.kind === 'soon') return e.days === 0 ? 'Today' : e.days === 1 ? 'Tomorrow' : `In ${e.days} days`;
  return e.text.replace(/^Expires /, '');
}

function GiftView({ store, card }: { store: CardStore; card: GiftCard }) {
  const [reveal, setReveal] = useState(false);
  const [pin, setPin] = useState(false);
  const c = colourOf(card.colour);
  const e = expiryState(card);
  const code = card.barcode ?? '';
  return (
    <div className="giftcard" style={{ background: c.bg, color: c.ink }}>
      <div className="cc-head">
        <div className="cc-name">{card.name}</div>
        <div style={{ fontSize: 12 }}>{card.usedUp ? 'Gift card · used up' : 'Gift card'}</div>
      </div>
      {(code || card.number) && (
        <div className="barcode-panel">
          {code && <CardCode value={code} type={card.barcodeType} cache={store.codeCache} />}
          {card.number && (
            <button className="num cc-reveal" onClick={() => setReveal((v) => !v)} aria-label={reveal ? 'Hide card number' : 'Show card number'}>
              {reveal ? card.number : masked(card.number)}
            </button>
          )}
        </div>
      )}
      <div className="cc-facts">
        <div>
          <span className="cc-fact-label">Balance</span>
          <span className="cc-fact num">{card.balance === undefined ? 'Not set' : money(card.balance)}</span>
        </div>
        <div>
          <span className="cc-fact-label">Expiry</span>
          <span className={`cc-fact${e.kind === 'soon' || e.kind === 'expired' ? ' cc-warn' : ''}`}>
            {expiryShort(card)}
          </span>
        </div>
      </div>
      {card.pin && (
        <button className="cc-pin num" onClick={() => setPin((v) => !v)} aria-label={pin ? 'Hide PIN' : 'Show PIN'} aria-live="polite">
          {pin ? `PIN ${card.pin}` : 'PIN •••• (tap to show)'}
        </button>
      )}
      {code && <div style={{ fontSize: 13, textAlign: 'center' }}>Turn your screen brightness up at the till.</div>}
    </div>
  );
}

function GiftDetails({ store, card }: { store: CardStore; card: GiftCard }) {
  const [photos, setPhotos] = useState<{ front?: string; back?: string }>({});
  const [big, setBig] = useState<'front' | 'back'>();
  useEffect(() => {
    let alive = true;
    void Promise.all([store.readPhoto(card.photoFront), store.readPhoto(card.photoBack)]).then(([front, back]) => alive && setPhotos({ front, back }));
    return () => {
      alive = false;
    };
  }, [store, card.photoFront, card.photoBack, card.updatedAt]);
  const lines = spendLines(card);
  const e = expiryState(card);
  return (
    <>
      {e.kind === 'soon' && (
        <div className="banner" role="note">
          <Icon name="alert" size={18} /> {e.text}. Use it before then.
        </div>
      )}
      {e.kind === 'expired' && (
        <div className="banner grey" role="note">
          {e.text}. Some shops still take an expired card: ask at the counter.
        </div>
      )}
      {(photos.front || photos.back) && (
        <div className="cc-thumbs">
          {(['front', 'back'] as const).map(
            (side) =>
              photos[side] && (
                <button key={side} className="cc-thumb" onClick={() => setBig(side)} aria-label={`Show the photo of the ${side}`}>
                  <img src={`data:image/jpeg;base64,${photos[side]}`} alt="" />
                  <span className="small">{side === 'front' ? 'Front' : 'Back'}</span>
                </button>
              ),
          )}
        </div>
      )}
      {card.notes && (
        <div className="card">
          <span className="small">Notes</span>
          <span className="cc-notes-text">{card.notes}</span>
        </div>
      )}
      {lines.length > 0 && (
        <div className="card flush">
          <div className="cc-h2 cc-pad">Balance history</div>
          {lines.map((l, i) => (
            <div key={`${l.at}-${i}`} className="cc-hist">
              <span>{shortDay(l.at)}</span>
              <span className="small">{l.change === undefined ? 'Starting balance' : l.change < 0 ? `Spent ${money(-l.change)}` : l.change > 0 ? `Added ${money(l.change)}` : 'Checked'}</span>
              <span className="num cc-hist-bal">{money(l.balance)}</span>
            </div>
          ))}
        </div>
      )}
      {big && photos[big] && (
        <Sheet title={big === 'front' ? 'Front of the card' : 'Back of the card'} onClose={() => setBig(undefined)}>
          <img className="cc-big" src={`data:image/jpeg;base64,${photos[big]}`} alt={`The ${big} of the ${card.name} card`} />
        </Sheet>
      )}
    </>
  );
}
