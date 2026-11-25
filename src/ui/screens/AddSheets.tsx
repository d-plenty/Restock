// 0.15.0: the Add screen's sheets and buttons (moved out of Add.tsx, past 3,000 lines): which shop,
// adding by hand, and the pick buttons.
import { tidyItemName } from '../../lib/itemName';
import { useRef, useState } from 'react';
import { guessCategoryId } from '../../lib/categoryGuess';
import { sameNameItem, sameNameWords } from '../../lib/sameName';
import { act } from '../../lib/undo';
import { addGroup, addListEntry, deleteListEntries, addProduct, addReading, allGroups, nowIso, uid, updateGroup } from '../../lib/db';
import { pickItemFor, pickItemOffList } from '../../lib/listPicks';
import { parseMoney } from '../../lib/units';
import { useLive } from '../../lib/useLive';
import { COSTCO_LIST_NOTE } from '../../lib/costcoLocal';
import { chainName, type Chain, type Group } from '../../types';
import { isLocalOnlyShop, SECTION_NAMES, SECTION_PLACE, type Section, type StoreChain } from '../../shops';
import { ChainDot, Icon, Sheet } from '../components';
import { pickedWords } from './addSave';
import { CategoryPick } from './Categories';
import { AddBtn, AddPair, addButtonsNote, AlwaysTick, pickButtonsNote, toPantryNote } from './addPickWords';
import { TAP, type ForLine, type Target, FIRST_SHOPS } from './addShared';

/** 0.12.0: "Where do you shop?", asked by a new phone's first search in place of the setup step. */
export function WhereShopSheet({
  onDone,
  onOther,
  onClose,
}: {
  onDone: (chains: StoreChain[]) => void | Promise<void>;
  onOther: () => void | Promise<void>;
  onClose: () => void;
}) {
  // None ticked to start with: which shops is your choice, and no shop gets a head start.
  const [on, setOn] = useState<StoreChain[]>([]);
  return (
    <Sheet title="Where do you shop?" onClose={onClose}>
      <p className="small" style={{ margin: 0 }}>
        Tick the ones you use. Restock searches them and compares them. Asked once: change it any time in Settings.
      </p>
      <div className="where-shops">
        {FIRST_SHOPS.map((c) => (
          <label key={c} className={`where-shop${on.includes(c) ? ' on' : ''}`}>
            <ChainDot chain={c} />
            <span className="grow">{chainName(c)}</span>
            <input type="checkbox" checked={on.includes(c)} onChange={() => setOn((list) => (list.includes(c) ? list.filter((x) => x !== c) : [...list, c]))} />
          </label>
        ))}
      </div>
      <button className="linkish" style={TAP} onClick={() => void onOther()}>
        Other shops (IGA, Costco and more)
      </button>
      <button className="btn primary block" disabled={!on.length} onClick={() => void onDone(on)}>
        {on.length ? `Search ${on.length} shop${on.length === 1 ? '' : 's'}` : 'Pick at least one shop'}
      </button>
    </Sheet>
  );
}

export function ManualSheet({
  attachTo,
  as,
  defaultName,
  barcode,
  categories,
  section,
  shops,
  forLine,
  onClose,
  onDone,
}: {
  attachTo?: Group;
  as: 'main' | 'alt';
  defaultName: string;
  barcode?: string;
  categories: { id: string; name: string }[];
  section: Section;
  /** This tab's shops, to pick from. */
  shops: StoreChain[];
  /** 0.9.5, from the Pick sheet: only "Add to pantry", and the list line becomes the new item. */
  forLine?: ForLine;
  onClose: () => void;
  onDone: (groupId?: string) => void;
}) {
  const [name, setName] = useState(defaultName);
  const [chain, setChain] = useState<Chain>(shops[0] ?? 'other');
  const [size, setSize] = useState('');
  const [price, setPrice] = useState('');
  const [special, setSpecial] = useState(false);
  const [categoryId, setCategoryId] = useState('');
  // One save at a time, so a double tap doesn't add it twice.
  const [saving, setSaving] = useState(false);
  const [busyAs, setBusyAs] = useState<Target>();
  const savingRef = useRef(false);
  // 0.12.10: a new item can't take a name another item has (adding to an item, or a list line, can).
  const everyItem = useLive(allGroups, []);
  const takenItem = attachTo ? undefined : sameNameItem(everyItem, name);
  const [takenSaid, setTakenSaid] = useState(false);

  const save = async (target: Target) => {
    if (!name.trim() || savingRef.current) return;
    if (target !== 'list' && takenItem) {
      setTakenSaid(true);
      requestAnimationFrame(() => document.getElementById('manual-name-taken')?.scrollIntoView({ block: 'center' }));
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setBusyAs(target);
    try {
      await saveAs(target);
    } finally {
      savingRef.current = false;
      setSaving(false);
      setBusyAs(undefined);
    }
  };

  const saveAs = async (target: Target) => {
    const n = name.trim();
    // 0.9.5 (undo): whatever this adds is one Undo; what to do after comes back from it.
    const next = await act(
      (r: { said?: string }) => r.said ?? null,
      async (): Promise<{ said?: string; after: () => void }> => {
        if (target === 'list') {
          // 0.9.6 (review H1): never a list line at Costco (it is shared): "Any shop", and it says so.
          const atCostco = isLocalOnlyShop(chain);
          await addListEntry({ id: uid(), text: n, chain: atCostco ? undefined : chain, categoryId: categoryId || undefined, section, checked: false, createdAt: nowIso() });
          // 0.9.11: from the Pick sheet, this replaces the line.
          if (forLine) await deleteListEntries([forLine.entry.id]);
          return { said: `${n} added to your shopping list${atCostco ? `. ${COSTCO_LIST_NOTE}` : ''}`, after: () => (forLine ? forLine.onListed() : onDone()) };
        }
        const id = uid();
        await addProduct({ id, chain, name: n, size: size || undefined, barcode: as === 'main' ? barcode : undefined, createdAt: nowIso() });
        // "$4.50" works as well as "4.50" (0.9.0).
        const p = parseMoney(price);
        if (p > 0) await addReading({ productId: id, date: nowIso(), price: p, isSpecial: special, memberOnly: false, source: 'manual' });
        if (attachTo) {
          if (as === 'alt') await updateGroup(attachTo.id, { altProductIds: [...attachTo.altProductIds, id] });
          else {
            const notAt = (attachTo.notAt ?? []).filter((c) => c !== chain);
            if (!attachTo.usualProductId) await updateGroup(attachTo.id, { usualProductId: id, notAt });
            else await updateGroup(attachTo.id, { sameProductIds: [...attachTo.sameProductIds, id], notAt });
          }
          return { said: `Added to ${attachTo.name}`, after: () => onDone(attachTo.id) };
        }
        const groupId = uid();
        await addGroup({
          id: groupId,
          name: tidyItemName(n), // 0.11.3: starts with a capital
          // 0.11.2: no category chosen: the one its name fits, else none ("Other").
          categoryId: categoryId || guessCategoryId([n], categories.map((c) => ({ ...c, section })), section) || undefined,
          usualProductId: id,
          sameProductIds: [],
          altProductIds: [],
          alertLevel: 'good',
          section,
          createdAt: nowIso(),
        });
        if (forLine) {
          // 0.9.11: "Add to both" (the line becomes it) or "Add to pantry" (the line comes off the list).
          const off = target === 'pantry';
          const linked = await (off ? pickItemOffList : pickItemFor)(forLine.entry, { id: groupId, name: n }, forLine.always);
          return {
            said: pickedWords(n, { made: true, linked, always: forLine.always, word: forLine.word, place: SECTION_PLACE[section], off }),
            after: () => forLine.onDone({ id: groupId, name: n }, true, linked),
          };
        }
        if (target === 'both') {
          await addListEntry({ id: uid(), text: n, groupId, categoryId: categoryId || undefined, section, checked: false, createdAt: nowIso() });
        }
        return {
          said: target === 'both' ? `${n} added to ${SECTION_PLACE[section]} and shopping list` : `${n} added to ${SECTION_PLACE[section]}`,
          after: () => onDone(groupId),
        };
      },
    );
    next.after();
  };

  return (
    <Sheet title="Add manually" onClose={onClose} unsaved={!saving && !busyAs && (name.trim() !== defaultName.trim() || !!size.trim() || !!price.trim())}>
      <p className="small">Prices for hand-added products aren't checked automatically. Enter them from the shelf or catalogue as you see them.</p>
      <label className="field">
        <span>Product name</span>
        <input
          className="input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus={!defaultName.trim()}
          aria-invalid={takenSaid && !!takenItem}
          aria-describedby={takenSaid && takenItem ? 'manual-name-taken' : undefined}
        />
      </label>
      {takenSaid && takenItem && (
        <span id="manual-name-taken" className="small name-first-help missing" role="alert">
          {sameNameWords(takenItem)}
        </span>
      )}
      <div className="two">
        <label className="field">
          <span>Shop</span>
          <select className="input" value={chain} onChange={(e) => setChain(e.target.value as Chain)}>
            {shops.map((c) => (
              <option key={c} value={c}>
                {chainName(c)}
              </option>
            ))}
            <option value="other">Other</option>
          </select>
        </label>
        <label className="field">
          <span>Size</span>
          <input className="input" placeholder="e.g. 1kg, 24 pack" value={size} onChange={(e) => setSize(e.target.value)} />
        </label>
      </div>
      <div className="two">
        <label className="field">
          <span>Price today ($)</span>
          <input className="input num" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} />
        </label>
        <label className="check" style={{ alignSelf: 'end', padding: '0 0 12px' }}>
          <input type="checkbox" checked={special} onChange={(e) => setSpecial(e.target.checked)} />
          <span>On special</span>
        </label>
      </div>
      {!attachTo && (
        <label className="field">
          <span>Category</span>
          <CategoryPick section={section} categories={categories} value={categoryId} onChange={setCategoryId} none="None" />
        </label>
      )}
      {forLine ? (
        <>
          <PickButtons forLine={forLine} section={section} saving={saving} busy={busyAs} blocked={!name.trim()} onSave={(t) => void save(t)} />
        </>
      ) : attachTo ? (
        <button className="btn primary" disabled={!name.trim() || saving} onClick={() => save('pantry')}>
          {as === 'alt' ? 'Add to Also happy with' : `Add to ${attachTo.name}`}
        </button>
      ) : (
        <>
          {/* 0.9.12: the same layout as the search results and Pick my…. */}
          <AddBtn target="both" busy={busyAs} blocked={!name.trim()} className="btn primary" onClick={() => void save('both')}>
            Add to both
          </AddBtn>
          <AddPair section={section} category={categories.find((c) => c.id === categoryId)?.name} disabled={!name.trim()} busy={busyAs} onPantry={() => void save('pantry')} onList={() => void save('list')} />
          <p className="small" style={{ margin: 0 }}>{addButtonsNote(SECTION_PLACE[section], categories.find((c) => c.id === categoryId)?.name)}</p>
        </>
      )}
    </Sheet>
  );
}

/**
 * 0.9.11: the end of "Pick my coconut cream", on the phone (shop search and Add by hand): the same
 * three buttons as any add, and the "next time" tick (ticked to start with).
 */
export function PickButtons({
  forLine,
  section,
  saving,
  busy,
  blocked,
  onSave,
}: {
  forLine: ForLine;
  section: Section;
  saving: boolean;
  /** 0.10.7: which button is saving (only that one shows it). */
  busy?: Target;
  /** Nothing to add yet. */
  blocked?: boolean;
  onSave: (t: 'both' | 'list' | 'pantry') => void;
}) {
  const busyAs = busy ?? (saving ? 'both' : undefined);
  // 0.10.2: from the line's "Add to pantry": one button, the item made and the line kept as it.
  if (forLine.toPantry)
    return (
      <>
        <AlwaysTick forLine={forLine} />
        <AddBtn target="both" busy={busyAs} blocked={blocked} className="btn primary" onClick={() => onSave('both')}>
          <Icon name={section} size={18} /> Add to {SECTION_NAMES[section].toLowerCase()}
        </AddBtn>
        <p className="small" style={{ margin: 0 }}>{toPantryNote(SECTION_PLACE[section])}</p>
      </>
    );
  return (
    <>
      <AlwaysTick forLine={forLine} />
      <AddBtn target="both" busy={busyAs} blocked={blocked} className="btn primary" onClick={() => onSave('both')}>
        <Icon name="cart" size={18} /> Add to both
      </AddBtn>
      <AddPair section={section} disabled={blocked} busy={busyAs} onPantry={() => onSave('pantry')} onList={() => onSave('list')} />
      <p className="small" style={{ margin: 0 }}>{pickButtonsNote(SECTION_PLACE[section])}</p>
    </>
  );
}
