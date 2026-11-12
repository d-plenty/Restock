import { useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { ShopLine } from '../lib/shopTotals';
import { money } from '../lib/units';
import { promoLabel } from '../stores/http';
import { describe, multiText, VERDICT_LABEL, type ActionKind, type Option, type Recommendation } from '../lib/verdict';
import { chainName, GOOD_SALE, GREAT_SALE, type Chain } from '../types';
import { Icon, memberProgram, Sheet, stockWhere } from './components';
import { SwapWhy } from './shopTotalsCard';

// Every status tag can be tapped to say what it means for this product: why it's a small
// saving, why it's the cheapest, what it was swapped for, how a multi-buy works.

/**
 * A tag that opens an explanation. It sits inside tappable rows, so the explanation is drawn at
 * the top of the page and taps, swipes and long presses inside it never reach the row.
 */
export function InfoTag({
  className,
  label,
  title,
  children,
  render,
}: {
  className: string;
  label: string;
  title: string;
  children?: ReactNode;
  /** Draw a whole custom sheet instead of the plain one. */
  render?: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();
  return (
    <>
      <span
        role="button"
        tabIndex={0}
        className={`tag ${className} tag-btn`}
        aria-label={`${label}: what does this mean?`}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            e.stopPropagation();
            setOpen(true);
          }
        }}
        onTouchStart={stop}
        onContextMenu={stop}
      >
        {label}
        <Icon name="info" size={11} />
      </span>
      {open && (
        // React passes events up through portals, so stop them here before they reach the row.
        <span onClick={stop} onTouchStart={stop} onTouchMove={stop} onTouchEnd={stop} onContextMenu={stop} onPointerDown={stop}>
          {createPortal(
            render ? (
              render(close)
            ) : (
              <Sheet title={title} onClose={close}>
                {children}
              </Sheet>
            ),
            document.body,
          )}
        </span>
      )}
    </>
  );
}

const LEGEND = (
  <div className="legend">
    <div>
      <span className="tag great">GREAT DEAL</span> {Math.round(GREAT_SALE * 100)}% or more off its usual price
    </div>
    <div>
      <span className="tag good">ON SPECIAL</span> {Math.round(GOOD_SALE * 100)}% or more off
    </div>
    <div>
      <span className="tag small">SMALL SAVING</span> any drop below its usual price, under {Math.round(GOOD_SALE * 100)}%
    </div>
    <div>
      <span className="tag wait">WAIT</span> on special, but it's been at least 5% cheaper recently (never at half price or better)
    </div>
    <div>
      <span className="tag fake">FAKE SALE</span> tagged as a special or promotion on the shop's website, but no cheaper than its usual price
    </div>
    <div>
      <span className="tag normal">USUAL PRICE</span> not on special
    </div>
  </div>
);

function basisText(o: Option): string {
  if (o.stats.fromMarket) return 'shared prices, matched to your shop';
  if (o.verdict.basis === 'history') return `the ${o.stats.spanDays} days of prices Restock has seen`;
  if (o.verdict.basis === 'was-price') return 'the shop\'s own "was" price (Restock is still learning this one)';
  return 'nothing yet';
}

/**
 * "Fake sale", explained: what the shop's website said, why Restock disagrees, and that it isn't
 * necessarily the shop being misleading. Shops tag products for lots of reasons that aren't a
 * discount (an ongoing low-price program, a price lock), and Restock only sees the website's tags.
 */
const near = (a?: number, b?: number) => a !== undefined && b !== undefined && Math.abs(a - b) < 0.015;

function FakeWhy({ o }: { o: Option }) {
  const cur = o.stats.current;
  const shop = chainName(o.product.chain);
  const was = cur?.wasPrice !== undefined && cur.wasPrice > (cur.price ?? 0) + 0.004 ? cur.wasPrice : undefined;
  const label = promoLabel(cur?.promo);
  const normal = o.stats.typical;
  const shops = shop.endsWith('s') ? `${shop}'` : `${shop}'s`;
  return (
    <div className="fake-why">
      <div className="title" style={{ fontSize: 15 }}>
        Why "fake sale"?
      </div>
      {was !== undefined ? (
        <p className="small">
          {shops} website shows it as a special: {money(cur?.price)}, "was {money(was)}". But going by {basisText(o)}, its usual price is{' '}
          {money(normal)}, so it isn't any cheaper than usual. The "was" price is higher than it has usually been.
        </p>
      ) : (
        <p className="small">
          {shops} website has this product tagged{label ? ` "${label}"` : ' with a promotion'}, so Restock reads it as on special. But there's no
          "was" price, and {near(cur?.price, normal) ? `${money(cur?.price)} is what it usually costs` : `it usually costs ${money(normal)}`}, so you
          aren't saving anything by buying it now.
        </p>
      )}
      <p className="small">
        It doesn't necessarily mean {shop} is misleading anyone. Shops tag products for reasons that aren't a short-term discount, like an ongoing
        lower-price program or a price lock{o.product.chain === 'coles' ? ' (Coles does this a lot)' : ''}. Restock can only see the website's tag,
        not the shelf ticket. "Fake sale" here just means: <strong>no cheaper than it normally is.</strong>
      </p>
    </div>
  );
}

/** What a verdict tag means for this product, with its numbers. */
export function VerdictBody({ o }: { o: Option }) {
  const cur = o.stats.current;
  return (
    <>
      {o.verdict.headline.toLowerCase() !== VERDICT_LABEL[o.verdict.kind].toLowerCase() && (
        <p style={{ margin: 0, fontWeight: 600 }}>{o.verdict.headline}</p>
      )}
      <p className="small" style={{ fontSize: 15, margin: 0 }}>
        {describe(o)} at {chainName(o.product.chain)}. {o.verdict.detail}
      </p>
      <div className="stat-row">
        <div className="stat">
          <span className="k">Today</span>
          <span className="v num">{money(o.multi ? o.shelfPrice : o.price)}</span>
          {o.multi && <span className="k">{multiText(o.multi)}</span>}
        </div>
        <div className="stat">
          <span className="k">Usual</span>
          <span className="v num">{money(o.stats.typical ?? cur?.wasPrice)}</span>
        </div>
        <div className="stat">
          <span className="k">Lowest seen</span>
          <span className="v num">{money(o.stats.low)}</span>
        </div>
      </div>
      <p className="small">The usual price comes from {basisText(o)}.</p>
      {o.verdict.kind === 'fake' && <FakeWhy o={o} />}
      <div className="title" style={{ fontSize: 15 }}>
        What the labels mean
      </div>
      {LEGEND}
    </>
  );
}

export function VerdictInfoTag({ o }: { o: Option }) {
  const label = VERDICT_LABEL[o.verdict.kind];
  return (
    <InfoTag className={o.verdict.kind} label={label} title={cap(label)}>
      <VerdictBody o={o} />
    </InfoTag>
  );
}

/** A pantry item's one status tag, explained using the option it's about. */
export function ActionInfoTag({ rec, action, great }: { rec: Recommendation; action: ActionKind; great?: boolean }) {
  const map: Record<ActionKind, [string, string]> = {
    buy: ['good', great ? 'GREAT DEAL' : 'ON SPECIAL'],
    alt: ['alt', 'SWAP & SAVE'],
    small: ['small', 'SMALL SAVING'],
    wait: ['wait', 'WAIT'],
    skip: ['fake', 'FAKE SALE'],
    none: ['normal', 'USUAL PRICE'],
  };
  const [cls, label] = map[action];
  const o = action === 'alt' ? rec.alt : rec.best;
  if (!o) return <span className={`tag ${cls}`}>{label}</span>;
  if (action === 'alt' && rec.alt) {
    const line: ShopLine = { item: rec.group.name, groupId: rec.group.id, pick: rec.alt, outOfStock: false, qty: 1, yours: rec.best, fair: 0 };
    return <InfoTag className={cls} label={label} title={rec.group.name} render={(close) => <SwapWhy line={line} onClose={close} />} />;
  }
  return (
    <InfoTag className={cls} label={label} title={cap(label)}>
      <VerdictBody o={o} />
    </InfoTag>
  );
}

/** "CHEAPEST": your picks at each store, cheapest first. */
export function CheapestInfoTag({ o, options }: { o: Option; options: Option[] }) {
  const priced = options.filter((x) => x.price !== undefined).sort((a, b) => a.price! - b.price!);
  return (
    <InfoTag className="best" label="CHEAPEST" title="Why it's the cheapest">
      <p className="small" style={{ fontSize: 15, margin: 0 }}>
        Of the shops with your picks, {chainName(o.product.chain)} is cheapest for you today
        {o.multi ? `, when you buy ${o.multi.n} (${multiText(o.multi)})` : ''}.
      </p>
      <div className="card flush">
        {priced.map((x) => (
          <div key={x.product.id} className={`row${x === o ? ' selected' : ''}`}>
            <span className="grow">
              <span className="title" style={{ fontSize: 15 }}>
                {chainName(x.product.chain)}
              </span>
              <span className="small">
                {describe(x)}
                {x.multi ? ` · ${multiText(x.multi)}` : ''}
                {x.locked ? ' · member price needs the card' : ''}
              </span>
            </span>
            <span className="num" style={{ fontWeight: 700 }}>
              {money(x.price)}
              {x.multi ? ' each' : ''}
            </span>
          </div>
        ))}
      </div>
      <p className="small">
        "Cheapest" uses the price you'd pay: member prices only if you've added that shop's card, and multi-buys at their price each. Your shopping
        list only uses a multi-buy price when you're buying the full set.
      </p>
    </InfoTag>
  );
}

/** "2 FOR $5.00": how the multi-buy works. */
export function MultiInfoTag({ o }: { o?: Option }) {
  if (!o?.multi) return null;
  const m = o.multi;
  return (
    <InfoTag className="good" label={`${m.n} FOR ${money(m.total)}`} title="Multi-buy deal">
      <p style={{ margin: 0 }}>
        {chainName(o.product.chain)} has {describe(o)} at <strong>{multiText(m)}</strong>: that's {money(o.price)} each when you buy {m.n}.
      </p>
      <p className="small" style={{ fontSize: 15 }}>
        Buy just one and it's {money(o.shelfPrice)}. Restock judges the deal at {money(o.price)} each, and your shopping list only uses that price
        when you've got {m.n} or more on the list (tap + to add more).
      </p>
    </InfoTag>
  );
}

export function MemberInfoTag({ chain, hasCard }: { chain: Chain; hasCard?: boolean }) {
  // The same program names as MemberTag (0.9.0: one list, components.tsx memberProgram).
  const { name, cls } = memberProgram(chain);
  const program = name ?? 'membership';
  return (
    <InfoTag className={cls} label={program === 'membership' ? 'MEMBER PRICE' : `MEMBER PRICE · ${program.toUpperCase()}`} title="Member price">
      <p style={{ margin: 0 }}>This price is only for {program} members.</p>
      <p className="small" style={{ fontSize: 15 }}>
        {hasCard === false
          ? `You haven't added a ${program} card, so Restock uses the usual price for you. Add your card under Cards on Home to count it.`
          : `Restock counts it because you've added your ${program} card. Remember to scan it at the checkout.`}
      </p>
    </InfoTag>
  );
}

export function StockInfoTag({ o, label }: { o: Option; label?: string }) {
  const where = stockWhere(o.product.chain);
  return (
    <InfoTag className="fake wrap" label={label ?? `OUT OF STOCK ${where.toUpperCase()}`} title={`Out of stock ${where}`}>
      <p style={{ margin: 0 }}>
        {chainName(o.product.chain)}'s website says {describe(o)} is out of stock {where === 'online' ? 'online' : where}.
      </p>
      <p className="small" style={{ fontSize: 15 }}>
        {where === 'online'
          ? "Online stock is checked on the shop's website, not at your branch, so your local shop may still have it."
          : "This is Coles' own stock count for your branch, from its website. It can be a little behind the shelf."}{' '}
        Restock picks another of your picks or another shop while it's out, and checks again at the next price check.
      </p>
    </InfoTag>
  );
}

/** "SWAP" on the shopping list: what it was swapped for and why. */
export function SwapInfoTag({ line, label = 'SWAP' }: { line: ShopLine; label?: string }) {
  return <InfoTag className="alt" label={label} title={line.item} render={(close) => <SwapWhy line={line} onClose={close} />} />;
}

const cap = (s: string) => s.charAt(0) + s.slice(1).toLowerCase();
