// 0.15.0: Shopping mode (moved out of List.tsx, which had grown past 2,500 lines): the trip's shops,
// ticking things off in the shop, what's left, and adding while shopping. The list itself and its
// helpers stay in List.tsx.
import { StockTag } from '../StockTag';
import { flavourSets } from '../../lib/flavours';
import { aisleLabel, aisleOf, byAisle as sortByAisle, getAisles, type AisleAt } from '../../lib/aisles';
import { countTicks } from '../../lib/inventory';
import { branchAdvice, branchName, stockRows } from '../../lib/stock';
import { useEffect, useState, type ReactNode } from 'react';
import { clearTrip, saveTrip, type SavedTrip } from '../../lib/trip';
import { scanBarcode } from '../../lib/barcode';
import { serverMode } from '../../server-mode/flag';
import { PhoneOnlyNote } from '../../server-mode/ui/PhoneOnly';
import { allCards, getSettings, updateListEntry, updateSettings, cachedSettings } from '../../lib/db';
import { buzz } from '../../lib/listActions';
import { shopTotals, type ShopTotals } from '../../lib/shopTotals';
import { act } from '../../lib/undo';
import { Stepper } from '../Stepper';
import { money } from '../../lib/units';
import { kiloPrice } from '../../lib/unitPrice';
import { useLive } from '../../lib/useLive';
import type { Recommendation } from '../../lib/verdict';
import { chainName, secondBranch, type Category, type Chain, type ListEntry, type LoyaltyCard, type Settings } from '../../types';
import { ChainDot, Icon, previewFromOption, type PreviewProduct, ProductPreview, RowInfo, Sheet, Thumb, useBackLayer } from '../components';
import { useNav } from '../nav';
import { type ListSection, type StoreChain } from '../../shops';
import { CardBarcode, PROGRAMS } from './Cards';
import { shopsLeft, tripRecs } from '../../lib/tripPlan';
import { ShopKey, Ctx, recFor, dealFor, shopOf, qtyOf, packsOf, priceOf, tickEntry, stockNote, useListAdd, EditEntry } from './List';

/**
 * A line in shopping mode. On the phone the whole line ticks it (a big target in the shop). 0.9.4,
 * the web on a server (design 15): only the checkbox ticks, and the line opens its product.
 */
/**
 * 0.10.9: shopping mode's shops to pick from: "Where are you first?", each shop with how many things
 * and about how much, then "Where to next?" with the done ones greyed (tap one to go back in).
 */
export function ShopPicker({
  shops,
  doneAt,
  anyCount,
  generalCount = 0,
  standby,
  name,
  stats,
  onPick,
  onAll,
  onFinish,
}: {
  shops: ShopKey[];
  doneAt: ShopKey[];
  anyCount: number;
  generalCount?: number;
  /** How many things this shop could stand in for with an alternative, if the other shops miss out. */
  standby?: (s: ShopKey) => number;
  name: (s: ShopKey) => string;
  stats: (s: ShopKey) => { n: number; got: number; left: number; total: number; spent: number };
  onPick: (s: ShopKey) => void;
  onAll: () => void;
  onFinish: () => void;
}) {
  const toDo = shops.filter((s) => !doneAt.includes(s));
  const done = shops.filter((s) => doneAt.includes(s));
  const last = doneAt[doneAt.length - 1];
  // The shop with the most still to get, marked the first time (the obvious place to start).
  const most = !doneAt.length ? [...toDo].filter((x) => stats(x).left > 0).sort((a, b) => stats(b).left - stats(a).left)[0] : undefined;
  const card = (s: ShopKey, isDone: boolean) => {
    const st = stats(s);
    return (
      <button key={s} type="button" className={`shop-pick${isDone ? ' done' : ''}${s === most || (!isDone && s === toDo[0] && doneAt.length) ? ' next' : ''}`} onClick={() => onPick(s)}>
        {isDone ? (
          <span className="shop-pick-tick" aria-hidden>
            <Icon name="check" size={14} />
          </span>
        ) : (
          <ChainDot chain={s as Chain} />
        )}
        <span className="grow" style={{ minWidth: 0 }}>
          <span className="title shop-pick-name">{name(s)}</span>
          <span className="small num">
            {isDone
              ? `Done · ${st.got} of ${st.n} · ${money(st.spent)} · tap to go back in`
              : st.n === 0
                ? 'Nothing from your list yet'
                : `${st.left === 1 ? '1 item' : `${st.left} items`}${st.total > 0 ? ` · about ${money(st.total - st.spent)}` : ''}`}
          </span>
          {!isDone && (standby?.(s) ?? 0) > 0 && (
            <span className="small">{standby!(s) === 1 ? '1 alternative' : `${standby!(s)} alternatives`} here, if the other shops miss out</span>
          )}
          {s === most && <span className="tag good shop-pick-tag">MOST ON YOUR LIST</span>}
        </span>
        {!isDone && <Icon name="chevron" size={18} />}
      </button>
    );
  };
  return (
    <div className="shop-picker">
      {last && (
        <div className="shop-picker-done" role="status">
          <Icon name="check" size={18} /> {chainName(last)} done: {stats(last).got} of {stats(last).n} in the trolley
        </div>
      )}
      <h2 className="shop-picker-title">{!toDo.length ? 'Every shop done' : doneAt.length ? 'Where to next?' : 'Where are you first?'}</h2>
      <div className="shop-picks">
        {toDo.map((s) => card(s, false))}
        {done.map((s) => card(s, true))}
      </div>
      {/* 0.12.7: one short line (it was three paragraphs) */}
      {anyCount + generalCount > 0 && (
        <p className="small" style={{ margin: 0 }}>
          Plus {anyCount + generalCount} to get anywhere, at the bottom of each shop.
        </p>
      )}
      {!toDo.length && (
        <button className="btn primary block" onClick={onFinish}>
          <Icon name="check" size={18} /> Finish shopping
        </button>
      )}
      <button type="button" className="linkish shop-picker-all" onClick={onAll}>
        See everything in one list
      </button>
    </div>
  );
}

export function ShopRow({
  e,
  name,
  onOpen,
  thumb,
  extra,
  children,
  onTicked,
}: {
  e: ListEntry;
  name: string;
  onOpen?: () => void;
  /** 0.12.7: told before the tick is saved, so the trip remembers which shop it was got at. */
  onTicked?: (on: boolean) => void;
  thumb?: ReactNode;
  extra?: ReactNode;
  children: ReactNode;
}) {
  const tick = (ev: { target: { checked: boolean } }) => {
    buzz(10);
    onTicked?.(ev.target.checked);
    void tickEntry(e, ev.target.checked, name);
  };
  if (!serverMode)
    return (
      <label className={`shoprow${e.checked ? ' got' : ''}`}>
        <input type="checkbox" checked={e.checked} onChange={tick} />
        {thumb}
        {children}
        {extra}
      </label>
    );
  return (
    <div className={`shoprow${e.checked ? ' got' : ''}`}>
      <label className="tick-hit">
        <input type="checkbox" checked={e.checked} onChange={tick} aria-label={`Got ${name}`} />
      </label>
      {thumb}
      {onOpen ? (
        <button type="button" className="shoprow-open" onClick={onOpen} aria-label={`${name}, open the item`}>
          {children}
        </button>
      ) : (
        children
      )}
      {extra}
    </div>
  );
}

/**
 * Before shopping: anything out of stock where you're going. In stock at your other Coles says so;
 * out everywhere is listed so you can skip it today (it stays on your list for next time).
 */
function StockCheck({
  entries,
  recs,
  plan,
  skip,
  onSkip,
}: {
  entries: ListEntry[];
  recs: Recommendation[];
  plan: ShopTotals;
  skip: Set<string>;
  onSkip: (s: Set<string>) => void;
}) {
  const c: Ctx = { totals: plan, recs, order: [], title: '' };
  const notes = entries
    .map((e) => ({ e, n: stockNote(c, e) }))
    .filter((x): x is { e: ListEntry; n: NonNullable<ReturnType<typeof stockNote>> } => !!x.n);
  if (!notes.length) return null;
  const name = (e: ListEntry) => recFor(c, e)?.group.name ?? e.text;
  return (
    <div className="card flush">
      <div className="section-head" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 2 }}>
        <span className="title">Out of stock ({notes.length})</span>
        <span className="small">Tick the ones to skip today. They stay on your list for next time.</span>
      </div>
      {notes.map(({ e, n }) => (
        <label key={e.id} className="check">
          <input
            type="checkbox"
            checked={skip.has(e.id)}
            onChange={() => {
              const next = new Set(skip);
              if (next.has(e.id)) next.delete(e.id);
              else next.add(e.id);
              onSkip(next);
            }}
            aria-label={`Skip ${name(e)} today`}
          />
          <span style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
            <span className="title" style={{ fontSize: 15 }}>
              {name(e)}
            </span>
            <span className="small" style={{ color: n.kind === 'second' ? 'var(--green-ink)' : 'var(--amber-ink)' }}>
              {n.text}
            </span>
          </span>
        </label>
      ))}
    </div>
  );
}

/**
 * 0.12.7: Start shopping, step 1: "Which shops today?" Big buttons, none chosen for you; tap the ones
 * you're going to, then Continue. Step 2 is shopping mode's "Where are you first?" (with one shop
 * chosen it goes straight to that shop's list). It replaces Change shops, which was a small button
 * people had to find once they were already shopping.
 */
export function TripShops({
  shops,
  entries,
  recs,
  totals,
  compare,
  onClose,
  onStart,
}: {
  shops: StoreChain[];
  entries: ListEntry[];
  recs: Recommendation[];
  totals: ShopTotals;
  compare: 'unit' | 'price';
  onClose: () => void;
  onStart: (chosen: StoreChain[], skip: Set<string>) => void;
}) {
  const [skip, setSkip] = useState<Set<string>>(new Set());
  const [chosen, setChosen] = useState<StoreChain[]>([]);
  useBackLayer(onClose);
  const n = totals.linked;
  const plan = chosen.length ? shopTotals(entries, tripRecs(recs, chosen).recs, chosen as never, compare) : undefined;
  const flip = (x: StoreChain) => setChosen((cur) => (cur.includes(x) ? cur.filter((y) => y !== x) : shops.filter((y) => y === x || cur.includes(y))));
  return (
    <div className="shopmode" role="dialog" aria-label="Which shops today?">
      <div className="shopmode-top">
        <button className="icon-btn" aria-label="Back to your list" onClick={onClose}>
          <Icon name="back" size={20} />
        </button>
        <div style={{ flex: 1 }}>
          <div className="title" style={{ fontSize: 17 }}>
            Shopping
          </div>
          <div className="small">Step 1 of 2</div>
        </div>
      </div>
      <div className="shopmode-list">
        <div className="shop-picker">
          <h2 className="shop-picker-title">Which shops today?</h2>
          <div className="shop-picks" role="group" aria-label="The shops you're going to today">
            {shops.map((x) => {
              const on = chosen.includes(x);
              const st = totals.stores.find((t) => t.chain === x);
              const has = st?.lines.length ?? 0;
              // 0.12.7: what this shop could stand in for, with an "Also happy with" product
              const alone = shopTotals(entries, tripRecs(recs, [x]).recs, [x] as never, compare).stores.find((t) => t.chain === x);
              const alts = Math.max(0, (alone?.lines.length ?? 0) - has);
              return (
                <button key={x} type="button" className={`shop-pick trip-pick${on ? ' on' : ''}`} aria-pressed={on} onClick={() => flip(x)}>
                  <ChainDot chain={x} />
                  <span className="grow" style={{ minWidth: 0 }}>
                    <span className="title shop-pick-name">{branchName(cachedSettings(), x)}</span>
                    {n > 0 && <span className="small num">{has >= n ? (n === 1 ? 'Has your item' : `Has all ${n} items`) : has ? `Has ${has} of your ${n} items` : 'None of your picks'}{alts > 0 ? ` · ${alts === 1 ? '1 alternative' : `${alts} alternatives`}` : ''}</span>}
                  </span>
                  <span className="trip-tick" aria-hidden>
                    {on && <Icon name="check" size={18} />}
                  </span>
                </button>
              );
            })}
          </div>
          {/* 0.9.9: which branch to go to, by stock (Coles' two branches, Woolworths signed in). Only when there's something to say. */}
          {(() => {
            const advice = branchAdvice(
              entries.filter((e) => !e.checked).map((e) => {
                const r = e.groupId ? recs.find((x) => x.group.id === e.groupId) : undefined;
                return r ? stockRows(r.options.filter((o) => o.role === 'main').map((o) => o.product), cachedSettings()) : [];
              }),
            );
            return advice ? (
              <div className="banner green" role="note" style={{ fontSize: 13 }}>
                {advice}
              </div>
            ) : null;
          })()}
          {plan && <StockCheck entries={entries} recs={recs} plan={plan} skip={skip} onSkip={setSkip} />}
        </div>
      </div>
      <div className="shop-done-bar">
        <button className="btn primary block" disabled={!chosen.length} onClick={() => onStart(chosen, skip)}>
          {chosen.length ? 'Continue' : 'Tap the shops you are going to'}
          {chosen.length > 0 && <Icon name="chevron" size={18} />}
        </button>
      </div>
    </div>
  );
}

/**
 * 0.12.10: "Add to list" inside shopping mode. Type a thing: one of your own items adds that item
 * (with its price, so the trolley total keeps up), anything else goes on as a plain line to get at
 * any shop. The sheet stays open for the next one.
 */
function AddWhileShopping({ entries, recs, section, onClose }: { entries: ListEntry[]; recs: Recommendation[]; section: ListSection; onClose: () => void }) {
  const { text, setText, add, pantryMatches, exactPantry, addFromPantry } = useListAdd(entries, recs, section);
  const [added, setAdded] = useState(0);
  const did = <T,>(p: Promise<T>) => void p.then(() => setAdded((n) => n + 1));
  return (
    <Sheet title="Add to your list" onClose={onClose}>
      <form
        onSubmit={(ev) => {
          ev.preventDefault();
          if (text.trim()) did(exactPantry ? addFromPantry(exactPantry) : add(text));
        }}
        style={{ display: 'flex', gap: 8 }}
      >
        <input className="input" autoFocus placeholder="e.g. Milk" aria-label="Add to shopping list" value={text} onChange={(e) => setText(e.target.value)} />
        <button type="submit" className="btn primary" disabled={!text.trim()} style={{ flexShrink: 0 }}>
          <Icon name="plus" size={18} /> Add
        </button>
      </form>
      {pantryMatches.length > 0 && (
        <div className="card flush pantry-matches" role="list" aria-label="In your pantry">
          {pantryMatches.map((r) => (
            <button key={r.group.id} role="listitem" className="row" onClick={() => did(addFromPantry(r))}>
              <Thumb src={(r.best ?? r.options[0])?.product.imageUrl} />
              <span className="grow">
                <span className="title clip" style={{ fontSize: 15 }}>
                  {r.group.name}
                </span>
                <span className="small clip">
                  In your pantry
                  {(r.best ?? r.options[0]) ? ` · ${chainName((r.best ?? r.options[0])!.product.chain)} ${money((r.best ?? r.options[0])!.price)}` : ''}
                </span>
              </span>
              <span className="btn small primary" aria-hidden>
                <Icon name="plus" size={16} /> Add
              </span>
            </button>
          ))}
        </div>
      )}
      <p className="small" role="status" style={{ margin: 0 }}>
        {added > 0 ? `${added} added. ` : ''}
        Your own items come with their price. Anything else shows under Any shop.
      </p>
      <button className="btn block" onClick={onClose}>
        Back to shopping
      </button>
    </Sheet>
  );
}

/** Big, simple, in-store view: tick things off, see the trolley total, show your card. */
export function ShoppingMode({
  c: all,
  shops,
  chosen,
  skip,
  compare,
  entries: allEntries,
  general = [],
  categories,
  section,
  recs,
  resume,
  onClose,
}: {
  c: Ctx;
  shops: StoreChain[];
  /** 0.12.10: which list this is, and its items, for "Add to list" while you shop. */
  section: ListSection;
  recs: Recommendation[];
  /** 0.12.10: a trip being picked up again: the shops done, the page open, where things were ticked. */
  resume?: SavedTrip;
  /** The shops you're going to today. */
  chosen: StoreChain[];
  /** Out of stock, and skipped for this trip. */
  skip: Set<string>;
  compare: 'unit' | 'price';
  entries: ListEntry[];
  /** 0.12.6: the General list's lines, shown at the bottom of every shop's page ("get anywhere"). */
  general?: ListEntry[];
  categories: Category[];
  onClose: () => void;
}) {
  // ⓘ on a line: what the product looks like, to find it on the shelf (0.7.3).
  const [info, setInfo] = useState<PreviewProduct>();
  // 0.12.5: the blue i beside a line's price opens the same page as on the shopping list. It's the one place to change
  // how many, edit, move or remove while you shop; the lines themselves stay plain ("3 × Juice").
  const [editing, setEditing] = useState<ListEntry>();
  // Everything priced at only the shops picked (ticked rows too, so they keep their shop and price).
  const entries = allEntries.filter((e) => !skip.has(e.id));
  const skipped = allEntries.filter((e) => skip.has(e.id));
  // 0.12.6: General lines still to get, and the ones ticked on this trip (they stay showing, ticked).
  // 0.15.1: kept as state, added to while drawing (React's way to remember what was seen before).
  const [generalSeen, setGeneralSeen] = useState<Set<string>>(() => new Set(general.filter((e) => !e.checked).map((e) => e.id)));
  const newGeneral = general.filter((e) => !e.checked && !generalSeen.has(e.id));
  if (newGeneral.length) setGeneralSeen((seen) => new Set([...seen, ...newGeneral.map((e) => e.id)]));
  const generalShown = general.filter((e) => !e.checked || generalSeen.has(e.id));
  /** At one shop: the ones with no shop picked, and the ones picked for that shop. In one list: all of them. */
  const generalAt = (v: ShopKey | 'all') => generalShown.filter((e) => v === 'all' || !e.chain || e.chain === v);
  // 0.10.9: one shop at a time (see below). 0.12.7: declared here, because what each shop shows now
  // depends on which shops are finished.
  const [at, setAt] = useState<ShopKey | 'all' | undefined>(() =>
    resume?.at === 'all' || (resume?.at && (chosen as string[]).concat('other').includes(resume.at)) ? (resume.at as ShopKey | 'all') : undefined,
  );
  const [doneAt, setDoneAt] = useState<ShopKey[]>(() => (resume?.doneAt ?? []) as ShopKey[]);
  /** Where each thing was ticked on this trip, so a ticked line keeps that shop and its price. */
  const [gotAt, setGotAt] = useState<Map<string, ShopKey>>(() => new Map((resume?.gotAt ?? []) as [string, ShopKey][]));
  // 0.12.10: adding to the list without leaving the shop.
  const [adding, setAdding] = useState(false);
  // 0.12.7 (lib/tripPlan): each item is offered at the cheapest shop still to visit that has one of
  // your picks. Finish a shop without ticking it and it moves to the next. An "Also happy with"
  // product only fills a gap: no pick of yours at the shops left, or your picks there out of stock.
  const ctxOf = (shopsNow: StoreChain[], finished: ShopKey[]): Ctx & { alternatives: Set<string> } => {
    const t = tripRecs(all.recs, shopsNow, finished);
    return {
      ...all,
      recs: t.recs,
      alternatives: t.alternatives,
      totals: shopTotals(
        entries.map((e) => ({ ...e, checked: false })),
        t.recs,
        shopsLeft(shopsNow, finished) as never,
        compare,
      ),
      order: [...chosen, 'other', 'any'],
    };
  };
  /** The trip as it stands: the shops still to visit. Unticked lines are placed by this. */
  const c = ctxOf(chosen, doneAt);
  /** The whole trip, as it started: where each thing is cheapest today. */
  const whole = ctxOf(chosen, []);
  // Each shop a line was ticked at, priced on its own (only those shops: working one out isn't free).
  const oneShop = new Map([...new Set(gotAt.values())].filter((w) => chosen.includes(w as StoreChain)).map((w) => [w, ctxOf([w as StoreChain], [])] as const));
  const atShop = (shop: StoreChain) => oneShop.get(shop) ?? whole;
  /** The context a line is priced and placed by: where it was ticked, else the shops still to visit. */
  const cx = (e: ListEntry) => {
    if (!e.checked) return c;
    const where = gotAt.get(e.id);
    return where && chosen.includes(where as StoreChain) ? atShop(where as StoreChain) : whole;
  };
  const isAlternative = (e: ListEntry) => {
    const d = dealFor(cx(e), e);
    return !!d && cx(e).alternatives.has(d.product.id);
  };
  /** Not ticked at a cheaper shop you've finished: "Cheaper at Coles ($3.80)". */
  const cheaperWas = (e: ListEntry): string | undefined => {
    if (e.checked || !e.groupId) return undefined;
    const first = dealFor(whole, e);
    const now = dealFor(cx(e), e);
    if (!first || !now || first.product.chain === now.product.chain || !doneAt.includes(first.product.chain as ShopKey)) return undefined;
    const was = priceOf(whole, e);
    const is = priceOf(cx(e), e);
    return was !== undefined && is !== undefined && was < is - 0.004 ? `Cheaper at ${chainName(first.product.chain)} (${money(was)})` : undefined;
  };
  const noteTick = (e: ListEntry, on: boolean) => {
    const where = on ? shopOf(c, e) : undefined;
    setGotAt((m) => {
      const next = new Map(m);
      if (where !== undefined) next.set(e.id, where);
      else next.delete(e.id);
      return next;
    });
  };
  const elsewhere = (e: ListEntry) => (e.groupId ? !dealFor(cx(e), e) : !!e.chain && e.chain !== 'other' && !chosen.includes(e.chain as StoreChain));
  const cards = useLive(allCards, []);
  const [card, setCard] = useState<LoyaltyCard>();

  // 0.10.9: one shop at a time. With things at two or more shops, shopping mode starts by asking
  // which shop you're at; that shop's things show (and the ones with no shop), then "Done at Coles"
  // goes back to the shops, with the done ones greyed. "See everything in one list" is the old view.
  // (`at` and `doneAt` are declared above, with the trip's plan.)


  // Keep the screen on while shopping: asked for once, let go when shopping mode closes.
  useEffect(() => {
    let lock: { release: () => Promise<void> } | undefined;
    let done = false;
    const nav = navigator as Navigator & {
      wakeLock?: {
        request: (t: 'screen') => Promise<{ release: () => Promise<void> }>;
      };
    };
    nav.wakeLock
      ?.request('screen')
      .then((l) => {
        if (done) void l.release().catch(() => undefined);
        else lock = l;
      })
      .catch(() => undefined);
    return () => {
      done = true;
      void lock?.release().catch(() => undefined);
    };
  }, []);

  const order = new Map(categories.map((cat, i) => [cat.id, i]));
  const catOf = (e: ListEntry) => recFor(c, e)?.group.categoryId ?? e.categoryId;
  const nameOf = (e: ListEntry) => recFor(c, e)?.group.name ?? e.text;
  const azOf = (a: ListEntry, b: ListEntry) => nameOf(a).localeCompare(nameOf(b), 'en-AU', { sensitivity: 'base' });
  const byCategory = (a: ListEntry, b: ListEntry) => (order.get(catOf(a) ?? '') ?? 99) - (order.get(catOf(b) ?? '') ?? 99) || azOf(a, b);

  // 0.10.2: each shop's lines by aisle (the default; 1 to 50, or 50 to 1), category, or A–Z. Your
  // pick is remembered (Settings → Shopping list and receipts, In shopping mode, start with).
  const live = useLive(getSettings, []) ?? cachedSettings();
  const [sort, setSortState] = useState<NonNullable<Settings['shopSort']>>(() => {
    const start = cachedSettings()?.shopSort ?? { by: 'aisle' };
    // The web has no aisle numbers: it starts with your categories instead.
    return serverMode && start.by === 'aisle' ? { by: 'category' } : start;
  });
  const setSort = (next: NonNullable<Settings['shopSort']>) => {
    setSortState(next);
    void updateSettings({ shopSort: next });
  };
  // Aisle numbers are noted by the phone's price check; the web has none (they stay on the phone).
  const aisles = useLive(getAisles, []);
  // 0.10.2: which Coles you're at, when you have two (aisles and the branch name follow it).
  const [colesSlot, setColesSlot] = useState<'1' | '2'>('1');
  const colesStoreNo = live?.localPrices ? (colesSlot === '1' ? live.stores?.coles?.branchStoreNo : live.stores?.coles?.branchStoreNo2) : undefined;
  const second = secondBranch(live);
  const aisleAt = (e: ListEntry): AisleAt | undefined => {
    const d = dealFor(cx(e), e);
    if (!d || d.product.chain !== 'coles' || !colesStoreNo) return undefined;
    return aisleOf(aisles, d.product.id, colesSlot, colesStoreNo);
  };
  // 0.10.8: no aisle known for anything on the list (most shops don't say): no Aisle option, and
  // the list goes by category, until an aisle is known (your pick is kept for when it is).
  const anyAisle = !serverMode && entries.some((e) => !e.checked && !!aisleAt(e));
  const by = sort.by === 'aisle' && !anyAisle ? 'category' : sort.by;
  const sortShop = (items: ListEntry[]) =>
    by === 'az' ? [...items].sort(azOf) : by === 'category' ? [...items].sort(byCategory) : sortByAisle(items, aisleAt, nameOf, !!sort.down);
  const inTrolley = entries.filter((e) => e.checked && !elsewhere(e)).reduce((s, e) => s + (priceOf(cx(e), e) ?? 0), 0);
  const notHere = entries.filter((e) => elsewhere(e));
  const left = entries.filter((e) => !e.checked);
  const here = (shop: ShopKey) => entries.filter((e) => !elsewhere(e) && shopOf(cx(e), e) === shop);
  // 0.12.7: every shop you said you're going to has its page, even with nothing of yours there yet
  // (an alternative may land there once the other shops are finished, and General lines show there).
  const shopKeys = c.order.filter((s) => s !== 'any' && (here(s).length > 0 || chosen.includes(s as StoreChain)));
  const standby = (shop: ShopKey) =>
    shop === 'other' || shop === 'any' || doneAt.includes(shop)
      ? 0
      : left.filter((e) => {
          if (!e.groupId || shopOf(c, e) === shop) return false;
          const d = dealFor(atShop(shop as StoreChain), e);
          return !!d && atShop(shop as StoreChain).alternatives.has(d.product.id);
        }).length;
  const byShop = shopKeys.length > 1 && shopKeys.some((s) => here(s).length > 0 || doneAt.includes(s));
  /** The shop showing: one shop, all of them in one list, or none (the shops to pick from). */
  const view: ShopKey | 'all' | undefined = byShop ? at : 'all';
  const shopName = (shop: ShopKey) =>
    shop === 'any' ? 'Any shop' : shop === 'coles' && colesSlot === '2' && second ? second : branchName(cachedSettings(), shop);
  const statsOf = (shop: ShopKey) => {
    const items = here(shop);
    const got = items.filter((e) => e.checked);
    return {
      n: items.length,
      got: got.length,
      left: items.length - got.length,
      total: items.reduce((s, e) => s + (priceOf(cx(e), e) ?? 0), 0),
      spent: got.reduce((s, e) => s + (priceOf(cx(e), e) ?? 0), 0),
    };
  };
  // (the shops' page says it's done, in a banner that's read out too)
  const doneHere = (shop: ShopKey) => {
    setDoneAt((d) => (d.includes(shop) ? d : [...d, shop]));
    setAt(undefined);
  };
  const nav = useNav();
  const toast = nav.toast;
  // 0.12.10: the trip is kept as it goes, so leaving the app (or Android closing it) doesn't lose it.
  const tripNow = (isOpen: boolean) => ({ section, chosen, skip: [...skip], at, doneAt, gotAt: [...gotAt], open: isOpen });
  const ticked = entries.filter((e) => e.checked).length;
  useEffect(() => {
    saveTrip(tripNow(true));
  }, [at, doneAt, ticked, gotAt, chosen.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps
  /** Step out: with things still to get the trip is kept ("Resume shopping"); with none it's over. */
  function leave() {
    if (left.length) saveTrip(tripNow(false));
    else clearTrip();
    onClose();
  }
  // Back (or Escape) goes back to the shops from one shop, else closes shopping mode, unless a sheet
  // is open on top of it.
  useBackLayer(() => (at ? setAt(undefined) : leave()));
  const finish = () => {
    clearTrip();
    onClose();
  };
  // 0.9.4, the web on a server: a line opens its product (only the checkbox ticks); see ShopRow.
  const openOf = (e: ListEntry) => {
    const g = recFor(all, e)?.group.id;
    return serverMode && g ? () => nav.push({ name: 'item', groupId: g }) : undefined;
  };

  /** Scan something going into the trolley: tick it off, and say if the price matches. */
  const scanToTick = async () => {
    const out = await scanBarcode('Scan to tick it off');
    if (!out.ok) return;
    const match = left.find((e) => {
      const r = recFor(c, e);
      return !!r && r.options.some((o) => o.product.barcode === out.code);
    });
    if (!match) {
      toast("That isn't on this list.");
      return;
    }
    const r = recFor(c, match)!;
    const o = r.options.find((x) => x.product.barcode === out.code);
    const want = dealFor(cx(match), match);
    const name = r.group.name;
    // 0.9.5 (undo): the message comes with Undo.
    const said =
      o && want && o.product.id !== want.product.id
        ? `${name} ticked. Restock picked ${want.product.name}, ${money(want.price)}, at ${chainName(want.product.chain)}.`
        : `${name} ticked${want?.price !== undefined ? `, ${money(want.price)}` : ''}.`;
    noteTick(match, true);
    await act(said, async () => {
      await updateListEntry(match.id, { checked: true });
      await countTicks([match.id], true).catch(() => undefined); // 0.13.1
    });
  };

  const shelfLook = (e: ListEntry): PreviewProduct | undefined => {
    const o = dealFor(cx(e), e) ?? recFor(c, e)?.options[0];
    if (o) return previewFromOption(o);
    return e.product ? { ...e.product, price: e.price } : undefined;
  };

  return (
    <div className="shopmode" role="dialog" aria-label="Shopping">
      <div className="shopmode-top">
        {byShop && view && (
          <button className="icon-btn" aria-label="Back to your shops" onClick={() => setAt(undefined)}>
            <Icon name="back" size={20} />
          </button>
        )}
        {view && view !== 'all' ? (
          // 0.10.9: at one shop: its name, and how far through its things you are
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="title shopmode-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <ChainDot chain={view as Chain} /> <span className="clip">{shopName(view)}</span>
            </div>
            <div className="small num">
              {statsOf(view).got} of {statsOf(view).n} in the trolley · <strong>{money(statsOf(view).spent)}</strong>
            </div>
            <div className="shop-progress" aria-hidden>
              <span style={{ width: `${Math.round((statsOf(view).got / Math.max(1, statsOf(view).n)) * 100)}%` }} />
            </div>
          </div>
        ) : (
          <div style={{ flex: 1 }}>
            <div className="title shopmode-title">Shopping</div>
            <div className="small num">
              {!view && byShop ? (
                <>
                  {doneAt.length} of {shopKeys.length} shops done · <strong>{money(inTrolley)}</strong> so far
                </>
              ) : (
                <>
                  In the trolley: <strong>{money(inTrolley)}</strong> · {left.length} to go
                </>
              )}
            </div>
            {entries.length > 0 && (
              <div className="shop-progress" aria-hidden>
                <span style={{ width: `${Math.round(((entries.length - left.length) / entries.length) * 100)}%` }} />
              </div>
            )}
          </div>
        )}
        {!serverMode && (
          <button className="icon-btn" aria-label="Scan to tick off" onClick={() => void scanToTick()}>
            <Icon name="scan" size={20} />
          </button>
        )}
        {/* 0.12.10: with things still to get it's Pause (the trip is kept); with none, Done */}
        <button className="btn small primary" onClick={leave} aria-label={left.length ? 'Pause shopping. You can resume it later' : 'Done shopping'}>
          {left.length ? 'Pause' : 'Done'}
        </button>
      {/* 0.10.2: Change shops is a button (it was a link under the total), beside your cards. */}
      {/* 0.12.7: Change shops went: Start shopping asks which shops you're going to today. Your cards stay. */}
      {/* 0.13.0: your cards (and Add to list) sit in the navy top itself, on their own line under the title */}
      {(view || (cards && cards.length > 0)) && (
        <div className="chips shopmode-cards">
          {/* 0.12.10: picked up something that wasn't on the list? Add it here and the total keeps up. */}
          {view && (
            <button className="chip" onClick={() => setAdding(true)}>
              <Icon name="plus" size={16} /> Add to list
            </button>
          )}
          {(cards ?? []).map((k) => (
            <button key={k.id} className="chip" onClick={() => setCard(k)}>
              <Icon name="card" size={16} /> Show {k.program === 'other' ? k.label : PROGRAMS[k.program].name}
            </button>
          ))}
        </div>
      )}
      </div>
      {view && (
      <div className="shopmode-sort">
        <span className="small" style={{ fontWeight: 600 }}>
          Sort by
        </span>
        <div className="seg" role="group" aria-label="Sort each shop by">
          {(anyAisle || serverMode) && (
            <button type="button" aria-pressed={by === 'aisle'} disabled={serverMode} onClick={() => setSort({ ...sort, by: 'aisle' })}>
              Aisle
            </button>
          )}
          <button type="button" aria-pressed={by === 'category'} onClick={() => setSort({ ...sort, by: 'category' })}>
            Category
          </button>
          <button type="button" aria-pressed={by === 'az'} onClick={() => setSort({ ...sort, by: 'az' })}>
            A–Z
          </button>
        </div>
        {by === 'aisle' && !serverMode && (
          <button
            type="button"
            className="btn small ghost"
            onClick={() => setSort({ ...sort, down: !sort.down })}
            aria-label={sort.down ? 'Aisles 50 to 1. Tap for 1 to 50' : 'Aisles 1 to 50. Tap for 50 to 1'}
          >
            <Icon name="sort" size={14} /> {sort.down ? '50→1' : '1→50'}
          </button>
        )}
      </div>
      )}
      {view && serverMode && <PhoneOnlyNote compact text="Aisle numbers are in shopping mode on the phone (they come from your Coles branch)." />}
      <div className="shopmode-list">
        {info && <ProductPreview product={info} onClose={() => setInfo(undefined)} />}
        {adding && <AddWhileShopping entries={allEntries} recs={recs} section={section} onClose={() => setAdding(false)} />}
        {editing &&
          (() => {
            const latest = allEntries.find((x) => x.id === editing.id) ?? general.find((x) => x.id === editing.id);
            if (!latest) return null;
            return (
              <EditEntry
                entry={latest}
                categories={categories}
                shops={shops}
                deal={dealFor(cx(latest), latest) ?? recFor(c, latest)?.options[0]}
                name={recFor(c, latest)?.group.name}
                alternative={isAlternative(latest)}
                onClose={() => setEditing(undefined)}
                details={
                  !latest.checked ? (
                    <div className="entry-qty">
                      <span className="title">How many</span>
                      <Stepper e={latest} />
                    </div>
                  ) : undefined
                }
              />
            );
          })()}
        {!view && (
          <ShopPicker
            shops={shopKeys}
            doneAt={doneAt}
            anyCount={here('any').filter((e) => !e.checked).length}
            generalCount={generalShown.filter((e) => !e.checked).length}
            standby={standby}
            name={shopName}
            stats={statsOf}
            onPick={setAt}
            onAll={() => setAt('all')}
            onFinish={finish}
          />
        )}
        {(view === 'all' ? c.order : view ? [view, 'any' as ShopKey] : []).map((shop) => {
          const items = sortShop(here(shop));
          // 0.12.7: a shop you're going to with nothing of yours there (yet) says so, plainly.
          if (!items.length)
            return view === shop && shop !== 'any' ? (
              <section key={shop}>
                <div className="eyebrow" style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '12px 16px 4px' }}>
                  <ChainDot chain={shop} /> {shopName(shop)}
                </div>
                <p className="small" style={{ margin: 0, padding: '4px 16px 12px' }}>
                  Nothing from your list here right now.
                  {standby(shop) > 0 ? ' An alternative shows here if your other shops miss out.' : ''}
                </p>
              </section>
            ) : null;
          return (
            <section key={shop}>
              <div
                className="eyebrow"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '12px 16px 4px',
                }}
              >
                {shop !== 'any' && <ChainDot chain={shop} />} {shopName(shop)}
                {/* 0.10.2: at your other Coles today? Its aisles instead. */}
                {shop === 'coles' && second && !serverMode && (
                  <button type="button" className="linkish small" style={{ marginLeft: 'auto', padding: 0, textTransform: 'none', letterSpacing: 0 }} onClick={() => setColesSlot(colesSlot === '1' ? '2' : '1')}>
                    At {colesSlot === '1' ? second : branchName(cachedSettings(), 'coles')} instead
                  </button>
                )}
              </div>
              {items.map((e) => {
                const d = dealFor(cx(e), e);
                const name = recFor(c, e)?.group.name ?? e.text;
                return (
                  <ShopRow
                    key={e.id}
                    e={e}
                    name={name}
                    onOpen={openOf(e)}
                    onTicked={(on) => noteTick(e, on)}
                    // 0.10.8: its photo, with the blue ⓘ, as on the list: tap it to see the product in full
                    // (photo, size, ingredients), so you know what you're looking for on the shelf.
                    thumb={
                      shelfLook(e) ? (
                        <span className="thumb-btn" aria-hidden>
                          <Thumb src={shelfLook(e)!.imageUrl} />
                        </span>
                      ) : items.some((x) => !!shelfLook(x)) ? (
                        // keeps the names lined up with the ones that have a photo
                        <span className="thumb-space" aria-hidden />
                      ) : undefined
                    }
                    extra={
                      // 0.12.5: the price with the blue i right under it (beside it there was no room left for the name on a phone)
                      <span className="shoprow-side">
                        {priceOf(cx(e), e) !== undefined && (
                          <span className="num" style={{ fontWeight: 700, fontSize: 17 }}>
                            {(d && !d.multi && kiloPrice(d.product, d.price)?.main) || money(priceOf(cx(e), e))}
                          </span>
                        )}
                        {d && !d.multi && kiloPrice(d.product, d.price, qtyOf(e))?.each && <span className="small num kilo-each">{kiloPrice(d.product, d.price, qtyOf(e))!.each}</span>}
                        <RowInfo name={name} onOpen={() => setEditing(e)} />
                      </span>
                    }
                  >
                    <span
                      style={{
                        flex: 1,
                        display: 'flex',
                        flexDirection: 'column',
                      }}
                    >
                      <span className="title" style={{ fontSize: 17 }}>
                        {qtyOf(e) > 1 && <span className="num">{qtyOf(e)} × </span>}
                        {name}
                      </span>
                      {d ? (
                        <span className="small">
                          {packsOf(cx(e), e)}
                          {d.product.name}
                          {/* 0.10.9: or any of the others you picked here (flavours, scents, colours) */}
                          {(() => {
                            const f = flavourSets(recFor(c, e)!).find((x) => x.chain === d.product.chain);
                            return f ? `, or any of your ${f.n} ${f.word}` : '';
                          })()}
                        </span>
                      ) : (
                        e.product && <span className="small">{e.product.name}</span>
                      )}
                      {/* 0.12.7: an "Also happy with" product standing in, or a pick you passed at a cheaper shop */}
                      {(isAlternative(e) || cheaperWas(e)) && (
                        <span className="tags" style={{ marginTop: 3 }}>
                          {isAlternative(e) && <span className="tag info">ALTERNATIVE</span>}
                          {cheaperWas(e) && <span className="tag normal">{cheaperWas(e)}</span>}
                        </span>
                      )}
                      {/* 0.10.2: where it is in the shop (shopping mode only). 0.10.8: only when the shop
                          has said; no 'Aisle: unknown' on every line. */}
                      {!e.checked && !serverMode && aisleAt(e) && (
                        <span className="tags" style={{ marginTop: 3 }}>
                          <span className="tag aisle">{aisleLabel(aisleAt(e))}</span>
                        </span>
                      )}
                      {stockNote(cx(e), e) && (
                        <span
                          className="small"
                          style={{ color: stockNote(cx(e), e)!.kind === 'second' ? 'var(--green-ink)' : 'var(--amber-ink)', fontWeight: 600 }}
                        >
                          {stockNote(cx(e), e)!.text}
                        </span>
                      )}
                      {/* 0.9.9: stock at each shop the item is bought at, a tap away. */}
                      {!e.checked && recFor(c, e) && (
                        <span className="tags" style={{ marginTop: 3 }}>
                          <StockTag
                            products={recFor(c, e)!
                              .options.filter((o) => o.role === 'main')
                              .map((o) => o.product)}
                            name={name}
                            onlyOut
                          />
                        </span>
                      )}
                    </span>
                  </ShopRow>
                );
              })}
            </section>
          );
        })}
        {/* 0.12.6: the General list, at the bottom of every shop's page: get these anywhere */}
        {view !== undefined && generalAt(view).length > 0 && (
          <section className="shop-general">
            <div className="eyebrow" style={{ padding: '12px 16px 4px' }}>
              General list · get anywhere
            </div>
            {generalAt(view).map((e) => (
              <ShopRow
                key={e.id}
                e={e}
                name={e.text}
                thumb={generalAt(view).some((x) => !!x.product?.imageUrl) || (view !== 'all' && here(view).some((x) => !!shelfLook(x))) ? (
                  e.product?.imageUrl ? (
                    <span className="thumb-btn" aria-hidden>
                      <Thumb src={e.product.imageUrl} />
                    </span>
                  ) : (
                    <span className="thumb-space" aria-hidden />
                  )
                ) : undefined}
                extra={
                  <span className="shoprow-side">
                    {e.price !== undefined && (
                      <span className="num" style={{ fontWeight: 700, fontSize: 17 }}>
                        {money(Math.round(e.price * qtyOf(e) * 100) / 100)}
                      </span>
                    )}
                    <RowInfo name={e.text} onOpen={() => setEditing(e)} />
                  </span>
                }
              >
                <span style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
                  <span className="title" style={{ fontSize: 17 }}>
                    {qtyOf(e) > 1 && <span className="num">{qtyOf(e)} × </span>}
                    {e.text}
                  </span>
                  {e.product && <span className="small">{e.product.name}</span>}
                </span>
              </ShopRow>
            ))}
          </section>
        )}
        {/* 0.12.7: nothing drops off silently: what none of today's shops has is at the bottom of every page (it was only on the shops page) */}
        {notHere.length > 0 && (
          <section className="not-today">
            <div className="eyebrow" style={{ padding: '12px 16px 4px', color: 'var(--amber-ink, inherit)' }}>
              {doneAt.length && shopsLeft(chosen, doneAt).length ? 'Not at the shops you have left' : "Not at today's shops"}
            </div>
            <p className="small" style={{ padding: '0 16px', margin: 0 }}>
              {doneAt.length && shopsLeft(chosen, doneAt).length
                ? "These were at a shop you've finished, or aren't at any of today's shops."
                : `${chosen.length === 1 ? `${chainName(chosen[0])} doesn't` : "The shops you're going to don't"} have these.`}{' '}
              Tick them off if you find them anyway.
            </p>
            {notHere.map((e) => {
              const best = dealFor(all, e);
              const name = recFor(all, e)?.group.name ?? e.text;
              return (
                <ShopRow
                  key={e.id}
                  e={e}
                  name={name}
                  onOpen={openOf(e)}
                  thumb={
                    best ? (
                      <span className="thumb-btn" aria-hidden>
                        <Thumb src={previewFromOption(best).imageUrl} />
                      </span>
                    ) : notHere.some((x) => !!dealFor(all, x)) ? (
                      <span className="thumb-space" aria-hidden />
                    ) : undefined
                  }
                  extra={
                    // The ⓘ on the right, as on every line (0.12.7: it sat on the photo here)
                    <span className="shoprow-side">
                      <RowInfo name={name} onOpen={() => setEditing(e)} />
                    </span>
                  }
                >
                  <span style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
                    <span className="title" style={{ fontSize: 17 }}>
                      {qtyOf(e) > 1 && <span className="num">{qtyOf(e)} × </span>}
                      {name}
                    </span>
                    <span className="small">
                      {best ? `At ${chainName(best.product.chain)}: ${best.product.name}, ${money(best.price)}` : 'No price at any of your shops yet'}
                    </span>
                  </span>
                </ShopRow>
              );
            })}
          </section>
        )}
        {view !== undefined && view !== 'all' && (
          // 0.10.9: done here: back to the shops (the done one greyed)
          <div className="shop-done-bar">
            <button className="btn primary block" onClick={() => doneHere(view)}>
              <Icon name="check" size={18} /> Done at {chainName(view)}
            </button>
            {statsOf(view).left > 0 && (
              <span className="small">
                {statsOf(view).left === 1 ? "The 1 you didn't tick stays" : `The ${statsOf(view).left} you didn't tick stay`} on your list.
              </span>
            )}
          </div>
        )}
        {view !== undefined && view !== 'all' ? null : skipped.length > 0 && (
          <p className="small" style={{ padding: '12px 16px 0', margin: 0 }}>
            Skipped today (out of stock): {skipped.map((e) => recFor(all, e)?.group.name ?? e.text).join(', ')}. Still on your list.
          </p>
        )}
        {view === 'all' && (
          // 0.12.10: everything in one list has its own way to end the shop (the top button pauses it)
          <div className="shop-done-bar">
            <button className="btn primary block" onClick={finish}>
              <Icon name="check" size={18} /> Finish shopping
            </button>
            {left.length > 0 && (
              <span className="small">
                {left.length === 1 ? "The 1 you didn't tick stays" : `The ${left.length} you didn't tick stay`} on your list.
              </span>
            )}
          </div>
        )}
      </div>
      {card && (
        <Sheet title={card.program === 'other' ? card.label : PROGRAMS[card.program].name} onClose={() => setCard(undefined)}>
          <div className="barcode-panel">
            <CardBarcode value={card.number} />
            <span className="num" style={{ letterSpacing: 2 }}>
              {card.number}
            </span>
          </div>
          <p className="small">Turn your screen brightness up if the scanner struggles.</p>
        </Sheet>
      )}
    </div>
  );
}
