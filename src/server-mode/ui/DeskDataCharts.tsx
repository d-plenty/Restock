// 0.9.5: the Data tab's charts, drawn by hand in SVG (no chart library): spending each month (bars),
// where you shop (bars across), one item's price over time (a line, the usual price dashed, specials
// marked with a diamond), and the storage bar. Each one is an image with a summary in words, its
// numbers written on it or in a table beside it, and one accent colour (the theme's own tokens, so
// light, dark and true black all work).
import { useEffect, useId, useRef, useState, type RefObject } from 'react';
import { chainName } from '../../shops';
import { money } from '../../lib/units';
import {
  barLayout,
  bytesText,
  cheapestByWeek,
  dayMonthYear,
  labelEvery,
  longMonth,
  monthLabel,
  moneyAxis,
  axisCents,
  moneyShort,
  niceScale,
  shares,
  storageParts,
  thisMonth,
  xsOf,
  yOf,
  type Box,
} from './dataCharts';
import type { DataSeries, DataStats, DataSummary } from './houseData';

/** A table of the chart's numbers, shown when asked (and always there for screen readers). */
function NumbersTable({ caption, head, rows }: { caption: string; head: string[]; rows: (string | number)[][] }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className="dd-numbers">
      <button type="button" className="dk-linkish" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)}>
        {open ? 'Hide the numbers' : 'Show the numbers'}
      </button>
      <div id={id} className={open ? 'dd-numbers-table' : 'sr-only'}>
        <table className="dd-mini">
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr>
              {head.map((h) => (
                <th key={h} scope="col">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                {r.map((c, j) =>
                  j === 0 ? (
                    <th key={j} scope="row">
                      {c}
                    </th>
                  ) : (
                    <td key={j}>{c}</td>
                  ),
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * The width a chart has on the page, so it's drawn at that size (text stays its real size, however
 * wide the card): a ResizeObserver on the box around it, `fallback` until it's measured.
 */
function useChartWidth(fallback = 600): [RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([e]) => {
      const next = Math.round(e.contentRect.width);
      if (next > 0) setW((was) => (Math.abs(was - next) > 2 ? Math.max(280, next) : was));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

// ---------- spending each month ----------

const BARS: Box = {
  width: 600,
  height: 220,
  top: 22,
  right: 8,
  bottom: 30,
  left: 44,
};

export function SpendingChart({ months, now = Date.now() }: { months: DataStats['spending']['months']; now?: number }) {
  const cur = thisMonth(now);
  const [ref, width] = useChartWidth();
  const box: Box = { ...BARS, width, left: width < 420 ? 38 : BARS.left };
  const { scale, bars, base } = barLayout(
    months.map((m) => m.total),
    box,
  );
  // Labels only where they fit: about 48 px a value, 40 a month.
  const room = Math.floor((width - box.left - box.right) / 40);
  const every = labelEvery(months.length, room);
  const valued = months.length <= Math.floor((width - box.left - box.right) / 48);
  const high = months.reduce((b, m, i) => (m.total > (months[b]?.total ?? -1) ? i : b), 0);
  const last = months[months.length - 1];
  const summary =
    months.length === 0
      ? 'Nothing ticked off yet'
      : `Spending each month, ${longMonth(months[0].month)} to ${longMonth(last.month)}: ` +
        months.map((m) => `${longMonth(m.month)} ${money(m.total)}${m.month === cur ? ' so far' : ''}`).join(', ');
  return (
    <>
      <div ref={ref} className="dd-chart-box">
        <svg className="dd-chart" width={box.width} height={box.height} viewBox={`0 0 ${box.width} ${box.height}`} role="img" aria-label={summary}>
          {scale.ticks.map((t) => (
            <g key={t}>
              <line className={t === 0 ? 'dd-axis' : 'dd-grid'} x1={box.left} x2={box.width - box.right} y1={yOf(t, scale, box)} y2={yOf(t, scale, box)} />
              <text className="dd-tick" x={box.left - 6} y={yOf(t, scale, box) + 4} textAnchor="end">
                {moneyAxis(t, axisCents(scale.ticks))}
              </text>
            </g>
          ))}
          {bars.map((b, i) => {
            const m = months[i];
            const isNow = m.month === cur;
            const showValue = m.total > 0 && (valued || i === high || i === months.length - 1);
            return (
              <g key={m.month}>
                {b.h > 0 && <rect className={`dd-bar${isNow ? ' now' : ''}`} x={b.x} y={b.y} width={b.w} height={b.h} rx={Math.min(5, b.w / 3)} />}
                {showValue && (
                  <text className="dd-value" x={b.cx} y={Math.max(12, b.y - 6)} textAnchor="middle">
                    {moneyShort(m.total)}
                  </text>
                )}
                {i % every === 0 || i === months.length - 1 ? (
                  <text className="dd-tick" x={b.cx} y={base + 18} textAnchor="middle">
                    {monthLabel(m.month, i === 0 && months.length > 12)}
                  </text>
                ) : null}
              </g>
            );
          })}
        </svg>
      </div>
      <NumbersTable
        caption="Spending each month"
        head={['Month', 'Spent', 'Things ticked off']}
        rows={months.map((m) => [`${longMonth(m.month)}${m.month === cur ? ' (so far)' : ''}`, money(m.total), m.count])}
      />
    </>
  );
}

// ---------- where you shop ----------

export function ShopBars({ shops }: { shops: DataStats['shops'] }) {
  const list = shops.filter((s) => s.total > 0).slice(0, 8);
  const pct = shares(list.map((s) => s.total));
  const top = Math.max(1, ...list.map((s) => s.total));
  return (
    <ul className="dd-shops" aria-label="Share of what you spent, by shop">
      {list.map((s, i) => (
        <li key={s.chain ?? 'none'}>
          <span className="dd-shop-line">
            <span className="clip">{s.chain ? chainName(s.chain) : 'No shop on the line'}</span>
            <strong className="num">
              {pct[i]}% · {moneyShort(s.total)}
            </strong>
          </span>
          <span className="dd-shop-track" aria-hidden>
            <span className="dd-shop-fill" style={{ width: `${Math.max(2, (s.total / top) * 100)}%` }} />
          </span>
        </li>
      ))}
    </ul>
  );
}

// ---------- one item's price over time ----------

const LINE_BOX: Box = {
  width: 600,
  height: 210,
  top: 24,
  right: 14,
  bottom: 28,
  left: 48,
};

function diamond(x: number, y: number, r: number) {
  return `M${x} ${y - r} L${x + r} ${y} L${x} ${y + r} L${x - r} ${y} Z`;
}

/** The cheapest price each week, the usual price dashed, and the specials as diamonds with their price. */
export function PriceChart({ series }: { series: DataSeries }) {
  const [ref, width] = useChartWidth();
  const LINE: Box = { ...LINE_BOX, width };
  const points = cheapestByWeek(series.weeks);
  const usual = series.usual;
  const prices = points.map((p) => p.price);
  const scale = niceScale(Math.min(...prices, usual ?? Infinity) * 0.92, Math.max(...prices, usual ?? -Infinity) * 1.04, 4);
  const xs = xsOf(points.length, LINE);
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${xs[i].toFixed(1)} ${yOf(p.price, scale, LINE).toFixed(1)}`).join(' ');
  // A month's name at its first week, where there's room since the last one (about 64 px).
  const monthAt = new Set<number>();
  let lastX = -Infinity;
  let lastMonth = '';
  points.forEach((p, i) => {
    const m = p.week.slice(0, 7);
    if (m !== lastMonth && xs[i] - lastX >= 64) {
      monthAt.add(i);
      lastX = xs[i];
    }
    lastMonth = m;
  });
  const lo = points.reduce((b, p, i) => (p.price < (points[b]?.price ?? Infinity) ? i : b), 0);
  const hi = points.reduce((b, p, i) => (p.price > (points[b]?.price ?? -Infinity) ? i : b), 0);
  // Which points get their price written: the specials (if not too many), the lowest, highest and newest.
  const specials = points.map((p, i) => (p.special ? i : -1)).filter((i) => i >= 0);
  const labelled = new Set([lo, hi, points.length - 1, ...(specials.length <= 8 ? specials : [])]);
  const first = points[0];
  const last = points[points.length - 1];
  const summary = points.length
    ? `${series.item.name}, cheapest price each week from ${dayMonthYear(first.week)} to ${dayMonthYear(last.week)}: ` +
      `${usual !== null ? `usually ${money(usual)}, ` : ''}lowest ${money(points[lo].price)}${points[lo].special ? ' on special' : ''}, highest ${money(points[hi].price)}, ` +
      `now ${money(last.price)}. On special in ${specials.length} of ${points.length} weeks.`
    : `${series.item.name}: no prices in this period`;
  return (
    <>
      <div ref={ref} className="dd-chart-box">
        <svg className="dd-chart" width={LINE.width} height={LINE.height} viewBox={`0 0 ${LINE.width} ${LINE.height}`} role="img" aria-label={summary}>
          {scale.ticks.map((t) => (
            <g key={t}>
              <line className="dd-grid" x1={LINE.left} x2={LINE.width - LINE.right} y1={yOf(t, scale, LINE)} y2={yOf(t, scale, LINE)} />
              <text className="dd-tick" x={LINE.left - 6} y={yOf(t, scale, LINE) + 4} textAnchor="end">
                {moneyAxis(t, axisCents(scale.ticks))}
              </text>
            </g>
          ))}
          {usual !== null && <line className="dd-usual" x1={LINE.left} x2={LINE.width - LINE.right} y1={yOf(usual, scale, LINE)} y2={yOf(usual, scale, LINE)} />}
          {points.length > 1 && <path className="dd-line" d={path} />}
          {points.map((p, i) =>
            p.special ? (
              <path key={p.week} className="dd-special" d={diamond(xs[i], yOf(p.price, scale, LINE), 7)} />
            ) : points.length === 1 || labelled.has(i) ? (
              <circle key={p.week} className="dd-dot" cx={xs[i]} cy={yOf(p.price, scale, LINE)} r={4} />
            ) : null,
          )}
          {points.map((p, i) =>
            labelled.has(i) ? (
              <text
                key={`v${p.week}`}
                className="dd-value"
                x={Math.min(LINE.width - LINE.right - 18, Math.max(LINE.left + 18, xs[i]))}
                y={p.special || i === lo ? yOf(p.price, scale, LINE) + 20 : yOf(p.price, scale, LINE) - 10}
                textAnchor="middle"
              >
                {moneyShort(p.price)}
              </text>
            ) : null,
          )}
          {points.map((p, i) =>
            monthAt.has(i) ? (
              <text key={`m${p.week}`} className="dd-tick" x={xs[i]} y={LINE.height - 8} textAnchor="middle">
                {monthLabel(p.week.slice(0, 7), i === 0)}
              </text>
            ) : null,
          )}
        </svg>
      </div>
      <NumbersTable
        caption={`${series.item.name}: cheapest price each week`}
        head={['Week from', 'Cheapest', 'Shop', 'On special']}
        rows={points.map((p) => [dayMonthYear(p.week) ?? p.week, money(p.price), chainName(p.chain), p.special ? 'Yes' : 'No'])}
      />
    </>
  );
}

/** The key under the price chart: a line, a dashed line and a diamond, each with words. */
export function PriceKey({ usual }: { usual: number | null }) {
  return (
    <div className="dd-key" aria-hidden>
      <span>
        <svg width="22" height="10">
          <line className="dd-line" x1="0" y1="5" x2="22" y2="5" />
        </svg>
        Cheapest price that week
      </span>
      {usual !== null && (
        <span>
          <svg width="22" height="10">
            <line className="dd-usual" x1="0" y1="5" x2="22" y2="5" />
          </svg>
          Usually {money(usual)}
        </span>
      )}
      <span>
        <svg width="14" height="14">
          <path className="dd-special" d={diamond(7, 7, 6)} />
        </svg>
        On special
      </span>
    </div>
  );
}

// ---------- storage ----------

export function StorageBar({ summary, names }: { summary: DataSummary; names: Record<string, string> }) {
  const parts = storageParts(summary, names);
  const label = `Storage: ${parts.map((p) => `${p.label} ${bytesText(p.bytes)}`).join(', ')}`;
  return (
    <>
      <div className="dd-stack" role="img" aria-label={label}>
        {parts
          .filter((p) => p.pct > 0)
          .map((p) => (
            <span key={p.key} className={`dd-seg dd-c-${p.key}`} style={{ width: `${p.pct}%` }} />
          ))}
      </div>
      <ul className="dd-legend">
        {parts.map((p) => (
          <li key={p.key}>
            <span className={`dd-swatch dd-c-${p.key}`} aria-hidden />
            <span className="grow">{p.label}</span>
            <strong className="num">{bytesText(p.bytes)}</strong>
          </li>
        ))}
      </ul>
    </>
  );
}
