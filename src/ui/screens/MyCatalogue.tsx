import { useRef, useState } from 'react';
import { allListEntries, getSettings } from '../../lib/db';
import { addGroupToList } from '../../lib/listActions';
import { buildCatalogue, type CatalogueDeal, type CataloguePage, type MyCatalogue } from '../../lib/myCatalogue';
import { loadRecommendations } from '../../lib/recs';
import { nameHasSize } from '../../lib/naming';
import { money, tidySize } from '../../lib/units';
import { useLive } from '../../lib/useLive';
import { activeSections, chainName, searchChainsIn, shopColor } from '../../shops';
import { Icon, TopBar } from '../components';
import { useNav } from '../nav';

// My catalogue (0.9.0): this week's deals on the things you track, a page per shop. See myCatalogue.ts.

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

  if (!data) return <div className="screen" />;
  const { catalogue: c, listed } = data;
  const goTo = (i: number) => {
    const el = pagesRef.current;
    if (el) el.scrollTo({ left: i * el.clientWidth, behavior: 'smooth' });
  };
  const add = async (d: CatalogueDeal) => {
    const added = await addGroupToList(d.rec.group);
    nav.toast(added ? `${d.rec.group.name} added to your list` : `${d.rec.group.name} is already on your list`);
  };
  const salesDeals = c.pages.filter((p) => p.kind === 'sales').flatMap((p) => p.deals);
  const addAll = async () => {
    let n = 0;
    for (const g of new Map(salesDeals.map((d) => [d.rec.group.id, d.rec.group])).values()) if (await addGroupToList(g)) n++;
    nav.toast(n ? `${n} item${n === 1 ? '' : 's'} added to your list` : 'They were all on your list already');
  };

  return (
    <div className="screen">
      <TopBar title="My catalogue" />
      {!c.pages.length ? (
        <div className="empty">
          <p>
            Nothing on sale from your items this week yet. Restock builds this catalogue from the things you track, after a price check.
          </p>
        </div>
      ) : (
        <>
          <div
            className="cat-pages"
            ref={pagesRef}
            onScroll={(e) => setPage(Math.round(e.currentTarget.scrollLeft / Math.max(1, e.currentTarget.clientWidth)))}
          >
            <section className="cat-page" aria-label="Cover">
              <div className="banner green cat-cover">
                <span className="cat-kicker">{weekText(c).toUpperCase()}</span>
                <h2>This week's deals on what you buy</h2>
                <span className="cat-lede">Only things you track. Only real sales.</span>
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
        </>
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
      <span className="cat-name">
        {o.product.name}
        {o.product.size && size && !nameHasSize(o.product.name, o.product.size) ? ` ${size}` : ''}
      </span>
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
