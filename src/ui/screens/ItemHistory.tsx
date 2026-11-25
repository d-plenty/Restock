// 0.15.0: an item's price history (moved out of Item.tsx, which had grown to nearly 2,000 lines):
// the chart and its picker, when it was last updated, and the stock-up tip.
import { useResetOn } from '../useResetOn';
import { useNow } from '../useNow';
import { useState, type ReactNode } from 'react';
import { MARKET_SOURCE } from '../../lib/market';
import { shopRank } from '../../lib/productOrder';
import { money } from '../../lib/units';
import { lastUpdatedText, newestReading, priceLine, productLine, sizeLabel } from '../../lib/unitPrice';
import { eachPriceOf, multiBuy, optionStyle, productQty, type Option, type PriceStats } from '../../lib/verdict';
import { chainName, type PriceReading } from '../../types';
import { ChainDot, Icon, PriceChart } from '../components';
import { unitText, WEEK, near, nameWithoutSize, onSale } from './Item';

/** "Last updated today, 6:32 am" for the product shown, top right of the Price history card (phone and web). */
function LastUpdated({ readings }: { readings: readonly PriceReading[] }) {
  const last = newestReading(readings);
  return (
    <span className="small ph-updated" style={{ marginLeft: 'auto', textAlign: 'right' }}>
      {lastUpdatedText(last?.date, last?.source)}
    </span>
  );
}

/**
 * Stock-up reminders from an item's sale pattern: "on sale now, and only every 6 weeks: stock up",
 * or "next sale likely around 18 Nov: maybe hold off".
 */
function StockUpTip({ stats, readings }: { stats: PriceStats; readings: { date: string; isSpecial: boolean }[] }) {
  const now = useNow(60_000);
  if (!stats.cycleWeeks || stats.cycleWeeks < 3) return null;
  if (stats.current?.isSpecial) {
    return (
      <div className="banner green" style={{ paddingTop: 10, paddingBottom: 10 }}>
        <strong>A good time to stock up</strong>
        <span style={{ fontSize: 13 }}>It only goes on special about every {stats.cycleWeeks} weeks, so this price may not be back for a while.</span>
      </div>
    );
  }
  const lastSale = [...readings].reverse().find((r) => r.isSpecial)?.date;
  if (!lastSale) return null;
  const next = Date.parse(lastSale) + stats.cycleWeeks * 7 * 86_400_000;
  const days = Math.round((next - now) / 86_400_000);
  const when = new Date(next).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
  return (
    <div className="banner blue" style={{ padding: '10px 12px' }}>
      <strong>{days > 2 ? `Next sale likely around ${when}` : 'A sale is due about now'}</strong>
      <span style={{ fontSize: 13 }}>
        {days > 2
          ? `It goes on special about every ${stats.cycleWeeks} weeks. If you can wait, maybe hold off.`
          : `It goes on special about every ${stats.cycleWeeks} weeks and the last one was a while ago.`}
      </span>
    </div>
  );
}

/**
 * Which product the price history is for (0.7.3): a tab for each shop, then that shop's products,
 * each with its size in bold, the name underneath, today's price and any sale, so two that share a
 * name ("Brita Maxtra Pro", 1 filter or 3 pack) are easy to tell apart.
 */
function HistoryPicker({ options, picked, onPick }: { options: Option[]; picked: Option; onPick: (id: string) => void }) {
  const chains = [...new Set(options.map((x) => x.product.chain))].sort((a, b) => shopRank(a) - shopRank(b));
  const [shop, setShop] = useState(picked.product.chain);
  useResetOn([picked.product.chain], () => setShop(picked.product.chain));
  const rows = options.filter((x) => x.product.chain === shop);
  // 0.11.2: "Cheapest" is by the comparison price only when every pick is measured the same way (all per
  // 100 g, say); grams against a count can't be compared, so the shelf price decides, as in Products I buy.
  const mains = options.filter((x) => x.role !== 'alt' && x.price !== undefined);
  const sameMeasure = mains.every((x) => x.unitPrice !== undefined) && new Set(mains.map((x) => productQty(x.product).unit)).size === 1;
  // 0.11.3: different measures, but each says how many are in it: the price of one (as recommend does).
  const byEach = !sameMeasure && mains.length > 1 && mains.every((x) => eachPriceOf(x) !== undefined);
  const costOf = (x: Option) => (sameMeasure ? x.unitPrice : byEach ? eachPriceOf(x) : x.price);
  const low = mains.length > 1 ? Math.min(...mains.map((x) => costOf(x)!)) : undefined;
  const off = (x: Option) =>
    x.unitPrice !== undefined && x.normalUnitPrice && x.unitPrice < x.normalUnitPrice * 0.97
      ? Math.round((1 - x.unitPrice / x.normalUnitPrice) * 100)
      : 0;
  return (
    <div className="ph-pick">
      {chains.length > 1 && (
        <div className="seg ph-shops" role="tablist" aria-label="Shop">
          {chains.map((c) => (
            <button
              key={c}
              role="tab"
              aria-selected={c === shop}
              onClick={() => {
                setShop(c);
                const first = options.find((x) => x.product.chain === c);
                if (first && picked.product.chain !== c) onPick(first.product.id);
              }}
            >
              <ChainDot chain={c} /> {chainName(c)}
              {options.filter((x) => x.product.chain === c).length > 1 && (
                <span className="ph-count">{options.filter((x) => x.product.chain === c).length}</span>
              )}
            </button>
          ))}
        </div>
      )}
      <div className="ph-rows" role="radiogroup" aria-label={`Products at ${chainName(shop)}`}>
        {rows.map((x) => {
          const pct = off(x);
          return (
            <button
              key={x.product.id}
              role="radio"
              aria-checked={x.product.id === picked.product.id}
              className="ph-row"
              onClick={() => onPick(x.product.id)}
            >
              <span className="ph-radio" aria-hidden />
              <span className="ph-row-text">
                <span className="ph-size">
                  {priceLine(x.product, x.price).unknown ? 'Size unknown' : sizeLabel(x.product)}
                  {low !== undefined && x.role !== 'alt' && costOf(x) !== undefined && Math.abs(costOf(x)! - low) < 1e-9 && (
                    <span className="tag best">CHEAPEST</span>
                  )}
                  {x.role === 'alt' && <span className="tag normal">ALTERNATIVE</span>}
                </span>
                <span className="ph-name">{nameWithoutSize(x)}</span>
                {unitText(x, optionStyle(options)) && <span className="ph-name num">{unitText(x, optionStyle(options))}</span>}
              </span>
              <span className="ph-row-price num">
                {x.price !== undefined ? money(x.price) : '—'}
                {pct >= 3 && <small>{pct}% off</small>}
                {x.product.inStock === false && <small className="out">Out of stock</small>}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * The price history card. It starts with what shared price history knows (today's price, a tip,
 * where today sits, how often it's on sale) and grows a chart and a week-by-week strip once this
 * phone has its own prices.
 */
export function PriceHistory({
  options,
  option: o,
  onPick,
  stats,
  allReadings,
  chartReadings,
  allowMulti,
  range,
  onEnterPrice,
  bare,
}: {
  /** 0.12.5: inside the item page's Price history fold: no card of its own and no second title. */
  bare?: boolean;
  options: Option[];
  option: Option;
  onPick: (id: string) => void;
  stats: PriceStats;
  allReadings: PriceReading[];
  chartReadings: PriceReading[];
  allowMulti: boolean;
  range?: ReactNode;
  onEnterPrice?: () => void;
}) {
  const [why, setWhy] = useState(false);
  const market = stats.fromMarket ? o.product.market : undefined;
  // A "2 for $12" week shows on the chart at $6.00 each, when this item counts multi-buys.
  const chartShown = allowMulti
    ? chartReadings.map((r) => {
        const mb = multiBuy(r.promo);
        return mb && mb.total / mb.n < r.price - 0.004 ? { ...r, price: Math.round((mb.total / mb.n) * 100) / 100, isSpecial: true } : r;
      })
    : chartReadings;
  const v = o.verdict;
  const today = o.price;
  // A price that may not be today's any more (0.9.0) is the last one seen, with its date by the product.
  const todayWord = v.stale ? 'Last seen' : 'Today';

  // The tag by today's price.
  const off = v.discount !== undefined && v.discount > 0.004 ? `${Math.round(v.discount * 100)}% OFF` : undefined;
  const pill =
    v.kind === 'great' || v.kind === 'good' || v.kind === 'small'
      ? { cls: 'green', text: off ?? 'ON SPECIAL' }
      : v.kind === 'wait'
        ? { cls: 'amber', text: off ? `${off} · WAIT` : 'WAIT' }
        : v.kind === 'fake'
          ? { cls: 'red', text: v.always ? 'ALWAYS ON SPECIAL' : 'FAKE SPECIAL' }
          : v.kind === 'normal'
            ? { cls: 'grey', text: v.headline.toUpperCase() }
            : undefined;

  // One plain tip: is it a good time to buy?
  const cycle = stats.cycleWeeks ? ` about every ${stats.cycleWeeks} weeks` : '';
  const saleOff = stats.usualSale !== undefined && stats.typical ? 1 - stats.usualSale / stats.typical : 0;
  // 0.10.10: only the tip the verdict at the top doesn't already give ("Wait for a better special" up
  // there and "Worth waiting" here said the same sentence twice).
  const tip =
    v.kind === 'normal' && stats.usualSale !== undefined && saleOff >= 0.1
              ? {
                  cls: 'amber',
                  title: 'Worth waiting',
                  body: `${saleOff >= 0.45 && saleOff <= 0.55 ? `It's half price (${money(stats.usualSale)})` : `It's usually ${money(stats.usualSale)} on special (${Math.round(saleOff * 100)}% off)`}${cycle}.`,
                }
      : undefined;

  // Where today's price sits, between the lowest and the normal price.
  const marks = [
    { key: 'low', label: 'Lowest', value: stats.low },
    { key: 'sale', label: 'Usual sale', value: stats.usualSale },
    { key: 'normal', label: 'Usual', value: stats.typical },
  ]
    .filter((m): m is { key: string; label: string; value: number } => m.value !== undefined)
    // A "usual sale" at the normal price (multi-buys keep the shelf price) says nothing.
    .filter((m) => m.key !== 'sale' || !near(m.value, stats.typical));
  const values = [...marks.map((m) => m.value), ...(today !== undefined ? [today] : [])];
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const flat = values.length < 2 || hi - lo < 0.01;
  const at = (x: number) => ((x - lo) / Math.max(0.01, hi - lo)) * 100;
  // Marks at (nearly) the same price share one label: "Usual sale & lowest".
  const labels: { pos: number; value: number; text: string; key: string }[] = [];
  for (const m of marks) {
    const same = labels.find((l) => near(l.value, m.value));
    if (same) same.text = `${same.text} & ${m.label.toLowerCase()}`;
    else labels.push({ pos: at(m.value), value: m.value, text: m.label, key: m.key });
  }
  // Labels too close together to read: keep the ends.
  const shown = labels.filter((l) => l.pos <= 1 || l.pos >= 99 || labels.every((x) => x === l || Math.abs(x.pos - l.pos) > 24));
  const todayNote = labels.find((l) => near(l.value, today));
  const hidden = labels.filter((l) => !shown.includes(l) && !near(l.value, today));

  // How often it's on sale: this phone's weeks once there are enough, else the shared history.
  const now = useNow(60_000);
  const strip = Array.from({ length: 13 }, (_, i) => {
    const end = now - (12 - i) * WEEK;
    const inWeek = allReadings.filter((r) => Date.parse(r.date) > end - WEEK && Date.parse(r.date) <= end);
    return inWeek.length ? (inWeek.some((r) => onSale(r, stats.typical, allowMulti)) ? 'sale' : 'no') : 'unknown';
  });
  const known = strip.filter((x) => x !== 'unknown').length;
  const saleWeeks = strip.filter((x) => x === 'sale').length;
  const ownShare = known >= 4 ? saleWeeks / known : undefined;
  const share = ownShare ?? market?.saleShare;
  const shareText =
    share === undefined
      ? undefined
      : share < 0.05
        ? 'Hardly ever'
        : share >= 0.42 && share <= 0.58
          ? 'About half the time'
          : share >= 0.28 && share < 0.42
            ? 'About a third of the time'
            : share >= 0.2 && share < 0.28
              ? 'About a quarter of the time'
              : `${Math.round(share * 100)}% of the time`;

  // When it was last on sale (from this phone's own price checks), to say if another is due (0.7.4).
  const lastSaleAt = [...allReadings].reverse().find((r) => onSale(r, stats.typical, allowMulti))?.date;
  const onSaleNow = !!allReadings.length && onSale(allReadings[allReadings.length - 1], stats.typical, allowMulti);
  const weeksSinceSale = lastSaleAt ? Math.floor((now - Date.parse(lastSaleAt)) / WEEK) : undefined;
  const nextSaleText =
    onSaleNow || weeksSinceSale === undefined || weeksSinceSale < 1
      ? undefined
      : stats.cycleWeeks && weeksSinceSale >= stats.cycleWeeks * 0.8
        ? `Last on special ${weeksSinceSale === 1 ? 'a week' : `${weeksSinceSale} weeks`} ago, so another sale is likely soon.`
        : stats.cycleWeeks
          ? `Last on special ${weeksSinceSale === 1 ? 'a week' : `${weeksSinceSale} weeks`} ago. Sales usually come round every ~${stats.cycleWeeks} weeks.`
          : `Last on special ${weeksSinceSale === 1 ? 'a week' : `${weeksSinceSale} weeks`} ago.`;

  const ownDays = allReadings.length ? Math.max(1, Math.round((now - Date.parse(allReadings[0].date)) / 86_400_000)) : 0;
  const ownWeeks = allReadings.length ? Math.max(1, Math.round((now - Date.parse(allReadings[0].date)) / WEEK)) : 0;
  const source = market
    ? `From shared prices · ${market.days} days`
    : allReadings.length
      ? `Your prices · ${ownWeeks >= 9 ? `${Math.round(ownWeeks / 4.3)} months` : `${ownWeeks} week${ownWeeks === 1 ? '' : 's'}`}`
      : 'No prices yet';

  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem('restock.historyOpen') === '1';
    } catch {
      return false;
    }
  });
  const toggleOpen = () =>
    setOpen((x) => {
      try {
        localStorage.setItem('restock.historyOpen', x ? '0' : '1');
      } catch {
        // just for this visit
      }
      return !x;
    });
  return (
    <div className={bare ? 'ph ph-bare' : 'card ph'}>
      <div className="ph-head" style={{ flexWrap: 'wrap' }}>
        {!bare && (
          <span className="title" style={{ fontSize: 17 }}>
            Price history
          </span>
        )}
        {/* 0.9.6: when this product's price was last checked (follows the size and shop picked). */}
        <LastUpdated readings={allReadings} />
      </div>
      {options.length > 1 && <HistoryPicker options={options} picked={o} onPick={onPick} />}

      <div className="ph-now">
        <div>
          <div className="ph-lab">{todayWord}</div>
          <div className="ph-big num">
            {money(today)}
            {o.multi && <span className="ph-each"> each</span>}
          </div>
        </div>
        {pill && <span className={`ph-pill ${pill.cls}`}>{pill.text}</span>}
      </div>
      <div className="ph-sub">
        {o.multi
          ? `${o.multi.n} for ${money(o.multi.total)} · one on its own is ${money(o.shelfPrice)}`
          : productLine(o.product, o.price, optionStyle(options))}
      </div>
      {tip && (
        <div className={`ph-tip ${tip.cls}`}>
          <b>{tip.title}</b>
          <span>{tip.body}</span>
        </div>
      )}

      {/* 0.10.10: today's price stays; the chart and the rest open when asked (and stay how you left them) */}
      <button className="btn small ph-more" aria-expanded={open} onClick={toggleOpen}>
        {open ? 'Hide the chart and history' : 'Show the chart and history'}{' '}
        <span className={open ? 'turn-up' : 'turn-down'}>
          <Icon name="chevron" size={14} />
        </span>
      </button>
      {open && (
        <>
      {range}
      {allReadings.length >= 2 ? (
        <>
          <div className="ph-chart">
            <PriceChart readings={chartShown.slice(-400)} typical={stats.typical} />
          </div>
          {/* 0.11.2: a short chart under "1 year" looked broken: say why it's short, and where the rest comes from */}
          {ownDays < 28 && (
            <p className="small ph-short" role="note">
              The chart is drawn from this phone's own price checks: {ownDays <= 1 ? 'a day' : `${ownDays} days`} so far, so that's all it can show yet. It
              fills in as your phone keeps checking.
              {market ? ` The usual price and how often it's on special come from shared prices (${market.days} days), which don't include a day-by-day chart.` : ''}
            </p>
          )}
        </>
      ) : (
        <p className="small" style={{ margin: 0 }}>
          Your own price chart starts after a couple of price checks.
        </p>
      )}

      {!flat && today !== undefined ? (
        <>
          <div className="ph-sec">Where today's price sits</div>
          <div className="ph-scale" aria-label={`${todayWord} ${money(today)}, between ${money(lo)} and ${money(hi)}`}>
            <div className="ph-track" />
            {labels.map((l) => (
              <span key={l.key} className={`ph-mark ${l.key}`} style={{ left: `${l.pos}%` }} />
            ))}
            <span className="ph-mark today" style={{ left: `${at(today)}%` }} />
            <div
              className="ph-pin"
              style={{ left: `${at(today)}%`, transform: `translateX(${at(today) < 20 ? '-12%' : at(today) > 80 ? '-88%' : '-50%'})` }}
            >
              {todayWord} {money(today)}
              {todayNote ? ` · ${todayNote.text.toLowerCase()}` : ''}
            </div>
            {shown.map((l) => (
              <div
                key={l.key}
                className="ph-lbl"
                style={
                  l.pos <= 1
                    ? { left: 0 }
                    : l.pos >= 99
                      ? { right: 0, textAlign: 'right' }
                      : { left: `${l.pos}%`, transform: 'translateX(-50%)', textAlign: 'center' }
                }
              >
                <b className="num">{money(l.value)}</b>
                {l.text}
              </div>
            ))}
          </div>
          {hidden.length > 0 && (
            <p className="small" style={{ margin: 0 }}>
              {hidden.map((l) => `${l.text} ${money(l.value)}`).join(' · ')}
            </p>
          )}
        </>
      ) : (
        today !== undefined && (
          <p className="small" style={{ margin: 0 }}>
            The price hasn't changed: {money(today)} every check, never on special.
          </p>
        )
      )}

      {shareText && (
        <>
          <div className="ph-sec">How often it's on special</div>
          {/* The bar is the share of the time it's been on sale, not a countdown (0.7.4). */}
          <div className="ph-often">
            <div className="ph-meter" role="img" aria-label={`On special ${Math.round((share ?? 0) * 100)}% of the time`}>
              <i style={{ width: `${Math.max(3, Math.round((share ?? 0) * 100))}%` }} />
            </div>
            <span>
              <b>{shareText}</b>
              {stats.cycleWeeks ? <br /> : null}
              {stats.cycleWeeks ? `a sale about every ${stats.cycleWeeks} weeks` : null}
            </span>
          </div>
          <div className="small" style={{ marginTop: -4 }}>
            The bar shows how much of the time it's been on special ({Math.round((share ?? 0) * 100)}%).
            {nextSaleText ? ` ${nextSaleText}` : ''}
          </div>
          {ownShare !== undefined && (
            <div className="ph-weeks" aria-label={`On special ${saleWeeks} of the last ${known} weeks with prices`}>
              {strip.map((x, i) => (
                <i key={i} className={x} />
              ))}
              <span className="small">
                {saleWeeks} of the last {known} weeks
              </span>
            </div>
          )}
        </>
      )}

      {/* "Stock up" or "next sale due": not when the tip above already says to wait, or that it's not a real sale. */}
      {v.kind !== 'wait' && v.kind !== 'fake' && <StockUpTip stats={stats} readings={chartReadings} />}
        </>
      )}

      {onEnterPrice && (
        <button className="btn small" style={{ alignSelf: 'flex-start', minHeight: 44 }} onClick={onEnterPrice}>
          <Icon name="tag" size={16} /> Enter a price
        </button>
      )}

      <button className="ph-src" onClick={() => setWhy((x) => !x)} aria-expanded={why}>
        <span>{source}</span>
        <Icon name="info" size={18} />
      </button>
      {why &&
        (market ? (
          <p className="small" style={{ margin: 0 }}>
            Usual, usual sale and lowest come from shared prices ({market.source || MARKET_SOURCE}): {market.days} days at {chainName(o.product.chain)}, on
            sale {Math.round(market.saleShare * 100)}% of the time{stats.cycleWeeks ? `, about every ${stats.cycleWeeks} weeks` : ''}.
            {stats.marketScale && stats.marketScale !== 1
              ? ` Adjusted ${Math.round(Math.abs(stats.marketScale - 1) * 100)}% ${stats.marketScale > 1 ? 'up' : 'down'} to match your shop's prices.`
              : ''}{' '}
            Restock switches to this phone's own prices after about 4 weeks.
          </p>
        ) : (
          <p className="small" style={{ margin: 0 }}>
            {stats.readings} price{stats.readings === 1 ? '' : 's'} seen over {stats.spanDays} days
            {stats.low !== undefined ? ` · lowest ${money(Math.min(stats.low, stats.current?.price ?? Infinity))}` : ''}. The usual price is the
            middle regular price over the last 6 months; a week counts as on special when it was on special or under its usual price.
          </p>
        ))}
    </div>
  );
}
