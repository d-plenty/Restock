import type { Dispatch, SetStateAction, JSX } from 'react';
import type { Group, Settings } from '../../types';
import type { SeenBefore } from '../../lib/seen';
import { kiloPrice } from '../../lib/unitPrice';
import { nameHasSize } from '../../lib/naming';
import { ItemRow, type NoteTone } from '../simple';
import { otherFlavours, varietyWord } from '../../lib/flavours';
import { bestScore, UNLIKELY } from '../../lib/searchHelp';
import { money, tidySize } from '../../lib/units';
import { type StoreProduct } from '../../stores';
import { isNative } from '../../stores/http';
import { UnblockButton } from '../Unblock';
import { isExactBarcode, type RankQuery } from '../../stores/rank';
import { mentions } from '../../stores/rank';
import { chainName, searchStoreId, type Chain } from '../../types';
import { SECTION_PLACE, shopDef, type Section, type StoreChain, kindOf as shopKindOf } from '../../shops';
import { ChainDot, ChainName, Hold, Icon, LoadingBar, specialTag } from '../components';
import { keyOf } from './addPicks';
import { uniqueProducts } from './attachOne';
import { TAP, type ForLine, type ChainResult, type SortKey, SORTS, sorted, FIRST_PAGE, MORE_PAGE, seenDay } from './addShared';

/** 0.12.4: one shop's results end with the way on: the next shop, or your picks. */
export function ShopDone(p: {
  altMode: boolean;
  anyResults: boolean;
  attachTo: string | undefined;
  backToPicks: () => void;
  changing: Chain | undefined;
  declined: Set<string>;
  finishEarly: () => void;
  finishedAt: (c: Chain) => void;
  forLine: ForLine | undefined;
  nextShopAfter: (c: Chain) => Chain | undefined;
  notSoldAt: (c: Chain) => void;
  picks: Map<string, StoreProduct>;
  results: Partial<Record<Chain, ChainResult>>;
  searched: StoreChain[];
  view: Chain | "all";
}) {
  const { altMode, anyResults, attachTo, backToPicks, changing, declined, finishEarly, finishedAt, forLine, nextShopAfter, notSoldAt, picks, results, searched, view } = p;
  return (
    <>
      {/* 0.12.4: one shop's results end with the way on: the next shop, or your picks */}
      {view !== 'all' && anyResults && !attachTo && !forLine && results[view as StoreChain]?.status === 'ok' && (searched.length > 1 || !!changing) && (
        <div className="shop-done">
          {/* 0.12.5: two ways on: the next shop, or straight to your picks (it was one button, "Finished at Coles") */}
          {altMode ? (
            // 0.12.7: finding an alternative at one shop: one way on, back to your picks.
            <button className="btn primary block shop-done-btn" onClick={backToPicks}>
              <Icon name="check" size={18} /> Done: back to your picks
            </button>
          ) : nextShopAfter(view as Chain) ? (
            <>
              <button className="btn primary block shop-done-btn" onClick={() => finishedAt(view as Chain)}>
                Next shop: {chainName(nextShopAfter(view as Chain)!)}
                <Icon name="chevron" size={18} />
              </button>
              {picks.size > 0 && (
                <button className="btn block shop-done-btn" onClick={() => finishEarly()}>
                  <Icon name="check" size={18} /> Finish: review and add
                </button>
              )}
            </>
          ) : (
            <button className="btn primary block shop-done-btn" onClick={() => finishedAt(view as Chain)}>
              <Icon name="check" size={18} /> {picks.size > 0 ? 'Finish: review and add' : `Finished at ${chainName(view)}`}
            </button>
          )}
          {!altMode && ![...picks.values()].some((x) => x.chain === view) && !declined.has(view) && picks.size > 0 && (
            <button
              className="btn block"
              onClick={() => {
                notSoldAt(view as Chain);
                finishedAt(view as Chain);
              }}
            >
              Not sold at {chainName(view)}
            </button>
          )}
        </div>
      )}
    </>
  );
}

/** 0.15.1 (split from Add.tsx): the results: which shop to show, a few from each shop (or one shop's list), and the same product at your other shops. */
export function AddResults(p: {
  PER_SHOP: 3;
  anyResults: boolean;
  changing: Chain | undefined;
  costcoLeftOut: false;
  instead: Partial<Record<Chain, { kind: string; items: StoreProduct[]; top: string[]; }>>;
  lastText: string;
  loadMore: (chain: StoreChain) => Promise<void>;
  mixed: StoreProduct[];
  original: Partial<Record<Chain, boolean>>;
  picks: Map<string, StoreProduct>;
  rankQ: RankQuery;
  reportWrong: (chain: StoreChain) => Promise<void>;
  resultRow: (sp: StoreProduct, top: Set<string>) => JSX.Element;
  results: Partial<Record<Chain, ChainResult>>;
  searchChain: (chain: StoreChain, text: string, rq: RankQuery, storeId?: string) => Promise<void>;
  searchCostcoToo: () => void;
  searched: StoreChain[];
  setOriginal: Dispatch<SetStateAction<Partial<Record<Chain, boolean>>>>;
  setPicks: Dispatch<SetStateAction<Map<string, StoreProduct>>>;
  setShopView: Dispatch<SetStateAction<Chain | "all">>;
  setShowUnlikely: Dispatch<SetStateAction<Partial<Record<Chain, boolean>>>>;
  setShowing: Dispatch<SetStateAction<Partial<Record<Chain, number>>>>;
  setSortBy: Dispatch<SetStateAction<Partial<Record<Chain, SortKey>>>>;
  setSpecialsOnly: Dispatch<SetStateAction<boolean>>;
  setSuggest: Dispatch<SetStateAction<StoreProduct[]>>;
  settings: Settings | undefined;
  showUnlikely: Partial<Record<Chain, boolean>>;
  showing: Partial<Record<Chain, number>>;
  shownItems: (c: Chain) => StoreProduct[];
  sortBy: Partial<Record<Chain, SortKey>>;
  specialsOnly: boolean;
  suggest: StoreProduct[];
  topKeys: Set<string>;
  view: Chain | "all";
}) {
  const { PER_SHOP, anyResults, changing, costcoLeftOut, instead, lastText, loadMore, mixed, original, picks, rankQ, reportWrong, resultRow, results, searchChain, searchCostcoToo, searched, setOriginal, setPicks, setShopView, setShowUnlikely, setShowing, setSortBy, setSpecialsOnly, setSuggest, settings, showUnlikely, showing, shownItems, sortBy, specialsOnly, suggest, topKeys, view } = p;
  return (
    <>
      {anyResults && !changing && (
        <div className="chips" role="group" aria-label="Show results from">
          {searched.length > 1 && (
            <button className="chip" aria-pressed={view === 'all'} onClick={() => setShopView('all')}>
              All
            </button>
          )}
          {searched.length > 1 &&
            (searched as Chain[]).map((c) => (
              <button key={c} className="chip" aria-pressed={view === c} onClick={() => setShopView(c)}>
                {chainName(c)}
              </button>
            ))}
          <button className="chip" aria-pressed={specialsOnly} onClick={() => setSpecialsOnly((v) => !v)}>
            On special only
          </button>
        </div>
      )}

      {anyResults && view === 'all' && searched.length > 1 && (
        <>
          {/* 0.12.5: said plainly: the first results are the closest match at each of your shops */}
          {mixed.length > 0 && (
            <div className="rec-head">
              <span className="rec-tag">Recommended</span>
              <span className="small">The closest matches at your shops. Tick the ones you buy.</span>
            </div>
          )}
          {mixed.length > 0 && <div className="card flush">{mixed.map((sp) => resultRow(sp, topKeys))}</div>}
          {(searched as Chain[]).some((c) => results[c as StoreChain]?.status === 'ok' && shownItems(c).length > PER_SHOP) && (
            <div className="eyebrow">Everything else</div>
          )}
          {(searched as Chain[]).map((c) => {
            const r = results[c as StoreChain];
            const left = shownItems(c).length - Math.min(PER_SHOP, shownItems(c).length);
            if (r?.status === 'loading')
              return (
                <div key={c} role="status" className="small">
                  Searching {chainName(c)}…
                  <LoadingBar seconds={(shopDef(c)?.kind ?? 'web') === 'web' ? 25 : 8} />
                </div>
              );
            if (r?.status === 'error')
              return isNative() ? (
                <div key={c} className="banner amber shop-miss">
                  <span>
                    <strong>{chainName(c)} didn't answer.</strong> {r.blocked ? 'Its website is checking for bots.' : 'Its prices are missing from this list.'}
                  </span>
                  <button className="btn small" style={TAP} onClick={() => setShopView(c)}>
                    See why
                  </button>
                </div>
              ) : null;
            if (r?.status === 'ok' && !shownItems(c).length)
              return (
                <p key={c} className="small" style={{ margin: 0 }}>
                  {specialsOnly ? `Nothing on special at ${chainName(c)}.` : `No matches at ${chainName(c)}.`}
                </p>
              );
            return left > 0 ? (
              // 0.12.2: a full-width button at the usual height (it was a small grey one)
              <button key={c} className="btn more-from" onClick={() => setShopView(c)}>
                <ChainDot chain={c} />
                <span className="grow">More from {chainName(c)}</span>
                <span className="num more-from-n">{left}</span>
                <Icon name="chevron" size={18} />
              </button>
            ) : null;
          })}
        </>
      )}

      {!isNative() && anyResults && (
        <div className="banner grey">
          <strong>Shop search works in the Android app</strong>
          <span style={{ fontSize: 13 }}>In this preview you can still add items by hand.</span>
        </div>
      )}

      {costcoLeftOut && isNative() && (
        <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <span className="small">Costco is only searched when you press Search.</span>
          <button className="btn" style={TAP} onClick={searchCostcoToo}>
            <Icon name="search" size={18} /> Search Costco
          </button>
        </div>
      )}

      {(() => {
        // Only hide a shop's results as "nothing like it" when another shop does have it.
        const likely = new Set(
          searched.filter((c) => {
            const r = results[c];
            return r?.status === 'ok' && r.items.length > 0 && bestScore(rankQ, r.items) >= UNLIKELY;
          }),
        );
        return searched
          .filter((c) => results[c] && view === c)
          .map((chain) => {
            const alt = instead[chain];
            const useAlt = !!alt && !original[chain];
            const first = results[chain]!;
            const firstCount = first.status === 'ok' ? first.items.length : 0;
            const r: ChainResult = useAlt ? { status: 'ok', items: alt.items, top: alt.top } : first;
            if (r.status === 'error' && !isNative()) return null;
            const limit = showing[chain] ?? FIRST_PAGE;
            const pool = r.status === 'ok' ? uniqueProducts(r.items).filter((sp) => !specialsOnly || sp.isSpecial) : [];
            const by = sortBy[chain] ?? 'relevant';
            // 0.12.5: by price or value, what doesn't mention what you typed goes after what does (steel wool isn't the cheapest potato)
            const inOrder = sorted(pool, by);
            const onTopic = by === 'relevant' || !rankQ.text ? inOrder : inOrder.filter((sp) => mentions(rankQ, sp));
            const ordered = onTopic.length && onTopic.length < inOrder.length ? [...onTopic, ...inOrder.filter((sp) => !onTopic.includes(sp))] : inOrder;
            // Ticked products first, so a ticked best match is never hidden under "Show more".
            const firstTicked =
              by === 'relevant' ? [...ordered.filter((sp) => picks.has(keyOf(sp))), ...ordered.filter((sp) => !picks.has(keyOf(sp)))] : ordered;
            // A shop with nothing like what you scanned or typed (wine and tofu for a dishwashing liquid).
            const unlikely =
              !useAlt &&
              r.status === 'ok' &&
              !!rankQ.text &&
              likely.size > 0 &&
              !likely.has(chain) &&
              pool.length > 0 &&
              !showUnlikely[chain] &&
              !ordered.some((sp) => picks.has(keyOf(sp))) &&
              bestScore(rankQ, pool) < UNLIKELY;
            const list = unlikely ? [] : firstTicked.slice(0, limit);
            const left = unlikely ? 0 : pool.length - list.length;
            const top = new Set(r.status === 'ok' ? (r.top ?? []) : []);
            const more = r.status === 'ok' && !!r.more && !unlikely && !specialsOnly;
            return (
              <section key={chain} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div className="eyebrow" style={{ flex: 1 }}>
                    <ChainName chain={chain} />
                  </div>
                  {r.status === 'ok' && r.items.length > 1 && (
                    <select
                      className="input"
                      style={{ width: 'auto', maxWidth: '60%', height: 44, padding: '0 8px', fontSize: 13 }}
                      value={sortBy[chain] ?? 'relevant'}
                      onChange={(e) => setSortBy((m) => ({ ...m, [chain]: e.target.value as SortKey }))}
                      aria-label={`Sort ${chainName(chain)} results`}
                    >
                      {SORTS.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
                {r.status === 'loading' && (
                  <div role="status" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <p className="small">
                      Searching {chainName(chain)}…
                      {(shopDef(chain)?.kind ?? 'web') === 'web' ? ' Reading the shop’s own website can take up to half a minute.' : ''}
                    </p>
                    <LoadingBar seconds={(shopDef(chain)?.kind ?? 'web') === 'web' ? 25 : 8} />
                  </div>
                )}
                {r.status === 'error' && (
                  <div className="banner amber" style={{ fontSize: 13 }}>
                    {r.blocked ? (
                      <>
                        <strong>{chainName(chain)} is blocking Restock</strong>
                        <span>Its website is checking for bots. That’s its check, not Restock’s. Unblock it once and prices carry on.</span>
                      </>
                    ) : (
                      r.message
                    )}
                    {settings && (
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
                        <button className="btn small" style={TAP} onClick={() => void searchChain(chain, lastText, rankQ, searchStoreId(settings, chain))}>
                          <Icon name="refresh" size={16} /> Try again
                        </button>
                        {(r.blocked || r.unblock) && (
                          <UnblockButton small chain={chain} onWorked={() => void searchChain(chain, lastText, rankQ, searchStoreId(settings, chain))} />
                        )}
                      </div>
                    )}
                  </div>
                )}
                {alt && (
                  <p className="small">
                    {useAlt && (
                      <>
                        {chainName(chain)} doesn’t seem to have “{lastText}”. Its {alt.kind} instead:{' '}
                      </>
                    )}
                    {(useAlt ? firstCount > 0 : true) && (
                      <button className="linkish small" style={TAP} onClick={() => setOriginal((m) => ({ ...m, [chain]: !m[chain] }))}>
                        {useAlt ? `Show what it found for “${lastText}” (${firstCount})` : `Show ${chainName(chain)}’s ${alt.kind} instead`}
                      </button>
                    )}
                  </p>
                )}
                {r.status === 'ok' && !r.items.length && (
                  <p className="small">
                    No matches at {chainName(chain)}.
                    {/* A shop read off its website that found nothing may just not be readable yet (0.8.6). */}
                    {shopKindOf(chain) === 'web' &&
                      ' If it sells this, its website may not work with Restock yet: Settings → Advanced → Diagnostics → Send search details helps get it fixed.'}
                  </p>
                )}
                {r.status === 'ok' && r.items.length > 0 && !pool.length && <p className="small">Nothing on special at {chainName(chain)}.</p>}
                {unlikely && (
                  <p className="small">
                    Nothing like it at {chainName(chain)}.{' '}
                    <button className="linkish small" style={TAP} onClick={() => setShowUnlikely((m) => ({ ...m, [chain]: true }))}>
                      Show what {chainName(chain)} found ({pool.length})
                    </button>
                  </p>
                )}
                {/* 0.10.11: tick one flavour, and the same thing's other flavours here (same brand and size) are one tap */}
                {(() => {
                  const mine = [...picks.values()].filter((x) => x.chain === chain);
                  const more = otherFlavours(mine, pool, (a, b) => keyOf(a) === keyOf(b));
                  if (!more.length) return null;
                  const word = varietyWord([...mine, ...more].map((x) => x.name));
                  if (changing) return null; // 0.12.1: one choice at a time on "Pick one at …"
                  return (
                    <button
                      className="btn small flavour-all"
                      style={TAP}
                      onClick={() => {
                        setPicks((prev) => {
                          const next = new Map(prev);
                          for (const x of more) next.set(keyOf(x), x);
                          return next;
                        });
                        setShowing((m) => ({ ...m, [chain]: Math.max(m[chain] ?? 0, pool.length) }));
                      }}
                    >
                      <Icon name="check" size={16} /> Add the other {more.length === 1 ? word.replace(/s$/, '') : `${more.length} ${word}`} too
                    </button>
                  );
                })()}
                {list.length > 0 && (
                  <div className="card flush">
                    {list.map((sp) => resultRow(sp, top))}
                  </div>
                )}
                {left > 0 && (
                  <button className="btn ghost small" style={TAP} onClick={() => setShowing((m) => ({ ...m, [chain]: limit + MORE_PAGE }))}>
                    Show more ({left})
                  </button>
                )}
                {left <= 0 && more && r.status === 'ok' && (
                  <button className="btn ghost small" style={TAP} disabled={r.loadingMore} onClick={() => void loadMore(chain)}>
                    {r.loadingMore ? `Getting more from ${chainName(chain)}…` : `Get more from ${chainName(chain)}`}
                  </button>
                )}
                {first.status === 'ok' && !rankQ.barcode && isNative() && (
                  <button className="linkish small" style={{ alignSelf: 'flex-end', ...TAP }} onClick={() => void reportWrong(chain)}>
                    Wrong results? Save them for the developer
                  </button>
                )}
              </section>
            );
          });
      })()}

      {suggest.length > 0 && (
        <div className="card hint" style={{ flexDirection: 'column' }}>
          <strong>Same product at {suggest.map((x) => chainName(x.chain)).join(' and ')}?</strong>
          {suggest.map((x) => (
            <span key={keyOf(x)} className="small clip">
              <ChainDot chain={x.chain} /> {x.name} · {money(x.price)}
            </span>
          ))}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button
              className="btn small primary"
              style={TAP}
              onClick={() => {
                setPicks((prev) => {
                  const next = new Map(prev);
                  for (const x of suggest) next.set(keyOf(x), x);
                  return next;
                });
                setSuggest([]);
              }}
            >
              <Icon name="check" size={16} /> Pick {suggest.length === 1 ? 'it' : 'them'} too
            </button>
            <button className="btn small" style={TAP} onClick={() => setSuggest([])}>
              No thanks
            </button>
          </div>
        </div>
      )}
    </>
  );
}

/** 0.12.1: changing one shop's pick: one line on what it's compared with. */
export function ChangeHead(p: {
  altMode: boolean;
  anchorChain: Chain | undefined;
  backToPicks: () => void;
  changing: Chain | undefined;
  picks: Map<string, StoreProduct>;
}) {
  const { altMode, anchorChain, backToPicks, changing, picks } = p;
  return (
    <>
      {/* 0.12.1: changing one shop's pick: one line on what it's compared with, and that shop's results only */}
      {changing && (
        <div className="change-head">
          {anchorChain && anchorChain !== changing && [...picks.values()].find((x) => x.chain === anchorChain) && (
            <p className="small" style={{ margin: 0 }}>
              To compare with {[...picks.values()].find((x) => x.chain === anchorChain)!.name} from {chainName(anchorChain)}.
            </p>
          )}
          <p className="small" style={{ margin: 0 }}>
            {altMode
              ? `Tick another brand or size you'd accept at ${chainName(changing)}.`
              : `Tick what you buy as this at ${chainName(changing)}.`}
          </p>
          <button className="btn block" onClick={backToPicks}>
            Back to your picks
          </button>
        </div>
      )}
    </>
  );
}

const sentence = (t: string) => t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();

/** One result: the photo, the name, its shop and size, one price and a word. + picks it. */
export function ResultRow({ sp, good, picked, tracked, inRole, rankQ, section, seen, photo, onPick, onPreview }: {
  sp: StoreProduct;
  /** One of the best matches for the search ("Good match"). */
  good: boolean;
  picked: boolean;
  /** The pantry item it's already in. */
  tracked?: Group;
  /** Adding to an item: which group of that item it's in. */
  inRole?: 'main' | 'alt';
  rankQ: RankQuery;
  section: Section;
  /** 0.11.0: what an earlier search of yours saw it at. */
  seen?: SeenBefore;
  photo?: string;
  onPick: (sp: StoreProduct) => void;
  onPreview: (sp: StoreProduct) => void;
}) {
    const size = sp.size && !nameHasSize(sp.name, sp.size) ? tidySize(sp.size, sp.name) : undefined;
    const note: { text: string; tone: NoteTone } | undefined = isExactBarcode(rankQ, sp)
      ? { text: 'Exact match', tone: 'good' }
      : tracked
        ? // 0.12.9: in the item being added to, it says which group it's in (an Also happy with one read "In your pantry" beside a +)
          { text: inRole === 'alt' ? 'Also happy with' : inRole === 'main' ? 'Products I buy' : `In ${SECTION_PLACE[(tracked.section ?? section) as Section]}`, tone: 'plain' }
        : sp.isSpecial && !sp.memberOnly
          ? { text: sentence(specialTag(sp.price, sp.wasPrice)), tone: 'good' }
          : sp.memberOnly && sp.chain !== 'costco'
            ? { text: 'Member price', tone: 'plain' }
            : !rankQ.barcode && good
              ? { text: 'Good match', tone: 'good' }
              : // 0.11.0: what an earlier search of yours saw it at (history, never today's price)
                seen
                ? { text: `You saw ${money(seen.price)} on ${seenDay(seen.day)}`, tone: 'plain' }
                : undefined;
    const what = `${sp.name} at ${chainName(sp.chain)}, ${money(sp.price)}`;
  return (
      <Hold onLong={() => onPreview(sp)}>
        <ItemRow
          className={picked ? 'picked' : undefined}
          photo={photo}
          name={sp.name}
          chain={sp.chain}
          // 0.12.5: loose fruit and veg also say their price by the kilo
          // 0.12.8: and that price is the main one, as on the shelf ticket; the shop's price for one sits beside the shop
          shopText={`${chainName(sp.chain)}${size ? ` · ${size}` : ''}${kiloPrice(sp, sp.price)?.each ? ` · ${kiloPrice(sp, sp.price)!.each}` : ''}`}
          price={sp.price}
          priceText={kiloPrice(sp, sp.price)?.main}
          note={note}
          onOpen={() => onPick(sp)}
          openLabel={picked ? `${what}: picked. Tap to unpick` : `Pick ${what}`}
          onInfo={() => onPreview(sp)}
          action={
            <span className={`plus-btn${picked ? ' on' : ''}`} aria-hidden="true">
              <Icon name={picked ? 'check' : 'plus'} size={22} />
            </span>
          }
        />
      </Hold>
  );
}
