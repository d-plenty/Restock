// The shopping list's "where to shop" card and the explanations behind it: the price at each shop,
// how the picks were made, the shop-around plan, and "swap & save" (moved out of components.tsx in 0.9.0).

import { useState } from 'react';
import { nameHasSize } from '../lib/naming';
import { aroundPlan, fewMissing, lineMeasure, recommendedStores, storeMeasure, withElsewhere } from '../lib/shopTotals';
import { money } from '../lib/units';
import { describe, lineCost, productQty } from '../lib/verdict';
import type { StoreChain } from '../shops';
import { chainName } from '../types';
import { ChainDot, Hold, Icon, previewFromOption, ProductPreview, Sheet, stockWhere, SwapBox, unitLabel } from './components';

/** Swap & save: one you'd also take instead of your pick, side by side. */
export function SwapWhy({
  line,
  chainName: storeLabel,
  onOpen,
  onClose,
}: {
  line: ShopLineT;
  chainName?: string;
  onOpen?: () => void;
  onClose: () => void;
}) {
  const [looking, setLooking] = useState(false);
  const { pick, yours } = line;
  if (looking) return <ProductPreview product={previewFromOption(pick)} onClose={() => setLooking(false)} />;
  const unitA = pick.unitPrice;
  const unitB = yours?.unitPrice;
  const sameUnit = yours && unitA !== undefined && unitB !== undefined && productQty(pick.product).unit === productQty(yours.product).unit;
  const where = storeLabel ?? chainName(pick.product.chain);
  let why: string;
  if (!yours) why = `Your pick has no price yet, so this is the one you can get.`;
  else if (yours.product.chain !== pick.product.chain && storeLabel)
    why = `Your pick isn't sold at ${where}, so this is the closest you can get there.`;
  else if (yours.product.inStock === false) why = `Yours is out of stock ${stockWhere(yours.product.chain, true)}, so this is the next best.`;
  else if (sameUnit && unitA! < unitB!) {
    const a = productQty(pick.product).qty ?? 0;
    const b = productQty(yours.product).qty ?? 0;
    const pack = a && b ? (a < b ? ' even though the pack is smaller' : a > b ? ', because the bigger pack costs less per 100 g' : '') : '';
    why = `It works out cheaper per ${productQty(pick.product).unit === 'ea' ? 'item' : '100 g / 100 mL'}: ${unitLabel(pick)} instead of ${unitLabel(yours)}${pack}. If you're only shopping at ${where}, this is the better buy.`;
  } else why = `It's cheaper on the shelf: ${money(pick.price)} instead of ${money(yours.price)}.`;
  return (
    <Sheet title={line.item} onClose={onClose}>
      <p style={{ margin: 0, fontWeight: 600 }}>
        Swap {yours ? describe(yours) : 'your pick'} for {describe(pick)}
      </p>
      <div className="two">
        <SwapBox label="Instead of yours" option={yours} />
        <SwapBox label="Get this" option={pick} hi />
      </div>
      <p className="small" style={{ fontSize: 15 }}>
        {why}
      </p>
      <button className="btn" onClick={() => setLooking(true)}>
        <Icon name="info" size={18} /> Photo and product details
      </button>
      {onOpen && (
        <button className="btn primary" onClick={onOpen}>
          Open {line.item}
        </button>
      )}
    </Sheet>
  );
}

type ShopLineT = import('../lib/shopTotals').ShopLine;

/** A line in a store's breakdown. Swapped lines say why (tap "Why this one?" or hold). */
function SwapLine({ line, chainName, onOpen }: { line: ShopLineT; chainName?: string; onOpen: () => void }) {
  const [why, setWhy] = useState(false);
  const swapped = line.pick.role === 'alt';
  return (
    <>
      <Hold onLong={() => setWhy(true)}>
        <PickRow
          label={line.item}
          pick={line.pick}
          qty={line.qty}
          onOpen={onOpen}
          note={line.outOfStock ? `Out of stock ${stockWhere(line.pick.product.chain)}` : undefined}
        />
      </Hold>
      {swapped && (
        <div style={{ padding: '0 14px 10px 38px' }}>
          <button className="linkish small" onClick={() => setWhy(true)}>
            Why this one instead of yours?
          </button>
        </div>
      )}
      {why && <SwapWhy line={line} chainName={chainName} onOpen={onOpen} onClose={() => setWhy(false)} />}
    </>
  );
}

function PickRow({
  label,
  pick,
  onOpen,
  note,
  qty = 1,
}: {
  label: string;
  pick?: import('../lib/verdict').Option;
  onOpen?: () => void;
  note?: string;
  qty?: number;
}) {
  return (
    <button className="row" onClick={onOpen} disabled={!onOpen}>
      {pick ? <ChainDot chain={pick.product.chain} /> : <span style={{ width: 12 }} />}
      <span className="grow">
        <span className="title" style={{ fontSize: 15 }}>
          {qty > 1 ? `${qty} × ` : ''}
          {label}
        </span>
        <span className="small">
          {pick
            ? `${pick.product.name}${pick.product.size && !nameHasSize(pick.product.name, pick.product.size) ? ` · ${pick.product.size}` : ''}`
            : note}
        </span>
        {pick && (pick.role === 'alt' || note) && (
          <span className="tags" style={{ marginTop: 2 }}>
            {note && <span className="tag normal">{note}</span>}
            {pick.role === 'alt' && <span className="tag alt">WOULD ALSO TAKE</span>}
          </span>
        )}
      </span>
      {pick && (
        <span className="num" style={{ fontWeight: 600 }}>
          {money(lineCost(pick, qty))}
        </span>
      )}
    </button>
  );
}

type Totals = import('../lib/shopTotals').ShopTotals;
type StoreTotal = Totals['stores'][number];

type FindAt = (groupId: string, chain: StoreChain, query: string) => void;

function StoreDetail({
  s,
  onOpenItem,
  onFindAt,
  onClose,
}: {
  s: StoreTotal;
  onOpenItem: (groupId: string) => void;
  onFindAt?: FindAt;
  onClose: () => void;
}) {
  const name = chainName(s.chain);
  const open = (id: string) => () => {
    onClose();
    onOpenItem(id);
  };
  return (
    <Sheet title={`Only ${name}`} onClose={onClose}>
      <div className="card flush">
        <div className="section-head">
          <span className="title">Buy at {name}</span>
          <span className="num" style={{ fontWeight: 700 }}>
            {money(s.total)}
          </span>
        </div>
        {s.lines.map((l) => (
          <SwapLine key={l.groupId} line={l} chainName={name} onOpen={open(l.groupId)} />
        ))}
        {/* 0.9.0: the list's one-off buys are in the total, so say so. */}
        {s.oneOffs > 0 && <PickRow label="One-off buys on your list" note={`${money(s.oneOffs)}, at the shops they were found at`} />}
        {!s.lines.length && (
          <p className="small" style={{ padding: '0 14px 12px' }}>
            Nothing on your list is available at {name}.
          </p>
        )}
      </div>
      {s.missing.length > 0 && (
        <div className="card flush">
          <div className="section-head">
            <span className="title">Not at {name}</span>
          </div>
          <p className="small" style={{ padding: '0 14px' }}>
            None of your picks for these are at {name}. Here's the next best place, or find one at {name} to add as a pick there.
          </p>
          {s.missing.map((m) => (
            <div key={m.groupId}>
              <PickRow
                label={m.item}
                pick={m.elsewhere}
                qty={m.qty}
                onOpen={open(m.groupId)}
                note={
                  (m.notHere ? `You don't buy it at ${name} · ` : '') +
                  (m.elsewhere ? `Next best: ${chainName(m.elsewhere.product.chain)}` : 'No price anywhere yet')
                }
              />
              {onFindAt && !m.notHere && (
                <div style={{ padding: '0 14px 10px 38px' }}>
                  <button
                    className="btn small"
                    onClick={() => {
                      onClose();
                      onFindAt(m.groupId, s.chain, m.item);
                    }}
                  >
                    <Icon name="search" size={16} /> Find one at {name}
                  </button>
                </div>
              )}
            </div>
          ))}
          <div className="row" style={{ borderTop: '1px solid var(--line)' }}>
            <span className="grow">
              <span className="title" style={{ fontSize: 15 }}>
                {name} plus the rest elsewhere
              </span>
            </span>
            <span className="num" style={{ fontWeight: 700 }}>
              {money(s.totalWithElsewhere)}
            </span>
          </div>
        </div>
      )}
      <p className="small">
        Today's prices and online stock. Tap an item to see it in your pantry. Uses the cheapest of your picks at {name}.
      </p>
    </Sheet>
  );
}

function AroundDetail({ t, onOpenItem, onClose }: { t: Totals; onOpenItem: (groupId: string) => void; onClose: () => void }) {
  return (
    <Sheet title="Shopping around" onClose={onClose}>
      <p className="small">The cheapest of each item, from whichever shop has it in stock.</p>
      <div className="card flush">
        {t.around.lines.map((l) => (
          <SwapLine
            key={l.groupId}
            line={l}
            onOpen={() => {
              onClose();
              onOpenItem(l.groupId);
            }}
          />
        ))}
        {t.around.missing.map((m) => (
          <PickRow key={m} label={m} note="Not in stock anywhere you track" />
        ))}
        {t.oneOffs.count > 0 && <PickRow label="One-off buys on your list" note={`${money(t.oneOffs.total)}, at the shops they were found at`} />}
      </div>
    </Sheet>
  );
}

/** The working behind the recommended store, in plain words. */
function HowPicked({ totals, min, onClose }: { totals: Totals; min: number; onClose: () => void }) {
  const by = totals.by;
  const r = recommendedStores(totals);
  const rec = r.recommended;
  const run = r.runnerUp;
  const low = r.cheapest;
  const n = totals.linked;
  const count = (s: StoreTotal) => (by === 'unit' ? s.cheapestFor : s.cheapestForTill);
  const how = by === 'unit' ? 'for the same shopping' : 'at the till';
  const gaps =
    rec && run
      ? rec.lines
          .map((l) => {
            const o = run.lines.find((x) => x.groupId === l.groupId);
            return o ? { item: l.item, d: lineMeasure(o, by) - lineMeasure(l, by) } : undefined;
          })
          .filter((x): x is { item: string; d: number } => !!x && Math.abs(x.d) > 0.005)
          .sort((a, b) => Math.abs(b.d) - Math.abs(a.d))
          .slice(0, 4)
      : [];
  return (
    <Sheet title="How Restock picks a shop" onClose={onClose}>
      {by === 'unit' ? (
        <p className="small">
          Your list is on <strong>Best value</strong>, so Restock prices <strong>the same shopping</strong> at each shop: every item at the size you
          usually buy, from your picks at each shop and its regular packs (Any size items: the cheapest way to get that amount). A bulk pack,
          or a shop only selling a bigger or smaller size, can't tip it. Ones you'd also take don't count here.
        </p>
      ) : (
        <p className="small">
          Your list is on <strong>Lowest price</strong>, so Restock compares what you'd pay <strong>at the till</strong> at each shop, whatever the
          pack sizes.
        </p>
      )}
      <p className="small">
        <strong>Shop around</strong> is recommended: every item from the shop that has it cheapest. If one shop has everything on your list and
        shopping around wouldn't save {min < 0.005 ? 'anything' : `at least ${money(min)}`} over it, that shop is recommended instead. Change{' '}
        {min < 0.005 ? 'this' : `the ${money(min)}`} in Settings → Shopping list.
      </p>
      <p className="small">
        <strong>If you only go to one shop</strong>, the best one is the cheapest, unless it only just wins (by under $2, or 3%) or one item alone makes the difference. Then the shop that's
        cheapest for more of your items is recommended instead, so one big special at a shop that's dearer for everything else doesn't decide it.
      </p>
      <p className="small">
        A shop that's missing a few items (up to {fewMissing(n)} of your {n}) can still be recommended, if it's clearly cheaper (by over $2, or 3%)
        even after buying those few at the next cheapest shop. A shop missing more than that isn't one shop any more, so it isn't recommended as one.
      </p>
      <div className="card flush">
        <div className="row small" style={{ fontWeight: 700 }}>
          <span className="grow">Shop</span>
          <span style={{ width: 80, textAlign: 'right' }}>Same shopping</span>
          <span style={{ width: 74, textAlign: 'right' }}>At the till</span>
        </div>
        {totals.stores
          .filter((s) => s.lines.length)
          .map((s) => (
            <div key={s.chain} className="row" style={s === rec ? { background: 'var(--green-bg)' } : undefined}>
              <ChainDot chain={s.chain} />
              <span className="grow">
                <span className="title" style={{ fontSize: 15 }}>
                  {chainName(s.chain)}
                </span>
                <span className="small">
                  {s.missing.length ? `missing ${s.missing.length} · ` : ''}cheapest for {count(s)} of {n}
                </span>
              </span>
              <span className="num" style={{ width: 80, textAlign: 'right', fontWeight: by === 'unit' ? 700 : 400 }}>
                {money(s.fair)}
              </span>
              <span className="num" style={{ width: 74, textAlign: 'right', fontWeight: by === 'price' ? 700 : 400 }}>
                {money(s.total)}
              </span>
            </div>
          ))}
      </div>
      {rec && run && low && r.saving !== undefined && r.reason === 'cheapest' && (
        <p className="small">
          <strong>{chainName(rec.chain)}</strong> is {money(r.saving)} cheaper than {chainName(run.chain)} {how}
          {n > 1 ? `, and the cheapest for ${count(rec)} of your ${n} items` : ''}.
          {(r.close || r.mostlyFrom) &&
            n > 1 &&
            ' That’s close, but it’s also the cheapest for at least as many of your items, so it stays recommended.'}
        </p>
      )}
      {rec && r.fewestMissing && r.saving !== undefined && r.reason === 'with-elsewhere' && (
        <p className="small">
          <strong>{chainName(rec.chain)}</strong> doesn't have {rec.missing.length === 1 ? '1 of your items' : `${rec.missing.length} of your items`},
          but even after buying {rec.missing.length === 1 ? 'it' : 'those'} at the next cheapest shop, it comes to {money(r.saving)} less {how} than{' '}
          {chainName(r.fewestMissing.chain)}
          {r.fewestMissing.missing.length ? '' : ', which has everything'}. So {chainName(rec.chain)} is recommended, plus a quick stop for{' '}
          {rec.missing.map((m) => m.item.toLowerCase()).join(', ')}.
        </p>
      )}
      {rec && low && r.saving !== undefined && r.reason === 'more-items' && (
        <p className="small">
          <strong>{chainName(low.chain)}</strong> comes to {money(r.saving)} less {how},{' '}
          {r.mostlyFrom
            ? `but most of that is the ${r.mostlyFrom.item.toLowerCase()} (${money(r.mostlyFrom.difference)} less there)`
            : 'but that’s too close to call'}
          . <strong>{chainName(rec.chain)}</strong> is the cheapest for {count(rec)} of your {n} items ({chainName(low.chain)}: {count(low)}), so{' '}
          {chainName(rec.chain)} is recommended.
        </p>
      )}
      {gaps.length > 0 && rec && run && (
        <div className="card flush">
          <div className="row small" style={{ fontWeight: 700 }}>
            Biggest differences
          </div>
          {gaps.map((g) => (
            <div key={g.item} className="row small">
              <span className="grow">{g.item}</span>
              <span className="num">
                {money(Math.abs(g.d))} less at {chainName(g.d > 0 ? rec.chain : run.chain)}
              </span>
            </div>
          ))}
        </div>
      )}
      {by === 'unit' && r.lowest && rec && r.lowest !== rec && r.lowest !== low && (
        <p className="small">
          <strong>{chainName(r.lowest.chain)}</strong> has the lowest total at the till ({money(r.lowest.total)}), but you'd take home less of some
          things: the same amount costs {money(r.lowest.fair)} there.
        </p>
      )}
      {by === 'price' && r.bestValue && rec && r.bestValue !== rec && r.bestValue !== low && (
        <p className="small">
          For the same amount of everything, <strong>{chainName(r.bestValue.chain)}</strong> is the best value ({money(r.bestValue.fair)}). Switch the
          list to Best value to compare that way.
        </p>
      )}
      <p className="small">
        The <strong>Best value / Lowest price</strong> switch at the top of the list changes how shops are compared, and which packs are picked.
      </p>
    </Sheet>
  );
}

/** "If you only went to one store" totals for the shopping list. Tap a store for the details. */
export function ShopTotalsCard({
  totals,
  onOpenItem,
  onFindAt,
  min = 1,
}: {
  totals: Totals;
  onOpenItem: (groupId: string) => void;
  onFindAt?: FindAt;
  /** Shop around only if it saves at least this much (Settings → Shopping list). */
  min?: number;
}) {
  const [detail, setDetail] = useState<StoreTotal | 'around'>();
  const [how, setHow] = useState(false);
  if (!totals.linked) return null;
  const by = totals.by;
  const n = totals.linked;
  const plan = aroundPlan(totals, by, min);
  const withLines = totals.stores.filter((s) => s.lines.length);
  const several = withLines.length > 1;
  const best = recommendedStores(totals).recommended;
  const measureWord = by === 'unit' ? 'same shopping' : 'at the till';
  const otherWord = by === 'unit' ? 'at the till' : 'same shopping';
  const storeWins = plan.pick !== 'around' ? plan.pick : undefined;
  const aroundOneShop = plan.stops.length === 1;
  // Nothing on the list has a price yet: no totals to compare.
  if (!plan.priced) {
    return (
      <div className="card">
        <span className="small">No prices yet for what's on your list. Totals show here after a price check.</span>
      </div>
    );
  }
  const outHere = (s: StoreTotal) => s.lines.filter((l) => l.outOfStock).length;

  const aroundBody = (
    <>
      <span className="hero-head">
        <Icon name="swap" size={20} />
        <span className="hero-title">Shop around</span>
        {!storeWins && several && <span className="tag rec">RECOMMENDED</span>}
      </span>
      <span className="hero-money">
        <span className="hero-big num">{money(plan.around)}</span>
        <span className="small">{measureWord}</span>
      </span>
      <span className="small hero-why">
        {aroundOneShop
          ? `Everything on your list is cheapest at ${chainName(plan.stops[0].chain)}.`
          : plan.complete && plan.saving !== undefined && plan.saving > 0.005
            ? `Every item at its cheapest shop. ${money(plan.saving)} less than ${chainName(plan.complete.chain)} alone${
                withLines.filter((s) => !s.missing.length).length === 1 ? ', the only shop with everything' : ', the cheapest shop with everything'
              }.`
            : plan.complete
              ? 'Every item at its cheapest shop.'
              : 'Every item at its cheapest shop. No one shop has everything on your list.'}
        {` About ${money(plan.aroundOther)} ${otherWord}.`}
      </span>
      {plan.stops.length > 1 && (
        <span className="stops">
          {plan.stops.map((x) => (
            <span key={x.chain} className="stop">
              <ChainDot chain={x.chain} /> {chainName(x.chain)} {x.items}
            </span>
          ))}
        </span>
      )}
    </>
  );

  const storeRow = (s: StoreTotal) => {
    const has = s.lines.length;
    const missing = s.missing.length;
    const other = by === 'unit' ? s.total : s.fair;
    return (
      <button key={s.chain} className="row" onClick={() => setDetail(s)}>
        <ChainDot chain={s.chain} />
        <span className="grow">
          <span className="title line-tags">
            {chainName(s.chain)}
            {!has ? null : missing ? (
              <span className="tag wait">{missing} MISSING</span>
            ) : (
              <span className="tag good">{n === 1 ? 'HAS IT' : `HAS ALL ${n}`}</span>
            )}
            {several && best === s && !storeWins && <span className="tag info">BEST ONE STORE</span>}
          </span>
          {has ? (
            <span className={`have ${missing ? 'miss' : 'all'}`}>{missing ? `Has ${has} of ${n}` : '✓ Everything on your list'}</span>
          ) : (
            <span className="have miss">None of your list</span>
          )}
          <span className="small">
            {outHere(s) > 0 ? `${outHere(s)} out of stock there · ` : ''}
            {missing && s.missing.every((m) => m.elsewhere) && has
              ? `${money(storeMeasure(s, by))} for the ${has} here, plus the ${missing === 1 ? 'one' : missing} from other shops`
              : has && Math.abs(other - storeMeasure(s, by)) > 0.25
                ? `${by === 'unit' ? 'At the till' : 'Same shopping'} ${money(other)}`
                : ''}
          </span>
        </span>
        {/* A store missing things: its total with those bought elsewhere, so it isn't made to look cheap. */}
        <span className="num price-col">
          {!has ? '—' : missing && s.missing.every((m) => m.elsewhere) ? `≈${money(withElsewhere(s, by))}` : money(storeMeasure(s, by))}
        </span>
        <Icon name="chevron" size={16} />
      </button>
    );
  };

  return (
    <div className="card flush shop-totals">
      {storeWins ? (
        <>
          <button className="hero" onClick={() => setDetail(storeWins)}>
            <span className="hero-head">
              <ChainDot chain={storeWins.chain} />
              <span className="hero-title">{chainName(storeWins.chain)}</span>
              <span className="tag rec">RECOMMENDED</span>
            </span>
            <span className="hero-money">
              <span className="hero-big num">{money(storeMeasure(storeWins, by))}</span>
              <span className="small">{measureWord}</span>
            </span>
            <span className="small hero-why">
              {plan.oneStop
                ? `Has all ${n}, and it's the cheapest for every one of them.`
                : plan.saving !== undefined && plan.saving < -0.005
                  ? `Has all ${n}, and it's ${money(-plan.saving)} less than shopping around. One stop does it.`
                  : min < 0.005
                    ? // "Any saving" (0.9.0): there's no minimum to be under, shopping around just saves nothing.
                      `Has all ${n}, and shopping around wouldn't save anything.`
                    : `Has all ${n}. Shopping around would only save ${money(Math.max(0, plan.saving ?? 0))}, under your ${money(min)} minimum.`}
              {` About ${money(by === 'unit' ? storeWins.total : storeWins.fair)} ${otherWord}.`}
              {outHere(storeWins) > 0 && ` ${outHere(storeWins)} out of stock there.`}
            </span>
          </button>
          {!plan.oneStop && (
            <button className="row" onClick={() => setDetail('around')}>
              <Icon name="swap" size={18} />
              <span className="grow">
                <span className="title">Shop around</span>
                <span className="small">
                  {plan.stops.length} shops: {plan.stops.map((x) => chainName(x.chain)).join(', ')}
                </span>
              </span>
              <span className="num price-col">{money(plan.around)}</span>
              <Icon name="chevron" size={16} />
            </button>
          )}
        </>
      ) : (
        <button className="hero" onClick={() => setDetail('around')}>
          {aroundBody}
        </button>
      )}
      {several && (
        <>
          <div className="section-head">
            <span className="eyebrow-in">{storeWins ? 'Other shops' : 'If you only go to one shop'}</span>
            <button className="info-btn" onClick={() => setHow(true)} aria-label="How Restock picks a shop">
              <Icon name="info" size={20} />
            </button>
          </div>
          {totals.stores.filter((s) => s !== storeWins).map(storeRow)}
        </>
      )}
      {/* 0.9.0: one-off buys with a price count in every total; only lines with no price at all are left out. */}
      {totals.oneOffs.count > 0 && (
        <p className="small" style={{ padding: '0 14px 12px' }}>
          Every total includes {money(totals.oneOffs.total)} for {totals.oneOffs.count === 1 ? 'the one-off buy' : `${totals.oneOffs.count} one-off buys`}{' '}
          on your list, at the shop {totals.oneOffs.count === 1 ? 'it was' : 'each was'} found at.
        </p>
      )}
      {totals.unpriced > 0 && (
        <p className="small" style={{ padding: '0 14px 12px' }}>
          {totals.unpriced} note{totals.unpriced === 1 ? '' : 's'} without a price {totals.unpriced === 1 ? "isn't" : "aren't"} counted.
        </p>
      )}
      {how && <HowPicked totals={totals} min={min} onClose={() => setHow(false)} />}
      {detail === 'around' && <AroundDetail t={totals} onOpenItem={onOpenItem} onClose={() => setDetail(undefined)} />}
      {detail && detail !== 'around' && <StoreDetail s={detail} onOpenItem={onOpenItem} onFindAt={onFindAt} onClose={() => setDetail(undefined)} />}
    </div>
  );
}

