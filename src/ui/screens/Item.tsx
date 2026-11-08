import { useEffect, useState, type ReactNode } from 'react';
import { groupRows, productRows, undoable } from '../../lib/undo';
import {
  addListEntry,
  addReading,
  allCategories,
  deleteGroup,
  getGroup,
  groupProductIds,
  nowIso,
  openEntryForGroup,
  readingsFor,
  removeProductFromGroup,
  uid,
  updateGroup,
  updateProduct,
} from '../../lib/db';
import { genericName } from '../../lib/naming';
import { ensureNotificationPermission, notificationsAllowed, scheduleReminders } from '../../lib/notify';
import { isNative } from '../../stores/http';
import { getSettings, updateSettings } from '../../lib/db';
import { loadRecommendations } from '../../lib/recs';
import { formatUnitPrice, money, tidySize } from '../../lib/units';
import { useLive } from '../../lib/useLive';
import {
  ALERT_LEVELS,
  computeStats,
  eachText,
  multiBuy,
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
import { SECTION_PLACE, searchChainsIn } from '../../shops';

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
      <div className="title" style={{ fontSize: 14 }}>
        Tell me when it's on sale
      </div>
      <div className="card flush radio-list" role="radiogroup" aria-label="Alerts">
        {ALERT_LEVELS.map((a) => (
          <label key={a.id} className="radio">
            <input type="radio" name="alert-level" checked={level === a.id} onChange={() => onChange(a.id, pct)} />
            <span style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1 }}>
              <span className="title" style={{ fontSize: 14 }}>
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
          <strong>Normal price</strong> is the middle of the non-sale prices Restock has seen over the last 6 months. Until there's a few weeks of
          history, it uses the store's own "was" price.
        </p>
        <p>
          <strong>On sale</strong>: {GOOD_SALE * 100}% or more below normal. <strong>Great deal</strong>: {GREAT_SALE * 100}% or more.{' '}
          <strong>Small saving</strong>: any price drop under {GOOD_SALE * 100}%, even 5c.
        </p>
        <p>
          <strong>Wait</strong> means it's on sale, but it's been at least 5% cheaper than this in the last 6 months, so a better sale is likely.
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
        <span className="title" style={{ fontSize: 14 }}>
          Want a heads-up when {name} is on sale?
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

function unitText(o: Option) {
  return [o.unitPrice !== undefined ? formatUnitPrice(o.unitPrice, productQty(o.product).unit) : '', eachText(o)].filter(Boolean).join(' · ');
}

export function ItemScreen({ groupId }: { groupId: string }) {
  const nav = useNav();
  const data = useLive(async () => {
    const group = await getGroup(groupId);
    if (!group) return null;
    const [recs, readings, categories, onList] = await Promise.all([
      loadRecommendations(),
      readingsFor(groupProductIds(group)),
      allCategories(),
      openEntryForGroup(groupId),
    ]);
    return {
      group,
      rec: recs.find((r) => r.group.id === groupId)!,
      readings,
      categories: categories.filter((c) => c.section === (group.section ?? 'pantry')),
      onList,
    };
  }, [groupId]);
  const [selected, setSelected] = useState<string>();
  const [sheet, setSheet] = useState<'edit' | 'price' | 'menu' | { option: Option }>();
  const appSettings = useLive(getSettings, []);
  const [preview, setPreview] = useState<Option>();
  const [rangeWeeks, setRangeWeeks] = useState<number>();

  if (data === undefined) return <div className="screen" />;
  if (data === null) {
    return (
      <div className="screen">
        <TopBar title="Item removed" />
      </div>
    );
  }

  const { group, rec, readings, categories, onList } = data;
  const mains = rec.options.filter((o) => o.role === 'main');
  const alts = rec.options.filter((o) => o.role === 'alt');
  const chartId = selected ?? rec.best?.product.id ?? group.usualProductId;
  const chartOption = rec.options.find((o) => o.product.id === chartId) ?? rec.options[0];
  const allReadings = chartOption ? (readings.get(chartOption.product.id) ?? []) : [];
  // The chart shows the range picked above it (up to the history you keep).
  const keepWeeks = appSettings?.historyWeeks ?? 8;
  const weeks = Math.min(rangeWeeks ?? keepWeeks, keepWeeks);
  const from = Date.now() - weeks * 7 * 86_400_000;
  const chartReadings = allReadings.filter((r) => Date.parse(r.date) >= from);
  const stats = chartOption ? withMarket(computeStats(chartReadings), chartOption.product.market) : undefined;
  // Shops on this item's tab that don't have your product yet (one per website).
  const missingChains = appSettings
    ? searchChainsIn(appSettings.enabledChains, group.section ?? 'pantry').filter((c) => !mains.some((o) => o.product.chain === c))
    : [];
  const searchName = mains[0]?.product.name ?? group.name;

  const addToList = async () => {
    if (!onList) {
      await addListEntry({ id: uid(), text: group.name, groupId: group.id, categoryId: group.categoryId, checked: false, createdAt: nowIso() });
    }
    nav.toast(onList ? 'Already on your shopping list' : 'Added to your shopping list');
  };

  const row = (o: Option, tag?: 'cheapest' | 'swap') => (
    <Hold key={o.product.id} onLong={() => setPreview(o)}>
      <div className="row">
        <MoreInfo src={o.product.imageUrl} name={o.product.name} onOpen={() => setPreview(o)} />
        <button className="row-main" style={{ color: 'inherit', font: 'inherit' }} onClick={() => setSheet({ option: o })}>
          <ChainDot chain={o.product.chain} />
          <span className="grow">
            <span className="title two-lines" style={{ fontSize: 14 }}>
              {o.product.name}
            </span>
            <span className="small">
              {chainName(o.product.chain)}
              {o.product.size ? ` · ${tidySize(o.product.size, o.product.name)}` : ''}
              {unitText(o) ? ` · ${unitText(o)}` : ''}
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
            {o.stats.current?.isSpecial && (
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
        {rec.detail && <p style={{ fontSize: 14 }}>{rec.detail}</p>}
        {rec.saving !== undefined && <p style={{ fontSize: 14, fontWeight: 700 }}>Saves about {money(rec.saving)}</p>}
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
            Restock has only {learning} day{learning === 1 ? '' : 's'} of its own prices for this, so the verdict uses months of history from
            hotprices.org. After about 4 weeks it switches to the prices this phone has seen.
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
            It still tells you about specials, but until it knows the usual price it compares against the store's "was" price, which can flatter a
            sale. It takes about 4 to 8 weeks.
          </span>
          {appSettings &&
            !appSettings.marketData.enabled &&
            rec.options.some((o) => o.product.chain === 'coles' || o.product.chain === 'woolworths') && (
              <button className="linkish small" style={{ alignSelf: 'flex-start' }} onClick={() => nav.push({ name: 'settings' })}>
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
      {group.targetPrice !== undefined && rec.best?.price !== undefined && rec.best.price <= group.targetPrice + 0.004 && (
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
          options={rec.options}
          option={chartOption}
          onPick={setSelected}
          stats={stats}
          allReadings={allReadings}
          chartReadings={chartReadings}
          allowMulti={group.allowMulti !== false}
          range={
            allReadings.length >= 2 ? (
              <div className="seg" role="group" aria-label="How far back">
                {HISTORY_WEEKS.map((w) => (
                  <button
                    key={w}
                    aria-pressed={w === weeks}
                    className={w > keepWeeks ? 'dim' : undefined}
                    onClick={() =>
                      w > keepWeeks
                        ? nav.toast(`You keep ${historyLabel(keepWeeks)} of prices. Keep more in Settings → Data and backup.`)
                        : setRangeWeeks(w)
                    }
                  >
                    {historyLabel(w)}
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
            Your product <HowItWorks />
          </span>
          <span className="small">{productsAndShops(mains)}</span>
        </div>
        {mains.map((o) => row(o, mains.length > 1 && o === rec.best && !tiedWithBest(rec).length ? 'cheapest' : undefined))}
        {mains.length > 1 && tiedWithBest(rec).length > 0 && (
          <p className="small" style={{ padding: '0 14px 12px' }}>
            {sameAt(rec.best!, tiedWithBest(rec), mains)} — buy it wherever suits you.
          </p>
        )}
        {!mains.length && (
          <p className="small" style={{ padding: '0 14px 12px' }}>
            Not linked to a store product yet.
          </p>
        )}
        {missingChains.length > 0 && (
          <button className="row" onClick={() => nav.push({ name: 'add', attachTo: group.id, as: 'main', query: searchName })}>
            <Icon name="plus" size={18} />
            <span className="grow">
              <span className="title" style={{ fontSize: 14, color: 'var(--green)' }}>
                Find it at {missingChains.map((c) => chainName(c)).join(' or ')}
              </span>
              <span className="small">So Restock can tell you which store is cheapest</span>
            </span>
          </button>
        )}
        {mains.length > 0 && (
          // Another product you buy as this item (a second scent of conditioner, say), at any shop,
          // including ones it's already ticked at.
          <button className="row" onClick={() => nav.push({ name: 'add', attachTo: group.id, as: 'main', another: true, query: group.name })}>
            <Icon name="plus" size={18} />
            <span className="grow">
              <span className="title" style={{ fontSize: 14, color: 'var(--green)' }}>
                Add another product
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
            Alternatives <HowItWorks />
          </span>
          <span className="small">{alts.length || 'None yet'}</span>
        </div>
        {alts.map((o) => row(o, rec.alt === o ? 'swap' : undefined))}
        <button className="row" onClick={() => nav.push({ name: 'add', attachTo: group.id, as: 'alt', query: group.name })}>
          <Icon name="swap" size={18} />
          <span className="grow">
            <span className="title" style={{ fontSize: 14, color: 'var(--green)' }}>
              Find an alternative
            </span>
            <span className="small">Another brand or size you'd happily buy instead</span>
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
                const undo = await undoable(() => deleteGroup(group.id), groupRows([group.id]));
                nav.pop();
                nav.toast(`${name} deleted`, undo);
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
      {sheet === 'price' && <PriceSheet options={rec.options} onClose={() => setSheet(undefined)} />}
      {typeof sheet === 'object' && <OptionSheet group={group} option={sheet.option} onClose={() => setSheet(undefined)} />}
    </div>
  );
}

function EditSheet({
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
    await updateGroup(group.id, {
      name: name.trim() || group.name,
      categoryId: categoryId || undefined,
      alertLevel,
      alertPct: alertLevel === 'custom' ? alertPct : undefined,
      allowBulk,
      allowMulti,
      targetPrice: Number.isFinite(t) && t > 0 ? Math.round(t * 100) / 100 : undefined,
    });
    onClose();
  };

  return (
    <Sheet title="Edit item" onClose={onClose}>
      <label className="field">
        <span>Name</span>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      {suggested && suggested.toLowerCase() !== name.trim().toLowerCase() && (
        <button className="chip" style={{ alignSelf: 'flex-start' }} onClick={() => setName(suggested)}>
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
        <input type="checkbox" checked={allowBulk} onChange={(e) => setAllowBulk(e.target.checked)} />
        <span style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
          <span className="title" style={{ fontSize: 14 }}>
            Swap for bulk packs to save money
          </span>
          <span className="small">Off: bigger packs are never suggested, here or on your shopping list.</span>
        </span>
      </label>
      <label className="check" style={{ padding: '4px 0' }}>
        <input type="checkbox" checked={allowMulti} onChange={(e) => setAllowMulti(e.target.checked)} />
        <span style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
          <span className="title" style={{ fontSize: 14 }}>
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
          const undo = await undoable(() => deleteGroup(group.id), groupRows([group.id]));
          onClose();
          nav.pop();
          nav.toast(`${name} deleted`, undo);
        }}
      >
        <Icon name="trash" size={18} /> Delete item
      </button>
    </Sheet>
  );
}

function PriceSheet({ options, onClose }: { options: Option[]; onClose: () => void }) {
  const [productId, setProductId] = useState(options[0]?.product.id);
  const [price, setPrice] = useState('');
  const [was, setWas] = useState('');
  const [special, setSpecial] = useState(false);
  const [member, setMember] = useState(false);
  const p = parseFloat(price);

  const save = async () => {
    if (!productId || !(p > 0)) return;
    const w = parseFloat(was);
    await addReading({
      productId,
      date: nowIso(),
      price: p,
      wasPrice: w > p ? w : undefined,
      isSpecial: special,
      memberOnly: member,
      source: 'manual',
    });
    onClose();
  };

  return (
    <Sheet title="Enter a price" onClose={onClose}>
      <p className="small">Seen a price in store or in the catalogue? Add it here. It counts towards the history like any other check.</p>
      {options.length > 1 && (
        <label className="field">
          <span>Product</span>
          <select className="input" value={productId} onChange={(e) => setProductId(e.target.value)}>
            {options.map((o) => (
              <option key={o.product.id} value={o.product.id}>
                {chainName(o.product.chain)} — {o.product.name}
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
      <div className="card flush">
        <label className="check">
          <input type="checkbox" checked={special} onChange={(e) => setSpecial(e.target.checked)} />
          <span>It's on special</span>
        </label>
        <label className="check">
          <input type="checkbox" checked={member} onChange={(e) => setMember(e.target.checked)} />
          <span>Needs a loyalty card (member price)</span>
        </label>
      </div>
      <button className="btn primary" disabled={!(p > 0)} onClick={save}>
        Save price
      </button>
    </Sheet>
  );
}

function OptionSheet({ group, option, onClose }: { group: Group; option: Option; onClose: () => void }) {
  const id = option.product.id;
  const nav = useNav();
  const [looking, setLooking] = useState(false);
  const [qty, setQty] = useState(option.product.qty?.toString() ?? '');
  const [unit, setUnit] = useState(option.product.qtyUnit ?? productQty(option.product).unit ?? 'ea');
  const isAlt = option.role === 'alt';

  /** Move between "your product" and "alternatives". */
  const move = async () => {
    const mains = [group.usualProductId, ...group.sameProductIds].filter((x): x is string => !!x && x !== id);
    const alts = group.altProductIds.filter((x) => x !== id);
    if (isAlt) mains.push(id);
    else alts.push(id);
    await updateGroup(group.id, { usualProductId: mains[0], sameProductIds: mains.slice(1), altProductIds: alts });
    onClose();
  };

  const remove = async () => {
    const undo = await undoable(() => removeProductFromGroup(group, id), productRows(group.id, id));
    onClose();
    nav.toast(`${option.product.name} removed`, undo);
  };

  const saveSize = async () => {
    const n = parseFloat(qty);
    await updateProduct(id, n > 0 ? { qty: n, qtyUnit: unit } : { qty: undefined, qtyUnit: undefined });
    onClose();
  };

  if (looking) return <ProductPreview product={previewFromOption(option)} onClose={() => setLooking(false)} />;

  return (
    <Sheet title={option.product.name} onClose={onClose}>
      <button className="btn" onClick={() => setLooking(true)}>
        <Icon name="info" size={18} /> Photo and product details
      </button>
      <p className="small">
        {isAlt ? 'Alternative' : 'Your product'} at {chainName(option.product.chain)}
        {option.product.size ? ` · ${tidySize(option.product.size, option.product.name)}` : ''}
        {option.product.barcode ? ` · barcode ${option.product.barcode}` : ''}
      </p>
      <p className="small">
        {option.verdict.headline}. {option.verdict.detail}
      </p>
      <div className="card">
        <div className="title" style={{ fontSize: 14 }}>
          Amount for unit pricing
        </div>
        <p className="small">Lets Restock compare different pack sizes fairly. For toilet paper, use total sheets (rolls × sheets per roll).</p>
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
        <Icon name="swap" size={18} /> {isAlt ? 'This is actually my product' : 'Make this an alternative'}
      </button>
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
/** The "how your product and alternatives work" explanation, from a small ⓘ by the section titles. */
function HowItWorks() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="icon-btn inline-info" aria-label="How your product and alternatives work" onClick={() => setOpen(true)}>
        <Icon name="info" size={16} />
      </button>
      {open && (
        <Sheet title="Your product and alternatives" onClose={() => setOpen(false)}>
          <p>
            <strong>Your product</strong> is the thing you actually buy. Link it at every store that sells it, and Restock always shows you the
            cheapest one. It doesn't matter which shop you normally go to.
          </p>
          <p>
            <strong>Alternatives</strong> are other products you'd be happy with, like a home brand. When your product isn't on sale but an
            alternative is, and it works out cheaper (per 100 g, per litre or per item), it shows up next to yours as Swap & save.
          </p>
          <p>If both are on sale, your product comes first. Bigger packs only count if you've said yes to bulk packs for this item (Edit).</p>
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
      <div className="banner green" style={{ padding: '10px 12px' }}>
        <strong>A good time to stock up</strong>
        <span style={{ fontSize: 13 }}>It only goes on sale about every {stats.cycleWeeks} weeks, so this price may not be back for a while.</span>
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
          ? `It goes on sale about every ${stats.cycleWeeks} weeks. If you can wait, maybe hold off.`
          : `It goes on sale about every ${stats.cycleWeeks} weeks and the last one was a while ago.`}
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
  const chains = [...new Set(options.map((x) => x.product.chain))];
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
                  {tidySize(x.product.size, x.product.name) || 'Size not given'}
                  {low !== undefined && x.unitPrice !== undefined && x.role !== 'alt' && Math.abs(x.unitPrice - low) < 1e-9 && (
                    <span className="tag great">Cheapest</span>
                  )}
                  {x.role === 'alt' && <span className="tag normal">Alternative</span>}
                </span>
                <span className="ph-name">{nameWithoutSize(x)}</span>
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
}: {
  options: Option[];
  option: Option;
  onPick: (id: string) => void;
  stats: PriceStats;
  allReadings: PriceReading[];
  chartReadings: PriceReading[];
  allowMulti: boolean;
  range?: ReactNode;
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

  // The tag by today's price.
  const off = v.discount !== undefined && v.discount > 0.004 ? `${Math.round(v.discount * 100)}% OFF` : undefined;
  const pill =
    v.kind === 'great' || v.kind === 'good' || v.kind === 'small'
      ? { cls: 'green', text: off ?? 'ON SALE' }
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
                  body: `${saleOff >= 0.45 && saleOff <= 0.55 ? `It's half price (${money(stats.usualSale)})` : `It's usually ${money(stats.usualSale)} on sale (${Math.round(saleOff * 100)}% off)`}${cycle}.`,
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
        ? `Last on sale ${weeksSinceSale === 1 ? 'a week' : `${weeksSinceSale} weeks`} ago, so another sale is likely soon.`
        : stats.cycleWeeks
          ? `Last on sale ${weeksSinceSale === 1 ? 'a week' : `${weeksSinceSale} weeks`} ago. Sales usually come round every ~${stats.cycleWeeks} weeks.`
          : `Last on sale ${weeksSinceSale === 1 ? 'a week' : `${weeksSinceSale} weeks`} ago.`;

  const ownWeeks = allReadings.length ? Math.max(1, Math.round((now - Date.parse(allReadings[0].date)) / WEEK)) : 0;
  const source = market
    ? `From shared price history · ${market.days} days`
    : allReadings.length
      ? `Your prices · ${ownWeeks >= 9 ? `${Math.round(ownWeeks / 4.3)} months` : `${ownWeeks} week${ownWeeks === 1 ? '' : 's'}`}`
      : 'No prices yet';

  return (
    <div className="card ph">
      <div className="ph-head">
        <span className="title" style={{ fontSize: 17 }}>
          Price history
        </span>
      </div>
      {options.length > 1 && <HistoryPicker options={options} picked={o} onPick={onPick} />}

      <div className="ph-now">
        <div>
          <div className="ph-lab">Today</div>
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
          : [tidySize(o.product.size, o.product.name), unitText(o)].filter(Boolean).join(' · ')}
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
          <div className="ph-scale" aria-label={`Today ${money(today)}, between ${money(lo)} and ${money(hi)}`}>
            <div className="ph-track" />
            {labels.map((l) => (
              <span key={l.key} className={`ph-mark ${l.key}`} style={{ left: `${l.pos}%` }} />
            ))}
            <span className="ph-mark today" style={{ left: `${at(today)}%` }} />
            <div
              className="ph-pin"
              style={{ left: `${at(today)}%`, transform: `translateX(${at(today) < 20 ? '-12%' : at(today) > 80 ? '-88%' : '-50%'})` }}
            >
              Today {money(today)}
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
          <div className="ph-sec">How often it's on sale</div>
          {/* The bar is the share of the time it's been on sale, not a countdown (0.7.4). */}
          <div className="ph-often">
            <div className="ph-meter" role="img" aria-label={`On sale ${Math.round((share ?? 0) * 100)}% of the time`}>
              <i style={{ width: `${Math.max(3, Math.round((share ?? 0) * 100))}%` }} />
            </div>
            <span>
              <b>{shareText}</b>
              {stats.cycleWeeks ? <br /> : null}
              {stats.cycleWeeks ? `a sale about every ${stats.cycleWeeks} weeks` : null}
            </span>
          </div>
          <div className="small" style={{ marginTop: -4 }}>
            The bar shows how much of the time it's been on sale ({Math.round((share ?? 0) * 100)}%).
            {nextSaleText ? ` ${nextSaleText}` : ''}
          </div>
          {ownShare !== undefined && (
            <div className="ph-weeks" aria-label={`On sale ${saleWeeks} of the last ${known} weeks with prices`}>
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

      <button className="ph-src" onClick={() => setWhy((x) => !x)} aria-expanded={why}>
        <span>{source}</span>
        <Icon name="info" size={18} />
      </button>
      {why &&
        (market ? (
          <p className="small" style={{ margin: 0 }}>
            Normal, usual sale and lowest come from shared price history (hotprices.org): {market.days} days at {chainName(o.product.chain)}, on sale{' '}
            {Math.round(market.saleShare * 100)}% of the time{stats.cycleWeeks ? `, about every ${stats.cycleWeeks} weeks` : ''}.
            {stats.marketScale && stats.marketScale !== 1
              ? ` Adjusted ${Math.round(Math.abs(stats.marketScale - 1) * 100)}% ${stats.marketScale > 1 ? 'up' : 'down'} to match your store's prices.`
              : ''}{' '}
            Restock switches to this phone's own prices after about 4 weeks.
          </p>
        ) : (
          <p className="small" style={{ margin: 0 }}>
            {stats.readings} price{stats.readings === 1 ? '' : 's'} seen over {stats.spanDays} days
            {stats.low !== undefined ? ` · lowest ${money(stats.low)}` : ''}. Normal is the usual non-sale price over the last 6 months; a week counts
            as on sale when it was on special or under its normal price.
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
