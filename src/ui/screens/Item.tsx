import { useEffect, useRef, useState, type ReactNode } from 'react';
import { act } from '../../lib/undo'; // 0.9.5 (undo)
import {
  addReading,
  allCategories,
  cardChains,
  deleteGroup,
  deleteReading,
  getGroup,
  groupProductIds,
  nowIso,
  openEntryForGroup,
  readingsFor,
  removeProductFromGroup,
  updateGroup,
  updateProduct,
} from '../../lib/db';
import { addToList as addToListUndoable } from '../../lib/listActions'; // 0.9.5 (undo)
import { MARKET_SOURCE } from '../../lib/market';
import { genericName, nameHasSize } from '../../lib/naming';
import { orderOptions, PRODUCT_ORDERS, shopRank } from '../../lib/productOrder';
import { ensureNotificationPermission, notificationsAllowed, scheduleReminders } from '../../lib/notify';
import { isNative } from '../../stores/http';
import { serverMode, serverUi } from '../../server-mode/flag';
import { firstPhoto, ItemPhoto } from '../../server-mode/ui/deskShared';
import { getSettings, updateSettings } from '../../lib/db';
import { loadRecommendations } from '../../lib/recs';
import { money, parseMoney, tidySize } from '../../lib/units';
import { amountToConfirm, basisWord, lastUpdatedText, newestReading, priceLine, productLine, sizeLabel, type CompareStyle } from '../../lib/unitPrice';
import { useLive } from '../../lib/useLive';
import {
  ALERT_LEVELS,
  computeStats,
  HISTORY_DAYS,
  multiBuy,
  optionStyle,
  productQty,
  tiedWithBest,
  withMarket,
  type Option,
  type PriceStats,
  type Recommendation,
} from '../../lib/verdict';
import {
  chainName,
  GOOD_SALE,
  GREAT_SALE,
  HISTORY_WEEKS,
  historyLabel,
  LEARNING_DAYS,
  type AlertLevel,
  type Group,
  type PriceReading,
} from '../../types';
import {
  CheckedAgo,
  Hold,
  MoreInfo,
  previewFromOption,
  ProductPreview,
  ChainDot,
  Explain,
  Icon,
  PriceChart,
  Sheet,
  SwapBox,
  TopBar,
} from '../components';
import { CheapestInfoTag, MemberInfoTag, MultiInfoTag, StockInfoTag, SwapInfoTag, VerdictInfoTag } from '../tagInfo';
import { useNav } from '../nav';
import { SECTION_PLACE, costcoIsOn, isLocalOnlyShop, searchChainsIn, type StoreChain } from '../../shops';
import { checkAtCostco, costcoCheckable } from '../../lib/costcoCheck'; // 0.9.6 (review L1)
import { notAtChains } from '../../lib/picks';

const BANNER: Record<Recommendation['action'], string> = {
  buy: 'green',
  alt: 'blue',
  small: 'green',
  wait: 'amber',
  skip: 'red',
  none: 'grey',
};

const PCTS = [10, 20, 30, 40, 50, 60, 70, 80, 90];

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
          <strong>Wait</strong> means it's on special, but it's been at least 5% cheaper than this in the last 6 months, so a better sale is likely.
        </p>
        <p>
          Alerts arrive after a price check (in the background, or when you tap Check prices &amp; stock), once per deal. Alternatives (swap &amp;
          save) count too.
        </p>
      </Explain>
    </div>
  );
}

/** Shown once, on an item page, to people who haven't allowed notifications yet. */
function AlertsPrompt({ name }: { name: string }) {
  const nav = useNav();
  const show = useLive(async () => {
    if (!isNative()) return false;
    const s = await getSettings();
    if (s.seenHints.includes('alerts')) return false;
    return !(await notificationsAllowed());
  }, []);
  if (!show) return null;
  const dismiss = async () => {
    const s = await getSettings();
    await updateSettings({ seenHints: [...s.seenHints, 'alerts'] });
  };
  return (
    <div className="card" style={{ flexDirection: 'row', alignItems: 'center' }}>
      <Icon name="bell" />
      <span style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span className="title" style={{ fontSize: 15 }}>
          Want a heads-up when {name} is on special?
        </span>
        <span className="small">Restock can send a notification after each price check.</span>
      </span>
      <span style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <button
          className="btn small primary"
          onClick={async () => {
            const ok = await ensureNotificationPermission();
            await dismiss();
            if (ok) {
              await scheduleReminders(await getSettings()).catch(() => undefined);
              nav.toast('Alerts are on');
            }
          }}
        >
          Turn on
        </button>
        <button className="btn small ghost" onClick={dismiss}>
          Not now
        </button>
      </span>
    </div>
  );
}

/** The usual amount, for "Any size": "300 g", or the usual product when its amount isn't known. */
/** The price history chart's range buttons, short enough for five across a phone (0.9.1). */
const RANGE_SHORT: Record<number, string> = { 4: '1 month', 8: '2 months', 13: '3 months', 26: '6 months', 52: '1 year' };

/** "2 months" as a 2 over "months" (the range buttons, 0.9.5). */
function RangeLabel({ text }: { text: string }) {
  const m = text.match(/^(\d+)\s+(.+)$/);
  if (!m) return <>{text}</>;
  return (
    <span className="range-label">
      <b>{m[1]}</b>
      <span>{m[2]}</span>
    </span>
  );
}

function amountOf(rec: Recommendation): string {
  const u = usualOption(rec);
  if (!u) return 'the amount you usually buy';
  const q = productQty(u.product);
  if (!q.qty || !q.unit) return `the amount in ${u.product.name}`;
  if (q.unit === 'ea' && u.product.size) return tidySize(u.product.size, u.product.name) ?? u.product.size;
  return q.unit === 'g'
    ? q.qty >= 1000
      ? `${+(q.qty / 1000).toFixed(2)} kg`
      : `${Math.round(q.qty)} g`
    : q.unit === 'ml'
      ? q.qty >= 1000
        ? `${+(q.qty / 1000).toFixed(2)} L`
        : `${Math.round(q.qty)} ml`
      : `${Math.round(q.qty)} of them`;
}
/** Where "This size" takes its amount from: the usual product, with its size when the name doesn't say. */
function amountFrom(rec: Recommendation): string {
  const u = usualOption(rec);
  if (!u) return 'your usual product';
  const { name, size } = u.product;
  return size && !nameHasSize(name, size) ? `${name} (${tidySize(size, name) ?? size})` : name;
}
const usualOption = (rec: Recommendation) =>
  rec.options.find((o) => o.product.id === rec.group.usualProductId) ?? rec.options.find((o) => o.role === 'main');

/** 0.9.6: both prices, per item then the comparison price: "$0.98 each · $2.61 / L (estimated)", or "$0.98 each · size unknown". */
function unitText(o: Option, style?: CompareStyle) {
  return priceLine(o.product, o.price, style).text;
}

export function ItemScreen({ groupId }: { groupId: string }) {
  const nav = useNav();
  const data = useLive(async () => {
    const group = await getGroup(groupId);
    if (!group) return null;
    const [recs, readings, categories, onList, cards] = await Promise.all([
      loadRecommendations(),
      readingsFor(groupProductIds(group)),
      allCategories(),
      openEntryForGroup(groupId),
      cardChains(),
    ]);
    // Deleted on another phone (or a moment ago): show "Item removed".
    const rec = recs.find((r) => r.group.id === groupId);
    if (!rec) return null;
    return {
      group,
      rec,
      readings,
      categories: categories.filter((c) => c.section === (group.section ?? 'pantry')),
      onList,
      cards,
    };
  }, [groupId]);
  const [selected, setSelected] = useState<string>();
  const [sheet, setSheet] = useState<'edit' | 'price' | 'menu' | { option: Option }>();
  const appSettings = useLive(getSettings, []);
  const [preview, setPreview] = useState<Option>();
  const [rangeWeeks, setRangeWeeks] = useState<number>();
  const adding = useRef(false);
  // 0.9.4, the web on a server: the server keeps older prices than this browser (weeks), so the chart
  // asks it for the product it shows (as the desktop side panel does). Never on the phone.
  const [older, setOlder] = useState<Map<string, PriceReading[]>>(new Map());
  const olderPrices = serverMode ? serverUi.current?.olderPrices : undefined;
  const wantOlder = olderPrices && data ? (data.rec.options.find((o) => o.product.id === (selected ?? data.rec.best?.product.id ?? data.group.usualProductId)) ?? data.rec.options[0])?.product.id : undefined;
  useEffect(() => {
    if (!olderPrices || !wantOlder || older.has(wantOlder)) return;
    let live = true;
    const from = new Date(Date.now() - Math.max(...HISTORY_WEEKS) * 7 * 86_400_000).toISOString();
    void olderPrices(wantOlder, from)
      .catch(() => [] as PriceReading[])
      .then((rows) => live && setOlder((m) => new Map(m).set(wantOlder, rows)));
    return () => {
      live = false;
    };
  }, [olderPrices, wantOlder, older]);

  const [checkingCostco, setCheckingCostco] = useState(false); // 0.9.6 (review L1): "Check at Costco"
  if (data === undefined) return <div className="screen" />;
  if (data === null) {
    return (
      <div className="screen">
        <TopBar title="Item removed" />
      </div>
    );
  }

  const { group, rec, readings, categories, onList, cards } = data;
  // Listed in the order picked on this page (0.7.6): by shop then size, cheapest first, or A to Z.
  const order = appSettings?.productOrder ?? 'size';
  const ordered = orderOptions(rec.options, order);
  const cstyle = optionStyle(rec.options); // one comparison unit on every line of this item (0.9.6)
  const mains = ordered.filter((o) => o.role === 'main');
  const alts = ordered.filter((o) => o.role === 'alt');
  const chartId = selected ?? rec.best?.product.id ?? group.usualProductId;
  const chartOption = rec.options.find((o) => o.product.id === chartId) ?? rec.options[0];
  const ownReadings = chartOption ? (readings.get(chartOption.product.id) ?? []) : [];
  // 0.9.4, server mode: the server's prices and this browser's, once per time and price (this browser's
  // copy wins), and as far back as the server keeps. On a phone, just its own.
  const fromServer = chartOption ? (older.get(chartOption.product.id) ?? []) : [];
  const seenHere = new Set(ownReadings.map((r) => `${r.date.slice(0, 16)}|${r.price}`));
  const extra = fromServer.filter((r) => !seenHere.has(`${r.date.slice(0, 16)}|${r.price}`));
  const allReadings = extra.length ? [...ownReadings, ...extra].sort((a, b) => a.date.localeCompare(b.date)) : ownReadings;
  // The chart shows the range picked above it (up to the history you keep, or the server keeps).
  const keepWeeks = fromServer.length ? Math.max(...HISTORY_WEEKS) : (appSettings?.historyWeeks ?? 8);
  const weeks = Math.min(rangeWeeks ?? keepWeeks, keepWeeks);
  const from = Date.now() - weeks * 7 * 86_400_000;
  const chartReadings = allReadings.filter((r) => Date.parse(r.date) >= from);
  // Member prices only count towards normal and lowest with the shop's card (0.9.0), as in the verdict.
  const stats = chartOption
    ? withMarket(
        // 0.9.1: with 12 months picked, Lowest, Normal and Usual sale cover the whole chart, not just its last 6 months.
        computeStats(chartReadings, Date.now(), cards.has(chartOption.product.chain), Math.max(HISTORY_DAYS, weeks * 7 + 1)),
        chartOption.product.market,
      )
    : undefined;
  // Shops you've said you don't buy it at (0.8.9), and the ones on this item's tab with none of
  // your picks yet (one per website).
  const chainOf = (id: string) => rec.options.find((o) => o.product.id === id)?.product.chain;
  const notAt = notAtChains(group, chainOf) as StoreChain[];
  const missingChains = appSettings
    ? searchChainsIn(appSettings.enabledChains, group.section ?? 'pantry').filter(
        (c) => !mains.some((o) => o.product.chain === c) && !notAt.includes(c),
      )
    : [];
  // "Not at this shop": it stops asking, the shop counts as not having it, and any you'd also take
  // there go (they'd never come up), with Undo.
  const notAtShop = async (c: StoreChain) => {
    const there = alts.filter((o) => o.product.chain === c);
    await act(`${group.name}: not at ${chainName(c)}`, async () => {
      for (const o of there) await removeProductFromGroup((await getGroup(group.id)) ?? group, o.product.id);
      // 0.9.6 (review L1): "Not at Costco" stays on this phone; the shared item never says Costco.
      if (isLocalOnlyShop(c)) return setCostcoNotAt(true);
      const now = (await getGroup(group.id)) ?? group;
      await updateGroup(group.id, { notAt: [...new Set([...(now.notAt ?? []), c])] });
    }); // 0.9.5 (undo)
  };
  /** 0.9.6 (review L1): this phone's own "Not at Costco" for this item (settings.costco.notAt, never shared). */
  const setCostcoNotAt = async (on: boolean) => {
    const s = await getSettings();
    const was = s.costco?.notAt ?? [];
    const notAt = on ? [...new Set([...was, group.id])] : was.filter((id) => id !== group.id);
    await updateSettings({ costco: { ...(s.costco ?? { on: false }), notAt } });
  };
  const searchName = mains[0]?.product.name ?? group.name;
  // 0.9.6 (review L1): a Costco product's price is checked again only when the person presses
  // "Check at Costco" here: one page, never with "Check now" for everything or in the background.
  const costcoHere = costcoIsOn() ? costcoCheckable([...mains, ...alts].map((o) => o.product)) : [];
  const checkCostco = async (p: (typeof mains)[number]['product']) => {
    if (checkingCostco) return;
    setCheckingCostco(true);
    try {
      nav.toast((await checkAtCostco(p)).text);
    } finally {
      setCheckingCostco(false);
    }
  };

  // Checks the list itself, so a double tap adds it once (with its tab's list and a qty).
  const addToList = async () => {
    if (adding.current) return;
    adding.current = true;
    try {
      const added = !onList && (await addToListUndoable(group)); // 0.9.5 (undo)
      if (!added) nav.toast('Already on your shopping list');
    } finally {
      adding.current = false;
    }
  };

  const row = (o: Option, tag?: 'cheapest' | 'swap') => (
    <Hold key={o.product.id} onLong={() => setPreview(o)}>
      <div className="row">
        <MoreInfo src={o.product.imageUrl} name={o.product.name} onOpen={() => setPreview(o)} />
        <button className="row-main" style={{ color: 'inherit', font: 'inherit' }} onClick={() => setSheet({ option: o })}>
          <span className="grow">
            <span className="title two-lines" style={{ fontSize: 15 }}>
              {o.product.name}
            </span>
            {/* The shop on the line under the name, as on Home and the Pantry (0.9.0). */}
            <span className="small">
              <ChainDot chain={o.product.chain} /> {chainName(o.product.chain)}
              {productLine(o.product, o.price, cstyle) ? ` · ${productLine(o.product, o.price, cstyle)}` : ''}
              {o.stats.current && ' · '}
              <CheckedAgo date={o.stats.current?.date} source={o.stats.current?.source} />
            </span>
            <span className="tags" style={{ marginTop: 2 }}>
              {tag === 'cheapest' && <CheapestInfoTag o={o} options={rec.options.filter((x) => x.role === o.role)} />}
              {tag === 'swap' && (
                <SwapInfoTag
                  label="SWAP & SAVE"
                  line={{ item: group.name, groupId: group.id, pick: o, outOfStock: false, qty: 1, yours: rec.best, fair: 0 }}
                />
              )}
              <VerdictInfoTag o={o} />
              {o.price !== undefined && priceLine(o.product, o.price).unknown && <span className="tag normal">SIZE UNKNOWN</span>}
              {o.product.sizing?.size?.basis === 'estimated' && <span className="tag normal">ESTIMATED SIZE</span>}
              {o.product.inStock === false && <StockInfoTag o={o} />}
              <MultiInfoTag o={o} />
              {o.stats.current?.memberOnly && <MemberInfoTag chain={o.product.chain} hasCard={!o.locked} />}
            </span>
          </span>
          <span style={{ textAlign: 'right' }}>
            <span className="num" style={{ fontWeight: 600, display: 'block' }}>
              {money(o.multi ? o.shelfPrice : o.price)}
            </span>
            {o.multi && (
              <span className="small num" style={{ display: 'block' }}>
                {money(o.price)} each in {o.multi.n}s
              </span>
            )}
            {/* Last week's special (0.9.0): the last price seen, but the sale may be over. */}
            {o.stats.current?.isSpecial && o.verdict.stale === 'ended' && (
              <span className="small" style={{ display: 'block' }}>
                special, may have ended
              </span>
            )}
            {o.stats.current?.isSpecial && o.verdict.stale !== 'ended' && (
              <span className="small" style={{ display: 'block' }}>
                {o.stats.current.wasPrice && o.stats.current.wasPrice > (o.price ?? 0) ? (
                  <>
                    special · was{' '}
                    <span className="num" style={{ textDecoration: 'line-through' }}>
                      {money(o.stats.current.wasPrice)}
                    </span>
                  </>
                ) : (
                  'special'
                )}
              </span>
            )}
          </span>
        </button>
      </div>
    </Hold>
  );

  // New items: say plainly that the verdict gets better once there's a few weeks of history.
  const learning = learningDays(rec.options.filter((o) => o.role === 'main'));
  const usingShared = rec.options.some((o) => o.stats.fromMarket);

  return (
    <div className="screen">
      {/* 0.9.5, the web on a server: the item's big photo at the top (its first letter if none). */}
      {serverMode && (
        <ItemPhoto
          src={firstPhoto(rec.options.find((o) => o.product.id === group.usualProductId)?.product, rec.best?.product, ...rec.options.map((o) => o.product))}
          name={group.name}
        />
      )}
      <TopBar
        title={group.name}
        right={
          <button className="icon-btn" aria-label="More options" onClick={() => setSheet('menu')}>
            <Icon name="more" size={20} />
          </button>
        }
      />

      <div className={`banner ${BANNER[rec.action]}`}>
        <div className="eyebrow" style={{ color: 'inherit', opacity: 0.9 }}>
          Verdict
        </div>
        <div className="big">{rec.headline}</div>
        {rec.detail && <p style={{ fontSize: 15 }}>{rec.detail}</p>}
        {rec.saving !== undefined && <p style={{ fontSize: 15, fontWeight: 700 }}>Saves about {money(rec.saving)}</p>}
      </div>
      {rec.action === 'alt' && rec.alt && (
        <div className="two">
          <SwapBox label="Instead of yours" option={rec.best} />
          <SwapBox label="Get this" option={rec.alt} hi />
        </div>
      )}
      {learning !== undefined && usingShared && (
        <div className="card hint" style={{ flexDirection: 'column', gap: 4 }}>
          <strong>
            Judged with shared price history <span className="tag normal beta">Beta</span>
          </strong>
          <span>
            Restock has only {learning} day{learning === 1 ? '' : 's'} of its own prices for this, so the verdict uses months of shared price
            history. After about 4 weeks it switches to the prices this phone has seen.
          </span>
        </div>
      )}
      {learning !== undefined && !usingShared && (
        <div className="card hint" style={{ flexDirection: 'column', gap: 4 }}>
          <strong>Still learning this item's prices</strong>
          <span>
            {learning === 0
              ? 'Restock has only just started watching it.'
              : `Restock has ${learning} day${learning === 1 ? '' : 's'} of prices so far.`}{' '}
            It still tells you about specials, but until it knows the usual price it compares against the shop's "was" price, which can flatter a
            sale. It takes about 4 to 8 weeks.
          </span>
          {appSettings &&
            !appSettings.marketData.enabled &&
            rec.options.some((o) => o.product.chain === 'coles' || o.product.chain === 'woolworths') && (
              <button
                className="linkish small"
                style={{ alignSelf: 'flex-start' }}
                onClick={() => {
                  nav.push({ name: 'settings' });
                  // Open Settings at Shared price history, once that section has drawn.
                  let tries = 0;
                  const t = window.setInterval(() => {
                    const el = document.getElementById('s-shared');
                    if (!el && ++tries < 30) return;
                    window.clearInterval(t);
                    el?.scrollIntoView({ block: 'start' });
                  }, 50);
                }}
              >
                Judge it from day one with shared price history (Beta)
              </button>
            )}
        </div>
      )}
      <div className="chips" style={{ marginTop: -4 }}>
        <button className="chip" onClick={() => setSheet('edit')} aria-label="Change price alerts">
          <Icon name="bell" size={14} /> Alert: {ALERT_LEVELS.find((a) => a.id === group.alertLevel)?.label}
          {group.alertLevel === 'custom' ? ` (${group.alertPct ?? 30}%+)` : ''}
        </button>
        <button className="chip" onClick={() => setSheet('edit')} aria-label="Set a target price">
          <Icon name="tag" size={14} /> {group.targetPrice !== undefined ? `Under ${money(group.targetPrice)}` : 'Set a price alert'}
        </button>
      </div>
      {/* Not for a price that may not be today's any more (0.9.0): it says "right now". */}
      {group.targetPrice !== undefined && rec.best?.price !== undefined && rec.best.price <= group.targetPrice + 0.004 && !rec.best.verdict.stale && (
        <div className="banner green">
          <strong>Under your {money(group.targetPrice)} target</strong>
          <span style={{ fontSize: 13 }}>
            {money(rec.best.price)} at {chainName(rec.best.product.chain)} right now.
          </span>
        </div>
      )}

      <AlertsPrompt name={group.name} />

      <button className={`btn block ${onList ? '' : 'primary'}`} onClick={addToList}>
        <Icon name={onList ? 'cartCheck' : 'cartPlus'} size={18} /> {onList ? 'On your shopping list' : 'Add to shopping list'}
      </button>
      <p className="small" style={{ marginTop: -6 }}>
        This item stays in {SECTION_PLACE[group.section ?? 'pantry']} so Restock keeps watching its price. The shopping list is just for this trip.
      </p>

      {chartOption && stats && (
        <PriceHistory
          options={ordered}
          option={chartOption}
          onPick={setSelected}
          stats={stats}
          allReadings={allReadings}
          chartReadings={chartReadings}
          allowMulti={group.allowMulti !== false}
          onEnterPrice={() => setSheet('price')}
          range={
            allReadings.length >= 2 ? (
              <div className="seg range-seg" role="group" aria-label="How far back">
                {HISTORY_WEEKS.map((w) => (
                  <button
                    key={w}
                    aria-pressed={w === weeks}
                    aria-label={historyLabel(w)}
                    className={w > keepWeeks ? 'dim' : undefined}
                    onClick={() =>
                      w > keepWeeks
                        ? nav.toast(`You keep ${historyLabel(keepWeeks)} of prices. Keep more in Settings → Price checks.`)
                        : setRangeWeeks(w)
                    }
                  >
                    {/* 0.9.1: five choices; 0.9.5 (look): the number over its unit, so all five fit a phone at any text size. */}
                    <RangeLabel text={RANGE_SHORT[w] ?? historyLabel(w)} />
                  </button>
                ))}
              </div>
            ) : undefined
          }
        />
      )}

      <div className="card flush">
        <div className="section-head">
          <span className="title">
            My picks <HowItWorks />
          </span>
          {mains.length > 2 ? (
            <select
              className="input"
              style={{ width: 'auto', height: 44, padding: '0 36px 0 10px', fontSize: 14 }}
              value={order}
              onChange={(e) => void updateSettings({ productOrder: e.target.value as typeof order })}
              aria-label="Order of products"
            >
              {PRODUCT_ORDERS.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.label}
                </option>
              ))}
            </select>
          ) : (
            <span className="small">{productsAndShops(mains)}</span>
          )}
        </div>
        {mains.length > 2 && (
          <p className="small" style={{ padding: '0 14px 4px' }}>
            {productsAndShops(mains)}
          </p>
        )}
        {mains.length > 0 && (
          <div className="size-choice">
            <div className="seg" role="radiogroup" aria-label="Which sizes">
              {[false, true].map((any) => (
                <button
                  key={String(any)}
                  role="radio"
                  aria-checked={!!group.anySize === any}
                  aria-pressed={!!group.anySize === any}
                  onClick={() => void act(`${group.name}: ${any ? 'any size' : 'this size'}`, () => updateGroup(group.id, { anySize: any }))}
                >
                  {any ? 'Any size' : 'This size'}
                </button>
              ))}
            </div>
            <p className="small">
              {group.anySize
                ? `Any of your picks, any size and as many as it takes: at each shop Restock works out the cheapest way to get ${amountOf(rec)}.`
                : `Amount: from ${amountFrom(rec)}. Shops are compared on that amount, buying one of your picks for each on your list.`}
            </p>
          </div>
        )}
        {mains.map((o) => row(o, mains.length > 1 && o === rec.best && !tiedWithBest(rec).length ? 'cheapest' : undefined))}
        {costcoHere.map((p) => (
          <div key={`costco-check-${p.id}`} style={{ padding: '0 14px 12px' }}>
            <button className="btn small" style={{ minHeight: 44 }} disabled={checkingCostco} onClick={() => void checkCostco(p)}>
              <Icon name="refresh" size={16} /> {checkingCostco ? 'Checking Costco…' : costcoHere.length > 1 ? `Check at Costco: ${p.name}` : 'Check at Costco'}
            </button>
          </div>
        ))}
        {mains.length > 1 && tiedWithBest(rec).length > 0 && (
          <p className="small" style={{ padding: '0 14px 12px' }}>
            {sameAt(rec.best!, tiedWithBest(rec), mains)}, so buy it wherever suits you.
          </p>
        )}
        {!mains.length && (
          <p className="small" style={{ padding: '0 14px 12px' }}>
            Not linked to a shop's product yet.
          </p>
        )}
        {missingChains.map((c) => (
          // A shop on this tab with none of your picks: find it there, or say you don't buy it there.
          // The words on full width, the two buttons under them (0.9.0: side by side they squashed the words).
          <div className="row shop-gap" key={c}>
            <ChainDot chain={c} />
            <span className="grow">
              <span className="title" style={{ fontSize: 15 }}>
                Not added at {chainName(c)}
              </span>
              <span className="small">So Restock can tell you which shop is cheapest</span>
              <span className="shop-gap-btns">
                <button className="btn small" onClick={() => nav.push({ name: 'add', attachTo: group.id, as: 'main', chain: c, query: searchName })}>
                  <Icon name="search" size={16} /> Find it
                </button>
                <button className="btn small" onClick={() => void notAtShop(c)}>
                  Not here
                </button>
              </span>
            </span>
          </div>
        ))}
        {notAt.map((c) => (
          <div className="row shop-gap" key={c}>
            <ChainDot chain={c} />
            <span className="grow">
              <span className="title" style={{ fontSize: 15 }}>
                Not at {chainName(c)}
              </span>
              <span className="small">You don't buy it there, so {chainName(c)} counts as not having it</span>
            </span>
            <button
              className="btn small"
              onClick={async () => {
                const g = (await getGroup(group.id)) ?? group;
                await act(`${group.name}: buying it at ${chainName(c)} again`, async () => {
                  if (isLocalOnlyShop(c)) await setCostcoNotAt(false);
                  if ((g.notAt ?? []).includes(c)) await updateGroup(group.id, { notAt: (g.notAt ?? []).filter((x) => x !== c) });
                });
              }}
            >
              Buy it here again
            </button>
          </div>
        ))}
        {mains.length > 0 && (
          // Another product you buy as this item (a second scent of conditioner, or the Aldi one at
          // Aldi), at any shop, including ones it's already ticked at.
          <button className="row" onClick={() => nav.push({ name: 'add', attachTo: group.id, as: 'main', another: true, query: group.name })}>
            <Icon name="plus" size={18} />
            <span className="grow">
              <span className="title" style={{ fontSize: 15, color: 'var(--green)' }}>
                Add another pick
              </span>
              <span className="small">
                Another one you buy as {group.name}, at any shop ({kindOfVariety(group, data.categories)}, say)
              </span>
            </span>
          </button>
        )}
      </div>

      <div className="card flush">
        <div className="section-head">
          <span className="title">
            Would also take <HowItWorks />
          </span>
          <span className="small">{alts.length || 'None yet'}</span>
        </div>
        <p className="small" style={{ padding: '0 14px 6px' }}>
          Only for Swap &amp; save: Restock tells you when one of these is on special for less than your pick. They don't count when shops are compared.
        </p>
        {alts.map((o) => row(o, rec.alt === o ? 'swap' : undefined))}
        <button className="row" onClick={() => nav.push({ name: 'add', attachTo: group.id, as: 'alt', query: group.name })}>
          <Icon name="swap" size={18} />
          <span className="grow">
            <span className="title" style={{ fontSize: 15, color: 'var(--green)' }}>
              Find one you'd also take
            </span>
            <span className="small">Another brand or size you'd happily buy instead, when it's cheaper</span>
          </span>
        </button>
      </div>

      <button className="btn primary block" onClick={() => nav.pop()}>
        <Icon name="check" size={18} /> Done
      </button>
      <p className="small" style={{ textAlign: 'center', marginTop: -6 }}>
        Changes are saved as you make them.
      </p>

      {sheet === 'edit' && (
        <EditSheet
          group={group}
          categories={categories}
          suggested={genericName(mains[0]?.product.name, mains[0]?.product.brand)}
          onClose={() => setSheet(undefined)}
        />
      )}
      {preview && <ProductPreview product={previewFromOption(preview)} onClose={() => setPreview(undefined)} />}
      {sheet === 'menu' && (
        <Sheet title={group.name} onClose={() => setSheet(undefined)}>
          <div className="card flush">
            <button className="row" onClick={() => setSheet('edit')}>
              <Icon name="pencil" size={18} />
              <span className="grow">
                <span className="title">Edit name, category and alerts</span>
              </span>
            </button>
            <button className="row" disabled={!rec.options.length} onClick={() => setSheet('price')}>
              <Icon name="tag" size={18} />
              <span className="grow">
                <span className="title">Enter a price</span>
                <span className="small">Saw it on the shelf? Add the price yourself.</span>
              </span>
            </button>
            <button
              className="row"
              onClick={async () => {
                setSheet(undefined);
                const name = group.name;
                await act(`${name} deleted`, () => deleteGroup(group.id)); // 0.9.5 (undo)
                nav.pop();
              }}
            >
              <Icon name="trash" size={18} />
              <span className="grow">
                <span className="title" style={{ color: 'var(--red-ink)' }}>
                  Delete item
                </span>
                <span className="small">Removes it and its price history</span>
              </span>
            </button>
          </div>
        </Sheet>
      )}
      {sheet === 'price' && <PriceSheet options={rec.options} productId={chartOption?.product.id} onClose={() => setSheet(undefined)} />}
      {typeof sheet === 'object' && <OptionSheet group={group} option={sheet.option} options={rec.options} onClose={() => setSheet(undefined)} />}
    </div>
  );
}

export function EditSheet({
  group,
  categories,
  suggested,
  onClose,
}: {
  group: Group;
  categories: { id: string; name: string }[];
  suggested?: string;
  onClose: () => void;
}) {
  const nav = useNav();
  const [name, setName] = useState(group.name);
  const [categoryId, setCategoryId] = useState(group.categoryId ?? '');
  const [alertLevel, setAlertLevel] = useState<AlertLevel>(group.alertLevel);
  const [alertPct, setAlertPct] = useState(group.alertPct ?? 30);
  const [allowBulk, setAllowBulk] = useState(group.allowBulk !== false);
  const [allowMulti, setAllowMulti] = useState(group.allowMulti !== false);
  const [target, setTarget] = useState(group.targetPrice !== undefined ? group.targetPrice.toFixed(2) : '');

  const save = async () => {
    const t = parseFloat(target.replace(/[^0-9.]/g, ''));
    // 0.9.5 (undo)
    await act(`Saved ${name.trim() || group.name}`, () => updateGroup(group.id, {
      name: name.trim() || group.name,
      categoryId: categoryId || undefined,
      alertLevel,
      alertPct: alertLevel === 'custom' ? alertPct : undefined,
      allowBulk,
      allowMulti,
      targetPrice: Number.isFinite(t) && t > 0 ? Math.round(t * 100) / 100 : undefined,
    }));
    onClose();
  };

  return (
    <Sheet title="Edit item" onClose={onClose}>
      <label className="field">
        <span>Name</span>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      {suggested && suggested.toLowerCase() !== name.trim().toLowerCase() && (
        <button className="chip wrap" style={{ alignSelf: 'flex-start' }} onClick={() => setName(suggested)}>
          Use a short name: {suggested}
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
      <button className="btn primary" onClick={save}>
        Save
      </button>
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
    </Sheet>
  );
}

/** "Last updated today, 6:32 am" for the product shown, top right of the Price history card (phone and web). */
export function LastUpdated({ readings }: { readings: readonly PriceReading[] }) {
  const last = newestReading(readings);
  return (
    <span className="small ph-updated" style={{ marginLeft: 'auto', textAlign: 'right' }}>
      {lastUpdatedText(last?.date, last?.source)}
    </span>
  );
}

/** A local calendar day as "2026-11-12", for the date box. */
const dayOf = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

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
  const today = dayOf(new Date());
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

function OptionSheet({ group, option, options, onClose }: { group: Group; option: Option; options: Option[]; onClose: () => void }) {
  const id = option.product.id;
  const [looking, setLooking] = useState(false);
  // 0.9.6: nothing typed yet and Restock has a guess or an estimate: it fills the box, to check and save (confirmed).
  const offer = option.product.qty ? undefined : amountToConfirm(option.product);
  const [qty, setQty] = useState(option.product.qty?.toString() ?? (offer ? String(offer.qty) : ''));
  const [unit, setUnit] = useState(option.product.qtyUnit ?? offer?.unit ?? productQty(option.product).unit ?? 'ea');
  const line = priceLine(option.product, option.price, optionStyle(options));
  const isAlt = option.role === 'alt';
  const lastAtShop = !isAlt && options.filter((o) => o.role === 'main' && o.product.chain === option.product.chain).length === 1;

  /** Move between My picks and Would also take. */
  const move = async () => {
    const mains = [group.usualProductId, ...group.sameProductIds].filter((x): x is string => !!x && x !== id);
    const alts = group.altProductIds.filter((x) => x !== id);
    if (isAlt) mains.push(id);
    else alts.push(id);
    await act(isAlt ? `${option.product.name} is one of your picks` : `${option.product.name} moved to Would also take`, () =>
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
        {isAlt ? 'Would also take' : 'My pick'} at {chainName(option.product.chain)}
        {` · ${line.size}`}
        {option.product.barcode ? ` · barcode ${option.product.barcode}` : ''}
      </p>
      <p className="small">
        {option.verdict.headline}. {option.verdict.detail}
      </p>
      <div className="card">
        <div className="title" style={{ fontSize: 15 }}>
          Amount for unit pricing
        </div>
        <p className="small">Lets Restock compare different pack sizes fairly. For toilet paper, use total sheets (rolls × sheets per roll).</p>
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
            placeholder={String(productQty(option.product).qty ?? '')}
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
        <Icon name="swap" size={18} /> {isAlt ? 'Make this one of my picks' : 'Move to Would also take'}
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

/** Days of history for an item that's still learning (under 4 weeks), or undefined once it's settled. */
function learningDays(options: Option[]): number | undefined {
  if (!options.length || options.some((o) => o.stats.current && o.stats.readings > 0 && isSample(o))) return undefined;
  const span = Math.max(0, ...options.map((o) => o.stats.spanDays ?? 0));
  return span < LEARNING_DAYS ? span : undefined;
}
const isSample = (o: Option) => /\(sample\)/i.test(o.product.name);

/**
 * A picture of the statistics: where today's price sits between the lowest, the usual sale
 * and the normal price, and how much of the time it's on sale.
 */
/** The "how My picks and Would also take work" explanation, from a small ⓘ by the section titles. */
function HowItWorks() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="icon-btn inline-info" aria-label="How My picks and Would also take work" onClick={() => setOpen(true)}>
        <Icon name="info" size={16} />
      </button>
      {open && (
        <Sheet title="My picks and Would also take" onClose={() => setOpen(false)}>
          <p>
            <strong>My picks</strong> are what you buy at each shop. They can be different at each one: Heinz at Coles and Woolworths, Aldi's own
            at Aldi. Shops are compared using your picks only, so a shop with none of them counts as not having it.
          </p>
          <p>
            <strong>Would also take</strong> are others you'd happily buy when they're cheaper, like another home brand. They're only for Swap
            &amp; save: when one is on special for less than your pick (per 100 g, per litre or per item), it shows up next to yours.
          </p>
          <p>
            <strong>This size</strong> compares shops on the amount of your usual product, buying one of your picks for each on your list.{' '}
            <strong>Any size</strong> lets any of your picks, in any size and any number, do: at each shop Restock works out the cheapest way to get
            that amount, say three small bags instead of one big one.
          </p>
          <p>
            <strong>Not here</strong>, on a shop with none of your picks, tells Restock you don't buy it there. It stops asking you to find it, and
            that shop counts as not having it.
          </p>
          <p>If a pick and one you'd also take are both on special, your pick comes first. Bigger packs only come up as swaps if you've said yes to bulk packs (Edit).</p>
        </Sheet>
      )}
    </>
  );
}

/**
 * Stock-up reminders from an item's sale pattern: "on sale now, and only every 6 weeks: stock up",
 * or "next sale likely around 18 Nov: maybe hold off".
 */
function StockUpTip({ stats, readings }: { stats: PriceStats; readings: { date: string; isSpecial: boolean }[] }) {
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
  const days = Math.round((next - Date.now()) / 86_400_000);
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

// ---------- price history ----------

const WEEK = 7 * 86_400_000;
const near = (a: number | undefined, b: number | undefined) => a !== undefined && b !== undefined && Math.abs(a - b) < 0.015;

/** "8 products · 3 shops", or "2 shops" when it's one product per shop. */
function productsAndShops(list: Option[]): string {
  const shops = new Set(list.map((x) => x.product.chain)).size;
  const s = `${shops} shop${shops === 1 ? '' : 's'}`;
  return list.length === shops ? s : `${list.length} products · ${s}`;
}

/** "Same price at Coles and Woolworths", or "at every shop", naming shops rather than counting products. */
function sameAt(best: Option, tied: Option[], all: Option[]): string {
  const shops = [...new Set([best, ...tied].map((x) => x.product.chain))];
  if (shops.length === new Set(all.map((x) => x.product.chain)).size && shops.length > 1) return 'Same price at every shop';
  if (shops.length === 1) return `Same price for ${tied.length + 1} products at ${chainName(shops[0])}`;
  const names = shops.map((c) => chainName(c));
  return `Same price at ${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** The product's name without its size, for the second line of a price history row. */
function nameWithoutSize(o: Option): string {
  const size = o.product.size?.trim();
  let n = o.product.name;
  if (size) n = n.replace(new RegExp(`\\s*[|·-]?\\s*${size.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i'), '');
  return n.replace(/\s*\|\s*$/, '').trim() || o.product.name;
}

/**
 * Which product the price history is for (0.7.3): a tab for each shop, then that shop's products,
 * each with its size in bold, the name underneath, today's price and any sale, so two that share a
 * name ("Brita Maxtra Pro", 1 filter or 3 pack) are easy to tell apart.
 */
function HistoryPicker({ options, picked, onPick }: { options: Option[]; picked: Option; onPick: (id: string) => void }) {
  const chains = [...new Set(options.map((x) => x.product.chain))].sort((a, b) => shopRank(a) - shopRank(b));
  const [shop, setShop] = useState(picked.product.chain);
  useEffect(() => setShop(picked.product.chain), [picked.product.chain]);
  const rows = options.filter((x) => x.product.chain === shop);
  const priced = options.filter((x) => x.unitPrice !== undefined && x.role !== 'alt');
  const low = priced.length > 1 ? Math.min(...priced.map((x) => x.unitPrice!)) : undefined;
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
              aria-pressed={c === shop}
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
                  {low !== undefined && x.unitPrice !== undefined && x.role !== 'alt' && Math.abs(x.unitPrice - low) < 1e-9 && (
                    <span className="tag great">Cheapest</span>
                  )}
                  {x.role === 'alt' && <span className="tag normal">Alternative</span>}
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

/** Is this reading a sale? (A multi-buy alone doesn't count when the item has multi-buys off.) */
function onSale(r: PriceReading, typical: number | undefined, allowMulti: boolean): boolean {
  const multiOnly = !allowMulti && !!multiBuy(r.promo) && !(r.wasPrice !== undefined && r.wasPrice > r.price + 0.004);
  if (r.isSpecial && !multiOnly) return true;
  return typical !== undefined && r.price < typical * 0.97;
}

/**
 * The price history card. It starts with what shared price history knows (today's price, a tip,
 * where today sits, how often it's on sale) and grows a chart and a week-by-week strip once this
 * phone has its own prices.
 */
function PriceHistory({
  options,
  option: o,
  onPick,
  stats,
  allReadings,
  chartReadings,
  allowMulti,
  range,
  onEnterPrice,
}: {
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
          ? { cls: 'red', text: 'FAKE SALE' }
          : v.kind === 'normal'
            ? { cls: 'grey', text: v.headline.toUpperCase() }
            : undefined;

  // One plain tip: is it a good time to buy?
  const cycle = stats.cycleWeeks ? ` about every ${stats.cycleWeeks} weeks` : '';
  const saleOff = stats.usualSale !== undefined && stats.typical ? 1 - stats.usualSale / stats.typical : 0;
  const tip =
    v.kind === 'great'
      ? { cls: 'green', title: 'A great deal', body: v.detail }
      : v.kind === 'good'
        ? { cls: 'green', title: 'A good sale', body: v.detail }
        : v.kind === 'small'
          ? { cls: 'green', title: 'A small saving', body: v.detail }
          : v.kind === 'wait'
            ? { cls: 'amber', title: 'Worth waiting', body: v.detail }
            : v.kind === 'normal' && stats.usualSale !== undefined && saleOff >= 0.1
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
    { key: 'normal', label: 'Normal', value: stats.typical },
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
  const now = Date.now();
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

  const ownWeeks = allReadings.length ? Math.max(1, Math.round((now - Date.parse(allReadings[0].date)) / WEEK)) : 0;
  const source = market
    ? `From shared price history · ${market.days} days`
    : allReadings.length
      ? `Your prices · ${ownWeeks >= 9 ? `${Math.round(ownWeeks / 4.3)} months` : `${ownWeeks} week${ownWeeks === 1 ? '' : 's'}`}`
      : 'No prices yet';

  return (
    <div className="card ph">
      <div className="ph-head" style={{ flexWrap: 'wrap' }}>
        <span className="title" style={{ fontSize: 17 }}>
          Price history
        </span>
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

      {range}
      {allReadings.length >= 2 ? (
        <div className="ph-chart">
          <PriceChart readings={chartShown.slice(-400)} typical={stats.typical} />
        </div>
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
            Usual, usual sale and lowest come from shared price history ({market.source || MARKET_SOURCE}): {market.days} days at {chainName(o.product.chain)}, on
            sale {Math.round(market.saleShare * 100)}% of the time{stats.cycleWeeks ? `, about every ${stats.cycleWeeks} weeks` : ''}.
            {stats.marketScale && stats.marketScale !== 1
              ? ` Adjusted ${Math.round(Math.abs(stats.marketScale - 1) * 100)}% ${stats.marketScale > 1 ? 'up' : 'down'} to match your shop's prices.`
              : ''}{' '}
            Restock switches to this phone's own prices after about 4 weeks.
          </p>
        ) : (
          <p className="small" style={{ margin: 0 }}>
            {stats.readings} price{stats.readings === 1 ? '' : 's'} seen over {stats.spanDays} days
            {stats.low !== undefined ? ` · lowest ${money(stats.low)}` : ''}. The usual price is the middle regular price over the last 6 months; a week counts
            as on special when it was on special or under its usual price.
          </p>
        ))}
    </div>
  );
}

/** "another scent or size" for cleaning and toiletries, "another flavour or size" for food and drink (0.7.3). */
function kindOfVariety(group: Group, categories: { id: string; name: string }[]): string {
  const cat = categories.find((c) => c.id === group.categoryId)?.name ?? '';
  const scented =
    group.section === 'pharmacy' ||
    /clean|laundry|wash|bath|toilet|personal|beauty|hair|skin|body|deodor|soap|shampoo|condition/i.test(`${cat} ${group.name}`);
  return scented ? 'another scent or size' : 'another flavour or size';
}
