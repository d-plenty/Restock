// 0.9.4 (design section 15): Specials and catalogues on the web, like the phone's. Every shop the
// household follows, by tab, with its website, specials and catalogue links; This week's specials
// from the half-price lists the phones fetched and shared (the server never fetches a shop); and My
// catalogue (made here from your items' prices). Home shows a little of both (HomeSpecials).
import { useMemo, useState } from 'react';
import { addListEntry, allGroups, getSettings, nowIso, uid } from '../../lib/db';
import { buildCatalogue } from '../../lib/myCatalogue';
import { loadRecommendations } from '../../lib/recs';
import { likeYourPantry } from '../../lib/specials';
import { money } from '../../lib/units';
import { useLive } from '../../lib/useLive';
import { activeSections, chainName, searchChainsIn, type StoreChain } from '../../shops';
import type { StoreProduct } from '../../stores/types';
import { ChainDot, Icon, Thumb, timeAgo } from '../../ui/components';
import { useNav } from '../../ui/nav';
import { HousePage } from './DeskServer';
import { https, useFollowed, useShared } from './houseData';
import { memberNames } from '../live';

const MINE_KEY = 'deskSpecialsMine';

function loadMine(): boolean {
  try {
    return localStorage.getItem(MINE_KEY) !== '0';
  } catch {
    return true;
  }
}

/** A shop's product picture: only an https one (anything the page's CSP doesn't allow shows the box). */
export const thumbOf = (url: unknown) => (typeof url === 'string' ? https(url) : undefined);

function useSpecialLists() {
  const shared = useShared();
  const groups = useLive(allGroups, []);
  const pantry = useMemo(() => (groups ?? []).filter((g) => (g.section ?? 'pantry') === 'pantry').map((g) => g.name), [groups]);
  const lists = useMemo(
    () =>
      Object.values(shared?.lists ?? {})
        .map((l) => ({ ...l, items: l.items as unknown as StoreProduct[] }))
        .sort((a, b) => chainName(a.chain).localeCompare(chainName(b.chain))),
    [shared],
  );
  return { shared, lists, pantry };
}

function useAddSpecial() {
  const nav = useNav();
  return async (p: StoreProduct) => {
    await addListEntry({ id: uid(), text: p.name, chain: p.chain, price: p.price, section: 'pantry', checked: false, createdAt: nowIso() });
    nav.toast(`${p.name} added to your shopping list`);
  };
}

function SpecialRow({ p, onAdd }: { p: StoreProduct; onAdd: (p: StoreProduct) => void }) {
  return (
    <div className="row house-special">
      <Thumb src={thumbOf(p.imageUrl)} />
      <span className="grow">
        <span className="title clip">{p.name}</span>
        <span className="small">
          <strong className="num">{money(p.price)}</strong>
          {p.wasPrice ? <s className="dk-was"> {money(p.wasPrice)}</s> : null}
          {p.promo ? ` · ${p.promo}` : ''}
        </span>
      </span>
      <button className="btn small primary" onClick={() => onAdd(p)} aria-label={`Add ${p.name} to your shopping list`}>
        <Icon name="cartPlus" size={16} /> List
      </button>
    </div>
  );
}

function ShopRow({ s }: { s: NonNullable<ReturnType<typeof useFollowed>>[number]['shops'][number] }) {
  const link = (href: string | undefined, label: string, icon: string, primary?: boolean) =>
    href ? (
      <a className={`btn small${primary ? ' primary' : ''}`} href={href} target="_blank" rel="noopener noreferrer" aria-label={`${s.name} ${label.toLowerCase()} (opens a new tab)`}>
        <Icon name={icon} size={16} /> {label}
      </a>
    ) : null;
  return (
    <div className="dk-row">
      <span className="grow">
        <span className="dk-row-title">
          <ChainDot chain={s.chain} /> {s.name}
        </span>
        <span className="dk-sub">{s.catalogueNote ?? (s.catalogue ? 'Catalogue online' : 'No catalogue found yet. A phone looks for it on the shop\'s website.')}</span>
      </span>
      <span className="dk-btns">
        {link(s.catalogue, 'Catalogue', 'book', true)}
        {link(s.specials, 'Specials', 'flame')}
        {link(s.website, 'Website', 'external')}
      </span>
    </div>
  );
}

export function DeskSpecials({ narrow }: { narrow?: boolean }) {
  const nav = useNav();
  const followed = useFollowed();
  const { lists, pantry } = useSpecialLists();
  const [mine, setMineState] = useState(loadMine);
  const add = useAddSpecial();
  const names = memberNames();
  const setMine = (v: boolean) => {
    setMineState(v);
    try {
      localStorage.setItem(MINE_KEY, v ? '1' : '0');
    } catch {
      // fine
    }
  };
  const filter = mine && pantry.length > 0;
  return (
    <HousePage narrow={narrow} title="Specials and catalogues">
      <button className="banner green cat-entry dk-self-start house-cat" onClick={() => nav.push({ name: 'mycatalogue' })}>
        <span className="cat-kicker">YOUR RESTOCK CATALOGUE</span>
        <span className="cat-entry-title">Made from what you buy</span>
        <span className="cat-lede">This week's sales on the things you track, a page for each shop.</span>
        <span className="btn small cat-open">Open my catalogue</span>
      </button>

      <section className="dk-stack" aria-labelledby="sp-week">
        <div className="dk-section-head">
          <h2 id="sp-week">This week's specials</h2>
          <div className="dk-seg" role="group" aria-label="Which specials">
            <button aria-pressed={filter} disabled={!pantry.length} onClick={() => setMine(true)}>
              Like what I buy
            </button>
            <button aria-pressed={!filter} onClick={() => setMine(false)}>
              Everything
            </button>
          </div>
        </div>
        {lists.length === 0 && (
          <div className="card">
            <p className="small">
              None shared yet. Your phones share the half-price lists they fetch when they sync (Restock 0.9.4 or newer); this page shows them, so the
              server never has to ask the shops.
            </p>
          </div>
        )}
        <div className="dk-grid">
          {lists.map((l) => {
            const items = filter ? likeYourPantry(l.items, pantry) : l.items;
            return (
              <section key={l.chain} className="card flush" aria-label={`${chainName(l.chain)} specials`}>
                <div className="dk-col-head house-col-head">
                  <h3>
                    <ChainDot chain={l.chain as StoreChain} /> {chainName(l.chain)} · half price
                  </h3>
                  <span className="dk-sub num">
                    {items.length}
                    {filter ? ` of ${l.items.length}` : ''}
                  </span>
                </div>
                <span className="dk-sub house-pad">
                  {l.device.startsWith('srv-') ? 'Shared by your phones' : `From ${names.get(l.device) ?? 'a phone'}`}
                  {l.at ? `, ${timeAgo(l.at)}` : ''}
                </span>
                {items.length === 0 && <p className="small house-pad">{filter ? 'Nothing like what you buy this week.' : 'None this week.'}</p>}
                {items.slice(0, 40).map((p) => (
                  <SpecialRow key={p.storeProductId} p={p} onAdd={(x) => void add(x)} />
                ))}
              </section>
            );
          })}
        </div>
        <p className="small">"List" adds it for this trip only. To watch its price, add it to your pantry on a phone.</p>
      </section>

      <section className="dk-stack" aria-labelledby="sp-shops">
        <h2 id="sp-shops">Your shops</h2>
        <p className="small dk-tight">Every shop the household follows. Links open the shop's own site in a new tab.</p>
        {followed?.map((g) => (
          <section key={g.section} className="card flush" aria-labelledby={`sp-${g.section}`}>
            <h3 id={`sp-${g.section}`} className="dk-card-title">
              {g.title}
            </h3>
            {g.shops.map((s) => (
              <ShopRow key={s.chain} s={s} />
            ))}
          </section>
        ))}
        {followed && !followed.length && <p className="small">No shops picked yet. Pick them in Settings → Shops.</p>}
        <p className="small">Catalogue prices can differ by state and store. Your items' prices are checked by your phones, so you don't need to hunt for them here.</p>
      </section>
    </HousePage>
  );
}

/** Home: a few of this week's specials like what you buy, and My catalogue's sum. */
export function HomeSpecials() {
  const nav = useNav();
  const { lists, pantry } = useSpecialLists();
  const add = useAddSpecial();
  const cat = useLive(async () => {
    const [settings, recs] = await Promise.all([getSettings(), loadRecommendations()]);
    const chains = [...new Set(activeSections(settings).flatMap((s) => searchChainsIn(settings.enabledChains, s)))];
    return buildCatalogue(recs, chains);
  }, []);
  const picks = useMemo(() => {
    const all = lists.flatMap((l) => (pantry.length ? likeYourPantry(l.items, pantry) : l.items));
    return all.slice(0, 6);
  }, [lists, pantry]);
  return (
    <div className="dk-split">
      <section className="dk-wide" aria-labelledby="home-sp">
        <div className="dk-section-head">
          <h2 id="home-sp">This week's specials</h2>
          <button className="dk-linkish" onClick={() => nav.push({ name: 'specials' })}>
            Specials and catalogues
          </button>
        </div>
        {picks.length === 0 ? (
          <div className="card">
            <p className="small">{lists.length ? 'Nothing like what you buy on half price this week.' : 'None shared yet: your phones share the half-price lists they fetch.'}</p>
          </div>
        ) : (
          <div className="card flush">
            {picks.map((p) => (
              <SpecialRow key={`${p.chain}-${p.storeProductId}`} p={p} onAdd={(x) => void add(x)} />
            ))}
          </div>
        )}
      </section>
      <aside className="dk-aside">
        <section className="card" aria-labelledby="home-cat">
          <div className="dk-section-head">
            <h2 id="home-cat">My catalogue</h2>
            <button className="dk-linkish" onClick={() => nav.push({ name: 'mycatalogue' })}>
              Open it
            </button>
          </div>
          {cat ? (
            cat.items > 0 ? (
              <>
                <span className="dk-stat num">{cat.items}</span>
                <span className="dk-sub">
                  of your items on sale this week{cat.saving > 0 ? `, saving about ${money(cat.saving)}` : ''}
                  {cat.halfPrice ? ` · ${cat.halfPrice} half price` : ''}
                </span>
              </>
            ) : (
              <p className="small">None of your items is on sale this week.</p>
            )
          ) : (
            <p className="small" aria-busy="true">
              …
            </p>
          )}
        </section>
      </aside>
    </div>
  );
}
