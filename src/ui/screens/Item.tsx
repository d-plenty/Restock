import { useNow } from '../useNow';
import { ShelfNotices } from './ShelfNotices';
import { useEffect, useRef, useState } from 'react';
import { flavourNoteFor, flavourSets } from '../../lib/flavours';
import { act } from '../../lib/undo';
import { allCategories, cardChains, deleteGroup, getGroup, groupProductIds, openEntryForGroup, readingsFor, removeProductFromGroup, updateGroup } from '../../lib/db';
import { addToList as addToListUndoable } from '../../lib/listActions';
import { MARKET_SHOPS } from '../../lib/market';
import { sharedOn } from '../../lib/priceShare';
import { genericName, nameHasSize } from '../../lib/naming';
import { orderOptions, PRODUCT_ORDERS } from '../../lib/productOrder';
import { ensureNotificationPermission, notificationsAllowed, scheduleReminders } from '../../lib/notify';
import { isNative } from '../../stores/http';
import { serverMode, serverUi } from '../../server-mode/flag';
import { firstPhoto, ItemPhoto } from '../../server-mode/ui/deskShared';
import { getSettings, updateSettings } from '../../lib/db';
import { loadRecommendations } from '../../lib/recs';
import { money, tidySize } from '../../lib/units';
import { kiloPrice, priceLine, productLine, type CompareStyle } from '../../lib/unitPrice';
import { useLive, useSettings } from '../../lib/useLive';
import { ALERT_LEVELS, computeStats, HISTORY_DAYS, multiBuy, optionStyle, productQty, tiedWithBest, withMarket, type Option, type Recommendation, unitWord } from '../../lib/verdict';

const wordList = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
import { chainName, HISTORY_WEEKS, historyLabel, LEARNING_DAYS, type Group, type PriceReading } from '../../types';
import { Hold, MoreInfo, RowInfo, previewFromOption, ProductPreview, ChainDot, Icon, Sheet, SwapBox, TopBar, ScreenWaiting } from '../components';
import { CheapestInfoTag, MemberInfoTag, MultiInfoTag, StockInfoTag, SwapInfoTag, VerdictInfoTag } from '../tagInfo';
import { useNav } from '../nav';
import { costcoIsOn, isLocalOnlyShop, searchChainsIn, type StoreChain } from '../../shops';
import { checkAtCostco, costcoCheckable } from '../../lib/costcoCheck';
import { haveLabel } from '../../lib/inventory';
import { HaveSheet, useInventory } from '../Inventory';
import { notAtChains } from '../../lib/picks';
import { PriceHistory } from './ItemHistory';
import { EditSheet, PriceSheet, OptionSheet } from './ItemSheets';

const BANNER: Record<Recommendation['action'], string> = {
  buy: 'green',
  alt: 'blue',
  small: 'green',
  wait: 'amber',
  skip: 'red',
  none: 'grey',
};

export const PCTS = [10, 20, 30, 40, 50, 60, 70, 80, 90];

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
export function unitText(o: Option, style?: CompareStyle) {
  return priceLine(o.product, o.price, style).text;
}

export function ItemScreen({ groupId }: { groupId: string }) {
  const now = useNow(60_000);
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
  const [sheet, setSheet] = useState<'edit' | 'alerts' | 'price' | 'menu' | { option: Option; wantUnit?: 'g' | 'ml' | 'ea' }>();
  // 0.13.1: inventory (Inventory.tsx)
  const inv = useInventory();
  const [haveOpen, setHaveOpen] = useState(false);
  // 0.12.8: the Products I buy fold, so Edit can open it (a hook: kept above the early returns)
  const productsFold = useRef<HTMLDetailsElement>(null);
  const [learnOpen, setLearnOpen] = useState(false);
  const appSettings = useSettings();
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
  if (data === undefined) return <ScreenWaiting title="Item" />;
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
  const from = now - weeks * 7 * 86_400_000;
  const chartReadings = allReadings.filter((r) => Date.parse(r.date) >= from);
  // Member prices only count towards normal and lowest with the shop's card (0.9.0), as in the verdict.
  const stats = chartOption
    ? withMarket(
        // 0.9.1: with 12 months picked, Lowest, Normal and Usual sale cover the whole chart, not just its last 6 months.
        computeStats(chartReadings, now, cards.has(chartOption.product.chain), Math.max(HISTORY_DAYS, weeks * 7 + 1)),
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
        <div className="row-main row-stretch">
          <button className="row-hit" onClick={() => setSheet({ option: o })} aria-label={`${o.product.name}, ${chainName(o.product.chain)}: details`} />
          <span className="grow">
            <span className="title two-lines" style={{ fontSize: 15 }}>
              {o.product.name}
            </span>
            {/* The shop on the line under the name, as on Home and the Pantry (0.9.0). */}
            <span className="small">
              <ChainDot chain={o.product.chain} /> {chainName(o.product.chain)}
              {productLine(o.product, o.price, cstyle) ? ` · ${productLine(o.product, o.price, cstyle)}` : ''}
            </span>
            <span className="tags" style={{ marginTop: 2 }}>
              {tag === 'cheapest' && <CheapestInfoTag o={o} options={rec.options.filter((x) => x.role === o.role)} />}
              {tag === 'swap' && (
                <SwapInfoTag
                  label="CHEAPER SWAP"
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
          <span className="price-and-info">
            <span className="num" style={{ fontWeight: 600, display: 'block' }}>
              {(!o.multi && kiloPrice(o.product, o.price)?.main) || money(o.multi ? o.shelfPrice : o.price)}
            </span>
            {!o.multi && kiloPrice(o.product, o.price)?.each && (
              <span className="small num kilo-each" style={{ display: 'block' }}>
                {kiloPrice(o.product, o.price)!.each}
              </span>
            )}
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
            {/* 0.12.7: the ⓘ on the right, under the price, as on a shopping line (it sat on the photo) */}
            <RowInfo name={o.product.name} onOpen={() => setPreview(o)} />
          </span>
        </div>
      </div>
    </Hold>
  );

  // 0.12.5: the best of your picks at each shop (the same measure the verdict compares on), for the card under the verdict.
  const costOf = (o: Option) => (rec.byUnit ? o.unitPrice : o.price) ?? Infinity;
  const shopBest = [...new Set(mains.map((o) => o.product.chain))].map((c) => {
    const at = mains.filter((o) => o.product.chain === c);
    if (rec.best && at.includes(rec.best)) return rec.best;
    const inStock = at.filter((o) => o.product.inStock !== false);
    return [...(inStock.length ? inStock : at)].sort((a, b) => costOf(a) - costOf(b))[0];
  });
  // 0.12.8: Edit has a row that opens Products I buy (people looked for their products under Edit).
  const showProducts = () => {
    setSheet(undefined);
    requestAnimationFrame(() => {
      const el = productsFold.current;
      if (!el) return;
      el.open = true;
      el.scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
  };
  // Products I buy opens by itself when something in it needs you: nothing linked yet, picks measured differently, or a shelf notice.
  const whatOpen = !mains.length || !!rec.mixedUnits || !!rec.shelf;
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
          // 0.10.8: Edit (name, category and alerts) is its own button; ⋯ has Enter a price and Delete.
          <span className="item-head-btns">
            <button className="btn small" onClick={() => setSheet('edit')} aria-label={`Edit ${group.name}: name, category and alerts`}>
              <Icon name="pencil" size={16} /> Edit
            </button>
            <button className="icon-btn" aria-label="More: enter a price or delete" onClick={() => setSheet('menu')}>
              <Icon name="more" size={20} />
            </button>
          </span>
        }
      />

      <div className={`banner ${BANNER[rec.action]}`}>
        <div className="eyebrow" style={{ color: 'inherit', opacity: 0.9 }}>
          Verdict
        </div>
        <div className="big">{rec.headline}</div>
        {rec.detail && <p style={{ fontSize: 15 }}>{rec.detail}</p>}
        {flavourNoteFor(rec) && (
          // 0.10.9: "On special in all 3 scents", or which ones are
          <p style={{ fontSize: 15, fontWeight: 700 }}>
            {chainName(rec.best!.product.chain)}: {flavourNoteFor(rec)}.
          </p>
        )}
        {rec.saving !== undefined && <p style={{ fontSize: 15, fontWeight: 700 }}>Saves about {money(rec.saving)}</p>}
      </div>
      {rec.action === 'alt' && rec.alt && (
        <div className="two">
          <SwapBox label="Instead of yours" option={rec.best} />
          <SwapBox label="Get this" option={rec.alt} hi />
        </div>
      )}
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

      {/* 0.13.1: how much is at home, when this item's tab keeps an inventory; a tap changes it */}
      {inv.tabs.has(group.section ?? 'pantry') && (
        <button className="card flush fold fold-go" onClick={() => setHaveOpen(true)} aria-label={`How much ${group.name} you have. Change it`}>
          <span className="fold-head">
            <span className="grow">
              <span className="title">How much I have</span>
              <span className="small">{inv.have.get(group.id) ? haveLabel(inv.have.get(group.id)).replace(/^Have: /, '') : 'Not counted yet'}</span>
            </span>
            <Icon name="chevron" size={18} />
          </span>
        </button>
      )}
      {haveOpen && <HaveSheet group={group} have={inv.have.get(group.id)} inv={inv} usualProductId={group.usualProductId} onClose={() => setHaveOpen(false)} />}

      {/* 0.12.5: the answer first: the best of your picks at each shop, one line each. Everything else on this page is folded under it. */}
      {(shopBest.length > 0 || missingChains.length > 0) && (
        <div className="card flush shop-best">
          <div className="eyebrow shop-best-head">Best price at each shop</div>
          {shopBest.map((o) => (
            <button key={o.product.id} className="row" onClick={() => setSheet({ option: o })} aria-label={`${chainName(o.product.chain)}: ${o.product.name}, ${money(o.price)}`}>
              <ChainDot chain={o.product.chain} />
              <span className="grow">
                <span className="title" style={{ fontSize: 15 }}>
                  {chainName(o.product.chain)}
                  {shopBest.length > 1 && o === rec.best && !tiedWithBest(rec).length && <span className="shop-best-tag"> · Cheapest</span>}
                </span>
                <span className="small clip">{o.product.name}</span>
              </span>
              <span className="num" style={{ fontWeight: 700 }}>
                {/* 0.12.8: loose fruit and veg by the kilo, as on the shelf ticket */}
                {o.price !== undefined ? ((!o.multi && kiloPrice(o.product, o.price)?.main) || money(o.multi ? o.shelfPrice : o.price)) : 'No price yet'}
              </span>
            </button>
          ))}
          {missingChains.map((c) => (
            <div className="row" key={c}>
              <ChainDot chain={c} />
              <span className="grow">
                <span className="title" style={{ fontSize: 15 }}>
                  {chainName(c)}
                </span>
                <span className="small">Not added yet</span>
              </span>
              <button className="btn small" onClick={() => nav.push({ name: 'add', attachTo: group.id, as: 'main', chain: c, query: searchName })} aria-label={`Find it at ${chainName(c)}`}>
                <Icon name="search" size={16} /> Find it
              </button>
            </div>
          ))}
        </div>
      )}

      {/* 0.12.8: "Products I buy" (it was called by another name), with what it's for and a pencil, so it's found: this is where products are added, changed and removed */}
      <details className="card flush fold" data-products open={whatOpen} ref={productsFold}>
        <summary className="fold-head">
          <span className="fold-icon" aria-hidden>
            <Icon name="pencil" size={18} />
          </span>
          <span className="grow">
            <span className="title">Products I buy</span>
            <span className="small">Add, change or remove products</span>
            <span className="small">
              {mains.length ? `${productsAndShops(mains)} · ${group.anySize ? 'any size' : 'this size'}` : 'Not linked to a shop yet'}
            </span>
          </span>
          <span className="fold-arrow" aria-hidden>
            <Icon name="chevron" size={18} />
          </span>
        </summary>
        <div className="section-head">
          <span className="small" style={{ flex: 1 }}>
            How this works <HowItWorks />
          </span>
          {mains.length > 2 ? (
            <select
              className="input"
              style={{ width: 'auto' }}
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
          ) : null}
        </div>
        {/* 0.10.9: several of the same thing at one shop are flavours (scents, colours) of it */}
        {flavourSets(rec).map((f) => (
          <p key={f.chain} className="small flavour-note">
            <strong>
              Any of your {f.n} {f.word} at {chainName(f.chain)}
            </strong>{' '}
            will do: a special on any of them counts.
          </p>
        ))}
        {mains.length > 0 && (
          <div className="size-choice">
            <div className="seg" role="radiogroup" aria-label="Which sizes">
              {[false, true].map((any) => (
                <button
                  key={String(any)}
                  role="radio"
                  aria-checked={!!group.anySize === any}
                  onClick={() => void act(`${group.name}: ${any ? 'any size' : 'this size'}`, () => updateGroup(group.id, { anySize: any }))}
                >
                  {any ? 'Any size' : 'This size'}
                </button>
              ))}
            </div>
            <p className="small">
              {group.anySize
                ? `At each shop Restock works out the cheapest way to get ${amountOf(rec)}.`
                : `Shops are compared on the amount in ${amountFrom(rec)}.`}
            </p>
          </div>
        )}
        {mains.map((o) => row(o, mains.length > 1 && o === rec.best && !tiedWithBest(rec).length ? 'cheapest' : undefined))}
        {/* 0.11.2: picks measured differently (mL and g) can't be compared by size: say so, and offer the fix */}
        {rec.mixedUnits && (
          <div className="banner amber mixed-units" role="note">
            <strong>Measured differently</strong>
            <span>
              Your picks are measured {wordList(rec.mixedUnits.units.map(unitWord))}, so Restock can't compare them by size. "Cheapest" here is the lowest
              price on the shelf, which may be a smaller pack.
            </span>
            {rec.mixedUnits.units[0] !== 'sheet' && (
              <>
                <span>
                  {rec.mixedUnits.units[0] === 'ea' ? 'If the pack also says how many are in it' : `If the pack also says how much is in it ${unitWord(rec.mixedUnits.units[0])}`}, add it and Restock
                  will compare them properly:
                </span>
                {rec.mixedUnits.odd.map((o) => (
                  <button
                    key={o.product.id}
                    className="btn small"
                    onClick={() => setSheet({ option: o, wantUnit: rec.mixedUnits!.units[0] as 'g' | 'ml' | 'ea' })}
                  >
                    Set the amount for {o.product.name}
                    {rec.mixedUnits!.odd.filter((x) => x.product.name === o.product.name).length > 1 ? ` at ${chainName(o.product.chain)}` : ''}
                  </button>
                ))}
              </>
            )}
          </div>
        )}
        {/* 0.11.3: a pick whose pack changed size, or that its shop no longer lists */}
        <ShelfNotices rec={rec} />
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
                {/* 0.12.6: the same words as the Add screen's review ("Not sold here") */}
                <button className="btn small" onClick={() => void notAtShop(c)}>
                  Not sold here
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
                Add another product
              </span>
              <span className="small">
                Another one you buy as {group.name}, at any shop ({kindOfVariety(group, data.categories)}, say)
              </span>
            </span>
          </button>
        )}
      </details>

      <details className="card flush fold">
        <summary className="fold-head">
          <span className="grow">
            <span className="title">Also happy with (alternative product)</span>
            <span className="small">{alts.length ? `${alts.length} added · cheaper swaps you'd also accept` : "Cheaper swaps you'd also accept"}</span>
          </span>
          <span className="fold-arrow" aria-hidden>
            <Icon name="chevron" size={18} />
          </span>
        </summary>
        <div className="section-head">
          <span className="small" style={{ flex: 1 }}>
            How this works <HowItWorks />
          </span>
        </div>
        {alts.map((o) => row(o, rec.alt === o ? 'swap' : undefined))}
        <button className="row" onClick={() => nav.push({ name: 'add', attachTo: group.id, as: 'alt', query: group.name })}>
          <Icon name="swap" size={18} />
          <span className="grow">
            <span className="title" style={{ fontSize: 15, color: 'var(--green)' }}>
              Find another you'd be happy with
            </span>
            <span className="small">Another brand or size you'd happily buy instead, when it's cheaper</span>
          </span>
        </button>
      </details>

      {/* 0.10.10: after what you buy and where (it was above them, three charts deep). 0.12.5: folded, like the rest. */}
      {chartOption && stats && (
        <details className="card flush fold">
          <summary className="fold-head">
            <span className="grow">
              <span className="title">Price history</span>
              <span className="small">
                {learning !== undefined ? `${learning} day${learning === 1 ? '' : 's'} of prices so far · chart and past prices` : 'Chart and past prices'}
              </span>
            </span>
            <span className="fold-arrow" aria-hidden>
              <Icon name="chevron" size={18} />
            </span>
          </summary>
        <PriceHistory
          bare
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
                        ? nav.toast(`You keep ${historyLabel(keepWeeks)} of prices. Keep more in Settings → Prices and deals.`)
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
        </details>
      )}

      {/* 0.12.5: Alerts is a row like the others (it was a chip under the verdict); it opens the alerts sheet */}
      <button className="card flush fold fold-go" onClick={() => setSheet('alerts')} aria-label="Change price alerts">
        <span className="fold-head">
          <span className="grow">
            <span className="title">Alerts</span>
            <span className="small">
              {ALERT_LEVELS.find((a) => a.id === group.alertLevel)?.label}
              {group.alertLevel === 'custom' ? ` (${group.alertPct ?? 30}%+)` : ''}
              {group.targetPrice !== undefined ? ` · under ${money(group.targetPrice)}` : ''}
            </span>
          </span>
          <Icon name="chevron" size={18} />
        </span>
      </button>

      {/* 0.12.5: "Still learning" is one line; the explanation opens from it */}
      {learning !== undefined && (
        <button className="linkish small learn-line" onClick={() => setLearnOpen(true)}>
          <Icon name="info" size={16} />{' '}
          {usingShared ? 'Judged with shared prices for now.' : "Still learning this item's usual price. It takes 4 to 8 weeks."}
        </button>
      )}
      {learnOpen && learning !== undefined && usingShared && (
        <Sheet title="Judged with shared prices" onClose={() => setLearnOpen(false)}>
        <div className="card hint" style={{ flexDirection: 'column', gap: 4 }}>
          <strong>
            Judged with shared prices
          </strong>
          <span>
            Restock has only {learning} day{learning === 1 ? '' : 's'} of its own prices for this, so the verdict uses months of shared
            prices. After about 4 weeks it switches to the prices this phone has seen.
          </span>
        </div>
        </Sheet>
      )}
      {learnOpen && learning !== undefined && !usingShared && (
        <Sheet title="Still learning this item's prices" onClose={() => setLearnOpen(false)}>
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
            !sharedOn(appSettings) &&
            rec.options.some((o) => (MARKET_SHOPS as readonly string[]).includes(o.product.chain)) && (
              <button
                className="linkish small"
                style={{ alignSelf: 'flex-start' }}
                onClick={() => {
                  // 0.10.0: Settings → Privacy and sharing, at Shared prices, once it has drawn.
                  nav.push({ name: 'settings', page: 'privacy' });
                  let tries = 0;
                  const t = window.setInterval(() => {
                    const el = document.getElementById('s-shared');
                    if (!el && ++tries < 30) return;
                    window.clearInterval(t);
                    el?.scrollIntoView({ block: 'start' });
                  }, 50);
                }}
              >
                Judge it from day one: turn on Shared prices
              </button>
            )}
        </div>
        </Sheet>
      )}
      {/* 0.10.10: no Done button here: changes save as you make them, and Back is at the top */}

      {(sheet === 'edit' || sheet === 'alerts') && (
        <EditSheet
          alertsOnly={sheet === 'alerts'}
          group={group}
          categories={categories}
          suggested={genericName(mains[0]?.product.name, mains[0]?.product.brand)}
          onClose={() => setSheet(undefined)}
          onProducts={showProducts}
        />
      )}
      {preview && <ProductPreview product={previewFromOption(preview)} onClose={() => setPreview(undefined)} />}
      {sheet === 'menu' && (
        <Sheet title={group.name} onClose={() => setSheet(undefined)}>
          <div className="card flush">
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
      {typeof sheet === 'object' && (
        <OptionSheet group={group} option={sheet.option} options={rec.options} wantUnit={sheet.wantUnit} onClose={() => setSheet(undefined)} />
      )}
    </div>
  );
}

/** A local calendar day as "2026-11-12", for the date box. */
export const dayOf = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

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
/** The "how Products I buy and Also happy with work" explanation, from a small ⓘ by the section titles. */
function HowItWorks() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="icon-btn inline-info" aria-label="How Products I buy and Also happy with work" onClick={() => setOpen(true)}>
        <Icon name="info" size={16} />
      </button>
      {open && (
        <Sheet title="Products I buy and Also happy with" onClose={() => setOpen(false)}>
          <p>
            <strong>Products I buy</strong> are what you buy at each shop. They can be different at each one: Heinz at Coles and Woolworths, Aldi's own
            at Aldi. Shops are compared using your picks only, so a shop with none of them counts as not having it.
          </p>
          <p>
            <strong>Also happy with</strong> are others you'd happily buy when they're cheaper, like another home brand. They're only for Swap
            &amp; save: when one is on special for less than your pick (per 100 g, per litre or per item), it shows up next to yours.
          </p>
          <p>
            <strong>This size</strong> compares shops on the amount of your usual product, buying one of your picks for each on your list.{' '}
            <strong>Any size</strong> lets any of your picks, in any size and any number, do: at each shop Restock works out the cheapest way to get
            that amount, say three small bags instead of one big one.
          </p>
          <p>
            <strong>Not sold here</strong>, on a shop with none of your picks, tells Restock you don't buy it there. It stops asking you to find it, and
            that shop counts as not having it.
          </p>
          <p>
            <strong>Add to shopping list</strong> is just for this trip. The item stays in your pantry, so Restock keeps watching its price.
          </p>
          <p>
            <strong>Several sizes or flavours at one shop</strong> are all watched, and a special on any of them counts. Keep only the one you want
            if it has to be that one.
          </p>
          <p>If a pick and one you'd also take are both on special, your pick comes first. Bigger packs only come up as swaps if you've said yes to bulk packs (Edit).</p>
        </Sheet>
      )}
    </>
  );
}

// ---------- price history ----------

export const WEEK = 7 * 86_400_000;
export const near = (a: number | undefined, b: number | undefined) => a !== undefined && b !== undefined && Math.abs(a - b) < 0.015;

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
export function nameWithoutSize(o: Option): string {
  const size = o.product.size?.trim();
  let n = o.product.name;
  if (size) n = n.replace(new RegExp(`\\s*[|·-]?\\s*${size.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i'), '');
  return n.replace(/\s*\|\s*$/, '').trim() || o.product.name;
}

/** Is this reading a sale? (A multi-buy alone doesn't count when the item has multi-buys off.) */
export function onSale(r: PriceReading, typical: number | undefined, allowMulti: boolean): boolean {
  const multiOnly = !allowMulti && !!multiBuy(r.promo) && !(r.wasPrice !== undefined && r.wasPrice > r.price + 0.004);
  if (r.isSpecial && !multiOnly) return true;
  return typical !== undefined && r.price < typical * 0.97;
}

/** "another scent or size" for cleaning and toiletries, "another flavour or size" for food and drink (0.7.3). */
function kindOfVariety(group: Group, categories: { id: string; name: string }[]): string {
  const cat = categories.find((c) => c.id === group.categoryId)?.name ?? '';
  const scented =
    group.section === 'pharmacy' ||
    /clean|laundry|wash|bath|toilet|personal|beauty|hair|skin|body|deodor|soap|shampoo|condition/i.test(`${cat} ${group.name}`);
  return scented ? 'another scent or size' : 'another flavour or size';
}
