import { useEffect, useMemo, useState } from 'react';
import { act } from '../../lib/undo'; // 0.9.5 (undo)
import { addListEntry, allListEntries, getSettings, nowIso, uid } from '../../lib/db';
import { addToList } from '../../lib/listActions';
import { buildCatalogue } from '../../lib/myCatalogue';
import { filterSpecials, shopSpecials, type Special, type SpecialSort } from '../../lib/mySpecials';
import { loadRecommendations } from '../../lib/recs';
import { unitTextOf } from '../../lib/searchHelp';
import { noteSeen, seenSpecials, type SeenRow } from '../../lib/seen';
import { loadSpecials, type SpecialsList } from '../../lib/specials';
import { money } from '../../lib/units';
import { useLive } from '../../lib/useLive';
import { specialsWeekStart } from '../../lib/verdict';
import { chainName, SECTION_NAMES, websiteOf, type Section, type StoreChain } from '../../shops';
import { isNative } from '../../stores/http';
import { ChainDot, Icon, LoadingBar, Thumb, TopBar } from '../components';
import { useNav } from '../nav';
import { catalogueShops, httpsLink } from './Catalogues';

// 0.11.0: My specials (More → Catalogues and specials → Open my specials). A list for each shop
// you use, closed until you open it, in every tab: Groceries, Bottle shop, Chemist and the sections
// you've made. Each shop's list is your items on special there, the shop's own half-price list where
// Restock can read one (Coles and Woolworths), and what your searches found on special there this
// week (lib/mySpecials.ts). Search and sort work across the shops you've opened.
//
// Before, this was the Specials page: Woolworths and Coles half price in one long list, and a link
// for Aldi.

const GROUP = (s: Section) => (s === 'pantry' ? 'Groceries' : SECTION_NAMES[s]);
/** "Add to pantry", "Add to Bottle shop", "Add to Pets": where tracking it puts it. */
const trackLabel = (s: Section) => (s === 'pantry' ? 'Add to pantry' : `Add to ${SECTION_NAMES[s]}`);
const FULL_LIST: readonly string[] = ['woolworths', 'coles'];
/** "Coles's", "Woolworths'". */
const possessive = (name: string) => `${name}${/s$/i.test(name) ? "'" : "'s"}`;
const SORTS: { id: SpecialSort; label: string }[] = [
  { id: 'saving', label: 'Biggest saving' },
  { id: 'price', label: 'Lowest price' },
  { id: 'az', label: 'A–Z' },
];
const localDay = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export function SpecialsScreen() {
  const nav = useNav();
  const base = useLive(async () => {
    const [settings, recs, entries] = await Promise.all([getSettings(), loadRecommendations(), allListEntries()]);
    const groups = catalogueShops(settings);
    const chains = [...new Set(groups.flatMap((g) => g.chains))];
    const pages = buildCatalogue(recs, chains).pages;
    const since = localDay(specialsWeekStart(Date.now()));
    const seen = new Map<string, SeenRow[]>();
    for (const c of chains) seen.set(c, await seenSpecials(c, since));
    const listed = new Set(entries.filter((e) => !e.checked && e.groupId).map((e) => e.groupId!));
    return { groups, pages, seen, listed };
  }, []);
  const [lists, setLists] = useState<SpecialsList[]>();
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [typed, setTyped] = useState('');
  const [sort, setSort] = useState<SpecialSort>('saving');
  const [only, setOnly] = useState<Section | 'all'>('all');
  const load = async (fresh = false) => {
    setBusy(true);
    try {
      const l = await loadSpecials(fresh);
      setLists(l);
      // what the shops' lists showed is remembered like any search result
      void noteSeen(l.flatMap((x) => x.items));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const byShop = useMemo(() => {
    const m = new Map<string, Special[]>();
    if (!base) return m;
    for (const c of new Set(base.groups.flatMap((g) => g.chains))) {
      const page = base.pages.find((p) => p.chain === c && p.kind === 'sales');
      m.set(c, shopSpecials(page?.deals ?? [], lists?.find((l) => l.chain === c)?.items ?? [], base.seen.get(c) ?? []));
    }
    return m;
  }, [base, lists]);

  if (!base) return <div className="screen" />;
  const groups = base.groups.filter((g) => only === 'all' || g.section === only);
  const shown = groups.flatMap((g) => g.chains.map((c) => `${g.section}|${c}`));
  const allOpen = shown.length > 0 && shown.every((k) => open.has(k));
  // a search opens every shop that has a match, so you don't have to hunt for it
  const searching = typed.trim().length > 0;

  const addLine = async (s: Special, section: Section) => {
    if (s.groupId) {
      const rec = base.pages.flatMap((p) => p.deals).find((d) => d.rec.group.id === s.groupId);
      if (rec && !(await addToList(rec.rec.group))) nav.toast(`${rec.rec.group.name} is already on your list`);
      return;
    }
    await act(`${s.name} added to your shopping list`, () =>
      addListEntry({ id: uid(), text: s.name, chain: s.chain as StoreChain, price: s.price, section, checked: false, createdAt: nowIso() }),
    );
  };

  return (
    <div className="screen">
      <TopBar title="My specials" />
      <p className="sub">What's on special at each shop you use. Open a shop to see its specials. Most change on Wednesdays.</p>
      <div className="specials-tools">
        <label className="search-field" style={{ flex: '1 1 100%' }}>
          <Icon name="search" size={18} />
          <input
            className="input"
            type="search"
            placeholder="Search the specials"
            aria-label="Search the specials"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
          />
        </label>
      </div>
      <div className="chips specials-opts" role="group" aria-label="Specials options">
        <select className="input" style={{ width: 'auto', minWidth: 158, height: 40, flex: 'none' }} value={sort} onChange={(e) => setSort(e.target.value as SpecialSort)} aria-label="Sort the specials">
          {SORTS.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
        {base.groups.length > 1 && (
          <select className="input" style={{ width: 'auto', minWidth: 150, height: 40, flex: 'none' }} value={only} onChange={(e) => setOnly(e.target.value as Section | 'all')} aria-label="Which shops to show">
            <option value="all">All my shops</option>
            {base.groups.map((g) => (
              <option key={g.section} value={g.section}>
                {GROUP(g.section)}
              </option>
            ))}
          </select>
        )}
        {shown.length > 1 && (
          <button className="chip" onClick={() => setOpen(allOpen ? new Set() : new Set(shown))} aria-pressed={allOpen}>
            <Icon name="chevron" size={15} /> {allOpen ? 'Close all' : 'Open all'}
          </button>
        )}
        <button className="chip" onClick={() => void load(true)} disabled={busy} aria-label="Refresh the shops' lists">
          <Icon name="refresh" size={15} /> Refresh
        </button>
      </div>
      {busy && (
        <div style={{ display: 'grid', gap: 8 }}>
          <span className="small" role="status">
            Getting this week's half-price lists…
          </span>
          <LoadingBar seconds={15} />
        </div>
      )}
      {!groups.length && <p className="small">Pick your shops in Settings → My shops to see their specials here.</p>}

      {groups.map(({ section, chains }) => (
        <div key={section} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {base.groups.length > 1 && (
            <div className="eyebrow" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <Icon name={section} size={15} /> {GROUP(section)}
            </div>
          )}
          {chains.map((c) => {
            const k = `${section}|${c}`;
            const all = byShop.get(c) ?? [];
            const items = filterSpecials(all, typed, sort);
            const isOpen = searching ? items.length > 0 : open.has(k);
            const full = FULL_LIST.includes(c);
            const err = lists?.find((l) => l.chain === c)?.error;
            const site = httpsLink(websiteOf(c));
            const toggle = () =>
              setOpen((o) => {
                const n = new Set(o);
                if (n.has(k)) n.delete(k);
                else n.add(k);
                return n;
              });
            return (
              <div className="card flush" key={k}>
                <div className={`row shop-head${isOpen ? ' open' : ''}`}>
                  <button className="grow shop-head-main specials-head" onClick={toggle} aria-expanded={isOpen} disabled={searching}>
                    <span className="title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <ChainDot chain={c} /> {chainName(c)}
                    </span>
                    <span className="small">
                      {searching ? `${items.length} of ${all.length} match` : all.length ? `${all.length} special${all.length === 1 ? '' : 's'}` : 'Nothing found yet'}
                    </span>
                  </button>
                  <Icon name="chevron" size={18} />
                </div>
                {isOpen && (
                  <>
                    {err && !all.some((s) => s.from === 'list') && (
                      <div className="banner amber" style={{ margin: '8px 12px' }}>
                        {chainName(c)} didn't send its list just now: {err}
                      </div>
                    )}
                    {items.slice(0, 80).map((s) => (
                      <div key={s.key} className="row">
                        <Thumb src={s.imageUrl} />
                        <span className="grow" style={{ minWidth: 0 }}>
                          <span className="title" style={{ fontSize: 15 }}>
                            {s.name}
                          </span>
                          <span className="small">
                            <strong className="num">{money(s.price)}</strong>
                            {s.was ? ` · was ${money(s.was)}` : ''}
                            {s.note ? ` · ${s.note}` : ''}
                          </span>
                          {s.product && unitTextOf(s.product) && <span className="small num">{unitTextOf(s.product)}</span>}
                          <span className="tags">
                            {s.from === 'yours' && <span className="tag good">YOUR ITEM</span>}
                            {s.from === 'seen' && <span className="tag normal">FROM YOUR SEARCHES</span>}
                          </span>
                        </span>
                        <span style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                          <button
                            className="btn small primary"
                            onClick={() => void addLine(s, section)}
                            disabled={!!s.groupId && base.listed.has(s.groupId)}
                            aria-label={`Add ${s.name} to your shopping list`}
                          >
                            <Icon name="cartPlus" size={16} /> {s.groupId && base.listed.has(s.groupId) ? 'On your list' : 'Add to list'}
                          </button>
                          {s.groupId ? (
                            <button className="btn small" onClick={() => nav.push({ name: 'item', groupId: s.groupId! })} aria-label={`Open ${s.groupName ?? s.name}`}>
                              Open item
                            </button>
                          ) : (
                            <button className="btn small" onClick={() => nav.push({ name: 'add', query: s.name, section })} aria-label={`${trackLabel(section)}: ${s.name}`}>
                              {trackLabel(section)}
                            </button>
                          )}
                        </span>
                      </div>
                    ))}
                    {items.length > 80 && <p className="small" style={{ padding: '8px 14px', margin: 0 }}>Showing the first 80 of {items.length}. Search to narrow it down.</p>}
                    <div className="specials-foot">
                      <p className="small" style={{ margin: 0 }}>
                        {full
                          ? `${possessive(chainName(c))} half-price list, with your items first.`
                          : all.length
                            ? `Only what Restock has seen at ${chainName(c)}: your items, and what your searches found this week. It can't read this shop's whole specials list.`
                            : !isNative() && full
                              ? 'Lists load in the Android app.'
                              : `Nothing of yours is on special at ${chainName(c)} this week, and no search has found a special there yet. Restock can't read this shop's whole specials list.`}
                      </p>
                      {site && (
                        <a className="btn small" href={c === 'aldi' ? 'https://www.aldi.com.au/special-buys' : site} style={{ textDecoration: 'none', alignSelf: 'flex-start' }}>
                          <Icon name="external" size={16} /> {c === 'aldi' ? 'Open Aldi Special Buys' : `Open ${possessive(chainName(c))} website`}
                        </a>
                      )}
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>
      ))}
      <p className="small">
        "Add to list" is for this trip only. "Add to pantry" (or the tab it belongs to) tracks it, so Restock watches its price. Prices here are what the
        shop showed when it was last looked at; a search always checks again.
      </p>
    </div>
  );
}
