// 0.9.3: Home at desktop widths: this week's tiles, good buys, the list and small price drops.
// The same data and sums as the phone's Home (Home.tsx weekDeals), laid out wide.
import { useMemo } from 'react';
import { allListEntries, deleteListEntries, getSettings, updateListEntry } from '../../lib/db';
import { addGroupToList } from '../../lib/listActions';
import { loadRecommendations } from '../../lib/recs';
import { nameHasSize } from '../../lib/naming';
import { money, tidySize } from '../../lib/units';
import { useLive } from '../../lib/useLive';
import { worthAlerting, type Recommendation } from '../../lib/verdict';
import { chainName } from '../../shops';
import { ChainName, Icon, SectionMark } from '../../ui/components';
import { useNav } from '../../ui/nav';
import { weekDeals } from '../../ui/screens/Home';
import { listSums, shopOf, useListAdd } from '../../ui/screens/List';
import { underTarget } from '../../ui/screens/Pantry';
import { openRecalls } from '../../ui/screens/Recalls';
import { ActionInfoTag } from '../../ui/tagInfo';
import { DeskHead, greeting, openItem } from './deskShared';
import { DeskAddBox } from './DeskList';

export function DeskHome() {
  const nav = useNav();
  const allRecs = useLive(loadRecommendations, []);
  const settings = useLive(getSettings, []);
  const allEntries = useLive(allListEntries, []);
  const recalls = useLive(openRecalls, []);
  // Worked out again only when the data changes, not on every key typed in the add box.
  const sums = useMemo(
    () => (allRecs && settings && allEntries ? { groceries: listSums(allEntries, allRecs, settings, 'pantry'), w: weekDeals(allRecs, settings, allEntries) } : undefined),
    [allRecs, settings, allEntries],
  );
  const adder = useListAdd(sums?.groceries.entries ?? [], sums?.groceries.recs ?? [], 'pantry');
  if (!allRecs || !settings || !allEntries || !sums) return <div className="dk-page" aria-busy="true" />;
  const { groceries, w } = sums;
  const today = new Date().toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long' });

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
  const shops = w.totals.around.chains.length;
  const under = w.recs.filter(underTarget);
  const hits = w.recs.filter((r) => underTarget(r) || worthAlerting(r));

  const toggle = async (r: Recommendation) => {
    const id = w.listed.get(r.group.id);
    if (id) {
      await deleteListEntries([id]);
      nav.toast(`${r.group.name} taken off your shopping list`);
      return;
    }
    const added = await addGroupToList(r.group);
    nav.toast(added ? `${r.group.name} added to your shopping list` : `${r.group.name} is already on your list`);
  };

  const preview = groceries.entries
    .filter((e) => !e.checked)
    .slice(0, 6)
    .concat(groceries.entries.filter((e) => e.checked).slice(0, 1));
  const nameOf = (id?: string, text = '') => (id ? groceries.names.get(id) : undefined) ?? text;

  return (
    <div className="dk-page">
      <DeskHead title={greeting()} sub={<span className="dk-date">{today}</span>}>
        <DeskAddBox adder={adder} label="Add to the shopping list" placeholder="Add to the list: milk, bread, dog food…" compact />
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
          <span className="dk-tile-lab">{w.on.length > 1 ? 'Grocery list' : 'Shopping list'}</span>
          <span className="dk-tile-big">{open.length ? `${open.length} to buy` : 'Empty'}</span>
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
            {under.length ? `${under.length} below the price you set` : hits.length ? 'On sale the way your alerts ask' : 'Nothing at your alert prices yet'}
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
            <div className="dk-table-wrap">
              <table className="dk-table">
                <thead>
                  <tr>
                    <th scope="col">Item</th>
                    <th scope="col">Where</th>
                    <th scope="col">Price</th>
                    <th scope="col">How good</th>
                    <th scope="col">
                      <span className="sr-only">Shopping list</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {w.worth.map((r) => {
                    const deal = (r.action === 'alt' ? r.alt : r.best)!;
                    const listed = w.listed.has(r.group.id);
                    const size = deal.product.size && !nameHasSize(deal.product.name, deal.product.size) ? tidySize(deal.product.size, deal.product.name) : undefined;
                    const was = deal.stats.current?.wasPrice;
                    const price = deal.multi ? deal.shelfPrice : deal.price;
                    return (
                      <tr key={r.group.id}>
                        <td>
                          <button className="dk-name" onClick={() => openItem(nav, r.group)}>
                            <SectionMark section={r.group.section} />
                            {r.group.name}
                          </button>
                          <span className="dk-sub clip">{r.action === 'alt' ? `Swap to ${deal.product.name}` : [deal.product.name, size].filter(Boolean).join(' · ')}</span>
                        </td>
                        <td className="dk-nowrap">
                          <ChainName chain={deal.product.chain} />
                        </td>
                        <td className="num">
                          <strong>{money(price)}</strong>
                          {was !== undefined && was > (price ?? 0) && <s className="dk-was"> {money(was)}</s>}
                        </td>
                        <td>
                          <ActionInfoTag rec={r} action={r.action} great={r.best?.verdict.kind === 'great'} />
                          <span className="dk-sub">{r.detail}</span>
                        </td>
                        <td className="dk-end">
                          <button className={`btn small${listed ? '' : ' dk-add'}`} aria-pressed={listed} onClick={() => void toggle(r)}>
                            <Icon name={listed ? 'cartCheck' : 'cartPlus'} size={16} />
                            {listed ? 'On the list' : 'Add to list'}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className="small">Prices come from your phones' checks. Your phones keep checking; this page shows what they found.</p>
        </section>

        <aside className="dk-aside">
          <section className="card" aria-labelledby="dk-onlist">
            <div className="dk-section-head">
              <h2 id="dk-onlist">On the list</h2>
              <button className="dk-linkish" onClick={() => nav.setTab('list', 'pantry')}>
                Open the list
              </button>
            </div>
            {preview.length === 0 && <p className="small">Nothing on the grocery list.</p>}
            {preview.map((e) => {
              const shop = shopOf(groceries.c, e);
              const title = nameOf(e.groupId, e.text);
              return (
                <label key={e.id} className={`dk-check${e.checked ? ' done' : ''}`}>
                  <input type="checkbox" checked={e.checked} onChange={(ev) => void updateListEntry(e.id, { checked: ev.target.checked })} />
                  <span className="grow">
                    {(e.qty ?? 1) > 1 && <span className="num">{e.qty} × </span>}
                    {title}
                  </span>
                  <span className="dk-sub">{shop === 'any' ? 'Any shop' : chainName(shop)}</span>
                </label>
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
            {w.smalls.length > 0 && <span className="small">Small savings: under 15% off the normal price.</span>}
          </section>
        </aside>
      </div>
    </div>
  );
}
