// 0.9.3: Home at desktop widths: this week's tiles, good buys, the list and small price drops.
// The same data and sums as the phone's Home (Home.tsx weekDeals), laid out wide.
import { todayText } from '../../lib/greeting';
import { useMemo } from 'react';
import { allListEntries, getSettings } from '../../lib/db';
import { addToList, takeOffList } from '../../lib/listActions'; // 0.9.5 (undo)
import { loadRecommendations } from '../../lib/recs';
import { nameHasSize } from '../../lib/naming';
import { money, tidySize } from '../../lib/units';
import { useLive } from '../../lib/useLive';
import { worthAlerting, type Recommendation } from '../../lib/verdict';
import { chainName } from '../../shops';
import { ChainName, Icon, SectionMark } from '../../ui/components';
import { useNav } from '../../ui/nav';
import { weekDeals } from '../../ui/screens/Home';
import { listSums, shopOf, tickEntry, useListAdd } from '../../ui/screens/List';
import { underTarget } from '../../ui/screens/Pantry';
import { openRecalls } from '../../ui/screens/Recalls';
import { ActionInfoTag } from '../../ui/tagInfo';
import { DeskHead, greeting, openItem } from './deskShared';
import { DeskAddBox } from './DeskList';
import { HomeSpecials } from './DeskSpecials';

export function DeskHome() {
  const nav = useNav();
  const allRecs = useLive(loadRecommendations, []);
  const settings = useLive(getSettings, []);
  const allEntries = useLive(allListEntries, []);
  const recalls = useLive(openRecalls, []);
  // Worked out again only when the data changes, not on every key typed in the add box.
  const sums = useMemo(
    () =>
      allRecs && settings && allEntries
        ? {
            groceries: listSums(allEntries, allRecs, settings, 'pantry'),
            // 0.9.5: the General list counts on the Shopping list tile too.
            general: listSums(allEntries, allRecs, settings, 'general').entries.filter((e) => !e.checked).length,
            w: weekDeals(allRecs, settings, allEntries),
          }
        : undefined,
    [allRecs, settings, allEntries],
  );
  const adder = useListAdd(sums?.groceries.entries ?? [], sums?.groceries.recs ?? [], 'pantry');
  if (!allRecs || !settings || !allEntries || !sums) return <div className="dk-page" aria-busy="true" />;
  const { groceries, general, w } = sums;
  const today = todayText();

  // On special this week: the same deals Home counts (on sale, swap & save, small savings), by shop.
  const byShop = new Map<string, number>();
  for (const r of w.dealRecs) {
    const c = w.dealChain(r);
    if (c) byShop.set(c, (byShop.get(c) ?? 0) + 1);
  }
  const shopLine = [...byShop.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([c, n]) => `${chainName(c)} ${n}`)
    .join(' · ');
  const open = w.entries.filter((e) => !e.checked);
  const toBuy = open.length + general;
  const shops = w.totals.around.chains.length;
  const under = w.recs.filter(underTarget);
  const hits = w.recs.filter((r) => underTarget(r) || worthAlerting(r));

  const toggle = async (r: Recommendation) => {
    const id = w.listed.get(r.group.id);
    if (id) {
      await takeOffList([id], r.group.name); // 0.9.5 (undo)
      return;
    }
    const added = await addToList(r.group); // 0.9.5 (undo)
    if (!added) nav.toast(`${r.group.name} is already on your list`);
  };

  const preview = groceries.entries
    .filter((e) => !e.checked)
    .slice(0, 6)
    .concat(groceries.entries.filter((e) => e.checked).slice(0, 1));
  const nameOf = (id?: string, text = '') => (id ? groceries.names.get(id) : undefined) ?? text;

  return (
    <div className="dk-page">
      <DeskHead title={greeting()} above={today}>
        <DeskAddBox adder={adder} label="Add to the shopping list" placeholder="Add to your shopping list: milk, bread, dog food…" compact />
      </DeskHead>

      <div className="dk-tiles">
        <button className="dk-tile navy" onClick={() => nav.setTab('pantry')}>
          <span className="dk-tile-lab">On special this week</span>
          <span className="dk-tile-big">
            {w.dealRecs.length} of your item{w.dealRecs.length === 1 ? '' : 's'}
          </span>
          <span className="dk-tile-sub">{shopLine || 'Nothing on special yet'}</span>
        </button>
        <button className="dk-tile" onClick={() => nav.setTab('list', 'pantry')}>
          <span className="dk-tile-lab">Shopping list</span>
          <span className="dk-tile-big">{toBuy ? `${toBuy} to buy` : 'Empty'}</span>
          <span className="dk-tile-sub num">
            {w.totals.around.total > 0
              ? `About ${money(w.totals.around.total)}${shops > 1 ? ` across ${shops} shops` : shops === 1 ? ` at ${chainName(w.totals.around.chains[0])}` : ''}`
              : 'Add things on the list page'}
          </span>
        </button>
        <button className="dk-tile" onClick={() => nav.setTab('pantry')}>
          <span className="dk-tile-lab">Price alerts</span>
          <span className="dk-tile-big">{hits.length ? `${hits.length} hit` : 'None hit'}</span>
          <span className="dk-tile-sub">
            {under.length ? `${under.length} below the price you set` : hits.length ? 'On special the way your alerts ask' : 'Nothing at your alert prices yet'}
          </span>
        </button>
        {recalls && recalls.length > 0 ? (
          <button className="dk-tile bad" onClick={() => nav.push({ name: 'recalls' })}>
            <span className="dk-tile-lab">Recalls</span>
            <span className="dk-tile-big">{recalls.length === 1 ? '1 possible' : `${recalls.length} possible`}</span>
            <span className="dk-tile-sub clip">{recalls[0].affected?.[0] ?? recalls[0].title}</span>
          </button>
        ) : (
          <div className="dk-tile good">
            <span className="dk-tile-lab">Recalls</span>
            <span className="dk-tile-big">{settings.recalls.enabled ? 'None here' : 'Off'}</span>
            <span className="dk-tile-sub">{settings.recalls.enabled ? 'Your phones check the official lists daily' : 'Turn recall alerts on on a phone'}</span>
          </div>
        )}
      </div>

      <div className="dk-split">
        <section className="dk-wide" aria-labelledby="dk-buys">
          <div className="dk-section-head">
            <h2 id="dk-buys">Good buys this week</h2>
            <button className="dk-linkish" onClick={() => nav.push({ name: 'specials' })}>
              All specials
            </button>
          </div>
          {w.worth.length === 0 ? (
            <div className="card">
              <p className="small">None of your items is on a good sale right now. Your phones keep checking, and new deals show up here.</p>
            </div>
          ) : (
            // 0.9.5: a grid, not a table, so it fits its column at every width: five columns when
            // there's room (1920), the shop and "how good" under the item (1280 and 1440), stacked
            // on narrow screens. The Add to list button is never cut off.
            <div className="dk-buys-wrap">
              <div className="dk-buys-head" aria-hidden>
                <span>Item</span>
                <span>Where</span>
                <span>Price</span>
                <span>How good</span>
                <span />
              </div>
              <ul className="dk-buys" aria-label="Good buys this week">
                {w.worth.map((r) => {
                  const deal = (r.action === 'alt' ? r.alt : r.best)!;
                  const listed = w.listed.has(r.group.id);
                  const size = deal.product.size && !nameHasSize(deal.product.name, deal.product.size) ? tidySize(deal.product.size, deal.product.name) : undefined;
                  const was = deal.stats.current?.wasPrice;
                  const price = deal.multi ? deal.shelfPrice : deal.price;
                  return (
                    <li key={r.group.id} className="dk-buy">
                      <span className="dk-buy-item">
                        <button className="dk-name" onClick={() => openItem(nav, r.group)}>
                          <SectionMark section={r.group.section} />
                          {r.group.name}
                        </button>
                        <span className="dk-sub clip">{r.action === 'alt' ? `Swap to ${deal.product.name}` : [deal.product.name, size].filter(Boolean).join(' · ')}</span>
                      </span>
                      <span className="dk-buy-where">
                        <ChainName chain={deal.product.chain} />
                      </span>
                      <span className="dk-buy-price num">
                        <strong>{money(price)}</strong>
                        {was !== undefined && was > (price ?? 0) && (
                          <s className="dk-was">
                            <span className="sr-only">usual price </span>
                            {money(was)}
                          </s>
                        )}
                      </span>
                      <span className="dk-buy-how">
                        <ActionInfoTag rec={r} action={r.action} great={r.best?.verdict.kind === 'great'} />
                        <span className="dk-sub">{r.detail}</span>
                      </span>
                      <span className="dk-buy-act">
                        <button
                          className={`btn small${listed ? '' : ' primary'}`}
                          aria-pressed={listed}
                          aria-label={listed ? `On the list: ${r.group.name}` : `Add to list: ${r.group.name}`}
                          onClick={() => void toggle(r)}
                        >
                          <Icon name={listed ? 'cartCheck' : 'cartPlus'} size={16} />
                          {listed ? 'On the list' : 'Add to list'}
                        </button>
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
          <p className="small">Prices come from your phones' checks. Your phones keep checking; this page shows what they found.</p>
        </section>

        <aside className="dk-aside">
          <section className="card" aria-labelledby="dk-onlist">
            <div className="dk-section-head">
              <h2 id="dk-onlist">Shopping list</h2>
              <button className="dk-linkish" onClick={() => nav.setTab('list', 'pantry')}>
                Open it
              </button>
            </div>
            {preview.length === 0 && <p className="small">Nothing on your shopping list.</p>}
            {preview.map((e) => {
              const shop = shopOf(groceries.c, e);
              const title = nameOf(e.groupId, e.text);
              return (
                <div key={e.id} className={`dk-check${e.checked ? ' done' : ''}`}>
                  {/* 0.9.4: only the checkbox ticks; the name opens the item. */}
                  <label className="tick-hit">
                    <input type="checkbox" checked={e.checked} aria-label={`Got ${title}`} onChange={(ev) => void tickEntry(e, ev.target.checked, title) /* 0.9.5 (undo) */} />
                  </label>
                  <span className="grow">
                    {e.groupId ? (
                      <button
                        type="button"
                        className="dk-line-open"
                        onClick={() => nav.push({ name: 'item', groupId: e.groupId! })}
                        aria-label={`${(e.qty ?? 1) > 1 ? `${e.qty} × ` : ''}${title}, open the item`}
                      >
                        {(e.qty ?? 1) > 1 && <span className="num">{e.qty} × </span>}
                        {title}
                      </button>
                    ) : (
                      <>
                        {(e.qty ?? 1) > 1 && <span className="num">{e.qty} × </span>}
                        {title}
                      </>
                    )}
                  </span>
                  <span className="dk-sub">{shop === 'any' ? 'Any shop' : chainName(shop)}</span>
                </div>
              );
            })}
            {open.length > 6 && <span className="small">and {open.length - 6} more</span>}
          </section>

          <section className="card" aria-labelledby="dk-drops">
            <h2 id="dk-drops">Price drops</h2>
            {w.smalls.length === 0 ? (
              <p className="small">No small drops on your items right now.</p>
            ) : (
              w.smalls.slice(0, 8).map((r) => (
                <div key={r.group.id} className="dk-drop">
                  <button className="dk-name" onClick={() => openItem(nav, r.group)}>
                    {r.group.name}
                  </button>
                  <span className="dk-sub">{r.best ? chainName(r.best.product.chain) : ''}</span>
                  <strong className="num dk-down">{r.saving ? `−${money(r.saving)}` : money(r.best?.price)}</strong>
                </div>
              ))
            )}
            {w.smalls.length > 0 && <span className="small">Small savings: under 15% off the usual price.</span>}
          </section>
        </aside>
      </div>

      {/* 0.9.4 (section 15): this week's specials the phones shared, and My catalogue. */}
      <HomeSpecials />
    </div>
  );
}
