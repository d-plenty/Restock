import { useEffect, useMemo, useState } from 'react';
import { act } from '../../lib/undo';
import { addListEntry, allListEntries, getSettings, nowIso, uid } from '../../lib/db';
import { findCatalogue, type CatalogueLink } from '../../lib/catalogues';
import { addToList } from '../../lib/listActions';
import { buildCatalogue } from '../../lib/myCatalogue';
import { filterSpecials, shopSpecials, type Special, type SpecialSort } from '../../lib/mySpecials';
import { loadRecommendations } from '../../lib/recs';
import { unitTextOf } from '../../lib/searchHelp';
import { noteSeen, seenSpecials } from '../../lib/seen';
import { loadSpecials, type SpecialsList } from '../../lib/specials';
import { money } from '../../lib/units';
import { useLive } from '../../lib/useLive';
import { specialsWeekStart } from '../../lib/verdict';
import { chainName, SECTION_NAMES, shopDef, websiteOf, type Section, type StoreChain } from '../../shops';
import { isNative } from '../../stores/http';
import type { StoreProduct } from '../../stores/types';
import { serverMode } from '../../server-mode/flag';
import { sharedSpecials } from '../../server-mode/live';
import { photoUrl } from '../../server-mode/ui/deskShared';
import { ChainDot, Icon, LoadingBar, Sheet, Thumb, TopBar } from '../components';
import { useNav } from '../nav';
import { catalogueShops, httpsLink } from './Catalogues';

// 0.12.2: one shop's catalogue, opened from its square button on Home or from More → Your shops.
// (Before, More → Catalogues and specials → My specials held every shop in one page of lists you
// opened one at a time.) What it shows is what Restock can read without trawling the shop: the
// shop's own half-price list (Coles and Woolworths), your items on special there, and what your
// searches found on special there this week (lib/mySpecials.ts). The shop's whole catalogue is one
// tap away, on the shop's own site.
//
// On a Restock server's web page nothing is fetched from a shop: the half-price list and the
// catalogue link are the ones the phones shared.

/** The shops whose own specials list Restock reads. */
export const FULL_LIST: readonly string[] = ['woolworths', 'coles'];
/** "Coles's", "Woolworths'". */
export const possessive = (name: string) => `${name}${/s$/i.test(name) ? "'" : "'s"}`;
const SORTS: { id: SpecialSort; label: string }[] = [
  { id: 'saving', label: 'Biggest saving' },
  { id: 'price', label: 'Lowest price' },
  { id: 'az', label: 'A–Z' },
];
const STEP = 60;
const localDay = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
/** The word on a tile's corner. */
export function tileBadge(s: Pick<Special, 'from' | 'price' | 'was'>): { text: string; mine: boolean } {
  if (s.from === 'yours') return { text: 'Your item', mine: true };
  return { text: s.was && s.price <= s.was * 0.55 ? 'Half price' : 'Special', mine: false };
}
/** Outside links open in the phone's browser; on the web page, in a new tab. */
const OUT = serverMode ? { target: '_blank', rel: 'noopener noreferrer' } : {};

export function ShopCatalogueScreen({ chain }: { chain: StoreChain }) {
  const nav = useNav();
  const name = chainName(chain);
  const full = FULL_LIST.includes(chain);
  const base = useLive(async () => {
    const [settings, recs, entries] = await Promise.all([getSettings(), loadRecommendations(), allListEntries()]);
    const section: Section = catalogueShops(settings).find((g) => g.chains.includes(chain))?.section ?? 'pantry';
    const page = buildCatalogue(recs, [chain]).pages.find((p) => p.chain === chain && p.kind === 'sales');
    const seen = await seenSpecials(chain, localDay(specialsWeekStart(Date.now()))).catch(() => []);
    const listed = new Set(entries.filter((e) => !e.checked && e.groupId).map((e) => e.groupId!));
    return { section, deals: page?.deals ?? [], seen, listed };
  }, [chain]);
  // The web page: what the phones shared (nothing is asked of a shop from here).
  const shared = useLive(async () => (serverMode ? await sharedSpecials() : undefined), []);
  const [lists, setLists] = useState<SpecialsList[]>();
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState<CatalogueLink>();
  const [typed, setTyped] = useState('');
  const [sort, setSort] = useState<SpecialSort>('saving');
  const [mineOnly, setMineOnly] = useState(false);
  const [shown, setShown] = useState(STEP);
  const [info, setInfo] = useState<Special>();
  const [added, setAdded] = useState<Set<string>>(new Set());

  const load = async (fresh = false) => {
    if (!full || serverMode) return;
    setBusy(true);
    try {
      const l = await loadSpecials(fresh);
      setLists(l);
      // what the shop's list showed is remembered like any search result
      void noteSeen(l.flatMap((x) => x.items));
    } catch {
      setLists([]);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void load();
    if (!serverMode) void findCatalogue(chain).then(setLink, () => setLink({ missing: 'unchecked' }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chain]);

  const list: StoreProduct[] = useMemo(
    () => (serverMode ? ((shared?.lists[chain]?.items ?? []) as unknown as StoreProduct[]) : (lists?.find((l) => l.chain === chain)?.items ?? [])),
    [shared, lists, chain],
  );
  const all = useMemo(() => (base ? shopSpecials(base.deals, list, base.seen) : []), [base, list]);
  const mine = useMemo(() => all.filter((s) => s.from === 'yours'), [all]);
  const items = useMemo(() => filterSpecials(mineOnly ? mine : all, typed, sort), [all, mine, mineOnly, typed, sort]);

  if (!base) return <div className="screen" />;
  const err = lists?.find((l) => l.chain === chain)?.error;
  const known = shopDef(chain)?.catalogue;
  const own = httpsLink(serverMode ? (known?.url ?? shared?.catalogues[chain]?.url) : link?.url);
  const site = httpsLink(websiteOf(chain));
  const isListed = (s: Special) => (s.groupId ? base.listed.has(s.groupId) : added.has(s.key));

  const addLine = async (s: Special) => {
    if (s.groupId) {
      const d = base.deals.find((x) => x.rec.group.id === s.groupId);
      if (d && !(await addToList(d.rec.group))) nav.toast(`${d.rec.group.name} is already on your shopping list`);
      return;
    }
    await act(`${s.name} added to your shopping list`, () =>
      addListEntry({ id: uid(), text: s.name, chain: s.chain as StoreChain, price: s.price, section: base.section, checked: false, createdAt: nowIso() }),
    );
    setAdded((a) => new Set(a).add(s.key));
  };
  const toPantry = base.section === 'pantry' ? 'Add to pantry' : `Add to ${SECTION_NAMES[base.section]}`;

  return (
    <div className="screen">
      <TopBar title={name} />
      <div className="banner green shopcat-banner">
        <span className="shopcat-kicker">{name} this week</span>
        <span className="big num" role="status">
          {all.length ? `${all.length} special${all.length === 1 ? '' : 's'}` : busy ? 'Getting the list…' : 'No specials found yet'}
        </span>
        {known?.note && <span className="shopcat-note">{known.note}</span>}
      </div>
      {busy && <LoadingBar seconds={15} />}
      {err && !list.length && (
        <div className="banner amber" role="alert">
          <strong>{name} didn't send its list just now</strong>
          <span className="shopcat-note">{err}</span>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn small" onClick={() => void load(true)} disabled={busy}>
              <Icon name="refresh" size={16} /> Try again
            </button>
          </div>
        </div>
      )}

      {all.length > 0 && (
        <div className="chips" role="group" aria-label="Which specials">
          <button className="chip" aria-pressed={!mineOnly} onClick={() => (setMineOnly(false), setShown(STEP))}>
            All specials <span className="num">{all.length}</span>
          </button>
          <button className="chip" aria-pressed={mineOnly} onClick={() => (setMineOnly(true), setShown(STEP))}>
            In my pantry <span className="num">{mine.length}</span>
          </button>
        </div>
      )}
      {all.length > 8 && (
        <div className="shopcat-tools">
          <label className="search-field">
            <Icon name="search" size={18} />
            <input
              className="input"
              type="search"
              placeholder={`Search ${possessive(name)} specials`}
              aria-label={`Search ${possessive(name)} specials`}
              value={typed}
              onChange={(e) => (setTyped(e.target.value), setShown(STEP))}
            />
          </label>
          <select className="input" value={sort} onChange={(e) => setSort(e.target.value as SpecialSort)} aria-label="Sort the specials">
            {SORTS.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
      )}

      {all.length > 0 && !items.length && (
        <p className="small" role="status">
          {typed.trim() ? `Nothing matches "${typed.trim()}".` : `Nothing in your pantry is on special at ${name} this week.`}
        </p>
      )}
      {items.length > 0 && (
        <div className="cat-tiles">
          {items.slice(0, shown).map((s) => {
            const badge = tileBadge(s);
            const on = isListed(s);
            return (
              <div className="cat-tile" key={s.key}>
                <button className="cat-tile-open" onClick={() => setInfo(s)} aria-label={`${s.name}, ${money(s.price)}. Details`}>
                  <span className="cat-tile-photo">
                    <Thumb src={serverMode ? photoUrl(s.imageUrl) : s.imageUrl} />
                    <span className={`cat-tile-badge${badge.mine ? ' mine' : ''}`}>{badge.text}</span>
                  </span>
                  <span className="cat-tile-name">{s.name}</span>
                </button>
                <span className="cat-tile-foot">
                  <span className="cat-tile-prices">
                    <span className="cat-tile-price num">{money(s.price)}</span>
                    <span className="cat-tile-save num">{s.saving > 0 ? `Save ${money(s.saving)}` : (s.note ?? 'On special')}</span>
                  </span>
                  <button
                    className={`btn primary plus-btn${on ? ' on' : ''}`}
                    onClick={() => void addLine(s)}
                    disabled={on}
                    aria-label={on ? `${s.name} is on your shopping list` : `Add ${s.name} to your shopping list`}
                  >
                    <Icon name={on ? 'check' : 'cartPlus'} size={22} />
                  </button>
                </span>
              </div>
            );
          })}
        </div>
      )}
      {items.length > shown && (
        <button className="btn" onClick={() => setShown(shown + STEP)}>
          Show more ({items.length - shown} left)
        </button>
      )}

      <div className="card shopcat-foot">
        <strong>{own ? `${possessive(name)} whole catalogue` : `More from ${name}`}</strong>
        <p className="small" style={{ margin: 0 }}>
          {full
            ? serverMode && !list.length
              ? `Your phones share ${possessive(name)} half-price list when they sync, and none has come in yet. Your own items on special there still show here.`
              : `This page is ${possessive(name)} half-price list, with your own items on special there and what your searches found this week. Restock doesn't read the whole catalogue.`
            : `Restock can't read ${possessive(name)} specials list. This page is your own items on special there and what your searches found this week.`}
          {own ? ' The whole catalogue is on the shop’s own site.' : ''}
        </p>
        <div className="shopcat-links">
          {own && (
            <a className="btn primary" href={own} {...OUT} style={{ textDecoration: 'none' }} aria-label={`Open ${possessive(name)} catalogue${serverMode ? ' (opens a new tab)' : ''}`}>
              <Icon name="book" size={18} /> Open the catalogue
            </a>
          )}
          {site && (
            <a className="btn" href={site} {...OUT} style={{ textDecoration: 'none' }} aria-label={`Open ${possessive(name)} website${serverMode ? ' (opens a new tab)' : ''}`}>
              <Icon name="external" size={18} /> Website
            </a>
          )}
          {full && !serverMode && isNative() && (
            <button className="btn" onClick={() => void load(true)} disabled={busy}>
              <Icon name="refresh" size={18} /> Refresh
            </button>
          )}
        </div>
        {!serverMode && !own && link?.missing && (
          <span className="small">
            {link.missing === 'unchecked'
              ? isNative()
                ? "Couldn't look for a catalogue just now."
                : 'Looking for a catalogue works in the Android app.'
              : `No catalogue found on ${site ? new URL(site).host.replace(/^www\./, '') : 'its website'}.`}
          </span>
        )}
        <span className="small">Catalogue prices can differ by state and branch.</span>
      </div>

      {info && (
        <Sheet title={info.name} onClose={() => setInfo(undefined)}>
          <dl className="pinfo-rows">
            <div>
              <dt>
                <ChainDot chain={chain} /> Now at {name}
              </dt>
              <dd className="num big">{money(info.price)}</dd>
            </div>
            {info.was !== undefined && (
              <div>
                <dt>{info.from === 'yours' ? 'Usual price' : 'Was'}</dt>
                <dd className="num">{money(info.was)}</dd>
              </div>
            )}
            {info.saving > 0 && (
              <div>
                <dt>You save</dt>
                <dd className="num">{money(info.saving)}</dd>
              </div>
            )}
            {info.note && (
              <div>
                <dt>Offer</dt>
                <dd>{info.note}</dd>
              </div>
            )}
            {info.product && unitTextOf(info.product) && (
              <div>
                <dt>By size</dt>
                <dd className="num">{unitTextOf(info.product)}</dd>
              </div>
            )}
          </dl>
          <p className="small" style={{ margin: 0 }}>
            {info.from === 'yours'
              ? `This is ${info.groupName ?? 'one of your items'}: Restock has its price history, so this is a real saving against what it usually costs.`
              : info.from === 'seen'
                ? `One of your searches found this on special at ${name} this week. It isn't in your pantry, so Restock doesn't watch its price.`
                : `This is what ${name} says. It isn't in your pantry, so Restock can't tell you yet whether the special is a real one.`}
          </p>
          <button
            className="btn primary"
            disabled={isListed(info)}
            onClick={() => {
              void addLine(info);
              setInfo(undefined);
            }}
          >
            <Icon name="cartPlus" size={18} /> {isListed(info) ? 'On your shopping list' : 'Add to shopping list'}
          </button>
          {info.groupId ? (
            <button className="btn" onClick={() => nav.push({ name: 'item', groupId: info.groupId! })}>
              Open item
            </button>
          ) : (
            <>
              <button
                className="btn"
                disabled={serverMode}
                onClick={() =>
                  nav.push({
                    name: 'add',
                    query: info.name,
                    section: base.section,
                    preTick: info.product?.storeProductId ? { chain, storeProductId: String(info.product.storeProductId), product: info.product } : undefined,
                  })
                }
              >
                <Icon name="plus" size={18} /> {toPantry}
              </button>
              {serverMode && <span className="small muted">Adding to the pantry is by shop search, which works in the Android app.</span>}
            </>
          )}
        </Sheet>
      )}
    </div>
  );
}
