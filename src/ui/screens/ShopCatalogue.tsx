import { useEffect, useMemo, useState } from 'react';
import { act } from '../../lib/undo';
import { addListEntry, allListEntries, getSettings, nowIso, uid } from '../../lib/db';
import { findCatalogue, type CatalogueLink } from '../../lib/catalogues';
import { addToList } from '../../lib/listActions';
import { buildCatalogue, doubtfulDeals } from '../../lib/myCatalogue';
import { filterSpecials, type Special, type SpecialSort } from '../../lib/mySpecials';
import { listLineKeys, ownSpecials, realCount } from '../../lib/ownSpecials';
import { weekDay } from '../../lib/ownSpecialsLive';
import { loadRecommendations } from '../../lib/recs';
import { unitTextOf } from '../../lib/searchHelp';
import { noteSeen, seenSpecials } from '../../lib/seen';
import { loadSpecials, type SpecialsList } from '../../lib/specials';
import { money } from '../../lib/units';
import { useLive } from '../../lib/useLive';
import { chainName, SECTION_NAMES, shopDef, websiteOf, type Section, type StoreChain } from '../../shops';
import { isNative } from '../../stores/http';
import type { StoreProduct } from '../../stores/types';
import { ChainDot, Icon, LoadingBar, Sheet, Thumb, TopBar, ScreenWaiting } from '../components';
import { useNav } from '../nav';
import { NoneFound } from '../simple';
import { cleanSearch } from '../../lib/searchText';
import { catalogueShops, httpsLink } from './Catalogues';

// 0.12.2: one shop's catalogue, opened from its square button on Home or from More → Your shops.
// 0.12.3: My catalogue is merged into it, and it shows only your own things on special there: the
// items you track (on any tab) and one-off shopping list lines (lib/ownSpecials.ts). Nothing you
// don't buy is shown; the shop's whole catalogue is the first thing on the page, on its own site.
// The shop's half-price list (Coles and Woolworths) is only fetched to spot a one-off list line on
// special, so a page with no such lines asks the shop for nothing.
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
/**
 * The word on a tile's corner. 0.12.6: the kind of deal ("Great deal", "On special", "Small saving",
 * "2 for $5.60", "Wait for a better special", "Not a real special"), in the Pantry's words and
 * colours. It said "Your item" on every tile, which the page already says.
 */
export function tileBadge(s: Pick<Special, 'deal'>): { text: string; tone: Special['deal']['tone'] } {
  return s.deal;
}
export function ShopCatalogueScreen({ chain }: { chain: StoreChain }) {
  const nav = useNav();
  const name = chainName(chain);
  const full = FULL_LIST.includes(chain);
  const base = useLive(async () => {
    const [settings, recs, entries] = await Promise.all([getSettings(), loadRecommendations(), allListEntries()]);
    const section: Section = catalogueShops(settings).find((g) => g.chains.includes(chain))?.section ?? 'pantry';
    const page = buildCatalogue(recs, [chain]).pages.find((p) => p.chain === chain && p.kind === 'sales');
    const lines = [...listLineKeys(entries)].some((k) => k.startsWith(`${chain}|`));
    const seen = lines ? await seenSpecials(chain, weekDay()).catch(() => []) : [];
    const listed = new Set(entries.filter((e) => !e.checked && e.groupId).map((e) => e.groupId!));
    return { section, deals: page?.deals ?? [], doubts: doubtfulDeals(recs, chain, page?.deals ?? []), seen, listed, entries, lines };
  }, [chain]);
  const [lists, setLists] = useState<SpecialsList[]>();
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState<CatalogueLink>();
  const [typed, setTyped] = useState('');
  const [sort, setSort] = useState<SpecialSort>('saving');
  const [shown, setShown] = useState(STEP);
  const [info, setInfo] = useState<Special>();
  const [added, setAdded] = useState<Set<string>>(new Set());

  const load = async (fresh = false) => {
    if (!full || !base?.lines) return;
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chain, base?.lines]);
  useEffect(() => {
    void findCatalogue(chain).then(setLink, () => setLink({ missing: 'unchecked' }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chain]);

  const list: StoreProduct[] = useMemo(
    () => lists?.find((l) => l.chain === chain)?.items ?? [],
    [lists, chain],
  );
  const all = useMemo(() => (base ? ownSpecials(base.deals, base.lines ? list : [], base.seen, base.entries, base.doubts) : []), [base, list]);
  const real = realCount(all);
  const items = useMemo(() => filterSpecials(all, typed, sort), [all, typed, sort]);
  const saving = all.reduce((t, s) => t + s.saving, 0);

  if (!base) return <ScreenWaiting title={name} />;
  const err = lists?.find((l) => l.chain === chain)?.error;
  const known = shopDef(chain)?.catalogue;
  const own = httpsLink(link?.url);
  const site = httpsLink(websiteOf(chain));
  const isListed = (s: Special) => (s.groupId ? base.listed.has(s.groupId) : s.from !== 'yours' || added.has(s.key));

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
      {/* 0.12.3: the whole catalogue first (it was a card at the bottom): Restock shows only your own things */}
      <div className="card shopcat-top">
        <strong>{own ? `${possessive(name)} whole catalogue` : `Everything at ${name}`}</strong>
        <p className="small" style={{ margin: 0 }}>
          Restock shows only your own things on special here. {own ? 'The whole catalogue is on the shop’s own site.' : 'Everything else is on the shop’s own site.'}
        </p>
        {(own || site) && (
          <div className="shopcat-links">
            {own && (
              <a className="btn primary" href={own} style={{ textDecoration: 'none' }} aria-label={`Open ${possessive(name)} catalogue`}>
                <Icon name="book" size={18} /> Open the catalogue
              </a>
            )}
            {site && (
              <a className="btn" href={site} style={{ textDecoration: 'none' }} aria-label={`Open ${possessive(name)} website`}>
                <Icon name="external" size={18} /> Website
              </a>
            )}
          </div>
        )}
        {!own && link?.missing && (
          <span className="small">
            {link.missing === 'unchecked'
              ? isNative()
                ? "Couldn't look for a catalogue just now."
                : 'Looking for a catalogue works in the Android app.'
              : `No catalogue found on ${site ? new URL(site).host.replace(/^www\./, '') : 'its website'}.`}
          </span>
        )}
        <span className="small">{known?.note ? `${known.note} ` : ''}Catalogue prices can differ by state and branch.</span>
      </div>

      <div className="banner green shopcat-banner">
        <span className="shopcat-kicker">{name} this week</span>
        <span className="big num" role="status">
          {real ? `${real} of yours on special` : busy ? 'Looking…' : 'None this week'}
        </span>
        {saving > 0.004 && <span className="shopcat-note num">Save about {money(saving)}</span>}
      </div>
      {busy && <LoadingBar seconds={15} />}
      {err && !list.length && (
        <div className="banner amber" role="alert">
          <strong>{name} didn't send its specials just now</strong>
          <span className="shopcat-note">One-off things on your shopping list may be missing from this page. {err}</span>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn small" onClick={() => void load(true)} disabled={busy}>
              <Icon name="refresh" size={16} /> Try again
            </button>
          </div>
        </div>
      )}

      {all.length > 8 && (
        <div className="shopcat-tools">
          <label className="search-field">
            <Icon name="search" size={18} />
            <input
              className="input"
              type="search"
              placeholder={`Search your ${name} specials`}
              aria-label={`Search your ${name} specials`}
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

      {/* 0.12.6: nothing found: the next step, with what was typed carried over */}
      {!items.length && !busy && cleanSearch(typed) && (
        <NoneFound
          text={`None of your ${name} specials match "${cleanSearch(typed)}".`}
          label={`Search ${name} for ${cleanSearch(typed)}`}
          onAdd={() => nav.push({ name: 'add', section: base.section, toPantry: true, chain, query: cleanSearch(typed) })}
        />
      )}
      {!items.length && !busy && !cleanSearch(typed) && (
        <p className="small" role="status">
          {`When something in your pantry or on your shopping list is on special at ${name}, it shows here.`}
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
                    <Thumb src={s.imageUrl} />
                    <span className={`cat-tile-badge ${badge.tone}`}>{badge.text}</span>
                  </span>
                  <span className="cat-tile-name">{s.name}</span>
                </button>
                <span className="cat-tile-foot">
                  <span className="cat-tile-prices">
                    <span className="cat-tile-price num">{money(s.price)}</span>
                    <span className={`cat-tile-save num${s.doubt ? ' doubt' : ''}`}>{s.saving > 0 ? `Save ${money(s.saving)}` : (s.note ?? 'On special')}</span>
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
            {info.doubt
              ? info.deal.tone === 'fake'
                ? `This is ${info.groupName ?? 'one of your items'}. ${name} marks it as a special, but from its price history this is what it usually costs.`
                : `This is ${info.groupName ?? 'one of your items'}. It's on special at ${name}, but it has been cheaper: worth waiting if you can.`
              : info.from === 'yours'
              ? `This is ${info.groupName ?? 'one of your items'}: Restock has its price history, so this is a real saving against what it usually costs.`
              : `This is on your shopping list, and ${name} has it on special this week. It isn't in your pantry, so Restock doesn't watch its price or check the special is a real one.`}
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
            </>
          )}
        </Sheet>
      )}
    </div>
  );
}
