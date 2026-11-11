// 0.9.4 (design section 15): Specials and catalogues on the web, like the phone's. Every shop the
// household follows, by tab, with its website, specials and catalogue links; This week's specials
// from the half-price lists the phones fetched and shared (the server never fetches a shop); and My
// catalogue (made here from your items' prices). Home shows a little of both (HomeSpecials).
import { useMemo, useState } from 'react';
import { addListEntry, allGroups, getSettings, nowIso, uid } from '../../lib/db';
import { addToList } from '../../lib/listActions'; // 0.9.5 (undo)
import { act } from '../../lib/undo'; // 0.9.5 (undo)
import { buildCatalogue } from '../../lib/myCatalogue';
import { loadRecommendations } from '../../lib/recs';
import { unitTextOf } from '../../lib/searchHelp';
import { likeYourPantry } from '../../lib/specials';
import { money } from '../../lib/units';
import { useLive } from '../../lib/useLive';
import { activeSections, chainName, searchChainsIn, type StoreChain } from '../../shops';
import type { StoreProduct } from '../../stores/types';
import type { Group } from '../../types';
import { ChainDot, Icon, Sheet, storePageUrl, Thumb, timeAgo } from '../../ui/components';
import { useNav } from '../../ui/nav';
import { HousePage } from './DeskServer';
import { useFollowed, useShared } from './houseData';
import { ItemPhoto, photoUrl } from './deskShared';
import { memberNames } from '../live';
import { useTrackSpecial } from './WebShopSearch'; // 0.9.5 (web search)

const MINE_KEY = 'deskSpecialsMine';

function loadMine(): boolean {
  try {
    return localStorage.getItem(MINE_KEY) !== '0';
  } catch {
    return true;
  }
}

/** A shop's product picture: https, from a shop's picture host the page's CSP allows (else the box). */
export const thumbOf = (url: unknown) => photoUrl(url);

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

function useAddSpecial(opener: { index: Map<string, string>; groups: Map<string, Group> }) {
  const nav = useNav();
  return async (p: StoreProduct) => {
    // A special on something you track goes on the list as that item (its line, its quantity).
    const id = trackedGroup(opener.index, p);
    const group = id ? opener.groups.get(id) : undefined;
    if (group) {
      const added = await addToList(group); // 0.9.5 (undo)
      if (!added) nav.toast(`${group.name} is already on your shopping list`);
      return;
    }
    // 0.9.5 (undo)
    await act(`${p.name} added to your shopping list`, () =>
      addListEntry({ id: uid(), text: p.name, chain: p.chain, price: p.price, section: 'pantry', checked: false, createdAt: nowIso() }),
    );
  };
}

/** Words to match a special with a tracked product by name: lower case, letters and digits only. */
const nameKey = (s: string) =>
  s
    .toLowerCase()
    .replace(/×/g, 'x')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** "chain|shop's id" and "chain|name" → the pantry item that tracks that product (0.9.5). */
export function trackedIndex(recs: { group: { id: string }; options: { product: { chain: string; storeProductId?: string; name: string } }[] }[]) {
  const m = new Map<string, string>();
  for (const r of recs)
    for (const o of r.options) {
      if (o.product.storeProductId) m.set(`${o.product.chain}|id|${o.product.storeProductId}`, r.group.id);
      m.set(`${o.product.chain}|name|${nameKey(o.product.name)}`, r.group.id);
    }
  return m;
}

export const trackedGroup = (index: Map<string, string>, p: Pick<StoreProduct, 'chain' | 'storeProductId' | 'name'>) =>
  (p.storeProductId ? index.get(`${p.chain}|id|${p.storeProductId}`) : undefined) ?? index.get(`${p.chain}|name|${nameKey(p.name)}`);

/** Opens a special: its item page when you track it, else its product sheet. */
function useOpenSpecial() {
  const nav = useNav();
  const recs = useLive(loadRecommendations, []);
  const index = useMemo(() => trackedIndex(recs ?? []), [recs]);
  const groups = useMemo(() => new Map((recs ?? []).map((r) => [r.group.id, r.group])), [recs]);
  const [sheet, setSheet] = useState<StoreProduct>();
  const open = (p: StoreProduct) => {
    const groupId = trackedGroup(index, p);
    if (groupId) nav.push({ name: 'item', groupId });
    else setSheet(p);
  };
  return { open, index, groups, sheet, close: () => setSheet(undefined) };
}

/** 0.9.5 (web search): Track for an untracked special, when Let the web page search the shops is on. */
type Tracker = ReturnType<typeof useTrackSpecial>;
const trackKey = (p: StoreProduct) => `${p.chain}:${p.storeProductId}`;

function SpecialRow({ p, onAdd, onOpen, tracked, tracker }: { p: StoreProduct; onAdd: (p: StoreProduct) => void; onOpen: (p: StoreProduct) => void; tracked: boolean; tracker?: Tracker }) {
  return (
    <div className="row house-special">
      <button type="button" className="house-special-open" onClick={() => onOpen(p)} aria-label={`${p.name}, ${tracked ? 'open the item' : 'details'}`}>
        <Thumb src={thumbOf(p.imageUrl)} />
        <span className="grow">
          <span className="title clip">{p.name}</span>
          <span className="small">
            <strong className="num">{money(p.price)}</strong>
            {p.wasPrice ? <s className="dk-was"> {money(p.wasPrice)}</s> : null}
            {p.promo ? ` · ${p.promo}` : ''}
            {tracked ? ' · in your pantry' : ''}
          </span>
          {/* 0.9.6: both prices, as on the phone. */}
          {unitTextOf(p) && <span className="small num">{unitTextOf(p)}</span>}
        </span>
      </button>
      {/* 0.9.5 (web search): Track it, as on the phone. */}
      {tracker?.on && !tracked && (
        <button className="btn small" disabled={!!tracker.busy} onClick={() => void tracker.track(p)} aria-label={`Track ${p.name}`}>
          <Icon name="pantry" size={16} /> {tracker.busy === trackKey(p) ? 'Tracking…' : 'Track'}
        </button>
      )}
      <button className="btn small primary" onClick={() => onAdd(p)} aria-label={`Add ${p.name} to your shopping list`}>
        <Icon name="cartPlus" size={16} /> Add to list
      </button>
    </div>
  );
}

/** A special you don't track yet: its photo, prices, the shop's page and Add to list. */
export function SpecialSheet({ p, onAdd, onClose, tracker }: { p: StoreProduct; onAdd: (p: StoreProduct) => void; onClose: () => void; tracker?: Tracker }) {
  const page = storePageUrl({ chain: p.chain, name: p.name, brand: p.brand, storeProductId: p.storeProductId });
  return (
    <Sheet title={chainName(p.chain)} onClose={onClose}>
      <ItemPhoto src={photoUrl(p.imageUrl)} name={p.name} size="sheet" />
      <span className="title dk-sheet-name">{p.name}</span>
      <div className="dk-sheet-price">
        <span className="num dk-sheet-now">{money(p.price)}</span>
        {p.wasPrice && p.wasPrice > (p.price ?? 0) ? (
          <span className="small num">
            usual price <s>{money(p.wasPrice)}</s>
          </span>
        ) : null}
        {p.promo && <span className="tag good">{p.promo.toUpperCase()}</span>}
      </div>
      {unitTextOf(p) && <span className="small num">{unitTextOf(p)}</span>}
      <p className="small">
        On special at {chainName(p.chain)} this week. It isn't in your pantry, so Restock doesn't watch its price.{' '}
        {tracker?.on ? 'Track it to put it in your pantry.' : 'Add it to your pantry on a phone to do that.'}
      </p>
      {/* 0.9.5 (web search): Track, from the server's own search of that shop. */}
      {tracker?.on && (
        <button
          className="btn"
          disabled={!!tracker.busy}
          onClick={() => {
            void tracker.track(p);
            onClose();
          }}
        >
          <Icon name="pantry" size={18} /> Track it
        </button>
      )}
      <button
        className="btn primary"
        onClick={() => {
          onAdd(p);
          onClose();
        }}
      >
        <Icon name="cartPlus" size={18} /> Add to list
      </button>
      {page && (
        <a className="btn" href={page} target="_blank" rel="noopener noreferrer">
          <Icon name="external" size={18} /> See it on the {chainName(p.chain)} website
        </a>
      )}
    </Sheet>
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
  const opener = useOpenSpecial();
  const add = useAddSpecial(opener);
  const tracker = useTrackSpecial(); // 0.9.5 (web search)
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
        <span className="cat-entry-title">Specials on the things you buy</span>
        <span className="cat-lede">This week's specials on everything you track, a page for each shop.</span>
        <span className="btn small cat-open">Open my catalogue</span>
      </button>

      <section className="dk-stack" aria-labelledby="sp-week">
        <div className="dk-section-head">
          <h2 id="sp-week">This week's specials</h2>
          <div className="dk-seg" role="group" aria-label="Which specials">
            <button aria-pressed={filter} disabled={!pantry.length} onClick={() => setMine(true)}>
              Things I buy
            </button>
            <button aria-pressed={!filter} onClick={() => setMine(false)}>
              All specials
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
                {items.length === 0 && <p className="small house-pad">{filter ? 'Nothing like the things you buy this week.' : 'None this week.'}</p>}
                {items.slice(0, 40).map((p) => (
                  <SpecialRow key={p.storeProductId} p={p} onAdd={(x) => void add(x)} onOpen={opener.open} tracked={!!trackedGroup(opener.index, p)} tracker={tracker} />
                ))}
              </section>
            );
          })}
        </div>
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
        <p className="small">Catalogue prices can differ by state and branch. Your items' prices are checked by your phones, so you don't need to hunt for them here.</p>
      </section>
      {opener.sheet && <SpecialSheet p={opener.sheet} onAdd={(x) => void add(x)} onClose={opener.close} tracker={tracker} />}
      {tracker.sheet}
    </HousePage>
  );
}

/** Home: a few of this week's specials like what you buy, and My catalogue's sum. */
export function HomeSpecials() {
  const nav = useNav();
  const { lists, pantry } = useSpecialLists();
  const opener = useOpenSpecial();
  const add = useAddSpecial(opener);
  const tracker = useTrackSpecial(); // 0.9.5 (web search)
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
            <p className="small">{lists.length ? 'Nothing like the things you buy is half price this week.' : 'None shared yet: your phones share the half-price lists they fetch.'}</p>
          </div>
        ) : (
          <div className="card flush">
            {picks.map((p) => (
              <SpecialRow key={`${p.chain}-${p.storeProductId}`} p={p} onAdd={(x) => void add(x)} onOpen={opener.open} tracked={!!trackedGroup(opener.index, p)} tracker={tracker} />
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
                  of your items on special this week{cat.saving > 0 ? `, saving about ${money(cat.saving)}` : ''}
                  {cat.halfPrice ? ` · ${cat.halfPrice} half price` : ''}
                </span>
              </>
            ) : (
              <p className="small">None of your items is on special this week.</p>
            )
          ) : (
            <p className="small" aria-busy="true">
              …
            </p>
          )}
        </section>
      </aside>
      {opener.sheet && <SpecialSheet p={opener.sheet} onAdd={(x) => void add(x)} onClose={opener.close} tracker={tracker} />}
      {tracker.sheet}
    </div>
  );
}
