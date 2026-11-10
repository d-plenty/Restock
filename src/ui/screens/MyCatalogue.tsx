import { useRef, useState, type KeyboardEvent } from 'react';
import { allListEntries, getSettings } from '../../lib/db';
import { addAllToList, addToList } from '../../lib/listActions'; // 0.9.5 (undo)
import { buildCatalogue, type CatalogueDeal, type CataloguePage, type MyCatalogue } from '../../lib/myCatalogue';
import { loadRecommendations } from '../../lib/recs';
import { nameHasSize } from '../../lib/naming';
import { money, tidySize } from '../../lib/units';
import { useLive } from '../../lib/useLive';
import { activeSections, chainName, searchChainsIn, shopColor } from '../../shops';
import { Icon, TopBar } from '../components';
import { useNav } from '../nav';
import { serverMode } from '../../server-mode/flag';
import { pageForKey, PageArrows } from '../../server-mode/ui/deskShared';

// My catalogue (0.9.0): this week's deals on the things you track, a page per shop. See myCatalogue.ts.
// 0.9.5, the web: Previous / Next above and below the pages (with "Page 3 of 7"), and ← → when the
// pages have focus; a deal's photo or name opens the item.

const DAY = new Intl.DateTimeFormat('en-AU', { weekday: 'short', day: 'numeric', month: 'short' });
const weekText = (c: MyCatalogue) => `${DAY.format(c.from)} – ${DAY.format(c.to)}`;

export function MyCatalogueScreen() {
  const nav = useNav();
  const data = useLive(async () => {
    const [settings, recs, entries] = await Promise.all([getSettings(), loadRecommendations(), allListEntries()]);
    const chains = [...new Set(activeSections(settings).flatMap((s) => searchChainsIn(settings.enabledChains, s)))];
    const listed = new Set(entries.filter((e) => !e.checked && e.groupId).map((e) => e.groupId!));
    return { catalogue: buildCatalogue(recs, chains), listed };
  }, []);
  const pagesRef = useRef<HTMLDivElement>(null);
  const [page, setPage] = useState(0);
  // The page Previous / Next / a key asked for, while the smooth scroll gets there (the scroll's
  // in-between positions don't change the page number meanwhile).
  const aim = useRef<{ page: number; until: number }>(undefined);

  if (!data) return <div className="screen" />;
  const { catalogue: c, listed } = data;
  const count = c.pages.length + 1;
  const goTo = (i: number) => {
    const el = pagesRef.current;
    aim.current = { page: i, until: Date.now() + 900 };
    setPage(i);
    if (el) el.scrollTo({ left: i * el.clientWidth, behavior: 'smooth' });
  };
  const onScroll = (el: HTMLDivElement) => {
    const at = Math.round(el.scrollLeft / Math.max(1, el.clientWidth));
    const a = aim.current;
    if (a && Date.now() < a.until && at !== a.page) return;
    aim.current = undefined;
    setPage(at);
  };
  // ← → on the pages, or on Previous / Next (not while typing or in a menu).
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || (e.target as HTMLElement).closest?.('input, select, textarea')) return;
    const to = pageForKey(e.key, page, count);
    if (to === undefined) return;
    e.preventDefault();
    if (to !== page) goTo(to);
  };
  const pageName = (i: number) => (i ? chainName(c.pages[i - 1].chain) : 'Cover');
  const arrows = (where: 'top' | 'bottom') =>
    serverMode ? <PageArrows page={Math.min(page, count - 1)} count={count} name={pageName(Math.min(page, count - 1))} onGo={goTo} where={where} /> : null;
  const add = async (d: CatalogueDeal) => {
    const added = await addToList(d.rec.group); // 0.9.5 (undo)
    if (!added) nav.toast(`${d.rec.group.name} is already on your list`);
  };
  const salesDeals = c.pages.filter((p) => p.kind === 'sales').flatMap((p) => p.deals);
  const addAll = async () => {
    // 0.9.5 (undo): "Added 32 to your shopping list", and one Undo takes all 32 off again.
    const n = await addAllToList([...new Map(salesDeals.map((d) => [d.rec.group.id, d.rec.group])).values()]);
    if (!n) nav.toast('They were all on your list already');
  };

  return (
    <div className="screen">
      <TopBar title="My catalogue" />
      {!c.pages.length ? (
        <div className="empty">
          <p>
            Nothing on special from your items this week yet. Restock builds this catalogue from the things you track, after a price check.
          </p>
        </div>
      ) : (
        <div className="cat-deck" style={{ display: 'flex', flexDirection: 'column', gap: 14 }} onKeyDown={serverMode ? onKey : undefined}>
          {arrows('top')}
          <div
            className="cat-pages"
            ref={pagesRef}
            onScroll={(e) => onScroll(e.currentTarget)}
            {...(serverMode
              ? { tabIndex: 0, role: 'region', 'aria-roledescription': 'catalogue', 'aria-label': 'My catalogue pages. Use the left and right arrow keys to turn the page.' }
              : {})}
          >
            <section className="cat-page" aria-label="Cover">
              <div className="banner green cat-cover">
                <span className="cat-kicker">{weekText(c).toUpperCase()}</span>
                <h2>Specials on the things you buy</h2>
                <span className="cat-lede">Only things you track. Only real specials.</span>
                <span className="cat-stats">
                  <span>
                    <b className="big">{money(c.saving)}</b>
                    <small>you could save</small>
                  </span>
                  <span>
                    <b className="big">{c.halfPrice}</b>
                    <small>half price</small>
                  </span>
                  <span>
                    <b className="big">{c.multiBuys}</b>
                    <small>multi-buy{c.multiBuys === 1 ? '' : 's'}</small>
                  </span>
                </span>
              </div>
              <div className="eyebrow">Inside</div>
              <div className="card flush">
                {c.pages.map((p, i) => (
                  <button key={p.chain} className="row" onClick={() => goTo(i + 1)}>
                    <span className="cat-num" style={{ background: shopColor(p.chain) }}>
                      {i + 2}
                    </span>
                    <span className="grow">
                      <span className="title">{chainName(p.chain)}</span>
                      <span className="small">{pageLine(p)}</span>
                    </span>
                    <Icon name="chevron" size={16} />
                  </button>
                ))}
              </div>
              {salesDeals.length > 0 && (
                <button className="btn primary" onClick={() => void addAll()}>
                  <Icon name="cartPlus" size={18} /> Add all {new Set(salesDeals.map((d) => d.rec.group.id)).size} to my list
                </button>
              )}
            </section>
            {c.pages.map((p) => (
              <section key={p.chain} className="cat-page" aria-label={chainName(p.chain)}>
                <div className="cat-shop">
                  <div className="cat-band" style={{ background: shopColor(p.chain) }}>
                    <span className="cat-band-name">{chainName(p.chain)}</span>
                    <span className="cat-band-sub">{pageLine(p)}</span>
                  </div>
                  <div className="cat-grid">
                    {p.deals.map((d) => (
                      <DealTile
                        key={d.rec.group.id}
                        d={d}
                        listed={listed.has(d.rec.group.id)}
                        onAdd={() => void add(d)}
                        onOpen={() => nav.push({ name: 'item', groupId: d.rec.group.id })}
                      />
                    ))}
                  </div>
                </div>
                {p.kind === 'cheapest' && (
                  <p className="small">
                    {chainName(p.chain)} has no sales on your items this week, so its page shows where it beats your other shops.
                  </p>
                )}
              </section>
            ))}
          </div>
          <div className="pagedots" aria-label="Pages">
            {[0, ...c.pages.map((_, k) => k + 1)].map((k) => (
              <button
                key={k}
                aria-current={Math.min(page, c.pages.length) === k ? 'page' : undefined}
                aria-label={k ? `${chainName(c.pages[k - 1].chain)} page` : 'Cover'}
                className={Math.min(page, c.pages.length) === k ? 'on' : ''}
                onClick={() => goTo(k)}
              />
            ))}
          </div>
          {arrows('bottom')}
        </div>
      )}
    </div>
  );
}

function pageLine(p: CataloguePage): string {
  const n = p.deals.length;
  return p.kind === 'sales' ? `${n} deal${n === 1 ? '' : 's'} on your items` : `Cheapest for ${n} of your items`;
}

function DealTile({ d, listed, onAdd, onOpen }: { d: CatalogueDeal; listed: boolean; onAdd: () => void; onOpen: () => void }) {
  const o = d.option;
  const [broken, setBroken] = useState(false);
  const size = o.product.size ? tidySize(o.product.size, o.product.name) : undefined;
  const name = `${o.product.name}${o.product.size && size && !nameHasSize(o.product.name, o.product.size) ? ` ${size}` : ''}`;
  return (
    <div className="cat-deal">
      <button className="cat-photo" onClick={onOpen} aria-label={`Open ${d.rec.group.name}`}>
        {o.product.imageUrl && !broken ? (
          <img src={o.product.imageUrl} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setBroken(true)} />
        ) : (
          <Icon name="box" size={26} />
        )}
      </button>
      <span className={`cat-burst${o.multi ? ' multi' : d.badge === 'CHEAPEST' || d.badge === 'SAME PRICE' ? ' plain' : ''}`}>
        {d.badge}
      </span>
      {serverMode ? (
        <button type="button" className="cat-name cat-name-open" onClick={onOpen}>
          {name}
        </button>
      ) : (
        <span className="cat-name">{name}</span>
      )}
      <span className="cat-price">
        <b className="num">{o.multi ? `${o.multi.n} for ${money(o.multi.total)}` : money(o.price)}</b>
        {d.was !== undefined && <s className="num">{money(d.was)}</s>}
      </span>
      <span className="cat-note">{d.note}</span>
      <button
        className={`cat-add${listed ? ' on' : ''}`}
        aria-label={listed ? `${d.rec.group.name} is on your list` : `Add ${d.rec.group.name} to your list`}
        onClick={onAdd}
      >
        <Icon name={listed ? 'check' : 'plus'} size={18} />
      </button>
    </div>
  );
}
