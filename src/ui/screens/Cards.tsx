import JsBarcode from 'jsbarcode';
import { useEffect, useRef, useState } from 'react';
import { scanBarcode } from '../../lib/barcode';
import { addCard, allCards, deleteCard, nowIso, uid } from '../../lib/db';
import { cardRows, undoable } from '../../lib/undo';
import { useLive } from '../../lib/useLive';
import type { CardProgram, LoyaltyCard } from '../../types';
import { Icon, Sheet, TopBar } from '../components';
import { useNav } from '../nav';

export const PROGRAMS: Record<CardProgram, { name: string; use: string }> = {
  flybuys: { name: 'Flybuys', use: 'Coles member prices' },
  everyday: { name: 'Everyday Rewards', use: 'Woolworths member prices' },
  other: { name: 'Other card', use: 'Any barcode card — not linked to prices' },
};

export function CardBarcode({ value }: { value: string }) {
  const ref = useRef<SVGSVGElement>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!ref.current) return;
    try {
      JsBarcode(ref.current, value, { format: 'CODE128', displayValue: false, height: 90, margin: 0, width: 2.2 });
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [value]);
  return failed ? (
    <p className="small">This number can't be drawn as a barcode. Show the number at checkout.</p>
  ) : (
    <svg ref={ref} role="img" aria-label="Card barcode" />
  );
}

export function CardsScreen() {
  const nav = useNav();
  const cards = useLive(allCards, []);
  const [selectedId, setSelectedId] = useState<string>();
  const [adding, setAdding] = useState(false);
  const [reveal, setReveal] = useState(false);

  if (!cards) return <div className="screen" />;
  const selected = cards.find((c) => c.id === selectedId) ?? cards[0];

  return (
    <div className="screen">
      <TopBar title="Loyalty cards" />

      {selected && (
        <div className={`loyalty ${selected.program}`}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
            <div style={{ fontSize: 20, fontWeight: 700 }}>{selected.program === 'other' ? selected.label : PROGRAMS[selected.program].name}</div>
            <div style={{ fontSize: 12 }}>{PROGRAMS[selected.program].use.split('—')[0]}</div>
          </div>
          <div className="barcode-panel">
            <CardBarcode value={selected.number} />
            <button
              className="num"
              style={{ border: 'none', background: 'none', fontSize: 15, letterSpacing: 2 }}
              onClick={() => setReveal((v) => !v)}
              aria-label={reveal ? 'Hide card number' : 'Show card number'}
            >
              {reveal ? selected.number : `•••• ${selected.number.slice(-4)}`}
            </button>
          </div>
          <div style={{ fontSize: 13, textAlign: 'center' }}>Turn your screen brightness up at the checkout.</div>
        </div>
      )}

      <div className="eyebrow">Your cards</div>
      {cards.map((c) => (
        <button
          key={c.id}
          className="card"
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            textAlign: 'left',
            borderWidth: c.id === selected?.id ? 2 : 1,
            borderColor: c.id === selected?.id ? 'var(--green)' : undefined,
          }}
          onClick={() => setSelectedId(c.id)}
        >
          <span className={`swatch ${c.program}`} aria-hidden="true" />
          <span style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 1 }}>
            <span className="title">{c.program === 'other' ? c.label : PROGRAMS[c.program].name}</span>
            <span className="small">{PROGRAMS[c.program].use}</span>
          </span>
          {c.id === selected?.id ? (
            <span className="small" style={{ color: 'var(--green)', fontWeight: 700 }}>
              Showing
            </span>
          ) : (
            <Icon name="chevron" size={18} />
          )}
        </button>
      ))}

      <button className="btn add" onClick={() => setAdding(true)}>
        <Icon name="plus" size={18} /> Add a card
      </button>

      {selected && (
        <button
          className="btn danger"
          onClick={async () => {
            const id = selected.id;
            setSelectedId(undefined);
            const undo = await undoable(() => deleteCard(id), cardRows(id));
            nav.toast('Card removed. Member prices for that store stop counting.', undo);
          }}
        >
          <Icon name="trash" size={18} /> Remove this card
        </button>
      )}

      <div className="banner grey" style={{ fontSize: 13 }}>
        Without a linked card, member-only prices are shown but never count as your best price.
      </div>

      {adding && (
        <AddCard
          onClose={() => setAdding(false)}
          onAdded={(c) => {
            setAdding(false);
            setSelectedId(c.id);
          }}
        />
      )}
    </div>
  );
}

function AddCard({ onClose, onAdded }: { onClose: () => void; onAdded: (c: LoyaltyCard) => void }) {
  const nav = useNav();
  const [program, setProgram] = useState<CardProgram>('flybuys');
  const [label, setLabel] = useState('');
  const [number, setNumber] = useState('');

  const scan = async () => {
    const out = await scanBarcode('Scan your card');
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
      await addCard(card);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
    nav.toast(`${card.label} added`);
    onAdded(card);
  };

  return (
    <Sheet title="Add a card" onClose={onClose}>
      <div className="seg" role="group" aria-label="Card type">
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
          value={number}
          onChange={(e) => setNumber(e.target.value)}
          placeholder="Type it or scan the card"
        />
      </label>
      <button className="btn" onClick={scan}>
        <Icon name="scan" /> Scan the card's barcode
      </button>
      <p className="small">Stored on this phone, and on your household's phones only if you chose to share cards in Local sync.</p>
      <button className="btn primary" disabled={!number.trim() || saving} onClick={save}>
        Add card
      </button>
    </Sheet>
  );
}
