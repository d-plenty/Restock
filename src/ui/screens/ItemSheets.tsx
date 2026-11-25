// 0.15.0: the item screen's sheets (moved out of Item.tsx): alerts, editing the item, a price, and
// picking an option.
import { useNow } from '../useNow';
import { tidyItemName } from '../../lib/itemName';
import { useState } from 'react';
import { act } from '../../lib/undo';
import { addReading, deleteGroup, deleteReading, nowIso, readingsFor, removeProductFromGroup, updateGroup, updateProduct } from '../../lib/db';
import { allGroups } from '../../lib/db';
import { sameNameItem, sameNameWords } from '../../lib/sameName';
import { money, parseMoney } from '../../lib/units';
import { amountToConfirm, basisWord, lastUpdatedText, priceLine } from '../../lib/unitPrice';
import { useLive } from '../../lib/useLive';
import { ALERT_LEVELS, optionStyle, productQty, type Option, unitWord } from '../../lib/verdict';
import { chainName, GOOD_SALE, GREAT_SALE, type AlertLevel, type Group } from '../../types';
import { CheckedAgo, previewFromOption, ProductPreview, Explain, Icon, Sheet } from '../components';
import { useNav } from '../nav';
import { PCTS, dayOf } from './Item';

/** Alert choice with a plain-English explanation of each level. */
export function AlertPicker({ level, pct, onChange }: { level: AlertLevel; pct: number; onChange: (level: AlertLevel, pct: number) => void }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div className="title" style={{ fontSize: 15 }}>
        Tell me when it's on special
      </div>
      <div className="card flush radio-list" role="radiogroup" aria-label="Alerts">
        {ALERT_LEVELS.map((a) => (
          <label key={a.id} className="radio">
            <input type="radio" name="alert-level" checked={level === a.id} onChange={() => onChange(a.id, pct)} />
            <span style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1 }}>
              <span className="title" style={{ fontSize: 15 }}>
                {a.label}
              </span>
              <span className="small">{a.explain}</span>
              {a.id === 'custom' && level === 'custom' && (
                <select
                  className="input"
                  style={{ marginTop: 6 }}
                  value={pct}
                  onChange={(e) => onChange('custom', parseInt(e.target.value, 10))}
                  aria-label="Percent off"
                >
                  {PCTS.map((p) => (
                    <option key={p} value={p}>
                      {p}% off or more
                    </option>
                  ))}
                </select>
              )}
            </span>
          </label>
        ))}
      </div>
      <Explain title="How alerts and sales work">
        <p>
          <strong>Usual price</strong> is the middle of the regular prices Restock has seen over the last 6 months. Until there's a few weeks of
          history, it uses the shop's own "was" price.
        </p>
        <p>
          <strong>On special</strong>: {GOOD_SALE * 100}% or more below usual. <strong>Great deal</strong>: {GREAT_SALE * 100}% or more.{' '}
          <strong>Small saving</strong>: any price drop under {GOOD_SALE * 100}%, even 5c.
        </p>
        <p>
          <strong>Wait</strong> means it's on special, but it's been at least 5% cheaper than this in the last 6 months, so a better special is likely.
        </p>
        <p>
          Alerts arrive after a price check (in the background, or when you tap Check prices &amp; stock), once per deal. Alternatives (swap &amp;
          save) count too.
        </p>
      </Explain>
    </div>
  );
}

export function EditSheet({
  group,
  categories,
  suggested,
  onClose,
  alertsOnly = false,
  onProducts,
}: {
  /** 0.12.8: "Products I buy" from Edit: saves what's changed here, then opens that part of the item's page. */
  onProducts?: () => void;
  group: Group;
  categories: { id: string; name: string }[];
  suggested?: string;
  onClose: () => void;
  /** 0.9.12: just the price alerts (from the Alert chips), titled "Price alerts". */
  alertsOnly?: boolean;
}) {
  const nav = useNav();
  const [name, setName] = useState(group.name);
  const [categoryId, setCategoryId] = useState(group.categoryId ?? '');
  const [alertLevel, setAlertLevel] = useState<AlertLevel>(group.alertLevel);
  const [alertPct, setAlertPct] = useState(group.alertPct ?? 30);
  const [allowBulk, setAllowBulk] = useState(group.allowBulk !== false);
  const [allowMulti, setAllowMulti] = useState(group.allowMulti !== false);
  const [target, setTarget] = useState(group.targetPrice !== undefined ? group.targetPrice.toFixed(2) : '');

  // 0.12.10: a rename can't land on another item's name (its own name, doubled or not, it keeps).
  const everyItem = useLive(allGroups, []);
  const takenItem = sameNameItem(everyItem, name, group);
  const [takenSaid, setTakenSaid] = useState(false);
  const save = async (): Promise<boolean> => {
    if (takenItem) {
      setTakenSaid(true);
      // Save is at the bottom of the sheet and the name is at the top: bring the reason into view.
      requestAnimationFrame(() => document.getElementById('edit-name-taken')?.scrollIntoView({ block: 'center' }));
      return false;
    }
    const t = parseFloat(target.replace(/[^0-9.]/g, ''));
    await act(`Saved ${name.trim() || group.name}`, () => updateGroup(group.id, {
      name: tidyItemName(name) || group.name, // 0.11.3: starts with a capital
      categoryId: categoryId || undefined,
      alertLevel,
      alertPct: alertLevel === 'custom' ? alertPct : undefined,
      allowBulk,
      allowMulti,
      targetPrice: Number.isFinite(t) && t > 0 ? Math.round(t * 100) / 100 : undefined,
    }));
    onClose();
    return true;
  };

  const unsaved =
    name !== group.name ||
    categoryId !== (group.categoryId ?? '') ||
    alertLevel !== group.alertLevel ||
    (alertLevel === 'custom' && alertPct !== (group.alertPct ?? 30)) ||
    allowBulk !== (group.allowBulk !== false) ||
    allowMulti !== (group.allowMulti !== false) ||
    target !== (group.targetPrice !== undefined ? group.targetPrice.toFixed(2) : '');

  return (
    <Sheet
      title={alertsOnly ? 'Price alerts' : 'Edit item'}
      onClose={onClose}
      // 0.10.11: closing with something changed and not saved asks first
      unsaved={unsaved}
    >
      {!alertsOnly && (
        <>
          <label className="field">
            <span>Name</span>
            <input
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              aria-invalid={takenSaid && !!takenItem}
              aria-describedby={takenSaid && takenItem ? 'edit-name-taken' : undefined}
            />
          </label>
          {takenSaid && takenItem && (
            <span id="edit-name-taken" className="small name-first-help missing" role="alert">
              {sameNameWords(takenItem)}
            </span>
          )}
          {suggested && suggested.toLowerCase() !== name.trim().toLowerCase() && (
            <button className="chip wrap" style={{ alignSelf: 'flex-start' }} onClick={() => setName(suggested)}>
              Use a short name: {suggested}
            </button>
          )}
          {onProducts && (
            <button
              className="btn"
              onClick={async () => {
                // What's changed here is saved first (nothing changed: nothing to save, or to undo)
                if (unsaved && !(await save())) return;
                onProducts();
              }}
            >
              <Icon name="pencil" size={18} /> Products I buy: add, change or remove
            </button>
          )}
          <label className="field">
            <span>Category</span>
            <select className="input" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
              <option value="">None</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
        </>
      )}
      <AlertPicker level={alertLevel} pct={alertPct} onChange={(l, p) => (setAlertLevel(l), setAlertPct(p))} />
      <label className="field">
        <span>Alert me under</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="title">$</span>
          <input
            className="input"
            inputMode="decimal"
            placeholder="e.g. 12.00"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            aria-label="Alert me when the price is under"
            style={{ maxWidth: 140 }}
          />
          {target && (
            <button className="btn small ghost" onClick={() => setTarget('')}>
              Clear
            </button>
          )}
        </div>
        <span className="small">Tells you when any of your shops has it at or below this price, special or not.</span>
      </label>
      {!alertsOnly && (
        <>
        <label className="check" style={{ padding: '4px 0' }}>
          <input type="checkbox" className="switch" checked={allowBulk} onChange={(e) => setAllowBulk(e.target.checked)} />
          <span style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
            <span className="title" style={{ fontSize: 15 }}>
              Swap for bulk packs to save money
            </span>
            <span className="small">Off: a bigger pack you'd also take is never suggested as a swap. Your own picks always count.</span>
          </span>
        </label>
        <label className="check" style={{ padding: '4px 0' }}>
          <input type="checkbox" className="switch" checked={allowMulti} onChange={(e) => setAllowMulti(e.target.checked)} />
          <span style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
            <span className="title" style={{ fontSize: 15 }}>
              Multi-buy to save money
            </span>
            <span className="small">
              Off: deals like "2 for $12" aren't counted. You see the price for one, and a multi-buy alone isn't treated as a sale.
            </span>
          </span>
        </label>
        </>
      )}
      <button className="btn primary" onClick={save}>
        Save
      </button>
      {!alertsOnly && (
        <button
          className="btn danger"
          onClick={async () => {
            const name = group.name;
            await act(`${name} deleted`, () => deleteGroup(group.id)); // 0.9.5 (undo)
            onClose();
            nav.pop();
          }}
        >
          <Icon name="trash" size={18} /> Delete item
        </button>
      )}
    </Sheet>
  );
}

/**
 * 0.9.6: Enter a price by hand, for any product at any shop (Coles, Woolworths, Aldi, chemists, bottle shops, Costco),
 * even when a price was found. You set the price and the day. It goes in the price history as "entered by hand",
 * counts in comparisons and the chart, and a later price check never overwrites it. The ones you've typed are
 * listed to delete. Everything can be undone.
 */
export function PriceSheet({ options, productId: first, onClose }: { options: Option[]; productId?: string; onClose: () => void }) {
  const [productId, setProductId] = useState(first ?? options[0]?.product.id);
  const [price, setPrice] = useState('');
  const [was, setWas] = useState('');
  const [special, setSpecial] = useState(false);
  const [member, setMember] = useState(false);
  const today = dayOf(new Date(useNow(60_000)));
  const [day, setDay] = useState(today);
  // "$4.50" and "4.50" both work (0.9.0).
  const p = parseMoney(price);
  const dayOk = /^\d{4}-\d{2}-\d{2}$/.test(day) && day <= today;
  const typed = useLive(
    async () => (productId ? ((await readingsFor([productId])).get(productId) ?? []).filter((r) => r.source === 'manual').reverse().slice(0, 8) : []),
    [productId],
  );

  const save = async () => {
    if (!productId || !(p > 0) || !dayOk) return;
    const w = parseMoney(was);
    // Today: right now. Another day: midday that day, so it sorts where it belongs.
    const date = day === today ? nowIso() : new Date(`${day}T12:00:00`).toISOString();
    // 0.9.5 (undo): a price typed in by mistake can be taken back.
    await act(`Price ${money(p)} added`, () =>
      addReading({
        productId,
        date,
        price: p,
        wasPrice: w > p ? w : undefined,
        // A member price is a special for card holders (0.9.0), so it never becomes the normal price.
        isSpecial: special || member,
        memberOnly: member,
        source: 'manual',
      }),
    );
    onClose();
  };

  return (
    <Sheet title="Enter a price" onClose={onClose}>
      <p className="small">
        Seen a price in the shop or in the catalogue? Type it here with the day you saw it. It's saved as entered by hand, counts in comparisons and the
        chart, and later price checks don't overwrite it. You can undo it or delete it.
      </p>
      {options.length > 1 && (
        <label className="field">
          <span>Product</span>
          <select className="input" value={productId} onChange={(e) => setProductId(e.target.value)}>
            {options.map((o) => (
              <option key={o.product.id} value={o.product.id}>
                {chainName(o.product.chain)} · {o.product.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="two">
        <label className="field">
          <span>Price ($)</span>
          <input className="input num" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} autoFocus />
        </label>
        <label className="field">
          <span>Was ($, optional)</span>
          <input className="input num" inputMode="decimal" value={was} onChange={(e) => setWas(e.target.value)} />
        </label>
      </div>
      <label className="field">
        <span>Day you saw it</span>
        <input className="input" type="date" value={day} max={today} onChange={(e) => setDay(e.target.value)} aria-label="Day you saw this price" />
      </label>
      <div className="card flush">
        <label className="check">
          <input type="checkbox" checked={special} onChange={(e) => setSpecial(e.target.checked)} />
          <span>It's on special</span>
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={member}
            onChange={(e) => {
              setMember(e.target.checked);
              if (e.target.checked) setSpecial(true);
            }}
          />
          <span>Needs a loyalty card (member price)</span>
        </label>
      </div>
      <button className="btn primary" disabled={!(p > 0) || !dayOk} onClick={save}>
        Save price
      </button>
      {typed && typed.length > 0 && (
        <div className="card flush" aria-label="Prices you entered by hand">
          <div className="eyebrow" style={{ padding: '10px 14px 0' }}>
            Entered by hand
          </div>
          {typed.map((r) => (
            <div key={r.id ?? r.date} className="row">
              <span className="grow">
                <span className="title num" style={{ fontSize: 15 }}>
                  {money(r.price)}
                </span>
                <span className="small">{lastUpdatedText(r.date).replace('Last updated ', '')}</span>
              </span>
              <button
                className="btn small danger"
                aria-label={`Delete the ${money(r.price)} price entered by hand`}
                onClick={() => r.id !== undefined && void act(`Price ${money(r.price)} deleted`, () => deleteReading(r.id!))}
              >
                <Icon name="trash" size={16} /> Delete
              </button>
            </div>
          ))}
        </div>
      )}
    </Sheet>
  );
}

export function OptionSheet({
  group,
  option,
  options,
  wantUnit,
  onClose,
}: {
  group: Group;
  option: Option;
  options: Option[];
  /** 0.11.2: opened from "Measured differently": the measure your other picks use, with the amount left to type. */
  wantUnit?: 'g' | 'ml' | 'ea';
  onClose: () => void;
}) {
  const id = option.product.id;
  const [looking, setLooking] = useState(false);
  // 0.9.6: nothing typed yet and Restock has a guess or an estimate: it fills the box, to check and save (confirmed).
  const offer = option.product.qty || wantUnit ? undefined : amountToConfirm(option.product);
  const [qty, setQty] = useState(wantUnit ? '' : (option.product.qty?.toString() ?? (offer ? String(offer.qty) : '')));
  const [unit, setUnit] = useState(wantUnit ?? option.product.qtyUnit ?? offer?.unit ?? productQty(option.product).unit ?? 'ea');
  const line = priceLine(option.product, option.price, optionStyle(options));
  const isAlt = option.role === 'alt';
  const lastAtShop = !isAlt && options.filter((o) => o.role === 'main' && o.product.chain === option.product.chain).length === 1;

  /** Move between Products I buy and Also happy with. */
  const move = async () => {
    const mains = [group.usualProductId, ...group.sameProductIds].filter((x): x is string => !!x && x !== id);
    const alts = group.altProductIds.filter((x) => x !== id);
    if (isAlt) mains.push(id);
    else alts.push(id);
    await act(isAlt ? `${option.product.name} moved to Products I buy` : `${option.product.name} moved to Also happy with`, () =>
      updateGroup(group.id, { usualProductId: mains[0], sameProductIds: mains.slice(1), altProductIds: alts }),
    ); // 0.9.5 (undo)
    onClose();
  };

  const remove = async () => {
    await act(`${option.product.name} removed`, () => removeProductFromGroup(group, id)); // 0.9.5 (undo)
    onClose();
  };

  const saveSize = async () => {
    const n = parseFloat(qty);
    await act(`Size saved for ${option.product.name}`, () => updateProduct(id, n > 0 ? { qty: n, qtyUnit: unit } : { qty: undefined, qtyUnit: undefined })); // 0.9.5 (undo)
    onClose();
  };

  if (looking) return <ProductPreview product={previewFromOption(option)} onClose={() => setLooking(false)} />;

  return (
    <Sheet title={option.product.name} onClose={onClose}>
      <button className="btn" onClick={() => setLooking(true)}>
        <Icon name="info" size={18} /> Photo and product details
      </button>
      <p className="small">
        {isAlt ? 'Also happy with' : 'My pick'} at {chainName(option.product.chain)}
        {` · ${line.size}`}
        {option.product.barcode ? ` · barcode ${option.product.barcode}` : ''}
        {option.stats.current && ' · '}
        <CheckedAgo date={option.stats.current?.date} source={option.stats.current?.source} />
      </p>
      <p className="small">
        {option.verdict.headline}. {option.verdict.detail}
      </p>
      <div className="card">
        <div className="title" style={{ fontSize: 15 }}>
          Amount for unit pricing
        </div>
        <p className="small">Lets Restock compare different pack sizes fairly. For toilet paper, use total sheets (rolls × sheets per roll).</p>
        {wantUnit && (
          <p className="small" role="note">
            <strong>Your other picks are measured {unitWord(wantUnit)}.</strong>{' '}
            {wantUnit === 'ea' ? 'Type how many are in this pack' : `Type how much is in this pack ${unitWord(wantUnit)}`}, as printed on the pack, and save it.
          </p>
        )}
        {/* 0.9.6: always say how sure Restock is: confirmed by you, estimated, or unknown. */}
        <p className="small" role="status">
          {option.product.qty
            ? `Confirmed by you: ${line.size}.`
            : offer
              ? `${line.suggestion ? `Size unknown. ${line.suggestion}` : `${line.size}. ${offer.note}`} It's filled in below: check it, then save to confirm.`
              : line.unknown
                ? 'Size unknown, so this one is left out of the cheapest comparison. Type the amount in the pack and save it.'
                : `Size from ${basisWord(option.product.sizing?.size?.basis) ?? "the shop's own words"}.`}
        </p>
        <div className="two">
          <input
            className="input num"
            inputMode="decimal"
            placeholder={wantUnit ? '' : String(productQty(option.product).qty ?? '')}
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            aria-label="Amount"
          />
          <select className="input" value={unit} onChange={(e) => setUnit(e.target.value as typeof unit)} aria-label="Unit">
            <option value="g">grams</option>
            <option value="ml">millilitres</option>
            <option value="ea">each / sheets</option>
          </select>
        </div>
        <button className="btn small" onClick={saveSize}>
          Save amount
        </button>
      </div>
      <button className="btn" onClick={move}>
        <Icon name="swap" size={18} /> {isAlt ? 'Move to Products I buy' : 'Move to Also happy with'}
      </button>
      {!isAlt && lastAtShop && (
        <p className="small" style={{ marginTop: -6 }}>
          It's your only pick at {chainName(option.product.chain)}, so moving it means {chainName(option.product.chain)} won't count as having{' '}
          {group.name} when shops are compared.
        </p>
      )}
      <button className="btn danger" onClick={remove}>
        <Icon name="trash" size={18} /> Remove from this item
      </button>
    </Sheet>
  );
}
